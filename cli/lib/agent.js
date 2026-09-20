import './env.js';
import OpenAI from 'openai';
import { normalizeToolCall } from './parser.js';
import { executeTool } from './tools.js';
import { validate } from './mig.js';

const openai = new OpenAI({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY,
});

// ── Model configuration ────────────────────────────────────
const MODEL_FALLBACKS = process.env.EXCAL_MODEL
  ? [process.env.EXCAL_MODEL]
  : ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];

let activeModel = MODEL_FALLBACKS[0];
let activeModelIndex = 0;

const DANGEROUS_TOOLS = ['write_file', 'edit_file', 'run_command'];

export const SYSTEM_PROMPT = `You are Excal Coder, a governed AI coding agent inside an IDE.

TOOLS:
1.  write_file(path, content) — write a new file or overwrite an existing one
2.  edit_file(path, old_string, new_string) — replace ONE exact snippet. old_string MUST appear EXACTLY ONCE. PREFER THIS over write_file when editing existing files.
3.  read_file(path, start_line?, end_line?) — read a file. Use line ranges for large files.
4.  list_files(directory) — list directory contents
5.  search_code(pattern, glob?, directory?) — ripgrep search across the project
6.  find_files(pattern, directory?) — glob file search (e.g. "**/*.test.js")
7.  get_project_info() — detect the project stack (Node/Python/Go/Rust, tests, deps)
8.  get_repo_map() — compact map of the whole codebase: files, top-level symbols, imports. CALL THIS FIRST when you need to understand the project structure or find where something lives.
9.  git_diff() — show current uncommitted changes
10.  run_command(command) — run a shell command

STARTING A NEW TASK:
1. get_repo_map() — see the whole project layout
2. pick the 1-3 files that matter
3. read_file() them
4. edit_file() the change
5. run_command() to test


WORKFLOW FOR EDITING CODE:
1. get_project_info() — understand the stack
2. search_code() or find_files() — locate relevant files
3. read_file() — read the file(s) you'll change
4. edit_file() — patch, don't rewrite. Include 2-3 surrounding lines to make old_string unique.
5. run_command() for tests if the project has them
6. git_diff() — verify the change


CRITICAL RULES:
- Respond with ONLY valid JSON: {"tool": "name", "args": {...}}
- Emit EXACTLY ONE tool call per response. Never bundle multiple tool calls.
- NEVER write "Tool Result:" or simulate tool output. The system provides results next turn.
- Do NOT wrap JSON in markdown fences. Do NOT use XML.
- If not calling a tool, reply in plain text.

DENIAL SEMANTICS:
- If the user denies or MIG blocks an action, do NOT re-propose it.
- Acknowledge in ONE short sentence and stop.
- Only propose a DIFFERENT action if the user explicitly asks.

EDIT_FILE RULES:
- old_string must match byte-for-byte, including whitespace and indentation.
- Include 2-3 lines of context above and below the changed line to make it unique.
- If you're not sure what the exact text is, call read_file first.`;

// ── Robust model call: rate-limit retry + model fallback ───
async function callModel(messages) {
  let lastErr = null;
  const maxAttempts = MODEL_FALLBACKS.length * 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const idx = Math.floor(attempt / 2) % MODEL_FALLBACKS.length;
    const model = MODEL_FALLBACKS[idx];

    try {
      const completion = await openai.chat.completions.create({
        model,
        messages,
        temperature: 0.4,
        max_tokens: 4096,    
      });

      if (activeModel !== model) {
        console.log(`🔁 Using model → ${model}`);
        activeModel = model;
        activeModelIndex = idx;
      }
      return completion;
    } catch (err) {
      const msg = String(err?.message || err);

      // Rate limit → wait and retry
      if (err?.status === 429 || /rate.?limit/i.test(msg)) {
        const wait = 3000 + attempt * 2000;
        console.log(`⏳ Rate limited. Waiting ${wait / 1000}s (attempt ${attempt + 1}/${maxAttempts})…`);
        await new Promise((r) => setTimeout(r, wait));
        lastErr = err;
        continue;
      }

      // Model unavailable → try next model
      if (/(404|410|unavailable|not found|no endpoints|decommissioned)/i.test(msg)) {
        console.log(`⚠️ Model ${model} unavailable, trying next…`);
        lastErr = err;
        continue;
      }
      
      if (/tool choice is none|tool.*called a tool/i.test(msg) && !err._retried) {
        err._retried = true;
        lastErr = err;
        continue;
      }

      throw err;
    }
  }
  throw new Error(`All model attempts failed. Last: ${lastErr?.message || lastErr}`);
}

// ── Session history trim (caps token usage) ────────────────
function trimSession(session) {
  const MAX_MESSAGES = 13; // system + 12 most recent
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = [
      session.messages[0], // system prompt stays
      ...session.messages.slice(-(MAX_MESSAGES - 1)),
    ];
  }
}

// ── The agent loop ─────────────────────────────────────────
export async function runAgentLoop(session, ui, cwd) {
  for (let i = 0; i < 5; i++) {
    trimSession(session);
    ui.thinking();

    let completion;
    try {
      completion = await callModel(session.messages);   // ← FIX: now calls callModel
    } catch (err) {
      ui.ai(`(model error: ${err.message.slice(0, 200)})`);
      return;
    }

    const msg = completion.choices?.[0]?.message;
    if (!msg) {
      ui.ai('(empty model response)');
      return;
    }

    const content = msg.content || '';
    const reasoning = msg.reasoning || '';

    // Recover tool calls from reasoning stream (gpt-oss quirk)
    let plan = normalizeToolCall(content);
    if (!plan && reasoning) plan = normalizeToolCall(reasoning);

    if (!content.trim() && !plan) {
      session.messages.push({ role: 'user', content: '(empty response — try again)' });
      continue;
    }

    // No tool call → final answer, return to prompt
    if (!plan) {
      ui.ai(content);
      session.messages.push({ role: 'assistant', content });
      return;
    }

    // Dangerous tool → gate via MIG
    if (DANGEROUS_TOOLS.includes(plan.tool)) {
      const verdict = await validate(plan.tool, plan.args, session.constraints);
      ui.verdict(verdict, plan);

      if (verdict.decision === 'DENY') {
        ui.blocked(verdict.reason);
        session.messages.push({ role: 'user', content: `MIG BLOCKED: ${verdict.reason}. Do NOT re-propose.` });
        continue;
      }

      if (verdict.decision === 'APPROVAL') {
        const approved = await ui.approve(plan, verdict);
        if (!approved) {
          ui.blocked('user denied');
          session.messages.push({ role: 'user', content: 'User DENIED. Do not re-propose. Acknowledge and stop.' });
          return; // stop the loop — don't let model keep trying
        }
      }
    }

    // Execute
    ui.toolCall(plan.tool, plan.args);
    const res = await executeTool(plan, cwd);
    ui.toolResult(res);

    session.messages.push({ role: 'assistant', content: JSON.stringify(plan) });
    session.messages.push({ role: 'user', content: `Tool Result: ${res.result}` });
  }
}
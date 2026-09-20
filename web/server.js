import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const openai = new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY,
});

// Pin one model. Free router rotates dialects; pinning kills 80% of the chaos.
// Override anytime with EXCAL_MODEL env var.
// Curated for tool-calling reliability on the free tier.
// Order matters: strongest tool-caller first.
// Check live free models anytime: https://openrouter.ai/models?max_price=0
const MODEL_FALLBACKS = (process.env.EXCAL_MODEL
  ? [process.env.EXCAL_MODEL]
  : ["openai/gpt-oss-120b"]);

let activeModelIndex = 0;
let activeModel = MODEL_FALLBACKS[0];

// ==========================================
// MIG: DETERMINISTIC INTENT RULES
// ==========================================
const COMMAND_RULES = [
  { pattern: /\brm\b|\bdel\b|\berase\b|\brmdir\b|\bremove-item\b|\bunlink\b|\bshred\b|\bformat\b|\bmkfs\b|\bdd\s+if=/i, intent: 'destructive_filesystem',    risk: 95, action: 'DENY' },
  { pattern: /curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh|iex\s*\(|invoke-expression/i,                intent: 'remote_script_execution',  risk: 98, action: 'DENY' },
  { pattern: /shutdown|reboot|halt|poweroff/i,                                                          intent: 'system_shutdown',          risk: 99, action: 'DENY' },
  { pattern: /npm\s+install|pip\s+install|pip3\s+install|yarn\s+add|apt\s+install/i,                   intent: 'install_dependency',       risk: 60, action: 'GATE' },
  { pattern: /git\s+push|git\s+reset\s+--hard|git\s+clean|git\s+checkout\s+\./i,                       intent: 'git_state_change',         risk: 70, action: 'GATE' },
  { pattern: /pytest|npm\s+test|npm\s+run\s+test|python\s+-m\s+unittest/i,                             intent: 'run_tests',                risk: 15, action: 'GATE' },
  { pattern: /python\s|node\s|npm\s+run|npm\s+start|go\s+run|cargo\s+run/i,                            intent: 'run_script',               risk: 40, action: 'GATE' },
  { pattern: /git\s+status|git\s+diff|git\s+log|^ls|^dir\s|type\s|cat\s|echo\s/i,                      intent: 'read_only',                risk:  5, action: 'GATE' },
];

function classifyCommand(cmd) {
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(cmd)) return rule;
  }
  return { intent: 'unknown_shell_command', risk: 85, action: 'GATE' }; // fail-closed
}

const CONSTRAINT_INTENTS = [
  { keys: ['install', 'package', 'dependency', 'npm', 'pip'], test: c => /npm\s+install|pip\s+install|yarn\s+add/.test(c) },
  { keys: ['delete', 'remove', 'rm '],                         test: c => /rm\s|del\s|rmdir|remove-item/.test(c) },
  { keys: ['network', 'internet', 'curl', 'wget', 'download'], test: c => /curl|wget|http/.test(c) },
  { keys: ['git', 'push', 'commit'],                            test: c => /git\s+(push|commit|reset)/.test(c) },
  { keys: ['test'],                                             test: c => /pytest|npm\s+test/.test(c) },
  // FIX: this line was missing — your Test 2 showed ALLOW even with "do not run any python" constraint.
  { keys: ['run', 'execute', 'script', 'python', 'node', 'command'], test: c => /python\s|node\s|npm\s+run|npm\s+start|go\s+run|cargo\s+run/i.test(c) },
];

// ==========================================
// THE SHIELD
// ==========================================
function checkMig(tool, args, userConstraints) {
  const constraints = (userConstraints || '').toLowerCase();

  if (tool === 'run_command') {
    const rule = classifyCommand(args.command || '');
    console.log(`🛡️ MIG: intent=${rule.intent} risk=${rule.risk} action=${rule.action}`);
    if (rule.action === 'DENY') {
      return { allowed: false, reason: `Deterministic DENY (${rule.intent}, risk ${rule.risk})` };
    }
    const cmd = (args.command || '').toLowerCase();
    for (const ci of CONSTRAINT_INTENTS) {
      if (ci.keys.some(k => constraints.includes(k)) && ci.test(cmd)) {
        return { allowed: false, reason: `User constraint matched intent (${rule.intent})` };
      }
    }
    return { allowed: true, reason: `ALLOW (${rule.intent}, risk ${rule.risk})` };
  }

  if (tool === 'write_file') {
    const target = (args.path || '').toLowerCase();
    const content = (args.content || '').toLowerCase();

    // Language → file extension synonyms.
    const LANG_EXTS = {
      python:     ['.py', '.pyw', '.pyi'],
      javascript: ['.js', '.jsx', '.mjs', '.cjs'],
      typescript: ['.ts', '.tsx'],
      java:       ['.java'],
      kotlin:     ['.kt'],
      rust:       ['.rs'],
      golang:     ['.go'],
      go:         ['.go'],
      ruby:       ['.rb'],
      php:        ['.php'],
      cpp:        ['.cpp', '.cc', '.hpp', '.hxx'],
      'c++':      ['.cpp', '.cc', '.hpp'],
      csharp:     ['.cs'],
      'c#':       ['.cs'],
      html:       ['.html', '.htm'],
      css:        ['.css', '.scss', '.sass', '.less'],
      markdown:   ['.md', '.markdown'],
      shell:      ['.sh', '.bash', '.zsh'],
      bash:       ['.sh', '.bash'],
      json:       ['.json'],
      yaml:       ['.yml', '.yaml'],
      toml:       ['.toml'],
      sql:        ['.sql'],
      env:        ['.env'],
      docker:     ['dockerfile'],
      dockerfile: ['dockerfile'],
    };

    const STOP = new Set([
      'do','not','dont','never','the','a','an','to','please','touch','modify','change',
      'edit','write','create','make','any','files','file','new','without','adding',
      'using','use','what','should','agent','absolutely','blank','plain','approve',
      'and','or','but','for','with','from','into','this','that','these','those',
    ]);

    const words = constraints
      .split(/[^a-z0-9_.+#-]+/)
      .filter(w => w.length > 2 && !STOP.has(w));

    for (const w of words) {
      // 1. Literal match against path
      if (target.includes(w)) {
        return { allowed: false, reason: `User constraint violated: "${w}" in path` };
      }
      // 2. Language → extension match
      if (LANG_EXTS[w]) {
        for (const ext of LANG_EXTS[w]) {
          if (target.endsWith(ext)) {
            return { allowed: false, reason: `User constraint violated: "${w}" → ${ext} file` };
          }
        }
      }
      // 3. Content signal match
      if (w.length >= 5 && content.includes(w)) {
        return { allowed: false, reason: `User constraint violated: "${w}" in content` };
      }
    }

    return { allowed: true, reason: 'ALLOW (write_file)' };
  }

  return { allowed: true, reason: 'ALLOW (safe tool)' };
}

// ==========================================
// THE HANDS
// ==========================================
function runCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: __dirname, timeout: 20000, maxBuffer: 1024 * 512 }, (error, stdout, stderr) => {
      let out = (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
      if (out.length > 4000) out = out.slice(0, 4000) + '\n... [output truncated]';
      if (error && error.code === 'ETIMEDOUT') out += '\n[command timed out after 20s and was killed]';
      resolve({ ok: !error, result: out || '(no output)' });
    });
  });
}

async function executeTool(plan) {
  const { tool, args } = plan;
  try {
    if (tool === 'write_file') {
      fs.writeFileSync(args.path, args.content, 'utf-8');
      return { ok: true, result: `Wrote to ${args.path}`, file: args.path, content: args.content };
    }
    if (tool === 'read_file') {
      const content = fs.readFileSync(args.path, 'utf-8');
      return { ok: true, result: content, file: args.path, content };
    }
    if (tool === 'list_files') {
      const dir = args.directory || '.';
      const ignored = new Set(['node_modules', '.git', '__pycache__', 'myenv', 'venv', 'frontend']);
      const files = fs.readdirSync(dir).filter(f => !f.startsWith('.') && !ignored.has(f));
      const formatted = files.map(f => fs.statSync(path.join(dir, f)).isDirectory() ? `📁 ${f}/` : `📄 ${f}`);
      return { ok: true, result: formatted.join('\n') };
    }
    if (tool === 'run_command') {
      return await runCommand(args.command);
    }
    return { ok: false, result: 'Unknown tool' };
  } catch (e) {
    return { ok: false, result: `Error: ${e.message}` };
  }
}

// ==========================================
// DIALECT NORMALIZER — the fix
// Deterministic cascade. Pure functions. No model, no network.
// Fail-closed: no match -> null -> treated as chat, NEVER executed.
// ==========================================
const KNOWN_TOOLS = ['write_file', 'read_file', 'list_files', 'run_command'];

// Utility: parse key='value', key="value", key=value from a kwarg string
function parseKwargs(str) {
  const args = {};
  const regex = /(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^,)\]]*))/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    const key = m[1];
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (key) args[key] = value;
  }
  return args;
}

// --- Dialect 1: JSON, direct or embedded ---
function tryJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === 'object' && KNOWN_TOOLS.includes(direct.tool)) {
      return { tool: direct.tool, args: direct.args || {}, dialect: 'json-direct' };
    }
  } catch { /* not direct JSON */ }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && KNOWN_TOOLS.includes(parsed.tool)) {
      return { tool: parsed.tool, args: parsed.args || {}, dialect: 'json-embedded' };
    }
  } catch { /* not valid embedded JSON */ }
  return null;
}

// --- Dialect 2: Phi special tokens: <|tool_call_start|>[name(k='v')]<|tool_call_end|> ---
function tryPhi(text) {
  if (!text) return null;
  const match = text.match(/<\|tool_call_start\|>\s*\[?\s*(\w+)\s*\(([^)]*)\)\s*\]?\s*<\|tool_call_end\|>/s);
  if (!match) return null;
  const toolName = match[1];
  if (!KNOWN_TOOLS.includes(toolName)) return null;
  return { tool: toolName, args: parseKwargs(match[2]), dialect: 'phi-special-token' };
}

// --- Dialect 3: XML with <tool_name>/<arg_key>/<arg_value> OR <tool>/<args> ---
function tryXml(text) {
  if (!text) return null;

  // Form A: <tool_name>name</tool_name> ... <arg_key>k</arg_key><arg_value>v</arg_value>
  const nameMatch = text.match(/<tool_?name>\s*([\w_]+)\s*<\/tool_?name>/i)
                 || text.match(/<tool>\s*([\w_]+)\s*<\/tool>/i);
  if (nameMatch) {
    const toolName = nameMatch[1].trim();
    if (KNOWN_TOOLS.includes(toolName)) {
      const keys = [...text.matchAll(/<arg_?key>\s*([\s\S]*?)\s*<\/arg_?key>/gi)].map(m => m[1].trim());
      const vals = [...text.matchAll(/<arg_?value>\s*([\s\S]*?)\s*<\/arg_?value>/gi)].map(m => m[1].trim());
      const args = {};
      keys.forEach((k, i) => { if (k && vals[i] !== undefined) args[k] = vals[i]; });
      return { tool: toolName, args, dialect: 'xml-namekey' };
    }
  }

  // Form B: <tool_call><name>list_files</name><args>{"directory":"."}</args></tool_call>
  const nameB = text.match(/<name>\s*([\w_]+)\s*<\/name>/i);
  const argsB = text.match(/<args>\s*([\s\S]*?)\s*<\/args>/i);
  if (nameB && KNOWN_TOOLS.includes(nameB[1].trim())) {
    let args = {};
    if (argsB) {
      try { args = JSON.parse(argsB[1].trim()); }
      catch { args = parseKwargs(argsB[1]); }
    }
    return { tool: nameB[1].trim(), args, dialect: 'xml-name-args' };
  }

  return null;
}

// --- Dialect 4: Markdown fenced blocks ```json {...}``` or ```tool_code name(...)``` ---
function tryFenced(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json|tool_code|tool|javascript|js)?\s*([\s\S]*?)```/i);
  if (!fence) return null;
  const inner = fence[1].trim();
  return tryJson(inner) || tryPhi(inner) || tryBareFunction(inner);
}

// --- Dialect 5: Bare function call at line start: name(k='v') ---
function tryBareFunction(text) {
  if (!text) return null;
  const match = text.match(/(?:^|\n)\s*(\w+)\s*\(([^)]*)\)\s*(?:\n|$)/);
  if (!match) return null;
  const toolName = match[1];
  if (!KNOWN_TOOLS.includes(toolName)) return null;
  return { tool: toolName, args: parseKwargs(match[2]), dialect: 'bare-function' };
}

// --- The cascade ---
function normalizeToolCall(text) {
  if (!text || typeof text !== 'string') return null;
  return (
    tryJson(text)       ||
    tryXml(text)        ||
    tryPhi(text)        ||
    tryFenced(text)     ||
    tryBareFunction(text)
  );
}

// Legacy name kept so nothing else breaks.
const parsePlan = normalizeToolCall;

// ==========================================
// THE AGENT LOOP
// ==========================================
const DANGEROUS_TOOLS = ['write_file', 'run_command'];

// Try each model in order. On 404/unavailable, advance and retry.
// Deterministic: same failure → same next model.
async function callModel(messages) {
  let lastErr = null;
  for (let attempt = 0; attempt < MODEL_FALLBACKS.length; attempt++) {
    const idx = (activeModelIndex + attempt) % MODEL_FALLBACKS.length;
    const model = MODEL_FALLBACKS[idx];
    try {
      const completion = await openai.chat.completions.create({
        model,
        messages,
        temperature: 0.4,
        max_tokens: 8192,
      });

      if (activeModel !== model) {
        console.log(`🔁 Switched model → ${model}`);
        activeModel = model;
        activeModelIndex = idx;
      }

      const msg = completion.choices?.[0]?.message;
      if (msg?.reasoning) {
        console.log(`💭 reasoning: ${String(msg.reasoning).slice(0, 200)}…`);
      }

      return {
        choices: [{ message: { content: msg?.content || '' } }],
        _reasoning: msg?.reasoning || '',
        _model: model,
      };
    } catch (err) {
      const msg = String(err?.message || err);
      const isUnavailable = /(404|410|unavailable|not found|no endpoints|decommissioned)/i.test(msg);
      console.log(`⚠️ Model ${model} failed: ${msg.slice(0, 200)}`);
      if (isUnavailable) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`All fallback models unavailable. Last error: ${lastErr?.message || lastErr}`);
}

async function runAgentLoop(ws, session) {
  for (let i = 0; i < 5; i++) {
    try {
      ws.send(JSON.stringify({ type: 'thinking' }));

      const completion = await callModel(session.messages);

      const content = completion.choices[0].message?.content || '';
      const reasoning = completion._reasoning || '';

      // gpt-oss quirk: tool calls sometimes land in `reasoning` instead of `content`.
      let plan = normalizeToolCall(content);
      let planSource = 'content';
      if (!plan && reasoning) {
        plan = normalizeToolCall(reasoning);
        if (plan) planSource = 'reasoning';
      }

      if (!content.trim() && !plan) {
        ws.send(JSON.stringify({ type: 'error', content: 'Model returned empty response. Retrying…' }));
        session.messages.push({ role: "user", content: "(previous response was empty — please try again)" });
        continue;
      }

      console.log(`📥 RAW [${i}]:`, content.slice(0, 300).replace(/\n/g, '\\n'));
      if (planSource === 'reasoning') {
        console.log(`🧠 tool call recovered from reasoning stream`);
      }

      if (plan) {
        console.log(`🧭 PARSED via ${plan.dialect}: ${plan.tool}`);

        if (DANGEROUS_TOOLS.includes(plan.tool)) {
          session.pendingPlan = plan;
          ws.send(JSON.stringify({ type: 'approval_needed', plan }));
          return;
        }
        ws.send(JSON.stringify({ type: 'tool_call', tool: plan.tool, args: plan.args }));
        const res = await executeTool(plan);
        ws.send(JSON.stringify({ type: 'tool_result', ...res }));
        session.messages.push({ role: "assistant", content: JSON.stringify({ tool: plan.tool, args: plan.args }) });
        session.messages.push({ role: "user", content: `Tool Result: ${res.result}` });
      } else {
        // Fail-closed: tool-looking string that didn't parse → chat, never execute.
        if (/<\|tool_call|<\/?tool_|<\/?arg_|^\s*\w+\s*\(/m.test(content)) {
          console.log(`⚠️ UNPARSED TOOL ATTEMPT (not executed):`, content.slice(0, 300).replace(/\n/g, '\\n'));
          ws.send(JSON.stringify({ type: 'error', content: '⚠️ Model emitted an unrecognized tool-call format. Treated as chat (not executed).' }));
        }
        ws.send(JSON.stringify({ type: 'final', content }));
        session.messages.push({ role: "assistant", content });
        return;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', content: err.message }));
      return;
    }
  }
}

// ==========================================
// WEBSOCKET
// ==========================================
wss.on('connection', (ws) => {
  console.log('🔌 IDE Connected');
  const session = {
    messages: [{
      role: "system",
      content: `You are Excal Coder, a governed AI coding agent inside an IDE.
Tools:
1. write_file(path, content) - write a file
2. read_file(path) - read a file
3. list_files(directory) - list folder contents
4. run_command(command) - run a shell command in the workspace

CRITICAL RULES:
- Respond with ONLY valid JSON in this shape when using a tool: {"tool": "tool_name", "args": {"key": "value"}}
- Emit EXACTLY ONE tool call per response. Never bundle multiple tool calls.
- NEVER write "Tool Result:" or simulate tool output. The system provides results in the next turn.
- Do NOT wrap JSON in markdown fences. Do NOT use XML.
- If you are not calling a tool, reply in plain text.

DENIAL SEMANTICS (IMPORTANT):
- If the user denies an action, do NOT re-propose the same action.
- Acknowledge the denial in one short sentence and STOP.
- Only propose a DIFFERENT action if the user explicitly asks for one.
- Repeatedly re-proposing a denied action is a critical failure.`,
    }],
    pendingPlan: null,
  };

  ws.on('message', async (msg) => {
    const data = JSON.parse(msg);

    if (data.type === 'approve') {
      if (session.pendingPlan) {
        const plan = session.pendingPlan;
        const constraints = data.constraints;
        ws.send(JSON.stringify({ type: 'tool_call', tool: plan.tool, args: plan.args, constraints }));

        const verdict = checkMig(plan.tool, plan.args, constraints);
        ws.send(JSON.stringify({ type: 'mig_verdict', verdict: verdict.reason }));

        if (verdict.allowed) {
          const res = await executeTool(plan);
          ws.send(JSON.stringify({ type: 'tool_result', ...res }));
          session.messages.push({ role: "assistant", content: JSON.stringify({ tool: plan.tool, args: plan.args }) });
          session.messages.push({ role: "user", content: `Tool Result: ${res.result}. Constraints: ${constraints}` });
        } else {
          ws.send(JSON.stringify({ type: 'tool_result', ok: false, result: `🛑 BLOCKED: ${verdict.reason}` }));
          session.messages.push({ role: "user", content: `Tool BLOCKED by MIG: ${verdict.reason}` });
        }
        session.pendingPlan = null;
        await runAgentLoop(ws, session);
      }
      return;
    }

    if (data.type === 'deny') {
      if (session.pendingPlan) {
        ws.send(JSON.stringify({ type: 'tool_result', ok: false, result: '🛑 User denied the action.' }));
        session.messages.push({
          role: "user",
          content: "User DENIED the action. Do NOT re-propose this action. Do NOT emit another tool call. Acknowledge the denial in ONE short sentence and stop."
        });
        session.pendingPlan = null;
        await runAgentLoop(ws, session);
      }
      return;
    }

    session.messages.push({ role: "user", content: data.message });
    await runAgentLoop(ws, session);
  });
});

server.listen(8000, () => console.log(`🚀 Excal Node IDE running on http://localhost:8000 · models=${MODEL_FALLBACKS.join(' → ')}`));
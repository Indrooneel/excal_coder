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
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: "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", // PUT KEY HERE
  defaultHeaders: { 'HTTP-Referer': 'https://excalcoder.ai', 'X-Title': 'Excal Coder' },
});

// ==========================================
// MIG: DETERMINISTIC INTENT RULES (no LLM here, ever)
// ==========================================
const COMMAND_RULES = [
  { pattern: /rm\s+-rf|rmdir\s+\/s|del\s+\/[sfq]|remove-item\s+.*-recurse|format\s+[a-z]:|mkfs|dd\s+if=/i, intent: 'destructive_filesystem', risk: 95, action: 'DENY' },
  { pattern: /curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh|iex\s*\(|invoke-expression/i,      intent: 'remote_script_execution', risk: 98, action: 'DENY' },
  { pattern: /shutdown|reboot|halt|poweroff/i,                                              intent: 'system_shutdown', risk: 99, action: 'DENY' },
  { pattern: /npm\s+install|pip\s+install|pip3\s+install|yarn\s+add|apt\s+install/i,         intent: 'install_dependency', risk: 60, action: 'GATE' },
  { pattern: /git\s+push|git\s+reset\s+--hard|git\s+clean|git\s+checkout\s+\./i,             intent: 'git_state_change', risk: 70, action: 'GATE' },
  { pattern: /pytest|npm\s+test|npm\s+run\s+test|python\s+-m\s+unittest/i,                   intent: 'run_tests', risk: 15, action: 'GATE' },
  { pattern: /python\s|node\s|npm\s+run|npm\s+start|go\s+run|cargo\s+run/i,                  intent: 'run_script', risk: 40, action: 'GATE' },
  { pattern: /git\s+status|git\s+diff|git\s+log|^ls|^dir\s|type\s|cat\s|echo\s/i,            intent: 'read_only', risk: 5, action: 'GATE' },
];

function classifyCommand(cmd) {
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(cmd)) return rule;
  }
  return { intent: 'unknown_shell_command', risk: 85, action: 'GATE' }; // fail-closed
}

// Constraint intents: user says "do not install packages" -> matches install commands
const CONSTRAINT_INTENTS = [
  { keys: ['install', 'package', 'dependency', 'npm', 'pip'],  test: c => /npm\s+install|pip\s+install|yarn\s+add/.test(c) },
  { keys: ['delete', 'remove', 'rm '],                          test: c => /rm\s|del\s|rmdir|remove-item/.test(c) },
  { keys: ['network', 'internet', 'curl', 'wget', 'download'],  test: c => /curl|wget|http/.test(c) },
  { keys: ['git', 'push', 'commit'],                            test: c => /git\s+(push|commit|reset)/.test(c) },
  { keys: ['test'],                                             test: c => /pytest|npm\s+test/.test(c) },
];

// ==========================================
// THE SHIELD (MIG stub - real API plugs in later)
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
    const STOP = new Set(['do','not','dont','never','the','a','an','to','please','touch','modify','change','edit','write','create','make','any','files','file','new','without','adding','using','use']);
    const words = constraints.split(/[^a-z0-9_.-]+/).filter(w => w.length > 3 && !STOP.has(w));
    const target = (args.path || '').toLowerCase();
    for (const w of words) {
      if (target.includes(w)) return { allowed: false, reason: `User constraint violated: "${w}" in path` };
    }
    return { allowed: true, reason: 'ALLOW (write_file)' };
  }

  return { allowed: true, reason: 'ALLOW (safe tool)' };
}

// ==========================================
// THE HANDS (Tools)
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
      const ignored = new Set(['node_modules', '.git', '__pycache__', 'myenv', 'venv']);
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

// Bulletproof JSON extractor
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return (parsed && typeof parsed === 'object' && parsed.tool) ? parsed : null;
  } catch (e) {
    return null;
  }
}

// ==========================================
// THE AGENT LOOP
// ==========================================
const DANGEROUS_TOOLS = ['write_file', 'run_command']; // these ALWAYS pause at the gate

async function runAgentLoop(ws, session) {
  for (let i = 0; i < 5; i++) {
    try {
      const completion = await openai.chat.completions.create({
        model: "openrouter/free",
        messages: session.messages
      });

      const reply = completion.choices[0].message.content;
      const plan = extractJson(reply);

      if (plan) {
        if (DANGEROUS_TOOLS.includes(plan.tool)) {
          session.pendingPlan = plan;
          ws.send(JSON.stringify({ type: 'approval_needed', plan }));
          return; // pause, wait for human
        }
        ws.send(JSON.stringify({ type: 'tool_call', tool: plan.tool, args: plan.args }));
        const res = await executeTool(plan);
        ws.send(JSON.stringify({ type: 'tool_result', ...res }));
        session.messages.push({ role: "assistant", content: JSON.stringify(plan) });
        session.messages.push({ role: "user", content: `Tool Result: ${res.result}` });
      } else {
        ws.send(JSON.stringify({ type: 'final', content: reply }));
        session.messages.push({ role: "assistant", content: reply });
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
4. run_command(command) - run a shell command in the workspace (tests, scripts, git). Dangerous commands are blocked by MIG.
Respond with ONLY JSON {"tool": "...", "args": {...}} when using a tool, or plain text when chatting.
After running a command, read its output and fix errors if needed.`
    }],
    pendingPlan: null
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
          session.messages.push({ role: "assistant", content: JSON.stringify(plan) });
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

    session.messages.push({ role: "user", content: data.message });
    await runAgentLoop(ws, session);
  });
});

app.use(express.static(__dirname));
server.listen(8000, () => console.log('🚀 Excal Node IDE running on http://localhost:8000'));
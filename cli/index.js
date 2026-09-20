#!/usr/bin/env node
import './lib/env.js'; 
import readline from 'readline/promises';
import { stdin, stdout } from 'process';
import { suggestConstraints } from './lib/mig.js';
import { runAgentLoop, SYSTEM_PROMPT } from './lib/agent.js';

// ─── Color palette ──────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
  bold:  '\x1b[1m',
  italic:'\x1b[3m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  blue:  '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m',
  bgRed: '\x1b[41m',
};

// ─── Helpers ────────────────────────────────────────────────
const W = Math.min(process.stdout.columns || 80, 90);
const HR = '─'.repeat(W);

function line() { console.log(`${C.gray}${HR}${C.reset}`); }
function blank() { console.log(); }

function box(title, body, color = C.cyan) {
  const inner = W - 4;
  const top = `${color}╭─ ${C.bold}${title}${C.reset}${color} ${'─'.repeat(Math.max(0, inner - title.length - 3))}╮${C.reset}`;
  const bottom = `${color}╰${'─'.repeat(W - 2)}╯${C.reset}`;
  console.log(top);
  for (const l of body.split('\n')) {
    console.log(`${color}│${C.reset} ${l}`);
  }
  console.log(bottom);
}

function truncate(s, n = 3) {
  const lines = String(s || '').split('\n');
  if (lines.length <= n) return lines.join('\n');
  return lines.slice(0, n).join('\n') + `\n${C.dim}... (${lines.length - n} more lines)${C.reset}`;
}

// ─── Session state ──────────────────────────────────────────
const rl = readline.createInterface({ input: stdin, output: stdout });
const cwd = process.cwd();

const session = {
  messages: [{ role: 'system', content: SYSTEM_PROMPT }],
  constraints: '',
  turnCount: 0,
  toolCallCount: 0,
  blockedCount: 0,
};

// ─── UI object passed to agent loop ────────────────────────
const ui = {
  thinking: () => {
    process.stdout.write(`${C.dim}${C.italic}🧠 thinking…${C.reset}\r`);
  },

  ai: (text) => {
    process.stdout.write(' '.repeat(50) + '\r'); // clear thinking line
    blank();
    console.log(`${C.cyan}${C.bold}🤖 Excal${C.reset}`);
    console.log(`${C.cyan}${text}${C.reset}`);
    blank();
  },

  toolCall: (tool, args) => {
    process.stdout.write(' '.repeat(50) + '\r');
    const argsPreview = JSON.stringify(args).slice(0, 70);
    console.log(`${C.blue}  ⚙  ${C.bold}${tool}${C.reset} ${C.gray}${argsPreview}${argsPreview.length >= 70 ? '…' : ''}${C.reset}`);
    session.toolCallCount++;
  },

  toolResult: (res) => {
    const icon = res.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    const body = truncate(res.result, res.ok ? 3 : 5);
    console.log(`${icon}  ${C.gray}${body.replace(/\n/g, `\n   `)}${C.reset}`);
  },

  verdict: (v, plan) => {
    blank();
    const isAllow = v.decision === 'ALLOW';
    const isDeny  = v.decision === 'DENY';
    const color   = isDeny ? C.red : isAllow ? C.green : C.yellow;
    const icon    = isDeny ? '🛑' : isAllow ? '🛡️ ' : '⚠️ ';
    const label   = isDeny ? 'DENY' : isAllow ? 'ALLOW' : 'GATE';

    box(
      `${icon} MIG ${label}`,
      `${C.bold}risk${C.reset}  ${C.bold}${v.risk}${C.reset}/100    ${C.bold}reason${C.reset}  ${v.reason}`,
      color
    );

    if (isDeny) session.blockedCount++;
  },

  blocked: (reason) => {
    console.log(`${C.red}${C.bold}  → action blocked:${C.reset} ${C.red}${reason}${C.reset}`);
    blank();
  },

  approve: async (plan, verdict) => {
    // Show a clean gate box for the plan
    let body = '';
    if (plan.tool === 'run_command') {
      body = `${C.bold}$ ${plan.args.command}${C.reset}`;
    } else if (plan.tool === 'write_file') {
      body = `${C.bold}${plan.args.path}${C.reset}\n${C.gray}${truncate(plan.args.content, 5)}${C.reset}`;
    } else if (plan.tool === 'edit_file') {
      const oldLines = (plan.args.old_string || '').split('\n');
      const newLines = (plan.args.new_string || '').split('\n');
      body = `${C.bold}${plan.args.path}${C.reset}\n`;
      body += oldLines.slice(0, 4).map(l => `${C.red}- ${l}${C.reset}`).join('\n');
      body += '\n';
      body += newLines.slice(0, 4).map(l => `${C.green}+ ${l}${C.reset}`).join('\n');
    } else {
      body = JSON.stringify(plan.args, null, 2);
    }

    box(`⚠  APPROVAL REQUIRED — ${plan.tool}`, body, C.yellow);
    blank();

    const ans = await rl.question(`${C.bold}  approve? ${C.gray}[y/N]${C.reset} `);
    return /^y(es)?$/i.test(ans.trim());
  },
};

// ─── Welcome banner ─────────────────────────────────────────
console.clear();
blank();
console.log(`${C.cyan}${C.bold}  ⚡ EXCAL CODER${C.reset}  ${C.gray}v0.4${C.reset}`);
console.log(`${C.gray}  governed AI coding agent  ·  house of galatine${C.reset}`);
blank();
line();
console.log(`  ${C.bold}cwd${C.reset}     ${C.gray}${cwd}${C.reset}`);
console.log(`  ${C.bold}model${C.reset}   ${C.gray}${process.env.EXCAL_MODEL || 'openai/gpt-oss-120b'}${C.reset}`);
console.log(`  ${C.bold}mig${C.reset}     ${C.green}active${C.reset} ${C.gray}(local deterministic stub)${C.reset}`);
line();
console.log(`  ${C.gray}type ${C.bold}exit${C.reset}${C.gray} to quit  ·  ${C.bold}ctrl+c${C.reset}${C.gray} to abort${C.reset}`);
blank();

// ─── Main loop ──────────────────────────────────────────────
while (true) {
  // Constraint chip on the prompt line
  const chip = session.constraints
    ? `${C.yellow}[🔒 ${session.constraints.slice(0, 40)}${session.constraints.length > 40 ? '…' : ''}]${C.reset} `
    : '';
  if (chip) console.log(`${C.gray}  constraint active: ${chip}${C.reset}`);

  const prompt = await rl.question(`${C.bold}${C.green}  ▸ ${C.reset}`);
  if (!prompt.trim()) continue;
  if (/^(exit|quit|:q)$/i.test(prompt.trim())) break;
  if (prompt.trim() === 'clear') { console.clear(); continue; }

  session.turnCount++;

  // Phase 1 — pre-flight constraint collection
  const suggestions = await suggestConstraints(prompt);
  let constraints = session.constraints;

  if (suggestions.length) {
    blank();
    console.log(`${C.gray}  suggested guardrails:${C.reset}`);
    suggestions.forEach((s, i) => {
      console.log(`${C.gray}    ${C.dim}${i + 1}.${C.reset}${C.gray} ${s}${C.reset}`);
    });
    const ans = await rl.question(`${C.gray}  add constraints? (blank = keep current, "-" = clear) > ${C.reset}`);
    if (ans.trim() === '-') constraints = '';
    else if (ans.trim()) constraints = ans.trim();
  }

  session.constraints = constraints;
  blank();

  session.messages.push({ role: 'user', content: prompt });

  try {
    await runAgentLoop(session, ui, cwd);
  } catch (err) {
    blank();
    box('❌ error', err.message.slice(0, 300), C.red);
    blank();
  }
}

// ─── Session summary ────────────────────────────────────────
blank();
line();
console.log(`${C.cyan}${C.bold}  session summary${C.reset}`);
console.log(`  ${C.gray}turns${C.reset}      ${session.turnCount}`);
console.log(`  ${C.gray}tool calls${C.reset} ${session.toolCallCount}`);
console.log(`  ${C.gray}blocked${C.reset}    ${session.blockedCount}`);
line();
blank();
console.log(`${C.gray}  good session. stay governed. 🛡️${C.reset}`);
blank();

rl.close();
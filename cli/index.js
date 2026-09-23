#!/usr/bin/env node
import './lib/env.js';
import readline from 'readline/promises';
import { stdin, stdout } from 'process';
import { suggestConstraints } from './lib/mig.js';
import { runAgentLoop, SYSTEM_PROMPT } from './lib/agent.js';
import { executeTool } from './lib/tools.js';

import { createTerminalUI, clean } from './lib/ui.js';

// ─── Session state ──────────────────────────────────────────
const rl = readline.createInterface({ input: stdin, output: stdout });

let activeController = null;
let closed = false;
rl.on('close', () => { closed = true; activeController?.abort(); });
rl.on('SIGINT', () => {
  if (activeController) {
    activeController.abort();
    console.log('\nCancelling current task…');
  } else rl.close();
});
async function ask(prompt, { signal } = {}) {
  if (closed) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  rl.once('close', abort);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try { return await rl.question(prompt, { signal: controller.signal }); }
  catch (err) {
    if (closed || err.code === 'ERR_USE_AFTER_CLOSE') return null;
    throw err;
  } finally {
    rl.removeListener('close', abort);
    signal?.removeEventListener('abort', abort);
  }
}

const cwd = process.cwd();

const session = {
  messages: [{ role: 'system', content: SYSTEM_PROMPT }],
  constraints: '',
  turnCount: 0,
  toolCallCount: 0,
  blockedCount: 0,
};

const ui = createTerminalUI({ output: stdout, session, cwd, ask,
  model: process.env.EXCAL_MODEL || 'openai/gpt-oss-120b (fallbacks enabled)',
  maxSteps: process.env.EXCAL_MAX_STEPS || 30 });
ui.banner();

// ─── Main loop ──────────────────────────────────────────────
while (true) {
  if (session.constraints) ui.notice(`Guardrails: ${session.constraints}`);
  const prompt = await ask(ui.prompt());
  if (prompt === null) break;
  if (!prompt.trim()) continue;
  if (/^(exit|quit|:q)$/i.test(prompt.trim())) break;
  if (prompt.trim() === 'clear') { if (stdout.isTTY) console.clear(); ui.banner(); continue; }

  const input = prompt.trim();
  if (input === '/help') { ui.help(); continue; }
  if (input === '/report') {
    if (session.progress) ui.report(session.progress);
    else ui.notice('No task evidence yet.');
    continue;
  }
  if (input === '/status') { ui.status(); continue; }
  if (input === '/verbose') {
    session.verbose = !session.verbose;
    ui.notice(`Tool output: ${session.verbose ? 'full' : 'preview (8 lines)'}`);
    continue;
  }
  if (input === '/last') { ui.panel('LAST TOOL RESULT', session.lastResult || 'No tool output yet.'); continue; }
  if (input === '/map' || input.startsWith('/map ')) {
    const result = await executeTool({ tool: 'get_repo_map', args: { directory: input.slice(4).trim() || '.' } }, cwd, { constraints: session.constraints });
    ui.panel('WORKSPACE MAP', result.result);
    continue;
  }
  if (input === '/constraints' || input.startsWith('/constraints ')) {
    const value = input.slice('/constraints'.length).trim();
    if (value) session.constraints = value === '-' ? '' : value;
    ui.notice(`Constraints: ${session.constraints || '(none)'}`);
    continue;
  }
  if (input === '/diff') {
    const result = await executeTool({ tool: 'git_diff', args: {} }, cwd);
    ui.panel('WORKSPACE DIFF', result.result);
    continue;
  }
  if (input === '/clear') {
    session.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    session.objective = '';
    session.progress = null;
    session.rejectedActions = new Set();
    console.log('Conversation cleared.');
    continue;
  }
  if (input.startsWith('/') && input !== '/continue') {
    console.log('Unknown command. Type /help.');
    continue;
  }
  if (input === '/continue' && !session.objective) {
    console.log('No active task to continue.');
    continue;
  }
  session.turnCount++;

  // Phase 1 — pre-flight constraint collection
  const suggestions = input === '/continue' ? [] : await suggestConstraints(prompt);
  let constraints = session.constraints;

  if (suggestions.length) {
    ui.panel('OPTIONAL GUARDRAILS', suggestions.map(s => `• ${s}`).join('\n') + '\n\nEnter custom constraints, leave blank to keep current, or - to clear.');
    const ans = await ask('  Guardrails ▸ ');
    if (ans === null) break;
    if (ans.trim() === '-') constraints = '';
    else if (ans.trim()) constraints = ans.trim();
  }

  session.constraints = constraints;


  if (input !== '/continue') {
    session.objective = prompt;
    session.progress = null;
    session.rejectedActions = new Set();
  }
  session.messages.push({ role: 'user', content: input === '/continue' ? 'Continue the active task from its current state. Recheck files if needed.' : prompt });

  try {
    activeController = new AbortController();
    ui.taskStart(session.objective);
    const result = await runAgentLoop(session, ui, cwd, { signal: activeController.signal });
    ui.taskEnd(result);
  } catch (err) {

    ui.panel('ERROR', clean(err.message).slice(0, 500), 31);

  } finally {
    activeController = null;
  }
}

ui.goodbye();
rl.close();

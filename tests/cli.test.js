import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeToolCall } from '../cli/lib/parser.js';
import { validatePlan, resolveWorkspacePath } from '../cli/lib/contracts.js';
import { executeTool, prepareToolExecution, runCommand } from '../cli/lib/tools.js';
import { validate } from '../cli/lib/mig.js';
import { runAgentLoop, buildModelMessages, createModelCaller, SYSTEM_PROMPT } from '../cli/lib/agent.js';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'excal-test-'));
  const cwd = path.join(parent, 'workspace');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, cwd };
}
const plan = (tool, args = {}) => ({ tool, args });
const completion = content => ({ choices: [{ message: { content } }] });
function harness(responses, extra = {}) {
  const events = [];
  const ui = Object.fromEntries(['thinking', 'ai', 'notice', 'verdict', 'blocked', 'toolCall', 'toolResult'].map(key => [key, (...args) => events.push([key, ...args])]));
  ui.approve = async () => true;
  const session = { messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'Fix the bug' }], constraints: '' };
  let calls = 0;
  const options = { callModel: async () => {
    const value = responses[calls++];
    if (value instanceof Error) throw value;
    return typeof value === 'string' ? completion(value) : value;
  }, ...extra };
  return { ui, session, options, events, calls: () => calls };
}

test('parser accepts a single complete plan and a complete JSON fence', () => {
  const text = JSON.stringify(plan('read_file', { path: 'x.js' }));
  assert.deepEqual(normalizeToolCall(text), plan('read_file', { path: 'x.js' }));
  assert.deepEqual(normalizeToolCall('```json\n' + text + '\n```'), plan('read_file', { path: 'x.js' }));
});

test('parser rejects ambiguous, embedded, malformed and unknown calls', () => {
  const text = JSON.stringify(plan('write_file', { path: 'x', content: 'x' }));
  for (const input of [text + text, 'Example: ' + text, text + '\nTool Result: done', 'null', '[]',
    '{"tool":"constructor","args":{}}', '{"tool":"read_file","args":[]}',
    '{"tool":"read_file","args":{"path":4}}', '{"tool":"read_file","args":{"path":"x","extra":true}}',
    'write_file(path="x", content="x")']) assert.equal(normalizeToolCall(input), null, input);
});

test('schemas reject missing args, invalid line ranges and empty edit targets', () => {
  for (const value of [plan('write_file', { path: 'x' }), plan('read_file', { path: 'x', start_line: 0 }),
    plan('read_file', { path: 'x', start_line: 5, end_line: 2 }), plan('edit_file', { path: 'x', old_string: '', new_string: '' })]) {
    assert.throws(() => validatePlan(value));
  }
});

test('file tools reject traversal and external symlinks', async t => {
  const { parent, cwd } = workspace(t);
  fs.writeFileSync(path.join(parent, 'secret'), 'outside');
  fs.symlinkSync(parent, path.join(cwd, 'escape'), 'dir');
  for (const target of ['../secret', path.join(parent, 'secret'), 'escape/secret']) {
    assert.equal((await executeTool(plan('read_file', { path: target }), cwd)).ok, false);
    assert.equal((await executeTool(plan('write_file', { path: target, content: 'changed' }), cwd)).ok, false);
  }
  assert.equal(fs.readFileSync(path.join(parent, 'secret'), 'utf8'), 'outside');
});

test('protected git data and internal write symlinks are rejected', t => {
  const { cwd } = workspace(t);
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.symlinkSync('.git', path.join(cwd, 'git-alias'), 'dir');
  fs.writeFileSync(path.join(cwd, 'real'), 'keep');
  fs.symlinkSync('real', path.join(cwd, 'alias'));
  assert.throws(() => resolveWorkspacePath(cwd, '.git/config'));
  assert.throws(() => resolveWorkspacePath(cwd, 'git-alias/config'));
  assert.throws(() => resolveWorkspacePath(cwd, 'alias', { write: true }));
});

test('edit writes dollar sequences literally and preserves CRLF and permissions', async t => {
  const { cwd } = workspace(t);
  const file = path.join(cwd, 'script.js');
  fs.writeFileSync(file, 'hello\r\nworld\r\n', { mode: 0o755 });
  const result = await executeTool(plan('edit_file', { path: 'script.js', old_string: 'hello\nworld', new_string: 'cash $& $$ $`\nworld' }), cwd);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'cash $& $$ $`\r\nworld\r\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
});

test('nonunique edits fail without changing the file', async t => {
  const { cwd } = workspace(t);
  fs.writeFileSync(path.join(cwd, 'x'), 'same same');
  assert.equal((await executeTool(plan('edit_file', { path: 'x', old_string: 'same', new_string: 'new' }), cwd)).ok, false);
  assert.equal(fs.readFileSync(path.join(cwd, 'x'), 'utf8'), 'same same');
});

test('stale approval refuses changed files and newly created destinations', async t => {
  const { cwd } = workspace(t);
  for (const exists of [false, true]) {
    const filename = exists ? 'old' : 'new';
    if (exists) fs.writeFileSync(path.join(cwd, filename), 'initial');
    const action = plan('write_file', { path: filename, content: 'agent edit' });
    const prepared = prepareToolExecution(action, cwd);
    fs.writeFileSync(path.join(cwd, filename), 'external edit');
    const result = await executeTool(action, cwd, prepared);
    assert.equal(result.ok, false);
    assert.match(result.result, /changed since approval/);
    assert.equal(fs.readFileSync(path.join(cwd, filename), 'utf8'), 'external edit');
  }
});

test('invalid executable arguments return an error rather than throwing', async t => {
  const { cwd } = workspace(t);
  assert.equal((await executeTool(plan('run_command', { command: null }), cwd)).ok, false);
});

test('search treats option-looking patterns as data', async t => {
  const { cwd } = workspace(t);
  fs.writeFileSync(path.join(cwd, 'x.txt'), 'a --files b\n');
  const result = await executeTool(plan('search_code', { pattern: '--files' }), cwd);
  assert.equal(result.ok, true, result.result);
  assert.match(result.result, /1:a --files b/);
});

test('find and repo map do not expose external symlink targets', async t => {
  const { parent, cwd } = workspace(t);
  fs.writeFileSync(path.join(parent, 'secret.js'), 'function secretMarker() {}');
  fs.symlinkSync(path.join(parent, 'secret.js'), path.join(cwd, 'link.js'));
  const map = await executeTool(plan('get_repo_map'), cwd);
  assert.doesNotMatch(map.result, /secretMarker/);
  const files = await executeTool(plan('find_files', { pattern: '**/*' }), cwd);
  assert.doesNotMatch(files.result, /link.js/);
  assert.equal((await executeTool(plan('find_files', { pattern: '../*' }), cwd)).ok, false);
});

test('MIG blocks destructive shell commands, credential writes and constrained reads', async () => {
  assert.equal((await validate('run_command', { command: 'rm -rf output' })).decision, 'DENY');
  assert.equal((await validate('write_file', { path: 'key.js', content: 'gsk_' + 'a'.repeat(30) })).decision, 'DENY');
  assert.equal((await validate('read_file', { path: 'private.txt' }, 'do not read private')).decision, 'DENY');
  assert.equal((await validate('run_command', { command: 'node test.js' })).decision, 'APPROVAL');
});

test('agent continues beyond five calls and completes with real tool results', async t => {
  const { cwd } = workspace(t);
  const h = harness([...Array(7).fill(JSON.stringify(plan('list_files'))), 'Done.']);
  const result = await runAgentLoop(h.session, h.ui, cwd, h.options);
  assert.equal(result.status, 'completed');
  assert.equal(h.events.filter(e => e[0] === 'toolResult').length, 7);
});

test('governance runs for read tools and blocking stops without model retry', async t => {
  const { cwd } = workspace(t);
  const h = harness([JSON.stringify(plan('read_file', { path: 'private.txt' }))]);
  h.session.constraints = 'do not read private';
  const result = await runAgentLoop(h.session, h.ui, cwd, h.options);
  assert.equal(result.status, 'blocked');
  assert.equal(h.calls(), 1);
  assert.equal(h.events.some(e => e[0] === 'toolCall'), false);
});

test('user denial stops and never creates the file', async t => {
  const { cwd } = workspace(t);
  const h = harness([JSON.stringify(plan('write_file', { path: 'x', content: 'x' }))]);
  h.ui.approve = async () => false;
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'denied');
  assert.equal(fs.existsSync(path.join(cwd, 'x')), false);
  assert.equal(h.calls(), 1);
});

test('reasoning-only plans never execute', async t => {
  const { cwd } = workspace(t);
  const response = { choices: [{ message: { content: '', reasoning: JSON.stringify(plan('write_file', { path: 'x', content: 'x' })) } }] };
  const h = harness([response, response, response]);
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'invalid_response');
  assert.equal(fs.existsSync(path.join(cwd, 'x')), false);
});

test('repeated identical failures terminate the task', async t => {
  const { cwd } = workspace(t);
  const h = harness(Array(3).fill(JSON.stringify(plan('read_file', { path: 'missing' }))));
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'stalled');
  assert.equal(h.calls(), 3);
});

test('step exhaustion is explicit, resumable, and does not claim completion', async t => {
  const { cwd } = workspace(t);
  const h = harness([JSON.stringify(plan('list_files'))], { maxSteps: 1 });
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'limit');
  assert.ok(h.events.some(e => e[0] === 'notice' && e[1].includes('/continue')));
  assert.equal(h.events.some(e => e[0] === 'ai'), false);
});

test('cancelled model requests cannot execute their returned plan', async t => {
  const { cwd } = workspace(t);
  const controller = new AbortController();
  const h = harness([], { signal: controller.signal, callModel: async () => {
    controller.abort();
    return completion(JSON.stringify(plan('write_file', { path: 'x', content: 'x' })));
  } });
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(cwd, 'x')), false);
});

test('shell cancellation terminates a long running command promptly', { timeout: 5000 }, async t => {
  const { cwd } = workspace(t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timer));
  const result = await runCommand('node -e "setInterval(() => {}, 1000)"', cwd, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.match(result.result, /cancelled/);
});

test('context compaction keeps the objective, constraints and complete tool pairs', () => {
  const session = { objective: 'Original task sentinel', constraints: 'Do not install packages', messages: [{ role: 'system', content: 'System' }] };
  for (let i = 0; i < 60; i++) session.messages.push({ role: 'assistant', content: JSON.stringify(plan('list_files')) }, { role: 'user', content: 'Tool Result ' + 'x'.repeat(1000) });
  const messages = buildModelMessages(session, 8000);
  assert.match(messages[1].content, /Original task sentinel/);
  assert.match(messages[1].content, /Do not install packages/);
  assert.equal(messages[2].role, 'assistant');
  assert.ok(messages.reduce((n, m) => n + m.content.length, 0) <= 8000);
});

test('model retries transient errors and retains the successful fallback', async () => {
  const calls = [];
  const client = { chat: { completions: { create: async ({ model }) => {
    calls.push(model);
    if (model === 'bad') throw Object.assign(new Error('not found'), { status: 404 });
    if (calls.length === 2) throw Object.assign(new Error('busy'), { status: 429 });
    return completion('ok');
  } } } };
  const call = createModelCaller({ client, models: ['bad', 'good'], sleep: async () => {} });
  await call([]);
  await call([]);
  assert.deepEqual(calls, ['bad', 'good', 'good', 'good']);
});

test('authentication failures are not retried', async () => {
  let count = 0;
  const call = createModelCaller({ client: { chat: { completions: { create: async () => {
    count++;
    throw Object.assign(new Error('invalid key'), { status: 401 });
  } } } }, models: ['one', 'two'], sleep: async () => {} });
  await assert.rejects(call([]), /invalid key/);
  assert.equal(count, 1);
});

test('continuation cannot re-propose a denied action with reordered arguments', async t => {
  const { cwd } = workspace(t);
  const h = harness([
    JSON.stringify(plan('write_file', { path: 'x', content: 'x' })),
    JSON.stringify(plan('write_file', { content: 'x', path: 'x' })),
  ]);
  let approvals = 0;
  h.ui.approve = async () => { approvals++; return false; };
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'denied');
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'blocked');
  assert.equal(approvals, 1);
});

test('shell timeout and output overflow return explicit failures', { timeout: 5000 }, async t => {
  const { cwd } = workspace(t);
  const timed = await runCommand('node -e "setInterval(() => {}, 1000)"', cwd, { timeoutMs: 100 });
  assert.equal(timed.ok, false);
  assert.match(timed.result, /timed out/);
  const large = await runCommand('node -e "process.stdout.write(\'x\'.repeat(2000000))"', cwd);
  assert.equal(large.ok, false);
  assert.match(large.result, /output exceeded/);
});

test('blank new files remain available but empty generated-file writes are blocked', async () => {
  assert.equal((await validate('write_file', { path: '__init__.py', content: '' })).decision, 'APPROVAL');
  assert.equal((await validate('write_file', { path: 'dist/bundle.js', content: '' })).decision, 'DENY');
});

test('oversized active requests fail explicitly rather than exceeding the context budget', () => {
  assert.throws(() => buildModelMessages({ objective: 'x'.repeat(1000), messages: [{ role: 'system', content: 'system' }] }, 500), /context budget/);
});

test('CLI exits cleanly on EOF while waiting for input', { timeout: 5000 }, async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['cli/index.js'], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('▸')) child.stdin.end(); });
  child.stderr.on('data', chunk => { error += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  assert.equal(code, 0, error);
  assert.match(output, /session summary/);
  assert.doesNotMatch(error, /unsettled/);
});

test('provider requests advertise native tool schemas', async () => {
  let request;
  const call = createModelCaller({ client: { chat: { completions: { create: async input => {
    request = input;
    return completion('Done');
  } } } }, models: ['test'] });
  await call([]);
  assert.equal(request.tool_choice, 'auto');
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.tools.length, 10);
  assert.ok(request.tools.some(tool => tool.function.name === 'edit_file'));
});

test('native tool calls execute through normal approval and validation', async t => {
  const { cwd } = workspace(t);
  const h = harness([{ choices: [{ message: { content: null, tool_calls: [{
    id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'native.txt', content: 'native works' }) },
  }] } }] }, 'Done']);
  let approved = false;
  h.ui.approve = async () => { approved = true; return true; };
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'completed');
  assert.equal(approved, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'native.txt'), 'utf8'), 'native works');
});

test('native tool batches are rejected without executing any action', async t => {
  const { cwd } = workspace(t);
  const call = { type: 'function', function: { name: 'write_file', arguments: '{"path":"x","content":"x"}' } };
  const response = { choices: [{ message: { tool_calls: [call, call] } }] };
  const h = harness([response, response, response]);
  assert.equal((await runAgentLoop(h.session, h.ui, cwd, h.options)).status, 'invalid_response');
  assert.equal(fs.existsSync(path.join(cwd, 'x')), false);
});

test('workspace map includes docs/configs, symbols and expandable folders', async t => {
  const { cwd } = workspace(t);
  fs.mkdirSync(path.join(cwd, 'src/nested'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), 'Documentation');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
  fs.writeFileSync(path.join(cwd, 'src/nested/app.js'), "import fs from 'node:fs';\nexport function hello() {}\n");
  const root = await executeTool(plan('get_repo_map', { depth: 1 }), cwd);
  assert.equal(root.ok, true);
  assert.match(root.result, /README.md/);
  assert.match(root.result, /package.json/);
  assert.match(root.result, /src\/ …/);
  assert.doesNotMatch(root.result, /hello/);
  const expanded = await executeTool(plan('get_repo_map', { directory: 'src', depth: 3 }), cwd);
  assert.match(expanded.result, /hello/);
  assert.match(expanded.result, /node:fs/);
  assert.equal((await executeTool(plan('get_repo_map', { directory: '..' }), cwd)).ok, false);
  assert.equal((await executeTool(plan('get_repo_map', { depth: 9 }), cwd)).ok, false);
});

test('workspace map excludes generated files, env files and constrained paths', async t => {
  const { cwd } = workspace(t);
  for (const directory of ['private', 'node_modules', 'dist']) {
    fs.mkdirSync(path.join(cwd, directory));
    fs.writeFileSync(path.join(cwd, directory, 'hidden.js'), 'export function secretMarker() {}');
  }
  fs.writeFileSync(path.join(cwd, '.env'), 'TEST_SECRET=not-real');
  fs.writeFileSync(path.join(cwd, 'visible.js'), 'export function visible() {}');
  const result = await executeTool(plan('get_repo_map'), cwd, { constraints: 'do not read private' });
  assert.match(result.result, /visible/);
  assert.doesNotMatch(result.result, /private|node_modules|dist\/|\.env|secretMarker/);
});

test('large maps are bounded and explicitly partial', async t => {
  const { cwd } = workspace(t);
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(cwd, `file-${i}.js`), `export function function${i}() {}`);
  const result = await executeTool(plan('get_repo_map'), cwd);
  assert.equal(result.ok, true);
  assert.ok(result.result.length <= 8000);
  assert.match(result.result, /Partial map/);
});

test('automatic map reaches the first model call and refreshes on continuation', async t => {
  const { cwd } = workspace(t);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'test');
  const requests = [];
  const h = harness([], { callModel: async messages => { requests.push(messages); return completion('Done'); } });
  await runAgentLoop(h.session, h.ui, cwd, h.options);
  assert.ok(requests[0].some(m => m.content.includes('Workspace snapshot') && m.content.includes('README.md')));
  fs.writeFileSync(path.join(cwd, 'new-file.js'), 'export function added() {}');
  await runAgentLoop(h.session, h.ui, cwd, h.options);
  assert.ok(requests[1].some(m => m.content.includes('new-file.js')));
  assert.equal(requests[1].filter(m => m.content.startsWith('Workspace snapshot')).length, 1);
});

test('verification evidence flags checks made before later edits', async () => {
  const { createProgress, recordProgress, progressReport, progressChecklist } = await import('../cli/lib/progress.js');
  const progress = createProgress('Fix a bug');
  recordProgress(progress, plan('run_command', { command: 'npm test' }), { ok: true, result: 'passed' });
  recordProgress(progress, plan('edit_file', { path: 'app.js' }), { ok: true, result: 'edited' });
  assert.match(progressReport(progress), /before the latest file edit; rerun needed/);
  assert.match(progressChecklist(progress)[3], /^○/);
  recordProgress(progress, plan('git_diff'), { ok: true, result: 'diff' });
  assert.match(progressChecklist(progress)[3], /^✓/);
  recordProgress(progress, plan('run_command', { command: 'node script.js' }), { ok: true, result: 'ok' });
  assert.match(progressChecklist(progress)[3], /^○/);
});

test('failed edits are not recorded as changed files', async () => {
  const { createProgress, recordProgress, progressReport } = await import('../cli/lib/progress.js');
  const progress = createProgress('Fix a bug');
  recordProgress(progress, plan('edit_file', { path: 'app.js' }), { ok: false, result: 'match not found' });
  assert.equal(progress.files.size, 0);
  assert.equal(progress.failures.length, 1);
  assert.match(progressReport(progress), /Verification is not recorded/);
});

test('agent reports real evidence and preserves it across continuation', async t => {
  const { cwd } = workspace(t);
  const h = harness([JSON.stringify(plan('write_file', { path: 'x', content: 'x' })), 'Done', 'Continued']);
  const reports = [];
  h.ui.report = progress => reports.push({ status: progress.status, files: [...progress.files] });
  await runAgentLoop(h.session, h.ui, cwd, h.options);
  await runAgentLoop(h.session, h.ui, cwd, h.options);
  assert.deepEqual(reports, [{ status: 'completed', files: ['x'] }, { status: 'completed', files: ['x'] }]);
});

test('denied actions produce a report without recording the proposed file as changed', async t => {
  const { cwd } = workspace(t);
  const h = harness([JSON.stringify(plan('write_file', { path: 'denied', content: 'x' }))]);
  h.ui.approve = async () => false;
  let report;
  h.ui.report = value => { report = value; };
  await runAgentLoop(h.session, h.ui, cwd, h.options);
  assert.equal(report.status, 'denied');
  assert.equal(report.files.size, 0);
});

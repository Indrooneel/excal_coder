import { progressChecklist, progressReport } from './progress.js';
import { stripVTControlCharacters } from 'node:util';

// Render external text as text, never as terminal control sequences.
export const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export function createTerminalUI({ output, session, cwd, ask, model, maxSteps }) {
  const color = output.isTTY && !Object.hasOwn(process.env, 'NO_COLOR');
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const write = text => output.write(text + '\n');
  const width = () => Math.max(24, Math.min(output.columns || 88, 100));
  let previousChecklist = '';
  let thinking = false, toolStarted = 0, taskStarted = 0;
  const started = Date.now();
  const counts = { success: 0, failed: 0, approved: 0, denied: 0 };
  const elapsed = since => `${((Date.now() - since) / 1000).toFixed(1)}s`;
  const clear = () => {
    if (thinking && output.isTTY) output.write('\r\x1b[2K');
    thinking = false;
  };
  const wrap = text => clean(text).split('\n').flatMap(line => {
    const chars = Array.from(line.replace(/\t/g, '    '));
    const lines = [];
    do { lines.push(chars.splice(0, width() - 6).join('')); } while (chars.length);
    return lines;
  });
  const panel = (title, body, tone = 36) => {
    clear();
    write('');
    write(paint(tone, `╭─ ${clean(title)}`));
    write(paint(tone, `│ ${'─'.repeat(width() - 4)}`));
    for (const line of wrap(body)) write(paint(tone, '│ ') + line);
    write(paint(tone, `╰${'─'.repeat(width() - 2)}`));
  };
  const notice = text => { clear(); write(`  ${paint(36, '•')} ${clean(text)}`); };
  const help = () => panel('FLIGHT MANUAL', [
    'TASKS', '  Type a request in plain language to start.',
    '  /continue           Resume the current task',
    '  /report             Show evidence for the current task',
    '  Ctrl+C              Cancel a task; exit when idle', '',
    'WORKSPACE & OUTPUT', '  /map [folder]       Display the directory tree and code map',
    '  /diff               Show Git status and changes',
    '  /last               Show the full last tool result',
    '  /verbose            Toggle full tool output', '',
    'SESSION', '  /status             View model, limits and session counters',
    '  /constraints [text] View or replace guardrails; - clears them',
    '  /clear              Clear conversation; keep guardrails',
    '  clear               Redraw the welcome screen',
    '  /help               Show this guide', '  exit                End the session', '',
    'APPROVALS', '  y / yes = execute the displayed action',
    '  Enter / n = deny; completed edits remain on disk',
  ].join('\n'));
  const banner = () => {
    panel('🚀 EXCAL CODER  /  v0.4', [
      '       /\\', '      /  \\     READY FOR LIFTOFF', '      |  |     Your governed coding copilot',
      '     /|  |\\', '    /_|__|_\\   House of Galatine', '       /\\', '',
      `Workspace   ${cwd}`, `Model       ${model}`,
      `Step limit  ${maxSteps} per run · /continue to resume`,
      'Mapping     Automatic directory tree + code symbols',
      'MIG         Local rules · writes and commands need approval', '',
      'Try: Explain this project without changing any files.',
      '/help for commands  ·  /map to explore  ·  Ctrl+C to cancel',
    ].join('\n'));
    write('');
  };
  const status = () => panel('MISSION STATUS', [
    `Workspace       ${cwd}`, `Model setting   ${model}`, `Step limit      ${maxSteps}`,
    `Session time    ${elapsed(started)}`, `Tasks started   ${session.turnCount}`,
    `Tools executed  ${session.toolCallCount}`, `Tools succeeded ${counts.success}`,
    `Tool errors     ${counts.failed}`, `Approved        ${counts.approved}`,
    `Denied by you   ${counts.denied}`, `Blocked actions ${session.blockedCount}`,
    `Tool output     ${session.verbose ? 'full' : 'preview (8 lines)'}`,
    `Constraints     ${session.constraints || '(none)'}`,
  ].join('\n'));
  return {
    banner, help, status, panel, notice,
    progress: progress => {
      const checklist = progressChecklist(progress).join('\n');
      if (checklist !== previousChecklist) { panel('TASK CHECKLIST · OBSERVED ACTIVITY', checklist); previousChecklist = checklist; }
    },
    report: progress => panel('VERIFICATION SUMMARY · TOOL EVIDENCE', progressReport(progress)),
    prompt: () => paint(36, '  🚀 excal ▸ '),
    taskStart: objective => {
      taskStarted = Date.now();
      previousChecklist = '';
      panel(`MISSION ${String(session.turnCount).padStart(2, '0')}`, objective + '\n\nNext: inspect relevant files → edit if needed → run checks → inspect diff.');
    },
    taskEnd: result => {
      clear();
      const labels = { completed: 'Response received', limit: 'Paused at step limit',
        denied: 'Stopped · action denied', blocked: 'Stopped · action blocked',
        cancelled: 'Cancelled', stalled: 'Stopped · repeated failure',
        invalid_response: 'Stopped · invalid model response', error: 'Stopped · error' };
      write(`\n  ${paint(36, '◆')} ${labels[result?.status] || 'Run ended'} · ${elapsed(taskStarted)}${result?.steps ? ` · ${result.steps} model steps` : ''}`);
      write('');
    },
    thinking: ({ step, maxSteps: limit } = {}) => {
      clear();
      const text = `  ◌ Thinking${step ? ` · step ${step}/${limit}` : ''} · Ctrl+C to cancel`;
      if (output.isTTY) { output.write(paint(90, text)); thinking = true; }
      else write(text);
    },
    ai: text => panel('🚀 EXCAL · RESPONSE', text),
    toolCall: (tool, args) => {
      clear(); toolStarted = Date.now(); session.toolCallCount++;
      write(`\n  ${paint(34, '⚙')} ${paint(1, clean(tool))}  #${session.toolCallCount}`);
      for (const [key, value] of Object.entries(args)) {
        if (['content', 'old_string', 'new_string'].includes(key)) continue;
        for (const line of wrap(`${key}: ${value}`)) write(`    ${line}`);
      }
    },
    toolResult: result => {
      clear(); session.lastResult = clean(result.result);
      if (result.ok) counts.success++; else counts.failed++;
      write(`  ${paint(result.ok ? 32 : 31, result.ok ? '✓ Success' : '✗ Failed')}${toolStarted ? ` · ${elapsed(toolStarted)}` : ''}`);
      toolStarted = 0;
      const lines = session.lastResult.split('\n');
      const shown = session.verbose || !result.ok ? lines : lines.slice(0, 8);
      for (const line of wrap(shown.join('\n'))) write(`    ${line}`);
      if (shown.length < lines.length) write(paint(90, `    … ${lines.length - shown.length} more lines · /last for full output`));
    },
    verdict: verdict => {
      clear();
      if (verdict.decision === 'DENY') panel('MIG · BLOCKED', `Risk ${verdict.risk}/100\n${verdict.reason}`, 31);
    },
    blocked: reason => { session.blockedCount++; notice(`Action blocked: ${reason}`); },
    approve: async (plan, verdict, { signal, before } = {}) => {
      let preview = `Action  ${plan.tool}\nRisk    ${verdict.risk}/100\nReason  ${verdict.reason}\n`;
      if (plan.tool === 'run_command') preview += `\nWorkspace: ${cwd}\n\n$ ${plan.args.command}\n\nShell commands use your account permissions; no OS sandbox.`;
      else {
        preview += `File    ${plan.args.path}\n\n`;
        if (plan.tool === 'edit_file') {
          preview += plan.args.old_string.split('\n').map(line => `- ${line}`).join('\n') + '\n';
          preview += plan.args.new_string.split('\n').map(line => `+ ${line}`).join('\n');
        } else {
          if (before != null) preview += `--- CURRENT CONTENT\n${before}\n`;
          preview += `+++ PROPOSED CONTENT\n${plan.args.content}`;
        }
      }
      panel('🛡 APPROVAL REQUIRED', preview, 33);
      write('  Review the full action above. Enter defaults to deny.');
      const answer = await ask(paint(33, '  Execute? [y/N] ▸ '), { signal });
      const approved = answer !== null && /^y(es)?$/i.test(answer.trim());
      if (approved) counts.approved++; else counts.denied++;
      return approved;
    },
    goodbye: () => { status(); write('\n  🚀 session summary · Flight ended. Your completed changes are on disk.\n'); },
  };
}

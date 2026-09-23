// Evidence comes only from tool results. Model prose cannot complete a phase.
export function createProgress(objective) {
  return { objective, sequence: 0, inspected: new Set(), files: new Set(),
    lastEdit: 0, lastCommand: 0, diffAt: null, commands: [], failures: [], status: 'running' };
}

export function recordProgress(progress, plan, result) {
  const sequence = ++progress.sequence;
  if (!result.ok) progress.failures.push({ tool: plan.tool, message: String(result.result).slice(0, 300) });
  if (result.ok && ['read_file', 'list_files', 'search_code', 'find_files', 'get_project_info', 'get_repo_map'].includes(plan.tool)) {
    progress.inspected.add(plan.args.path || plan.args.directory || plan.tool);
  }
  if (result.ok && ['write_file', 'edit_file'].includes(plan.tool)) {
    progress.files.add(plan.args.path);
    progress.lastEdit = sequence;
  }
  if (plan.tool === 'run_command') {
    progress.lastCommand = sequence;
    progress.commands.push({ command: plan.args.command, ok: result.ok === true, sequence });
  }
  if (result.ok && plan.tool === 'git_diff') progress.diffAt = sequence;
}

export function progressChecklist(progress) {
  return [
    `${progress.inspected.size ? '✓' : '○'} Inspect workspace · ${progress.inspected.size} successful inspection targets`,
    `${progress.files.size ? '✓' : '○'} Apply file edits if needed · ${progress.files.size} files written by file tools`,
    `${progress.commands.length ? '✓' : '○'} Run checks · ${progress.commands.length} commands attempted (see outcomes below)`,
    `${progress.diffAt !== null && progress.diffAt > Math.max(progress.lastEdit, progress.lastCommand) ? '✓' : '○'} Inspect diff after the latest edit or command`,
  ];
}

export function progressReport(progress) {
  const lines = [`Run status: ${progress.status}`, '', ...progressChecklist(progress), '', 'Files written by file tools:'];
  lines.push(...(progress.files.size ? [...progress.files].map(file => `  ${file}`) : ['  None recorded.']));
  lines.push('', 'Command results (exit status, not proof of test coverage):');
  if (!progress.commands.length) lines.push('  No commands ran. Verification is not recorded.');
  for (const command of progress.commands) {
    lines.push(`  ${command.ok ? 'PASS' : 'FAIL'}  ${command.command}${command.sequence < progress.lastEdit ? ' [before the latest file edit; rerun needed]' : ''}`);
  }
  if (progress.failures.length) {
    lines.push('', `Tool failures encountered: ${progress.failures.length} (may have been recovered)`);
    for (const failure of progress.failures.slice(-5)) lines.push(`  ${failure.tool}: ${failure.message}`);
  }
  lines.push('', 'Shell commands may change additional files. Review /diff and actual test output.');
  if (progress.status !== 'completed') lines.push('This run stopped without a final model response; work may remain.');
  return lines.join('\n');
}

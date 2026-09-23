import { validatePlan } from './contracts.js';

// MIG v0.4 stub
// cli/lib/mig.js
// MIG interface — local deterministic stub.
// SWAP LATER: replace internals with the Python mig_governance bridge.
// Contract (MUST stay identical after swap):
//   suggestConstraints(prompt) -> string[]
//   validate(tool, args, constraints) -> { decision: 'ALLOW'|'DENY'|'APPROVAL', risk, reason }

const COMMAND_RULES = [
  { pattern: /\brm\b|\bdel\b|\berase\b|\brmdir\b|\bremove-item\b|\bunlink\b|\bshred\b|\bformat\b|\bmkfs\b|\bdd\s+if=/i, intent: 'destructive_filesystem', risk: 95, action: 'DENY' },
  { pattern: /curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh|iex\s*\(|invoke-expression/i,                 intent: 'remote_script_execution',  risk: 98, action: 'DENY' },
  { pattern: /shutdown|reboot|halt|poweroff/i,                                                          intent: 'system_shutdown',          risk: 99, action: 'DENY' },
  { pattern: /npm\s+install|pip\s+install|pip3\s+install|yarn\s+add|apt\s+install|apt-get\s+install|choco\s+install|winget\s+install/i, intent: 'install_dependency', risk: 60, action: 'APPROVAL' },
  { pattern: /git\s+push|git\s+reset\s+--hard|git\s+clean|git\s+checkout\s+\.|git\s+rebase/i,           intent: 'git_state_change',         risk: 70, action: 'APPROVAL' },
  { pattern: /pytest|npm\s+test|npm\s+run\s+test|python\s+-m\s+unittest|go\s+test|cargo\s+test/i,        intent: 'run_tests',                risk: 15, action: 'APPROVAL' },
  { pattern: /python\s|node\s|npm\s+run|npm\s+start|go\s+run|cargo\s+run|ts-node|tsx\s/i,               intent: 'run_script',               risk: 40, action: 'APPROVAL' },
];

const CONSTRAINT_INTENTS = [
  { keys: ['install', 'package', 'dependency', 'npm', 'pip', 'yarn', 'apt'], test: (c) => /npm\s+install|pip\s+install|yarn\s+add|apt\s+install/i.test(c) },
  { keys: ['delete', 'remove', 'rm', 'erase'],                                test: (c) => /rm\s|del\s|rmdir|remove-item/i.test(c) },
  { keys: ['network', 'internet', 'curl', 'wget', 'download', 'fetch'],       test: (c) => /curl|wget|http|fetch/i.test(c) },
  { keys: ['git', 'push', 'commit', 'rebase'],                                 test: (c) => /git\s+(push|commit|reset|rebase|clean)/i.test(c) },
  { keys: ['test', 'pytest', 'unittest'],                                      test: (c) => /pytest|npm\s+test|go\s+test|cargo\s+test/i.test(c) },
  { keys: ['run', 'execute', 'script', 'python', 'node', 'command'],           test: (c) => /python\s|node\s|npm\s+run|go\s+run|cargo\s+run/i.test(c) },
  { keys: ['git', 'diff', 'status', 'log'],                                    test: (c) => /git\s+(diff|status|log)/i.test(c) },
];

const LANG_EXTS = {
  python:     ['.py', '.pyw', '.pyi'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx'],
  go:         ['.go'],
  golang:     ['.go'],
  rust:       ['.rs'],
  java:       ['.java'],
  kotlin:     ['.kt', '.kts'],
  cpp:        ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
  'c++':      ['.cpp', '.cc', '.hpp'],
  c:          ['.c', '.h'],
  csharp:     ['.cs'],
  'c#':       ['.cs'],
  ruby:       ['.rb'],
  php:        ['.php'],
  swift:      ['.swift'],
  shell:      ['.sh', '.bash', '.zsh'],
  bash:       ['.sh', '.bash'],
  markdown:   ['.md', '.markdown'],
  json:       ['.json'],
  yaml:       ['.yml', '.yaml'],
  toml:       ['.toml'],
  xml:        ['.xml'],
  html:       ['.html', '.htm'],
  css:        ['.css', '.scss', '.sass', '.less'],
  sql:        ['.sql'],
  env:        ['.env'],
  dockerfile: ['dockerfile'],
};

const STOP = new Set([
  'do', 'not', 'dont', 'never', 'the', 'a', 'an', 'to', 'please', 'touch', 'modify', 'change',
  'edit', 'write', 'create', 'make', 'any', 'files', 'file', 'new', 'without', 'adding',
  'using', 'use', 'what', 'should', 'agent', 'absolutely', 'blank', 'plain', 'approve',
  'and', 'or', 'but', 'for', 'with', 'from', 'into', 'this', 'that', 'these', 'those',
  'also', 'just', 'only', 'even', 'help', 'want', 'need', 'would', 'could', 'like',
]);

function classifyCommand(cmd) {
  for (const r of COMMAND_RULES) if (r.pattern.test(cmd)) return r;
  return { intent: 'unknown_shell_command', risk: 85, action: 'APPROVAL' };
}

export async function suggestConstraints(prompt) {
  const p = (prompt || '').toLowerCase();
  const s = [];
  if (/python|\.py\b|script/.test(p))                              s.push('do not create any python files');
  if (/database|db|credential|password|secret|api.?key|token/.test(p)) s.push('do not write credentials or secrets to disk');
  if (/install|package|dependency|npm|pip|yarn/.test(p))           s.push('do not install any packages');
  if (/network|api|http|fetch|request|curl|wget/.test(p))          s.push('do not make network calls');
  if (/delete|remove|clean|wipe/.test(p))                          s.push('do not delete any files');
  if (/git|push|commit|rebase|reset/.test(p))                      s.push('do not modify git state');
  return s;
}

export async function validate(tool, args, constraints = '') {
  try { validatePlan({ tool, args }); } catch (err) { return { decision: 'DENY', risk: 90, reason: err.message }; }
  const c = (constraints || '').toLowerCase();
  const words = c.split(/[^a-z0-9_.+#-]+/).filter((w) => w.length > 2 && !STOP.has(w));

  // ── run_command: classify, then constraint-match ────────────
  if (tool === 'run_command') {
    const rule = classifyCommand(args.command || '');
    if (rule.action === 'DENY') {
      return { decision: 'DENY', risk: rule.risk, reason: `Deterministic DENY (${rule.intent})` };
    }
    const cmd = (args.command || '').toLowerCase();
    for (const ci of CONSTRAINT_INTENTS) {
      if (ci.keys.some((k) => c.includes(k)) && ci.test(cmd)) {
        return { decision: 'DENY', risk: rule.risk, reason: `Constraint matched intent (${rule.intent})` };
      }
    }
    return { decision: 'APPROVAL', risk: rule.risk, reason: `GATE (${rule.intent})` };
  }

  // ── write_file / edit_file: path + language + content ───────
  if (tool === 'write_file' || tool === 'edit_file') {
    const target = (args.path || '').toLowerCase();
    if (tool === 'write_file' && !args.content.trim() && /(?:^|[\\/])(?:build|dist|target|node_modules)(?:[\\/]|$)/i.test(target)) {
      return { decision: 'DENY', risk: 80, reason: 'Empty writes inside generated or dependency directories are blocked' };
    }
    const content = ((args.content || '') + ' ' + (args.new_string || '')).toLowerCase();

    for (const w of words) {
      if (target.includes(w)) {
        return { decision: 'DENY', risk: 80, reason: `Constraint violated: "${w}" in path` };
      }
      if (LANG_EXTS[w] && LANG_EXTS[w].some((ext) => target.endsWith(ext))) {
        return {
          decision: 'DENY',
          risk: 80,
          reason: `Constraint violated: "${w}" → ${target.split('.').pop()} file`,
        };
      }
      if (w.length >= 5 && content.includes(w)) {
        return { decision: 'DENY', risk: 80, reason: `Constraint violated: "${w}" in content` };
      }
    }

    // Built-in credential guard — independent of user constraints
    const credPattern = /(sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|nvapi-[a-z0-9_-]{20,}|gsk_[a-z0-9]{20,})/i;
    if (credPattern.test(content)) {
      return { decision: 'DENY', risk: 95, reason: 'Hardcoded credential pattern detected in content' };
    }

    return { decision: 'APPROVAL', risk: 40, reason: `GATE (${tool})` };
  }

  // ── read-only tools: ALLOW (still honour path constraints) ──
  if (['read_file', 'list_files', 'search_code', 'find_files', 'get_project_info', 'git_diff', 'get_repo_map'].includes(tool)) {
    const target = (args.path || args.directory || args.pattern || '').toLowerCase();
    for (const w of words) {
      if (w.length >= 4 && target.includes(w)) {
        return { decision: 'DENY', risk: 60, reason: `Constraint violated: "${w}" in target` };
      }
    }
    return { decision: 'ALLOW', risk: 5, reason: `ALLOW (${tool})` };
  }

  // ── unknown tool: fail-closed ──────────────────────────────
  return { decision: 'DENY', risk: 90, reason: `Unknown tool "${tool}" — fail-closed` };
}
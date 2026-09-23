import fs from 'fs';
import path from 'path';
import { resolveWorkspacePath } from './contracts.js';

const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
]);

const IGNORED = new Set(['node_modules', '.git', 'myenv', 'venv', '.venv',
  'dist', 'build', 'target', '__pycache__', '.next', 'coverage', '.cache']);
const MAX_CHARS = 8000;

const SYMBOL_PATTERNS = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
  /^(?:export\s+)?(?:default\s+)?class\s+(\w+)/,
  /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function/,
  /^\s*(?:async\s+)?def\s+(\w+)/,
  /^\s*class\s+(\w+)/,
  /^func\s+(?:\([^)]*\)\s+)?(\w+)/,
  /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  /^(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/,
  /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+(\w+)/,
];

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/,
  /^\s*from\s+([\w.]+)\s+import/,
  /^\s*import\s+([\w.]+)/,
  /^\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
];

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') ||
         (t.startsWith('#') && !t.startsWith('#!'));
}

function extractFileInfo(content) {
  const symbols = [];
  const imports = [];
  const lines = content.split('\n');

  for (const line of lines) {
    if (isComment(line)) continue;
    const trimmed = line.trim();

    for (const re of SYMBOL_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { symbols.push(m[1]); break; }
    }

    for (const re of IMPORT_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { imports.push(m[1]); break; }
    }
  }

  return {
    symbols: [...new Set(symbols)],
    imports: [...new Set(imports)],
  };
}

export async function buildRepoMap(cwd, options = {}) {
  const { directory = '.', depth = 3, allowPath = async () => true } = options;
  const base = resolveWorkspacePath(cwd, directory);
  const queue = [{ absolute: base, relative: '', level: 0 }];
  const entries = [];
  let truncated = false;
  // Bound enumeration as well as prompt size. Do not follow symlinks.
  while (queue.length && entries.length < 120) {
    const current = queue.shift();
    let handle;
    try {
      handle = await fs.promises.opendir(current.absolute);
      let examined = 0;
      for await (const entry of handle) {
        if (++examined > 500 || entries.length >= 120) { truncated = true; break; }
        if (IGNORED.has(entry.name) || entry.name.startsWith('.env') || entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const absolute = path.join(current.absolute, entry.name);
        const relative = path.join(current.relative, entry.name);
        const workspaceRelative = path.relative(cwd, absolute);
        try { resolveWorkspacePath(cwd, workspaceRelative); } catch { continue; }
        if (!(await allowPath(workspaceRelative))) continue;
        const isDir = entry.isDirectory();
        const clipped = isDir && current.level + 1 >= depth;
        entries.push({ absolute, relative, isDir, clipped });
        if (isDir && !clipped) queue.push({ absolute, relative, level: current.level + 1 });
        if (clipped) truncated = true;
      }
    } catch { /* unreadable or concurrently removed directory */ }
  }
  if (queue.length) truncated = true;
  entries.sort((a, b) => {
    const left = a.relative.split(path.sep), right = b.relative.split(path.sep);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const comparison = left[i].localeCompare(right[i]);
      if (comparison) return comparison;
    }
    return left.length - right.length;
  });
  const lines = [`[Workspace map: ${directory}]`, 'Directory tree (names only):'];
  for (const entry of entries) {
    const parts = entry.relative.split(path.sep);
    lines.push(`${'  '.repeat(parts.length - 1)}${parts.at(-1)}${entry.isDir ? '/' : ''}${entry.clipped ? ' …' : ''}`);
  }
  if (!entries.length) lines.push('(empty or excluded workspace)');
  lines.push('', 'Code symbols and imports (approximate; read files to confirm):');
  let bytes = 0, mapped = 0;
  for (const entry of entries.filter(e => !e.isDir && CODE_EXTS.has(path.extname(e.relative)))) {
    if (mapped >= 40 || bytes >= 2_000_000) { truncated = true; break; }
    try {
      resolveWorkspacePath(cwd, path.relative(cwd, entry.absolute));
      if (fs.lstatSync(entry.absolute).isSymbolicLink()) continue;
      const size = fs.statSync(entry.absolute).size;
      if (size > 500_000 || bytes + size > 2_000_000) { truncated = true; continue; }
      const { symbols, imports } = extractFileInfo(fs.readFileSync(entry.absolute, 'utf8'));
      bytes += size;
      mapped++;
      lines.push(entry.relative);
      if (symbols.length) lines.push(`  symbols: ${symbols.slice(0, 8).join(', ')}`);
      if (imports.length) lines.push(`  imports: ${imports.slice(0, 5).join(', ')}`);
    } catch { /* unreadable files */ }
  }
  if (!mapped) lines.push('(no readable code files in this view)');
  let result = lines.join('\n');
  if (result.length > MAX_CHARS - 240) { result = result.slice(0, MAX_CHARS - 240); truncated = true; }
  return result + `\n\n${truncated ? '[Partial map: depth, entry, byte or output limit reached.] ' : ''}Use get_repo_map(directory, depth) to explore a folder. This snapshot may become stale after edits.`;
}

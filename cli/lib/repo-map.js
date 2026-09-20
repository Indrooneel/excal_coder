import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
]);

const IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/myenv/**', '**/venv/**',
  '**/.venv/**', '**/dist/**', '**/build/**', '**/__pycache__/**',
  '**/.next/**', '**/coverage/**',
];

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

export async function buildRepoMap(cwd, maxFiles = 60) {
  const files = await fg('**/*', {
    cwd,
    ignore: IGNORE,
    onlyFiles: true,
    dot: false,
    deep: 8,
  });

  const codeFiles = files.filter((f) =>
    CODE_EXTS.has(path.extname(f).toLowerCase())
  );

  if (codeFiles.length === 0) return '(no code files found)';

  // Shallow paths first — top-level files matter more than deep ones
  codeFiles.sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  const selected = codeFiles.slice(0, maxFiles);
  const out = [];

  for (const file of selected) {
    try {
      const content = fs.readFileSync(path.join(cwd, file), 'utf-8');
      const { symbols, imports } = extractFileInfo(content);

      out.push(file);
      if (symbols.length) {
        const shown = symbols.slice(0, 8).join(', ');
        const more = symbols.length > 8 ? ` +${symbols.length - 8}` : '';
        out.push(`  ⚙ ${shown}${more}`);
      }
      if (imports.length) {
        const shown = imports.slice(0, 5).join(', ');
        const more = imports.length > 5 ? ` +${imports.length - 5}` : '';
        out.push(`  → ${shown}${more}`);
      }
      out.push('');
    } catch {
      // skip unreadable files
    }
  }

  const header = `[Repo Map — ${selected.length}/${codeFiles.length} code files]`;
  return `${header}\n\n${out.join('\n')}`;
}
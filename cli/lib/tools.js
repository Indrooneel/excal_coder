// cli/lib/tools.js
import fs from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fg from 'fast-glob';
import { buildRepoMap } from './repo-map.js';

const execP = promisify(exec);
const execFileP = promisify(execFile);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'myenv', 'venv', '.venv',
  'dist', 'build', '.next', '.cache', 'coverage', '.pytest_cache',
]);

export function runCommand(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let out = (stdout || '') + (stderr ? '\n[stderr]\n' + stderr : '');
      if (out.length > 6000) out = out.slice(0, 6000) + '\n...[truncated]';
      if (err?.code === 'ETIMEDOUT') out += '\n[timed out after 30s]';
      resolve({ ok: !err, result: out || '(no output)' });
    });
  });
}

async function searchCode(args, cwd) {
  const pattern = args.pattern;
  if (!pattern) return { ok: false, result: 'search_code: missing pattern' };
  const dir = path.resolve(cwd, args.directory || '.');
  const glob = args.glob || undefined;

  try {
    const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '50'];
    if (glob) rgArgs.push('-g', glob);
    rgArgs.push(pattern, dir);
    const { stdout } = await execFileP('rg', rgArgs, { maxBuffer: 1024 * 1024 });
    return { ok: true, result: stdout.slice(0, 4000) || '(no matches)' };
  } catch (e) {
    if (e.code === 1) return { ok: true, result: '(no matches)' };
    if (e.code === 'ENOENT' || /not recognized|not found/i.test(e.message)) {
      return { ok: false, result: 'ripgrep (rg) not installed. Run: winget install BurntSushi.ripgrep.MSVC' };
    }
    return { ok: false, result: `search failed: ${e.message}` };
  }
}

async function findFiles(args, cwd) {
  const pattern = args.pattern || '**/*';
  const dir = path.resolve(cwd, args.directory || '.');
  try {
    const files = await fg(pattern, {
      cwd: dir,
      ignore: [
        '**/node_modules/**', '**/.git/**', '**/myenv/**', '**/venv/**',
        '**/.venv/**', '**/dist/**', '**/build/**', '**/__pycache__/**',
      ],
      onlyFiles: true,
      dot: false,
      deep: 8,
      followSymbolicLinks: false,
    });
    return { ok: true, result: files.slice(0, 300).join('\n') || '(no matches)' };
  } catch (e) {
    return { ok: false, result: `find_files failed: ${e.message}` };
  }
}

function getProjectInfo(cwd) {
  const info = {};

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      info.node = {
        name: pkg.name,
        version: pkg.version,
        type: pkg.type || 'commonjs',
        scripts: pkg.scripts || {},
        deps: Object.keys(pkg.dependencies || {}),
        devDeps: Object.keys(pkg.devDependencies || {}),
      };
    } catch {
      info.node = 'package.json (parse error)';
    }
  }

  const pyFiles = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'poetry.lock'];
  const found = pyFiles.filter((f) => fs.existsSync(path.join(cwd, f)));
  if (found.length) info.python = { files: found };

  if (fs.existsSync(path.join(cwd, 'go.mod'))) info.go = 'go.mod';
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) info.rust = 'Cargo.toml';
  if (fs.existsSync(path.join(cwd, 'pom.xml'))) info.java = 'pom.xml';
  if (fs.existsSync(path.join(cwd, 'build.gradle'))) info.java = 'build.gradle';
  if (fs.existsSync(path.join(cwd, '.git'))) info.git = true;

  const testDirs = ['tests', 'test', '__tests__', 'spec'];
  const foundTests = testDirs.filter((d) => fs.existsSync(path.join(cwd, d)));
  if (foundTests.length) info.testDirs = foundTests;

  const docs = ['README.md', 'README', 'LICENSE', 'LICENSE.md'].filter((f) =>
    fs.existsSync(path.join(cwd, f))
  );
  if (docs.length) info.docs = docs;

  if (Object.keys(info).length === 0) {
    return { ok: true, result: '(no recognised project files)' };
  }
  return { ok: true, result: JSON.stringify(info, null, 2) };
}

async function gitDiff(cwd) {
  try {
    const { stdout: status } = await execFileP('git', ['status', '--short'], { cwd, maxBuffer: 1024 * 512 });
    const { stdout: stat } = await execFileP('git', ['diff', '--stat'], { cwd, maxBuffer: 1024 * 512 });
    const { stdout: diff } = await execFileP('git', ['diff'], { cwd, maxBuffer: 1024 * 1024 });

    let out = '';
    if (status.trim()) out += `STATUS:\n${status}\n`;
    if (stat.trim()) out += `STAT:\n${stat}\n`;
    if (diff.trim()) out += `DIFF:\n${diff.slice(0, 4000)}`;
    return { ok: true, result: out || '(no changes)' };
  } catch (e) {
    if (/not a git repo/i.test(e.message)) return { ok: false, result: 'not a git repository' };
    if (e.code === 'ENOENT') return { ok: false, result: 'git not installed' };
    return { ok: false, result: `git diff failed: ${e.message}` };
  }
}

export async function executeTool(plan, cwd) {
  const { tool, args } = plan;
  try {
    // ── write_file ─────────────────────────────────────────────
    if (tool === 'write_file') {
      const filePath = path.resolve(cwd, args.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content, 'utf-8');
      return {
        ok: true,
        result: `Wrote ${args.path} (${args.content.length} chars)`,
        file: args.path,
        content: args.content,
      };
    }

    // ── edit_file (patch one unique block) ─────────────────────
    if (tool === 'edit_file') {
      const filePath = path.resolve(cwd, args.path);
      if (!fs.existsSync(filePath)) return { ok: false, result: `File not found: ${args.path}` };

      const original = fs.readFileSync(filePath, 'utf-8');
      const norm = (s) => s.replace(/\r\n/g, '\n');
      const origNorm = norm(original);
      const oldNorm = norm(args.old_string || '');
      const newNorm = norm(args.new_string || '');

      if (!oldNorm) return { ok: false, result: 'edit_file: empty old_string' };

      const occurrences = origNorm.split(oldNorm).length - 1;
      if (occurrences === 0) {
        return { ok: false, result: `old_string not found in ${args.path}. Read the file first to get exact text.` };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          result: `old_string matches ${occurrences} times in ${args.path}. Add more surrounding context to make it unique.`,
        };
      }

      const updated = origNorm.replace(oldNorm, newNorm);
      fs.writeFileSync(filePath, updated, 'utf-8');

      const oldHead = (args.old_string || '').split('\n')[0].slice(0, 100);
      const newHead = (args.new_string || '').split('\n')[0].slice(0, 100);
      const preview = `--- ${args.path}\n- ${oldHead}\n+ ${newHead}`;

      return { ok: true, result: preview, file: args.path, content: updated };
    }

    // ── read_file (with optional line range) ───────────────────
    if (tool === 'read_file') {
      const filePath = path.resolve(cwd, args.path);
      if (!fs.existsSync(filePath)) return { ok: false, result: `File not found: ${args.path}` };

      const stat = fs.statSync(filePath);
      if (stat.size > 500_000) {
        return {
          ok: false,
          result: `File too large (${Math.round(stat.size / 1024)}KB). Use start_line/end_line.`,
        };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = args.start_line ? Math.max(0, args.start_line - 1) : 0;
      const end = args.end_line ? Math.min(lines.length, args.end_line) : Math.min(lines.length, 300);
      const slice = lines.slice(start, end).join('\n');
      const header = `[${args.path} lines ${start + 1}-${end} of ${lines.length}]`;
      return { ok: true, result: `${header}\n${slice}`, file: args.path, content };
    }

    // ── list_files ─────────────────────────────────────────────
    if (tool === 'list_files') {
      const dir = path.resolve(cwd, args.directory || '.');
      if (!fs.existsSync(dir)) return { ok: false, result: `Directory not found: ${args.directory}` };

      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.') && !IGNORED_DIRS.has(d.name));

      const formatted = entries.map((d) => (d.isDirectory() ? `📁 ${d.name}/` : `📄 ${d.name}`));
      return { ok: true, result: formatted.join('\n') || '(empty)' };
    }

    // ── read-only helpers ──────────────────────────────────────
    if (tool === 'search_code') return await searchCode(args, cwd);
    if (tool === 'find_files') return await findFiles(args, cwd);
    if (tool === 'get_project_info') return getProjectInfo(cwd);
    if (tool === 'git_diff') return await gitDiff(cwd);
    if (tool === 'get_repo_map') {
      const map = await buildRepoMap(cwd);
      return { ok: true, result: map };
    }

    // ── run_command ────────────────────────────────────────────
    if (tool === 'run_command') return await runCommand(args.command, cwd);

    return { ok: false, result: `Unknown tool: ${tool}` };
  } catch (e) {
    return { ok: false, result: `Error: ${e.message}` };
  }
}
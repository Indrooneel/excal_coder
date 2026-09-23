import fs from 'node:fs';
import path from 'node:path';

const schemas = {
  write_file: { required: ['path', 'content'], strings: ['path', 'content'] },
  edit_file: { required: ['path', 'old_string', 'new_string'], strings: ['path', 'old_string', 'new_string'] },
  read_file: { required: ['path'], strings: ['path'], integers: ['start_line', 'end_line'] },
  list_files: { strings: ['directory'] },
  search_code: { required: ['pattern'], strings: ['pattern', 'glob', 'directory'] },
  find_files: { required: ['pattern'], strings: ['pattern', 'directory'] },
  get_project_info: {}, get_repo_map: { strings: ['directory'], integers: ['depth'] }, git_diff: {},
  run_command: { required: ['command'], strings: ['command'] },
};
export const KNOWN_TOOLS = Object.freeze(Object.keys(schemas));


export const TOOL_DEFINITIONS = Object.entries(schemas).map(([name, schema]) => ({
  type: 'function',
  function: {
    name,
    description: `Use ${name} as described in the system instructions.`,
    parameters: {
      type: 'object',
      properties: Object.fromEntries([
        ...(schema.strings || []).map(key => [key, { type: 'string' }]),
        ...(schema.integers || []).map(key => [key, { type: 'integer', minimum: 1 }]),
      ]),
      required: schema.required || [],
      additionalProperties: false,
    },
  },
}));

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Tool plan must be an object');
  const schema = Object.hasOwn(schemas, plan.tool) ? schemas[plan.tool] : null;
  if (!schema) throw new Error(`Unknown tool: ${String(plan.tool)}`);
  const args = plan.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool args must be an object');
  const strings = schema.strings || [];
  const integers = schema.integers || [];
  for (const key of Object.keys(args)) {
    if (![...strings, ...integers].includes(key)) throw new Error(`Unexpected argument: ${key}`);
    if (strings.includes(key) && typeof args[key] !== 'string') throw new Error(`${key} must be a string`);
    if (integers.includes(key) && (!Number.isSafeInteger(args[key]) || args[key] < 1)) throw new Error(`${key} must be a positive integer`);
  }
  for (const key of schema.required || []) {
    if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}`);
  }
  for (const key of ['path', 'directory', 'pattern', 'command', 'old_string']) {
    if (Object.hasOwn(args, key) && (!args[key].trim() || args[key].includes('\0'))) throw new Error(`${key} must be nonempty and contain no NUL bytes`);
  }
  if (args.depth && args.depth > 8) throw new Error('depth must be between 1 and 8');
  if (args.start_line && args.end_line && args.start_line > args.end_line) throw new Error('start_line must not exceed end_line');
  if (['content', 'new_string'].some(key => args[key]?.length > 1_000_000)) throw new Error('File change exceeds 1 MB limit');
  return plan;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(cwd, target = '.', { write = false } = {}) {
  const root = fs.realpathSync(cwd);
  const resolved = path.resolve(root, target);
  if (!inside(root, resolved)) throw new Error('Path escapes the workspace');
  const parts = path.relative(root, resolved).split(path.sep);
  if (parts.includes('.git')) throw new Error('Direct access to .git is blocked; use Git tools');
  let cursor = root;
  for (const part of parts.filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      const real = fs.realpathSync(cursor);
      if (!inside(root, real)) throw new Error('Symlink escapes the workspace');
      if (path.relative(root, real).split(path.sep).includes('.git')) throw new Error('Symlink targets protected .git data');
      if (write && stat.isSymbolicLink()) throw new Error('Writing through symlinks is blocked');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return resolved;
}

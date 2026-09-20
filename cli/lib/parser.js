const KNOWN_TOOLS = [
  'write_file', 'edit_file', 'read_file', 'list_files',
  'search_code', 'find_files', 'get_project_info', 'git_diff',
  'get_repo_map',
  'run_command',
];

function parseKwargs(str) {
  const args = {};
  const re = /(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^,)\]]*))/g;
  let m;
  while ((m = re.exec(str))) {
    const v = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (m[1]) args[m[1]] = v;
  }
  return args;
}

function scanFirstJson(str) {
  if (!str || !str.startsWith('{')) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { const o = JSON.parse(str.slice(0, i + 1)); o._end = i + 1; return o; }
        catch { return null; }
      }
    }
  }
  return null;
}

function tryJson(text) {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('{')) {
    const o = scanFirstJson(t);
    if (o && KNOWN_TOOLS.includes(o.tool)) return { tool: o.tool, args: o.args || {}, dialect: 'json' };
  }
  const s = text.indexOf('{');
  if (s === -1) return null;
  const o = scanFirstJson(text.slice(s));
  if (o && KNOWN_TOOLS.includes(o.tool)) return { tool: o.tool, args: o.args || {}, dialect: 'json-embedded' };
  return null;
}

function tryPhi(text) {
  const m = text.match(/<\|tool_call_start\|>\s*\[?\s*(\w+)\s*\(([^)]*)\)\s*\]?\s*<\|tool_call_end\|>/s);
  if (!m || !KNOWN_TOOLS.includes(m[1])) return null;
  return { tool: m[1], args: parseKwargs(m[2]), dialect: 'phi' };
}

function tryXml(text) {
  const nm = text.match(/<tool_?name>\s*([\w_]+)\s*<\/tool_?name>/i);
  if (nm && KNOWN_TOOLS.includes(nm[1].trim())) {
    const keys = [...text.matchAll(/<arg_?key>\s*([\s\S]*?)\s*<\/arg_?key>/gi)].map(x => x[1].trim());
    const vals = [...text.matchAll(/<arg_?value>\s*([\s\S]*?)\s*<\/arg_?value>/gi)].map(x => x[1].trim());
    const args = {};
    keys.forEach((k, i) => { if (vals[i] !== undefined) args[k] = vals[i]; });
    return { tool: nm[1].trim(), args, dialect: 'xml' };
  }
  return null;
}

function tryBare(text) {
  const m = text.match(/(?:^|\n)\s*(\w+)\s*\(([^)]*)\)\s*(?:\n|$)/);
  if (!m || !KNOWN_TOOLS.includes(m[1])) return null;
  return { tool: m[1], args: parseKwargs(m[2]), dialect: 'bare' };
}

export function normalizeToolCall(text) {
  if (!text || typeof text !== 'string') return null;
  return tryJson(text) || tryXml(text) || tryPhi(text) || tryBare(text);
}
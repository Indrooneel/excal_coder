import { validatePlan } from './contracts.js';

// Only a complete, single JSON plan is executable. Prose, multiple objects,
// simulated results, and reasoning are never scanned for executable fragments.
export function normalizeToolCall(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let input = text.trim();
  const fence = input.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) input = fence[1].trim();
  try {
    const parsed = JSON.parse(input);
    if (Object.keys(parsed).some(key => !['tool', 'args'].includes(key))) return null;
    validatePlan(parsed);
    return { tool: parsed.tool, args: parsed.args };
  } catch { return null; }
}

export function looksLikeToolCall(text) {
  return typeof text === 'string' && /"tool"\s*:|<\/?tool|<\|tool_call|^\s*(?:write_file|edit_file|read_file|list_files|run_command|search_code|find_files|get_project_info|get_repo_map|git_diff)\s*\(/m.test(text);
}

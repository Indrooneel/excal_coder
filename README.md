# Excal Coder CLI

Excal Coder is a local coding agent using Groq's OpenAI-compatible API. It reads a workspace, proposes edits and commands, checks them through MIG, and asks for approval before changing files or running commands.

## Run

Use Node.js 18 or later and install ripgrep (`rg`) for code search. Install dependencies with `npm install`.

Set `GROQ_API_KEY` in your environment or in `.env` beside this README. An exported environment variable takes precedence. Do not commit credentials.

From this project:

```sh
npm run cli
```

To work on another repository, change into that repository and run the absolute path to `cli/index.js`, or install the `excal` command with `npm link` first. The working directory is the file-tool workspace.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXCAL_MODEL` | `openai/gpt-oss-120b` with two fallbacks | Pin a specific Groq model; availability depends on your account/provider. |
| `EXCAL_MAX_STEPS` | `30` | Model calls per invocation, from 1 to 200. `/continue` resumes after the limit. |

## Commands

| Command | Behavior |
| --- | --- |
| `/help` | Show commands. |
| `/constraints text` | Replace the active constraints. |
| `/constraints` | Show active constraints. |
| `/constraints -` | Clear constraints. |
| `/diff` | Show Git status and a bounded diff. |
| `/continue` | Resume the current task with its objective preserved. |
| `/clear` | Reset conversation and task state, keeping constraints. |
| `clear` | Clear the terminal display. |
| `exit`, `quit`, `:q` | Exit. |
| Ctrl+C | Cancel an active task, or exit at the idle prompt. |

Constraints persist within the running CLI session. Suggested guardrails are examples: enter the desired text, leave blank to keep current constraints, or enter `-` to clear them. Sessions are not saved across restarts.

## Agent behavior

The CLI exposes ten tools: file reads, writes and exact edits; directory listing; code search; glob search; project information; repository mapping; Git diff; and shell execution.

Native API tool calls are enabled and pass through the same parser and governance checks. Multiple native calls in one response are rejected. As a text fallback, only a complete, single JSON tool plan (optionally inside one JSON fence) is executable. Embedded fragments, multiple plans, simulated tool results, and reasoning-stream plans are not executed. Invalid responses are retried at most twice before stopping. Tool arguments are validated before dispatch.

All tools pass through MIG. Denials stop the loop immediately. The same rejected action stays blocked when continuing the current task; starting a new user task resets that record. Repeated identical failures stop after three attempts. Rate limits, server failures and connection failures have bounded retries; authentication errors are reported immediately.

The active task and constraints are preserved separately from bounded recent conversation history. Older exchanges can be discarded; the agent is instructed to re-read files rather than invent missing context. Step limits produce an explicit pause instead of silently ending.

## File and command safety

File tools reject paths outside the workspace and direct access to `.git`, including external symlink targets. Writes through symlinks are blocked. New files and edits use temporary files followed by rename. Existing permissions are retained; exact edits preserve CRLF line endings and write dollar sequences literally. Existing files over 1 MB are not edited.

Approval shows the complete command or proposed file change. Before executing a file change, the tool checks that the destination contents still match the snapshot taken for approval. If another editor changed the file, the agent must read it and propose again. Cancellation leaves already completed changes on disk.

**MIG is a deterministic policy and approval layer, not an operating-system sandbox.** Approved shell commands have your account's filesystem and network access and can operate outside the workspace. Regex and keyword constraints do not understand every equivalent program or command. POSIX commands run in a separate process group so ordinary descendants can be stopped on cancellation, timeout or excessive output; Windows uses `taskkill /T /F`. Processes that deliberately detach are outside this guarantee.

The agent is prompted to run relevant checks and inspect its diff, but a model's final answer is not independent proof that a task is correct. Review the actual tool results and changes. There is no automatic rollback or crash-persistent task recovery yet.

## Validation

```sh
npm test
```

Tests use temporary workspaces, mocked model responses, and real local tool execution. They cover parser ambiguity, tool schemas, traversal and symlinks, literal edits, CRLF/modes, stale approvals, constraints, denial, continuation limits, context retention, subprocess cancellation and model retries. They make no provider API requests.

The web implementation in `web/server.js` and `frontend/` is separate; this CLI hardening does not update its agent or governance behavior.

## Automatic workspace mapping

Before the first model request of every task (including `/continue`), the CLI loads a fresh workspace tree and code-symbol map. It is retained separately from trimmed conversation history and labeled as untrusted repository data. No additional model call is needed to generate it.

The tree includes document and configuration filenames as well as source files. It skips dependency/build directories, `.git`, `.env*` files and symlinks. Code symbols and imports are approximate regex extraction, not full semantic analysis. MIG path constraints filter entries before their contents are read.

Maps are bounded to 120 entries, 40 code files, 2 MB of code input and 8,000 output characters. Each directory scan examines at most 500 entries. Default tree depth is 3; the model can call `get_repo_map({directory: "src", depth: 5})` to explore a specific folder (maximum depth 8). Partial maps are marked, and may become stale after edits; explicit map calls refresh the requested view. Enumeration follows filesystem order before sorting the selected view, so a capped map is not an exhaustive inventory.

## Terminal interface

The rocket welcome screen shows the workspace, configured model, step limit and governance mode. Task runs display model-step progress, tool execution time, success/error results, and elapsed time. Approval panels retain the full proposed edit or command and default to denial.

Use `/status` for session counters, `/map [folder]` to inspect a workspace map, `/last` for the last tool's complete returned output, and `/verbose` to toggle full tool output instead of the default eight-line preview. Tool-level output limits still apply. `/help` displays the flight manual. Colors are disabled for redirected output or when `NO_COLOR` is set.

## Task checklist and verification evidence

Each task starts with the inspect/edit/check/diff workflow. The activity checklist updates from actual tool results, not model claims. The final verification summary records file-tool writes, command exit outcomes, failed tool attempts and whether a successful diff inspection followed the latest edit or command. `/report` reopens the summary; `/continue` keeps its evidence, while a new task or `/clear` resets it.

A command exiting successfully does not establish test coverage. Commands executed before a later file edit are marked as needing a rerun. Shell-created or modified files are not individually tracked by this summary; inspect the diff and command output. Read-only tasks can finish without edit or verification steps being checked off.

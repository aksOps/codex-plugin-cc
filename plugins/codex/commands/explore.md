---
description: Ask Codex to investigate or trace a root cause without changing any files
argument-hint: "[--background|--wait] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-explore` subagent via the `Agent` tool
(`subagent_type: "codex:codex-explore"`), forwarding the raw user request as the prompt.

Raw user request:

$ARGUMENTS

Execution mode:

- `--background` runs the subagent in the background; `--wait` runs it in the foreground.
- With neither flag, default to foreground for a narrow question and background for a broad
  investigation.
- Execution flags are for Claude Code. Do not forward them to `task` or treat them as part of
  the task text.

Operating rules:

- The subagent makes one `Bash` call to
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --agent explore ...` and
  returns that command's stdout as-is.
- Return the Codex companion stdout verbatim.
- This command is read-only. It creates no worktree and changes no files. If the user wants
  the fix applied, use `/codex:implement`.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to
  run `/codex:setup`.

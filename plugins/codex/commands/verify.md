---
description: Ask Codex to check whether a change holds up, read-only
argument-hint: "[--background|--wait] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should verify]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-verify` subagent via the `Agent` tool
(`subagent_type: "codex:codex-verify"`), forwarding the raw user request as the prompt.

Raw user request:

$ARGUMENTS

Execution mode:

- `--background` runs the subagent in the background; `--wait` runs it in the foreground.
- With neither flag, default to foreground.
- Execution flags are for Claude Code. Do not forward them to `task` or treat them as part of
  the task text.

Operating rules:

- The subagent makes one `Bash` call to
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --agent verify ...` and
  returns that command's stdout as-is.
- Return the Codex companion stdout verbatim.
- This is a judgment pass, not the gate. The gate is the policy's declared verification
  commands and their exit codes, which run automatically after a write job. A positive opinion
  here never unblocks a job whose required checks failed.
- This command is read-only and changes no files.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to
  run `/codex:setup`.

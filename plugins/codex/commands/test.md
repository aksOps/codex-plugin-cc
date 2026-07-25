---
description: Hand test writing or test repair to Codex, restricted by policy to test paths
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should test or fix]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-test` subagent via the `Agent` tool
(`subagent_type: "codex:codex-test"`), forwarding the raw user request as the prompt.

Raw user request:

$ARGUMENTS

Execution mode:

- `--background` runs the subagent in the background; `--wait` runs it in the foreground.
- With neither flag, default to foreground for a single test and background for a suite-wide
  change.
- Execution flags are for Claude Code. Do not forward them to `task` or treat them as part of
  the task text.

Operating rules:

- The subagent makes one `Bash` call to
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write --agent test ...` and
  returns that command's stdout as-is.
- Return the Codex companion stdout verbatim.
- The `test` agent's writable globs are typically restricted to test paths. If the run reports
  refused changes, relay that verbatim: it means Codex tried to edit production code, which is
  the policy working. Use `/codex:implement` when production code genuinely must change.
- If the helper reports that write execution is denied, relay the reason. Do not edit files
  yourself as a fallback.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to
  run `/codex:setup`.

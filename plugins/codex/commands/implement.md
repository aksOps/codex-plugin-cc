---
description: Hand an implementation or fix to Codex, which works in an isolated worktree and returns a reviewable diff
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should build or fix]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-implement` subagent via the `Agent` tool
(`subagent_type: "codex:codex-implement"`), forwarding the raw user request as the prompt.

`codex:codex-implement` is a subagent, not a skill — do not call `Skill(codex:implement)`,
which would re-enter this command and hang the session. The command runs inline so the
`Agent` tool stays in scope.

Raw user request:

$ARGUMENTS

Execution mode:

- `--background` runs the subagent in the background; `--wait` runs it in the foreground.
- With neither flag, default to foreground.
- `--background` and `--wait` are Claude Code execution flags. Do not forward them to `task`
  and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded
  `task` call but keep them out of the task text.

Operating rules:

- The subagent is a thin forwarder. It makes one `Bash` call to
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write --agent implement ...`
  and returns that command's stdout as-is.
- Return the Codex companion stdout verbatim. Do not paraphrase, summarize, or add commentary.
- Do not ask the subagent to inspect files, poll `/codex:status`, fetch `/codex:result`, or do
  follow-up work.
- The run needs `.codex-plugin/policy.json` to declare the `implement` agent as write-capable.
  If the helper reports that write execution is denied, relay the reason; do not try to work
  around it or fall back to editing files yourself.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to
  run `/codex:setup`.
- If the user did not supply a request, ask what Codex should build or fix.

After the run:

- Point the user at `/codex:diff` to review the produced diff.
- Never run `git fetch` or `git cherry-pick` on the user's behalf. Landing is `/codex:land`,
  or it happens automatically when the host permission mode already authorizes it.

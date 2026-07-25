---
description: Show the diff a write-capable Codex job produced in its isolated worktree
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Show the recorded diff for a Codex job. With no job id, the latest finished job is used.

Raw slash-command arguments:

`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" diff "$ARGUMENTS"
```

Return that command's stdout verbatim.

Operating rules:

- This command is read-only. It renders what is already recorded; it does not re-run Codex.
- The output ends with the exact `git fetch` and `git cherry-pick` commands needed to land the
  change. **Do not run them.** Presenting them is the point: the user decides. Use
  `/codex:land` if the user asks you to apply it.
- If the job already landed, the output says so instead of printing the commands again.
- If the job produced refused changes, relay them verbatim. Refused changes are never
  committed and cannot be landed.

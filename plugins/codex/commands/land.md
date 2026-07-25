---
description: Apply a verified Codex job diff onto the current branch as a local commit
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Land a finished Codex job's diff onto the current branch. With no job id, the latest finished
job is used.

Raw slash-command arguments:

`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" land "$ARGUMENTS"
```

Return that command's stdout verbatim.

What the command enforces, so you do not need to check any of it yourself:

- The job must be `completed`, not `verification-failed`.
- Its required verification checks must have passed.
- It must have committed changes and no refused out-of-policy changes.
- The working tree must be clean, unless the repository policy says otherwise.

It performs a local `git fetch` from the job worktree followed by `git cherry-pick`, and
records an audit entry on the job. **It never pushes, never force-pushes, and never merges to
a remote.**

Operating rules:

- `disable-model-invocation` is set deliberately: landing is a user action. Run this only when
  the user asked for it.
- If the command refuses, relay the reason verbatim and stop. Do not work around it with your
  own git commands.

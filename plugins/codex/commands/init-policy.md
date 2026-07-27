---
description: Generate a starting .codex-plugin/policy.json from the repository's layout and toolchain
argument-hint: "[--force]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Generate an execution policy for this repository so write-capable Codex agents can run.

Raw slash-command arguments:

`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" init-policy "$ARGUMENTS"
```

Return that command's stdout verbatim.

Operating rules:

- The generator inspects the repository (directory layout, package manager, test toolchain)
  and writes a suggested `.codex-plugin/policy.json`. It refuses to overwrite an existing
  policy unless `--force` is passed.
- The generated file is a starting point, not an authority. Encourage the user to review the
  writable globs and verification commands before committing it.
- Do not commit the file yourself. Committing the policy is the human's explicit opt-in to
  write-capable agents in this repository.
- If generation fails (not a git repository, unreadable layout), relay the error verbatim.

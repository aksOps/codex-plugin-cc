# Changelog

## 2.0.0

Write-capable Codex work now runs in isolation under an execution policy.

### Breaking

- `--write` runs require an execution policy at `.codex-plugin/policy.json`. Without one,
  every write capability is denied and only read-only agents run. This is deliberate: the
  policy is what bounds which paths Codex may modify.
- Write work no longer edits the active checkout. It runs in a git worktree outside the
  repository on a `codex/<jobId>` branch and produces a diff to review, so anything that
  expected files to change in place must now use `/codex:diff` and `/codex:land`.
- The marketplace id is `aksops-codex` and the plugin author is `aksOps`. Re-register with
  `/plugin marketplace add aksOps/codex-plugin-cc` and `/plugin install codex@aksops-codex`.

### Added

- `/codex:implement` and `/codex:test` for write-capable work, `/codex:explore` and
  `/codex:verify` for read-only work, backed by four capability-typed subagents. Each pins its
  own policy identity, so capability comes from the policy file rather than prompt text.
- `/codex:diff` to review what a job produced and `/codex:land` to apply it as a local commit.
- Execution policy with per-agent writable globs, structured verification commands, resource
  limits, and landing rules. Schema at `plugins/codex/schemas/policy.schema.json`.
- Structured verification: policy-declared argv commands run inside the job worktree with no
  shell. A failing required check marks the job `verification-failed` and blocks landing.
- Permission-mode inheritance. In `acceptEdits`, `auto`, `dontAsk`, or `bypassPermissions` a
  verified diff lands automatically so autonomous sessions are not stalled; `plan` refuses
  write agents. The mode changes only whether the plugin pauses, never what Codex may touch.
- Policy-decided approvals. Sandbox escapes, session-wide write grants, and unlisted commands
  are refused without consulting the model, identically in every permission mode.
- Durable job ownership. A crashed worker's job becomes `stale` and frees its concurrency slot
  instead of claiming to run forever.
- Credential-stripped environments for commands the plugin spawns.

### Changed

- Write turns use `approvalPolicy: "on-request"` instead of `"never"`, and the app-server
  client can answer server-initiated requests.
- Landing is always a local `git fetch` plus `git cherry-pick` with an audit record. It never
  pushes, force-pushes, or merges to a remote.

## 1.0.0

- Initial version of the Codex plugin for Claude Code

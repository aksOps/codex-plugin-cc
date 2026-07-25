# Fleet Stage 0 Spike

Stage 0 answers the seven empirical questions from `EXECUTION_PLAN.md` section 7. Evidence paths below are relative to:

`.omo/evidence/ulw/019f95c0-4201-73c0-b1ce-a579f1b4077e/G001-p1-or-p2-fails-per-the-kill-criteria/a1/`

## P1 - PreToolUse can substitute a plugin-scoped agent

Status: PASS

Observed: The no-hook control executed the original agent. With a `PreToolUse` matcher for `Agent`, the hook returned a complete `updatedInput` preserving `description` and `prompt` while changing `subagent_type` to `fleet-spike:substituted`. The substituted marker existed, the original marker did not, and the stream recorded `task_started` for the substituted type. The scoped rerun passed again.

Decision: Retain settled decision 2. Use the Claude hook matcher name `Agent`, return the complete updated input, and target plugin-scoped agent names. The unscoped fallback was not needed. P1's kill condition did not fire.

Evidence: `p1/result.json`, `p1/scoped/result.json`, `p1/scoped-rerun/result.json`, `p1/cleanup-receipt.txt`.

## P2 - A thin Haiku proxy forwards exactly once and verbatim

Status: PASS

Observed: Five varied cases (code, config, docs, refactor, investigation) each made exactly one call to the allowed MCP `forward` tool, used no work tool, and returned the nonce-bearing tool result byte-for-byte. The proxy used Haiku, low effort, `maxTurns: 3`, and zero prompt revisions. A separate rerun reproduced the result.

Decision: Retain the proxy-agent design. Restrict each proxy to its single MCP forwarding tool and return the tool result without editorial text. The harness observed that `dontAsk` denied the MCP call while `bypassPermissions` allowed the explicitly restricted tool surface; production must preserve the narrow tool allowlist when selecting its permission mode. P2's kill condition did not fire.

Evidence: `p2/result.json`, `p2/root-rerun/verdict.json`, `p2/harness-verification.txt`, `p2/root-rerun/cleanup-receipt.txt`.

## P3 - Workflow-spawned agents bypass the project PreToolUse hook

Status: FAIL

Observed: On Claude Code 2.1.220, the direct Agent control fired the configured `PreToolUse` hook and wrote a hook record. The local Workflow completed, spawned its marker agent, and produced `P3_MARKER_WORKFLOW`, but no corresponding workflow hook record was created. The root rerun reproduced the direct record and the missing workflow record.

Decision: Apply the documented fallback: Workflow scripts must call the shared router themselves. Do not rely on the project hook to enforce routing for Workflow-spawned agents. This is informational and does not stop Stage 1.

Evidence: `p3/result.json`, `p3/root-rerun/direct.stream.jsonl`, `p3/root-rerun/workflow.stream.jsonl`, `p3/root-rerun/hook-logs/direct-control-root.jsonl`, `p3/root-rerun/cleanup-receipt.txt`.

## P4 - Isolated Codex subscription turn

Status: PASS

Observed: The declaration scan found no TypeScript SDK login API. An unauthenticated SDK turn used the vendored binary and isolated `CODEX_HOME`, then failed with HTTP 401 as expected. A fresh app-server device login emitted `account/login/completed`; a metadata-only snapshot recorded isolated `auth.json` mode 600. The authenticated SDK turn used `codexPathOverride` for `node_modules/.bin/codex`, supplied the isolated `CODEX_HOME`, and reached `turn.completed`. The immediate pre/post `~/.codex` mtime diff was empty.

Decision: Use the vendored app-server JSON-RPC login fallback for the isolated home, then execute through the TypeScript SDK with the vendored binary. P4 passes. Limitation: the extra workspace-write marker was not created because the Codex sandbox could not create `spike/p45`; this was outside P4's subscription-auth gate and does not establish workspace-write behavior for Stage 1.

Evidence: `p45/p4-result.json`, `p45/authenticated-sdk-turn-result.json`, `p45/codex-home-mtime-diff-final-authenticated-probe.txt`, `p45/codex-home-mtime-diff-final-authenticated-probe.exit-code`, `p45/cleanup-receipt.json`.

## P5 - The TypeScript SDK has no rate-limit accessor

Status: PASS

Observed: A case-insensitive scan of the exported declarations in `@openai/codex-sdk` 0.145.0 found no account, login, or rate-limit accessor. Generated schemas from the vendored app-server expose `account/rateLimits/read` and `account/rateLimits/updated`; an authenticated `account/rateLimits/read` request completed and returned the camelCase rate-limit shape.

Decision: Implement the Stage 6 quota reader as an owned JSON-RPC client against the vendored app-server. Do not parse rollout JSONL unless the app-server protocol later proves unusable.

Evidence: `p45/p5-result.json`, `p45/app-server-rate-limits-result.json`, `p45/app-server-rate-limits-final.exit-code`, `p45/declaration-accessor-search.txt`, `p45/app-server-schema-relevant.txt`.

## P6 - Deny-and-steer causes delegation

Status: PASS

Observed: The no-hook control performed one direct inline Edit without delegation. In five varied green cases (code, config, docs, refactor, investigation), the hook denied that Edit, Claude then spawned `p6-deny:marker`, and the delegated agent applied the intended change. All five passed on prompt revision 1.

Decision: Retain decision 3's deny-and-steer coverage and implement it in Stage 3. Keep the delegation-skill fallback documented, but it is not selected by this probe.

Evidence: `p6/result.json`, `p6/summary.stdout.json`, `p6/prompt-revisions.json`, `p6/cleanup-receipt.txt`.

## P7 - Criteria generation needs an explicit review signal

Status: PASS

Observed: The prescribed first five-case batch produced executable, checkable Criteria for the test-backed code change, config change, refactor, and investigation. The documentation case had a zero-byte raw-output snapshot, so it was recorded `unverified` rather than retried or silently counted as a pass. Score: 4/5. A later independent rerun produced 5/5, but it does not erase the observed failure in the prescribed batch.

Decision: Select the 3-4/5 Stage 2 fork. Machine-checkable `command` Criteria remain the default; allow explicit `checkKind: "review"` as a second-class signal, record it in every Event, and report objective and judged pass rates separately. Absolute rule: an uncheckable Step has `outcome: "unverified"`, never `"pass"`.

Evidence: `p7/result.json`, `p7/validation-report.md`, `p7/selected-fork.txt`, `p7/root-rerun/result.json`, `p7/root-rerun/cleanup-receipt.txt`.

## Stage 0 decision

Status: PASS

P1 and P2 passed, so neither kill criterion fired. P3 selected its documented self-routing fallback. P4 proved isolated subscription-auth SDK execution through the vendored binary after app-server device login. P5 selected and exercised app-server JSON-RPC. P6 retained deny-and-steer. P7 selected `checkKind: "review"`. Stage 0 may advance; the P4 workspace-write marker limitation remains a Stage 1 concern.

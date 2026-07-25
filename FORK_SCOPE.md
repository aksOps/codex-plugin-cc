# Fork Scope

This document is the governing contract for the fork. A contributor should be
able to use it to decide whether a proposed change belongs in the product and
whether the product is ready to release.

## Product Boundary

Claude Code remains the interactive host and continues to run Claude models
through the user's Claude subscription. The plugin makes OpenAI Codex models
available from that host through the locally installed Codex runtime.

The fork does not replace Claude Code's native model picker, proxy Anthropic
traffic, or present an OpenAI model as a native Claude model. OpenAI execution
is exposed through plugin commands and agents with the provider and model
identified explicitly.

The archived Fleet prototype is historical reference material. Nothing under
the archive participates in installation, runtime loading, tests, packaging, or
release decisions for the active plugin.

## Authentication Boundary

Authentication remains owned by the upstream Codex runtime. The fork does not
add, replace, restrict, or reinterpret its authentication methods.

ChatGPT login, API-key authentication, custom model providers, and endpoint
configuration continue to behave as documented and implemented upstream.
Feature code may consume provider availability and model metadata exposed by
the runtime, but it must not inspect credentials or make authentication policy
decisions.

The fork must:

- delegate login, refresh, logout, and credential storage to Codex;
- preserve supported upstream authentication and provider configurations;
- avoid reading, copying, logging, or returning authentication secrets; and
- keep delegation behavior independent from the mechanism used to authenticate.

## Delegation Boundary

Codex execution begins through an explicit plugin command or proactive
delegation by the Claude host based on task suitability. Delegation does not
use estimated usage or remaining quota.

The host may send eligible work to Codex when:

- the requested model is available from the configured Codex provider;
- the task policy permits Codex execution; and
- the execution sandbox required by the task is available.

If Codex is unavailable or execution fails, including because the provider
rejects further usage, the plugin reports the failure and returns control to
Claude. It must not silently substitute a provider or repeat the task with
Claude after Codex may have produced partial effects.

The host may become aggressive about delegation, but not about authority.
Proactive write delegation is allowed only within the same effect limits that
would apply to an explicit invocation.

## Execution and Security

Read-only review and write-capable implementation are separate capabilities.
Write-capable work must execute in an isolated worktree and produce a
reviewable diff. Models may propose changes and run permitted verification, but
a model may never decide on its own authority that a diff lands in the user's
active branch.

Security decisions are enforced outside model prompts. Release readiness
requires:

- fail-closed policy loading;
- repository-scoped writable roots;
- bounded process, duration, output, and network access;
- credential and environment-variable isolation;
- durable job ownership and cancellation;
- structured verification without arbitrary shell criteria;
- authorization bound to the repository and reviewed diff; and
- an auditable, explicit merge operation.

Claude hooks and Codex execution policies are defense in depth. Neither is the
sole authority.

Effect limits are set by policy and isolation, not by the host permission mode.
The host permission mode may govern whether the plugin pauses for confirmation
and whether a verified diff is landed automatically. It never widens writable
roots, never disables verification, and never permits writes outside the job
worktree. A permission mode is authorization supplied by the user through the
host, so it may relax interactivity; it is not a capability grant, so it may not
relax isolation.

## Upstream Relationship

This repository is a standalone project seeded from `openai/codex-plugin-cc` at
commit `db52e28`. It left that fork network and has no configured upstream
remote, so upstream changes are adopted deliberately by porting them rather than
by merging a tracked branch.

It still minimizes divergence from upstream's command surface, app-server
protocol, result rendering, and session transfer behavior, and keeps
fork-specific policy, isolation, verification, and landing logic in separate
modules. That separation is what makes a future port reviewable instead of a
rewrite, and it is why an upstream change should never silently weaken the
product contract.

Apache-2.0 license and NOTICE requirements remain in force. The original
copyright notice is retained and a modification notice is appended alongside it.
This project must not imply that its modifications are maintained, sponsored, or
endorsed by OpenAI.

## Release Gates

A production release is blocked until all of the following pass on the exact
release commit:

1. A fresh plugin installation works without a source checkout.
2. Existing upstream authentication and provider configurations continue to
   work without fork-specific credential handling.
3. Model discovery and explicit or proactive delegation work in a live
   session, and unavailable or failed Codex execution is reported without
   silent provider substitution.
4. Read-only and write-capable invocations complete through the plugin surface.
5. Write-capable work cannot modify the active checkout or paths outside its
   isolated worktree.
6. Restart, cancellation, concurrent-job, replay, and stale-state scenarios
   pass.
7. Verification failure prevents completion and merge.
8. Approval cannot be supplied or forged by model-generated input.
9. The final diff passes independent code, security, and manual workflow
    review.

Until every gate passes, the product is a development build rather than a
secure or compliant release.

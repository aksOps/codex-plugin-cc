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
Feature code may consume provider availability, model metadata, and quota
signals exposed by the runtime, but it must not inspect credentials or make
authentication policy decisions.

The fork must:

- delegate login, refresh, logout, and credential storage to Codex;
- preserve supported upstream authentication and provider configurations;
- avoid reading, copying, logging, or returning authentication secrets; and
- keep routing behavior independent from the mechanism used to authenticate.

## Quota-Aware Routing

Routing uses provider availability and observed quota state when the active
runtime exposes those signals. It must never infer quota from model prose or
silently substitute a provider.

The router may send eligible work to Codex when:

- the requested model is available from the configured Codex provider;
- the task policy permits Codex execution; and
- the execution sandbox required by the task is available.

Automatic quota-aware redirection additionally requires a known quota signal
above the configured reserve. An unavailable quota signal is reported as
unknown and must not disable an otherwise supported upstream authentication
mode or explicit Codex invocation. When Codex is unavailable or known to be
below reserve, the router returns an explicit reason and leaves automatic
execution with Claude. Quota degradation must be deterministic, observable,
and reversible when fresh quota data becomes available.

The router may become aggressive about delegation, but not about authority.
Automatic write delegation is allowed only within the same effect limits that
would apply to an explicit invocation.

## Execution and Security

Read-only review and write-capable implementation are separate capabilities.
Write-capable work must execute in an isolated worktree and produce a
reviewable diff. Models may propose changes and run permitted verification, but
they may not merge directly into the user's active branch.

Security decisions are enforced outside model prompts. Release readiness
requires:

- fail-closed policy loading;
- repository-scoped writable roots;
- bounded process, duration, output, and network access;
- credential and environment-variable isolation;
- durable job ownership and cancellation;
- structured verification without arbitrary shell criteria;
- one-use approval bound to the repository and reviewed diff; and
- an auditable, explicit merge operation.

Claude hooks and Codex execution policies are defense in depth. Neither is the
sole authority, and bypass modes must not expand the allowed effect set.

## Upstream Relationship

The fork keeps OpenAI's repository as its upstream and minimizes changes to
the command surface, app-server protocol, result rendering, and session
transfer behavior. Fork-specific policy, quota, state, and isolation logic
should remain modular so upstream updates can be reviewed and merged without
silently weakening the product contract.

Apache-2.0 license and NOTICE requirements remain in force. The fork must not
imply that its modifications are maintained or endorsed by OpenAI.

## Release Gates

A production release is blocked until all of the following pass on the exact
release commit:

1. A fresh plugin installation works without a source checkout.
2. Existing upstream authentication and provider configurations continue to
   work without fork-specific credential handling.
3. Model discovery and quota-aware degradation work in a live session,
   including the explicit unknown-quota case.
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

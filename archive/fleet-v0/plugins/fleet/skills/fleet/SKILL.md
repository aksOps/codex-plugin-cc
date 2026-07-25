---
name: fleet
description: Plan, grill, approve, and run an intent through Fleet's isolated cross-provider workflow.
argument-hint: <intent>
allowed-tools: Agent, Read, mcp__plugin_fleet_fleet__route, mcp__plugin_fleet_fleet__forward, mcp__plugin_fleet_fleet__await, mcp__plugin_fleet_fleet__status, mcp__plugin_fleet_fleet__check
---

Treat `$ARGUMENTS` as the exact Fleet intent. This skill is the only
user-facing entry point; do not offer internal MCP tools as alternate commands.

## Plan and grill

1. Resolve the current git repository to an absolute path.
2. Spawn `fleet:planner` with the intent, repository path, and any answers
   already given in this conversation. Embed the required Plan fields in the
   spawn prompt: `# Fleet Plan`, root `Intent`, then one or more `## Step <id>`
   sections containing `Intent`, `Dependencies`, `Files`, `Check Kind`, and
   either `Command` plus `Expected` or explicit `Review`. Tell it to inspect
   only the target repository. IDs must be lowercase kebab-case, and every
   dependency must repeat a heading's raw ID exactly, without a `Step ` prefix.
   The planner must own no implementation files and must not execute work.
3. If it returns `Question:`, show exactly that one question, its
   `Recommended:` answer, and why it blocks the Plan. Stop. Do not call any
   Fleet MCP tool. When the user answers, resume at step 2 with that answer.
4. When the planner returns a complete Plan, present it verbatim and ask:
   `Approve this Plan for autonomous execution? (recommended: approve)`
   Stop. Do not call any Fleet MCP tool.
5. Continue only after an explicit user approval in this conversation.
   Rejection or requested revision returns to step 2. Approval applies only to
   the exact displayed Plan.

## Execute the approved Plan

6. Parse every approved Plan Step. Before a Run exists, call
   `mcp__plugin_fleet_fleet__route` with the exact Step `intent` and `stepId`, the full
   approved Plan as `plan`, and `approved: true`. After a Run exists, route the
   remaining Steps with their exact `intent`, `stepId`, and `runId`. Preserve the
   returned shape, rule, Tier, provider, and effort. The router is
   authoritative; never substitute a provider or Tier.
7. Maintain the returned scheduler state. Start every dependency-eligible,
   file-disjoint Step without waiting for an unrelated Step; initiate their
   provider calls and Agent spawns concurrently. Serialize a Step until every
   dependency is terminal `pass` or explicitly `unverified`. If `forward`
   refuses an ownership overlap, leave that Step pending until the conflicting
   Step checks terminal. For every Agent spawn, begin its
   prompt with this exact routing envelope:

   ```text
   <fleet-route approved="true">
   Intent: <exact Step intent>
   Files: <comma-separated Step files, or none>
   Check Kind: <command or review>
   </fleet-route>
   ```

8. For a Codex Route, spawn `fleet:standard` as the neutral hook target. In the
   same prompt, immediately after `</fleet-route>` with no intervening text,
   emit one of these exact machine-readable blocks:

   ```text
   <fleet-forward>
   {"provider":"codex","intent":"<exact Step intent>","stepId":"<exact Step ID>","repoPath":"<absolute repository path>","plan":"<full approved Plan>","approved":true}
   </fleet-forward>
   ```

   ```text
   <fleet-forward>
   {"provider":"codex","intent":"<exact Step intent>","stepId":"<exact Step ID>","runId":"<existing Run ID>"}
   </fleet-forward>
   ```

   The JSON object must occupy exactly one physical line and use valid JSON
   escaping, including escaped newlines in `plan`. Do not add fields. The
   `intent` must exactly equal the routing envelope's Intent.

   The ambient hook must rewrite the neutral target to the routed Codex proxy.
   Require that proxy to return the `forward` result unchanged, then call
   `mcp__plugin_fleet_fleet__await` with the exact returned Run ID, Step ID,
   and rung. Record its error if it fails, but continue to criterion checking.
   Never bypass a routed
   Codex proxy with a direct Codex forward call.
9. For a Claude Route, call `mcp__plugin_fleet_fleet__forward` directly with
   `provider: "claude"`, the exact Step intent and ID, and the same new-Run or
   existing-Run fields from step 8. Spawn the returned
   `nativeAgent.subagentType` using its returned prompt. Capture any Agent
   error or concrete failure evidence. Do not launch Claude through a
   subprocess or SDK.
10. If a Route contains two Tiers, retain both in the execution record and
    start only scheduler-admitted, file-disjoint attempts. Never pretend an
    unstarted secondary Tier ran.
11. After every Codex await or Claude Agent attempt, call
    `mcp__plugin_fleet_fleet__check` with the exact returned `runId`, Step ID,
    and `rung`. For Claude, include `workerError` or `failureEvidence` when
    present. Handle the result exactly:
    - `pass` → the Step is complete.
    - `unverified` → report it as unverified and stop that Step; never ladder it.
    - `fail` with `nextRoute` → call `forward` again for the same Run, Step,
      and intent using that provider. Do not call `route` again. Rung 2 keeps
      the existing partial work and failure context. The rung 2 check resets
      the worktree before returning the fresh cross-provider rung 3 Route.
    - `status: "halted"` → stop the Run. Never attempt a fourth rung.
12. After any terminal check, use its returned scheduler state or call
    `mcp__plugin_fleet_fleet__status`, then immediately initiate newly eligible
    file-disjoint Steps. The status response exposes exact active attempts,
    Codex pool occupancy/queue state, and the combined Run-worktree diff.
13. Present the approved Plan path, Run worktree path, each rule/Tier/provider,
    provider outcomes, verification evidence, any deferred dual-route Tier,
    and final diff for review.

Never copy or merge the Run diff into the user's working tree. Stop after
presenting it. A later approved merge is a separate lifecycle action.

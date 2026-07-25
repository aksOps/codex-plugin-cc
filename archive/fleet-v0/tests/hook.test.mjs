import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleHookInput } from "../plugins/fleet/hooks/pre-tool-use.mjs";
import { route } from "../src/router/rules.mjs";

const hookPath = new URL(
  "../plugins/fleet/hooks/pre-tool-use.mjs",
  import.meta.url,
);
const hookFile = fileURLToPath(hookPath);

function agentInput(overrides = {}) {
  return {
    tool_name: "Agent",
    tool_input: {
      description: "Apply one mechanical rename",
      prompt: `<fleet-route approved="true">
Intent: Rename one local constant and run its test.
Files: src/example.mjs
Check Kind: command
</fleet-route>
Use the approved Fleet execution context.`,
      subagent_type: "general-purpose",
      ...overrides,
    },
  };
}

function codexPrompt(payload) {
  return `<fleet-route approved="true">
Intent: Implement a small parser change.
Files: src/parser.mjs
Check Kind: command
</fleet-route>
<fleet-forward>
${typeof payload === "string" ? payload : JSON.stringify(payload)}
</fleet-forward>
Context that must not reach the proxy.`;
}

function parsedForwardBlock(prompt) {
  const match = /<fleet-forward>\n([^\r\n]+)\n<\/fleet-forward>/.exec(prompt);
  assert.notEqual(match, null);
  return JSON.parse(match[1]);
}

function runHook(input, environment = {}) {
  const result = spawnSync(process.execPath, [hookFile], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    input: JSON.stringify(input),
  });
  return {
    ...result,
    output: JSON.parse(result.stdout),
  };
}

test("Agent disagreement rewrites the complete input to the selected Tier", () => {
  const input = agentInput({ run_in_background: false });

  const result = handleHookInput(input, {}, route);

  assert.equal(
    result.hookSpecificOutput.updatedInput.subagent_type,
    "fleet:quick",
  );
  assert.equal(
    result.hookSpecificOutput.updatedInput.description,
    input.tool_input.description,
  );
  assert.equal(
    result.hookSpecificOutput.updatedInput.prompt,
    input.tool_input.prompt,
  );
  assert.equal(result.hookSpecificOutput.updatedInput.run_in_background, false);
  assert.equal(result.hookSpecificOutput.permissionDecision, "allow");
  assert.match(
    result.hookSpecificOutput.permissionDecisionReason,
    /mechanical-single-file/,
  );
});

test("Codex rewrites canonicalize and preserve the exact new-Run payload", () => {
  const payload = {
    provider: "codex",
    intent: "Implement a small parser change.",
    stepId: "parser-change",
    repoPath: "/tmp/target",
    plan: "# Fleet Plan\nIntent: parser",
    approved: true,
  };
  const result = handleHookInput(
    agentInput({
      prompt: codexPrompt(payload),
      subagent_type: "fleet:standard",
      run_in_background: false,
    }),
    {},
    route,
  );

  assert.equal(
    result.hookSpecificOutput.updatedInput.subagent_type,
    "fleet:codex-low",
  );
  assert.deepEqual(
    parsedForwardBlock(result.hookSpecificOutput.updatedInput.prompt),
    payload,
  );
  assert.equal(
    result.hookSpecificOutput.updatedInput.prompt
      .split("mcp__plugin_fleet_fleet__forward").length - 1,
    1,
  );
  assert.equal(
    result.hookSpecificOutput.updatedInput.prompt.includes(
      "Context that must not reach the proxy.",
    ),
    false,
  );
  assert.equal(result.hookSpecificOutput.updatedInput.run_in_background, false);
});

test("Codex rewrites canonicalize and preserve the exact existing-Run payload", () => {
  const payload = {
    provider: "codex",
    intent: "Implement a small parser change.",
    stepId: "parser-change",
    runId: "run-existing",
  };

  const result = handleHookInput(
    agentInput({ prompt: codexPrompt(payload) }),
    {},
    route,
  );

  assert.equal(
    result.hookSpecificOutput.updatedInput.subagent_type,
    "fleet:codex-low",
  );
  assert.deepEqual(
    parsedForwardBlock(result.hookSpecificOutput.updatedInput.prompt),
    payload,
  );
});

test("Codex routes preserve the original Agent input when forward context is missing", () => {
  const prompt = `<fleet-route approved="true">
Intent: Implement a small parser change.
Files: src/parser.mjs
Check Kind: command
</fleet-route>`;

  const result = handleHookInput(agentInput({ prompt }), {}, route);

  assert.equal(result.hookSpecificOutput.updatedInput, undefined);
  assert.equal(typeof result.hookSpecificOutput.additionalContext, "string");
});

test("Codex routes preserve the original Agent input when forward context is malformed", () => {
  const malformed = [
    "{not-json",
    JSON.stringify({
      provider: "codex",
      intent: "Implement a small parser change.",
      stepId: "parser-change",
      repoPath: "/tmp/target",
      plan: "# Fleet Plan",
      approved: false,
    }),
  ];

  for (const payload of malformed) {
    const result = handleHookInput(
      agentInput({ prompt: codexPrompt(payload) }),
      {},
      route,
    );

    assert.equal(result.hookSpecificOutput.updatedInput, undefined);
    assert.equal(typeof result.hookSpecificOutput.additionalContext, "string");
  }
});

test("Codex routes preserve the original Agent input when intents mismatch", () => {
  const payload = {
    provider: "codex",
    intent: "Implement a different change.",
    stepId: "parser-change",
    runId: "run-existing",
  };

  const result = handleHookInput(
    agentInput({ prompt: codexPrompt(payload) }),
    {},
    route,
  );

  assert.equal(result.hookSpecificOutput.updatedInput, undefined);
  assert.equal(typeof result.hookSpecificOutput.additionalContext, "string");
});

test("large inline writes deny and steer while small edits pass", () => {
  const denied = handleHookInput({
    tool_name: "Write",
    tool_input: {
      file_path: "src/large.mjs",
      content: "x".repeat(4_000),
    },
  }, {}, route);
  const passed = handleHookInput({
    tool_name: "Edit",
    tool_input: {
      file_path: "src/small.mjs",
      old_string: "old",
      new_string: "new",
    },
  }, {}, route);

  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    denied.hookSpecificOutput.permissionDecisionReason,
    /Start \/fleet.*fleet:/,
  );
  assert.equal(passed.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(passed.hookSpecificOutput.updatedInput, undefined);
});

test("matching and lifecycle-internal agent types pass without mutation", () => {
  const matching = handleHookInput(
    agentInput({ subagent_type: "fleet:quick" }),
    {},
    route,
  );
  const planner = handleHookInput(
    agentInput({ subagent_type: "fleet:planner" }),
    {},
    route,
  );

  assert.equal(matching.hookSpecificOutput.updatedInput, undefined);
  assert.equal(planner.hookSpecificOutput.updatedInput, undefined);
});

test("unapproved Agent inputs pass through to preserve the single Fleet door", () => {
  const result = handleHookInput(
    agentInput({ prompt: "Implement a small change in src/example.mjs." }),
    {},
    route,
  );

  assert.equal(result.hookSpecificOutput.updatedInput, undefined);
  assert.match(
    result.hookSpecificOutput.additionalContext,
    /approved \/fleet Plan/,
  );
});

test("injected errors and the kill switch fail open with exit zero", () => {
  const injected = runHook(agentInput(), { FLEET_HOOK_INJECT_ERROR: "1" });
  const disabled = runHook(agentInput(), { FLEET_HOOK_DISABLE: "1" });

  assert.equal(injected.status, 0);
  assert.equal(injected.output.hookSpecificOutput.updatedInput, undefined);
  assert.match(
    injected.output.hookSpecificOutput.additionalContext,
    /original tool input preserved/,
  );
  assert.equal(disabled.status, 0);
  assert.equal(disabled.output.hookSpecificOutput.updatedInput, undefined);
  assert.match(
    disabled.output.hookSpecificOutput.additionalContext,
    /routing disabled/,
  );
});

test("malformed input exits zero and passes through", () => {
  const result = spawnSync(process.execPath, [hookFile], {
    encoding: "utf8",
    input: "{not-json",
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(output.hookSpecificOutput.updatedInput, undefined);
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /original tool input preserved/,
  );
});

test("routing handler stays below the 50 ms latency budget", () => {
  const startedAt = performance.now();

  handleHookInput(agentInput(), {}, route);

  assert.ok(
    performance.now() - startedAt < 50,
    "Fleet hook handler exceeded 50 ms",
  );
});

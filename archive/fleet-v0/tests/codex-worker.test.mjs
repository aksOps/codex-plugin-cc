import assert from "node:assert/strict";
import test from "node:test";

import { runCodexStep } from "../src/codex/worker.mjs";

test("runCodexStep starts one writable non-interactive turn", async () => {
  // Given
  const calls = [];
  const signal = AbortSignal.timeout(5_000);
  const thread = {
    id: "thread-42",
    async run(input, options) {
      calls.push({ input, options });
      return {
        finalResponse: "RESULT_NONCE_42",
        items: [{ type: "agent_message", text: "RESULT_NONCE_42" }],
        usage: { input_tokens: 3, output_tokens: 2 },
      };
    },
  };
  const client = {
    startThread(options) {
      calls.push({ options });
      return thread;
    },
  };

  // When
  const result = await runCodexStep({
    client,
    workingDirectory: "/tmp/fleet-worktree",
    prompt: "STEP_NONCE_42",
    modelReasoningEffort: "high",
    signal,
  });

  // Then
  assert.deepEqual(calls, [
    {
      options: {
        approvalPolicy: "never",
        modelReasoningEffort: "high",
        networkAccessEnabled: false,
        sandboxMode: "workspace-write",
        skipGitRepoCheck: false,
        workingDirectory: "/tmp/fleet-worktree",
      },
    },
    { input: "STEP_NONCE_42", options: { signal } },
  ]);
  assert.deepEqual(result, {
    finalResponse: "RESULT_NONCE_42",
    items: [{ type: "agent_message", text: "RESULT_NONCE_42" }],
    threadId: "thread-42",
    usage: { input_tokens: 3, output_tokens: 2 },
  });
});

test("runCodexStep forwards a discovered model without a built-in default", async () => {
  // Given
  let threadOptions;
  const client = {
    startThread(options) {
      threadOptions = options;
      return {
        id: "thread-model",
        async run() {
          return { finalResponse: "", items: [], usage: null };
        },
      };
    },
  };

  // When
  await runCodexStep({
    client,
    workingDirectory: "/tmp/fleet-worktree",
    prompt: "STEP_NONCE_MODEL",
    model: "discovered-model-id",
  });

  // Then
  assert.equal(threadOptions.model, "discovered-model-id");
});

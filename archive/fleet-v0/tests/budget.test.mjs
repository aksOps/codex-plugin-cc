import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { estimateClaudeBudget } from "../src/claude/budget.mjs";

async function createTranscript(claudeHome, slug, name, contents) {
  const projectPath = path.join(claudeHome, "projects", slug);
  await mkdir(projectPath, { recursive: true });
  const transcriptPath = path.join(projectPath, name);
  await writeFile(transcriptPath, contents, "utf8");
  return transcriptPath;
}

test("estimateClaudeBudget rolls up transcript usage and skips malformed lines", async () => {
  // Given
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "fleet-claude-"));
  const slug = "-workspaces-fleet";
  await createTranscript(
    claudeHome,
    slug,
    "first.jsonl",
    [
      JSON.stringify({
        message: {
          usage: {
            input_tokens: 11,
            output_tokens: 4,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 2,
          },
        },
      }),
      "{ malformed json",
      JSON.stringify({ message: { usage: { input_tokens: -9 } } }),
    ].join("\n"),
  );
  await createTranscript(
    claudeHome,
    slug,
    "second.jsonl",
    `${JSON.stringify({ usage: { input_tokens: 5, output_tokens: 7 } })}\n`,
  );

  // When
  const result = await estimateClaudeBudget({ claudeHome, projectSlug: slug });

  // Then
  assert.deepEqual(result, {
    isEstimate: true,
    inputTokens: 16,
    outputTokens: 11,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 2,
    totalTokens: 32,
  });
});

test("estimateClaudeBudget opens readable transcripts without a write capability", async () => {
  // Given
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "fleet-claude-"));
  const slug = "-read-only";
  const transcriptPath = await createTranscript(
    claudeHome,
    slug,
    "transcript.jsonl",
    `${JSON.stringify({ message: { usage: { output_tokens: 1 } } })}\n`,
  );
  await chmod(transcriptPath, 0o400);

  // When
  const result = await estimateClaudeBudget({ claudeHome, projectSlug: slug });

  // Then
  assert.equal(result.totalTokens, 1);
  assert.equal(result.isEstimate, true);
});

test("estimateClaudeBudget treats an absent project directory as an empty estimate", async () => {
  // Given
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "fleet-claude-"));

  // When
  const result = await estimateClaudeBudget({
    claudeHome,
    projectSlug: "-not-created",
  });

  // Then
  assert.deepEqual(result, {
    isEstimate: true,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  });
});

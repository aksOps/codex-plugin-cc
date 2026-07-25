import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_FIELDS = Object.freeze({
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  cache_creation_input_tokens: "cacheCreationInputTokens",
  cache_read_input_tokens: "cacheReadInputTokens",
});

function emptyEstimate() {
  return {
    isEstimate: true,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertProjectSlug(projectSlug) {
  if (
    typeof projectSlug !== "string" ||
    projectSlug.length === 0 ||
    projectSlug === "." ||
    projectSlug === ".." ||
    projectSlug.includes("/") ||
    projectSlug.includes("\\")
  ) {
    throw new TypeError("Claude project slug must be a single directory name.");
  }
}

function addUsage(estimate, usage) {
  if (!isRecord(usage)) {
    return;
  }

  for (const [field, property] of Object.entries(TOKEN_FIELDS)) {
    const value = usage[field];
    if (Number.isSafeInteger(value) && value >= 0) {
      estimate[property] += value;
      estimate.totalTokens += value;
    }
  }
}

async function readTranscript(transcriptPath, estimate) {
  let handle;
  try {
    handle = await open(transcriptPath, constants.O_RDONLY);
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  try {
    const contents = await handle.readFile({ encoding: "utf8" });
    for (const line of contents.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (!isRecord(record)) {
          continue;
        }
        const message = isRecord(record.message) ? record.message : null;
        addUsage(estimate, message?.usage ?? record.usage);
      } catch {
        // A partial or malformed transcript line is not budget evidence.
      }
    }
  } finally {
    await handle.close();
  }
}

export async function estimateClaudeBudget({
  projectSlug,
  claudeHome = join(homedir(), ".claude"),
} = {}) {
  assertProjectSlug(projectSlug);
  const estimate = emptyEstimate();
  const projectPath = join(claudeHome, "projects", projectSlug);

  let entries;
  try {
    entries = await readdir(projectPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && error.code === "ENOENT") {
      return estimate;
    }
    throw error;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      await readTranscript(join(projectPath, entry.name), estimate);
    }
  }
  return estimate;
}

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const appendQueues = new Map();

export async function appendEvent(eventsPath, event) {
  const resolvedPath = resolve(eventsPath);
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  })}\n`;
  const previous = appendQueues.get(resolvedPath) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(resolvedPath), { recursive: true });
      await appendFile(resolvedPath, line, "utf8");
    });
  appendQueues.set(resolvedPath, pending);

  try {
    await pending;
  } finally {
    if (appendQueues.get(resolvedPath) === pending) {
      appendQueues.delete(resolvedPath);
    }
  }
}

export async function readEvents(eventsPath) {
  let contents;
  try {
    contents = await readFile(eventsPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const events = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const value = JSON.parse(line);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        events.push(value);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  return events;
}

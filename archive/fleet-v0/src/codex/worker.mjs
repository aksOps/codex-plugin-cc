import { createCodexClient } from "./client.mjs";

export class CodexWorkerError extends Error {
  name = "CodexWorkerError";

  constructor(workingDirectory, options) {
    super(`Codex Step failed in ${workingDirectory}`, options);
    this.workingDirectory = workingDirectory;
  }
}

export async function runCodexStep({
  client,
  repoRoot,
  codexHome,
  workingDirectory,
  prompt,
  model,
  modelReasoningEffort,
  signal,
}) {
  const activeClient =
    client ?? (await createCodexClient({ repoRoot, codexHome }));
  const threadOptions = {
    approvalPolicy: "never",
    networkAccessEnabled: false,
    sandboxMode: "workspace-write",
    skipGitRepoCheck: false,
    workingDirectory,
  };

  if (model !== undefined) {
    threadOptions.model = model;
  }
  if (modelReasoningEffort !== undefined) {
    threadOptions.modelReasoningEffort = modelReasoningEffort;
  }

  const thread = activeClient.startThread(threadOptions);
  try {
    const turn = await thread.run(prompt, { signal });
    return {
      finalResponse: turn.finalResponse,
      items: turn.items,
      threadId: thread.id,
      usage: turn.usage,
    };
  } catch (error) {
    throw new CodexWorkerError(workingDirectory, { cause: error });
  }
}

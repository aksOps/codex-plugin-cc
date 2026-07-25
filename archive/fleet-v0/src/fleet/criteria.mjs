import { spawn } from "node:child_process";

function text(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function runCommand(command, worktreePath) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: worktreePath,
      env: { ...process.env, CI: "1" },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({
        exitCode: null,
        stdout,
        stderr,
        executionError: error.message,
      });
    });
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        stdout,
        stderr,
        ...(signal === null ? {} : { signal }),
      });
    });
  });
}

export async function evaluateCriterion({
  step,
  worktreePath,
  workerError = null,
  failureEvidence = null,
  executeCommand = runCommand,
}) {
  if (step.checkKind === "review") {
    return {
      outcome: "unverified",
      expected: null,
      failureEvidence:
        workerError === null && failureEvidence === null
          ? null
          : { workerError, workerEvidence: failureEvidence },
    };
  }

  const commandResult = await executeCommand(
    step.criteria.command,
    worktreePath,
  );
  const failed = workerError !== null || commandResult.exitCode !== 0;
  return {
    outcome: failed ? "fail" : "pass",
    expected: step.criteria.expected,
    failureEvidence: failed
      ? {
          command: step.criteria.command,
          expected: step.criteria.expected,
          exitCode: commandResult.exitCode,
          stdout: text(commandResult.stdout),
          stderr: text(commandResult.stderr),
          ...(commandResult.executionError === undefined
            ? {}
            : { executionError: commandResult.executionError }),
          ...(commandResult.signal === undefined
            ? {}
            : { signal: commandResult.signal }),
          ...(workerError === null ? {} : { workerError }),
          ...(failureEvidence === null
            ? {}
            : { workerEvidence: failureEvidence }),
        }
      : null,
  };
}

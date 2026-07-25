import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getCodexAuthStatus,
  inspectCodexAccount,
  startCodexDeviceLogin,
} from "../src/codex/auth.mjs";

async function createFakeAppServer(root) {
  const scriptPath = path.join(root, "fake-codex.mjs");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === 1) {
    process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: "fake" } }) + "\\n");
  } else if (message.method === "account/read") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        account: { type: "chatgpt", email: "private@example.test", planType: "pro" },
        requiresOpenaiAuth: true
      }
    }) + "\\n");
  } else if (message.method === "account/login/start") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        loginId: "login-42",
        verificationUrl: "https://auth.example.test/device",
        userCode: "CODE-42"
      }
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      method: "account/login/completed",
      params: { loginId: "login-42", success: true }
    }) + "\\n");
  } else if (message.method === "model/list") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        data: [
          { id: "model-visible", hidden: false },
          { id: "model-hidden", hidden: true }
        ],
        nextCursor: null
      }
    }) + "\\n");
  }
}
`,
    { mode: 0o700 },
  );
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

test("getCodexAuthStatus returns non-sensitive account metadata", async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-auth-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  await mkdir(repoRoot);
  const codexPath = await createFakeAppServer(root);

  // When
  const result = await getCodexAuthStatus({
    repoRoot,
    codexHome,
    codexPath,
  });

  // Then
  assert.deepEqual(result, {
    authenticated: true,
    authMode: "chatgpt",
    planType: "pro",
    requiresOpenaiAuth: true,
  });
});

test("startCodexDeviceLogin exposes the code and completion signal", async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-auth-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  await mkdir(repoRoot);
  const codexPath = await createFakeAppServer(root);

  // When
  const login = await startCodexDeviceLogin({
    repoRoot,
    codexHome,
    codexPath,
  });
  const completion = await login.completed;
  await login.close();

  // Then
  assert.deepEqual(
    {
      loginId: login.loginId,
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
      completion,
    },
    {
      loginId: "login-42",
      verificationUrl: "https://auth.example.test/device",
      userCode: "CODE-42",
      completion: { loginId: "login-42", success: true },
    },
  );
});

test("inspectCodexAccount discovers visible model IDs without identity data", async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-auth-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  await mkdir(repoRoot);
  const codexPath = await createFakeAppServer(root);

  // When
  const result = await inspectCodexAccount({
    repoRoot,
    codexHome,
    codexPath,
  });

  // Then
  assert.deepEqual(result, {
    authenticated: true,
    authMode: "chatgpt",
    models: ["model-visible"],
    planType: "pro",
    requiresOpenaiAuth: true,
  });
});

test(
  "getCodexAuthStatus rejects when the app-server cannot start",
  { timeout: 1_000 },
  async () => {
    // Given
    const root = await mkdtemp(path.join(os.tmpdir(), "fleet-auth-"));
    const repoRoot = path.join(root, "repo");
    const codexHome = path.join(root, "codex-home");
    await mkdir(repoRoot);

    // When
    const action = getCodexAuthStatus({
      repoRoot,
      codexHome,
      codexPath: path.join(root, "missing-codex"),
    });

    // Then
    await assert.rejects(action);
  },
);

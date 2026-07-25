import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexIsolationError,
  buildCodexEnvironment,
  getFleetCodexHome,
  getVendoredCodexPath,
  prepareCodexHome,
  resolveVendoredCodexPath,
} from "../src/codex/client.mjs";

test("prepareCodexHome creates a private directory outside the repository", async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-client-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "state", "codex-home");
  await mkdir(repoRoot);

  // When
  const prepared = await prepareCodexHome({ repoRoot, codexHome });

  // Then
  assert.equal(prepared, codexHome);
  assert.equal((await stat(codexHome)).mode & 0o777, 0o700);
});

test("prepareCodexHome repairs private-directory permissions", async () => {
  // Given
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-client-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  await mkdir(repoRoot);
  await mkdir(codexHome);
  await chmod(codexHome, 0o755);

  // When
  await prepareCodexHome({ repoRoot, codexHome });

  // Then
  assert.equal((await stat(codexHome)).mode & 0o777, 0o700);
});

test("prepareCodexHome rejects state inside the repository", async () => {
  // Given
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "fleet-client-"));
  const codexHome = path.join(repoRoot, ".fleet", "codex-home");

  // When
  const action = prepareCodexHome({ repoRoot, codexHome });

  // Then
  await assert.rejects(action, CodexIsolationError);
});

test("buildCodexEnvironment overrides ambient Codex state", () => {
  // Given
  const environment = {
    CODEX_HOME: "/ambient/codex",
    HOME: "/home/fleet",
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    FLEET_SECRET: "do-not-forward",
  };

  // When
  const result = buildCodexEnvironment({
    codexHome: "/isolated/codex",
    environment,
  });

  // Then
  assert.deepEqual(result, {
    CODEX_HOME: "/isolated/codex",
    HOME: "/home/fleet",
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
  });
});

test("buildCodexEnvironment removes global Codex paths from PATH", () => {
  const result = buildCodexEnvironment({
    codexHome: "/isolated/codex",
    environment: {
      HOME: "/home/fleet",
      PATH: [
        "/home/fleet/.codex/packages/standalone/codex-path",
        "/usr/local/bin",
        "/home/fleet/.codex/tmp/arg0",
        "/usr/bin",
      ].join(path.delimiter),
    },
  });

  assert.equal(result.PATH, ["/usr/local/bin", "/usr/bin"].join(path.delimiter));
  assert.doesNotMatch(result.PATH, /\/home\/fleet\/\.codex(?:\/|$)/);
});

test("resolveVendoredCodexPath never consults PATH", () => {
  // Given
  const repoRoot = "/srv/fleet";

  // When
  const result = resolveVendoredCodexPath(repoRoot);

  // Then
  assert.equal(result, "/srv/fleet/node_modules/.bin/codex");
});

test("integration aliases expose Fleet-owned paths", () => {
  // Given
  const repoRoot = "/srv/fleet";

  // When
  const codexHome = getFleetCodexHome();
  const codexPath = getVendoredCodexPath(repoRoot);

  // Then
  assert.equal(
    codexHome,
    path.join(os.homedir(), ".local", "share", "fleet", "codex-home"),
  );
  assert.equal(codexPath, "/srv/fleet/node_modules/.bin/codex");
});

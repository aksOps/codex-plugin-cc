import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const hookInput = JSON.stringify({
  tool_name: "Agent",
  tool_input: {
    description: "Route one approved Fleet Step",
    prompt: `<fleet-route approved="true">
Intent: Rename one local constant and run its test.
Files: src/example.mjs
Check Kind: command
</fleet-route>`,
    subagent_type: "fleet:standard",
  },
});

test("a preserved-layout package copy starts its hook and MCP runtime", async () => {
  const packageRoot = await mkdtemp(path.join(tmpdir(), "fleet-package-"));
  try {
    await Promise.all([
      cp(
        path.join(repoRoot, "plugins", "fleet"),
        path.join(packageRoot, "plugins", "fleet"),
        { recursive: true },
      ),
      cp(path.join(repoRoot, "src"), path.join(packageRoot, "src"), {
        recursive: true,
      }),
      copyFile(
        path.join(repoRoot, "policy.json"),
        path.join(packageRoot, "policy.json"),
      ),
      symlink(
        path.join(repoRoot, "node_modules"),
        path.join(packageRoot, "node_modules"),
        "dir",
      ),
    ]);

    const pluginRoot = path.join(packageRoot, "plugins", "fleet");
    const hook = spawnSync(
      process.execPath,
      [path.join(pluginRoot, "hooks", "pre-tool-use.mjs")],
      { encoding: "utf8", input: hookInput },
    );
    const mcp = spawnSync(
      process.execPath,
      [path.join(packageRoot, "src", "mcp", "server.mjs")],
      {
        encoding: "utf8",
        input: `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        })}\n`,
      },
    );

    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(
      JSON.parse(hook.stdout).hookSpecificOutput.updatedInput.subagent_type,
      "fleet:quick",
    );
    assert.equal(mcp.status, 0, mcp.stderr);
    assert.ok(
      JSON.parse(mcp.stdout).result.tools.some(({ name }) => name === "route"),
    );
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("a malformed plugin-only copy still fails open before router import", async () => {
  const packageRoot = await mkdtemp(path.join(tmpdir(), "fleet-plugin-only-"));
  const pluginRoot = path.join(packageRoot, "fleet");
  try {
    await mkdir(pluginRoot, { recursive: true });
    await cp(
      path.join(repoRoot, "plugins", "fleet"),
      pluginRoot,
      { recursive: true },
    );

    const hook = spawnSync(
      process.execPath,
      [path.join(pluginRoot, "hooks", "pre-tool-use.mjs")],
      { encoding: "utf8", input: hookInput },
    );
    const output = JSON.parse(hook.stdout);

    assert.equal(hook.status, 0);
    assert.equal(output.hookSpecificOutput.updatedInput, undefined);
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /router unavailable/,
    );
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

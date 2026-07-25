import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginRoot = new URL("../plugins/fleet/", import.meta.url);

async function readFrontmatter(relativePath) {
  const source = await readFile(new URL(relativePath, pluginRoot), "utf8");
  const match = source.match(/^---\n(?<frontmatter>[\s\S]*?)\n---\n/);
  assert.ok(match?.groups?.frontmatter);
  return Object.fromEntries(
    match.groups.frontmatter
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => {
        const separator = line.indexOf(":");
        return [
          line.slice(0, separator).trim(),
          line.slice(separator + 1).trim(),
        ];
      }),
  );
}

test("plugin metadata exposes one Fleet MCP server", async () => {
  // Given
  const manifest = JSON.parse(
    await readFile(
      new URL(".claude-plugin/plugin.json", pluginRoot),
      "utf8",
    ),
  );
  const mcp = JSON.parse(
    await readFile(new URL(".mcp.json", pluginRoot), "utf8"),
  );

  // When
  const serverNames = Object.keys(mcp.mcpServers);

  // Then
  assert.equal(manifest.name, "fleet");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(serverNames, ["fleet"]);
  assert.equal(mcp.mcpServers.fleet.command, "node");
});

test("all eight Tiers preserve Claude and restricted Codex contracts", async () => {
  // Given
  const deep = await readFrontmatter("agents/deep.md");
  const quick = await readFrontmatter("agents/quick.md");
  const standard = await readFrontmatter("agents/standard.md");
  const codexAgentNames = [
    "codex-explore",
    "codex-low",
    "codex-mid",
    "codex-high",
    "codex-qa",
  ];
  const codexAgents = await Promise.all(
    codexAgentNames.map((name) => readFrontmatter(`agents/${name}.md`)),
  );
  const proxy = await readFrontmatter("agents/codex-high.md");
  const planner = await readFrontmatter("agents/planner.md");

  // When
  const proxyTools = JSON.parse(proxy.tools);

  // Then
  assert.equal(deep.model, "opus");
  assert.equal(deep.effort, "high");
  assert.equal(quick.model, "haiku");
  assert.equal(quick.effort, "low");
  assert.equal(standard.model, "sonnet");
  assert.equal(standard.effort, "medium");
  assert.equal(proxy.model, "haiku");
  assert.equal(proxy.effort, "low");
  assert.equal(proxy.maxTurns, "3");
  assert.deepEqual(proxyTools, ["mcp__plugin_fleet_fleet__forward"]);
  for (const codexAgent of codexAgents) {
    assert.equal(codexAgent.model, "haiku");
    assert.equal(codexAgent.effort, "low");
    assert.equal(codexAgent.maxTurns, "3");
    assert.deepEqual(
      JSON.parse(codexAgent.tools),
      ["mcp__plugin_fleet_fleet__forward"],
    );
  }
  assert.equal(planner.model, "opus");
  assert.equal(planner.effort, "high");
  assert.deepEqual(JSON.parse(planner.tools), ["Read", "Glob", "Grep"]);
  assert.deepEqual(
    JSON.parse(planner.disallowedTools),
    [
      "Bash",
      "Edit",
      "Write",
      "Agent",
      "mcp__plugin_fleet_fleet__forward",
      "mcp__plugin_fleet_fleet__await",
      "mcp__plugin_fleet_fleet__status",
      "mcp__plugin_fleet_fleet__check",
    ],
  );
});

test("Fleet skill remains the single user-facing door", async () => {
  // Given
  const skill = await readFrontmatter("skills/fleet/SKILL.md");

  // When
  const name = skill.name;

  // Then
  assert.equal(name, "fleet");
  assert.deepEqual(
    skill["allowed-tools"].split(",").map((tool) => tool.trim()),
    [
      "Agent",
      "Read",
      "mcp__plugin_fleet_fleet__route",
      "mcp__plugin_fleet_fleet__forward",
      "mcp__plugin_fleet_fleet__await",
      "mcp__plugin_fleet_fleet__status",
      "mcp__plugin_fleet_fleet__check",
    ],
  );
});

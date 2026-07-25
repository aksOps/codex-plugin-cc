import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function walk(dir, predicate, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".generated" || entry.name === "node_modules") {
        continue;
      }
      walk(full, predicate, found);
      continue;
    }
    if (predicate(full)) {
      found.push(full);
    }
  }
  return found;
}

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g;
const DYNAMIC_IMPORT = /import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

function collectRelativeSpecifiers(source) {
  const specifiers = [];
  for (const pattern of [RELATIVE_IMPORT, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

test("no plugin module imports anything outside the plugin directory", () => {
  const escapes = [];

  for (const file of walk(PLUGIN_ROOT, (candidate) => candidate.endsWith(".mjs"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of collectRelativeSpecifiers(source)) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!resolved.startsWith(`${PLUGIN_ROOT}${path.sep}`)) {
        escapes.push(`${path.relative(ROOT, file)} -> ${specifier}`);
      }
    }
  }

  assert.deepEqual(escapes, [], "a fresh install ships only plugins/codex, so imports must not escape it");
});

test("plugin runtime code declares no third-party dependencies", () => {
  const bare = [];
  const allowedBuiltins = /^node:/;

  for (const file of walk(PLUGIN_ROOT, (candidate) => candidate.endsWith(".mjs"))) {
    const source = fs.readFileSync(file, "utf8");
    const pattern = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"'.][^"']*)["']/g;
    let match = pattern.exec(source);
    while (match) {
      if (!allowedBuiltins.test(match[1])) {
        bare.push(`${path.relative(ROOT, file)} -> ${match[1]}`);
      }
      match = pattern.exec(source);
    }
  }

  assert.deepEqual(bare, [], "the plugin must run from a plugin install with no npm install step");
});

test("every hook command resolves inside the plugin", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
  const commands = Object.values(hooks.hooks)
    .flat()
    .flatMap((entry) => entry.hooks ?? [])
    .map((entry) => entry.command);

  assert.equal(commands.length > 0, true);
  for (const command of commands) {
    assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${command} must be plugin-root relative`);
    const scriptMatch = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/);
    assert.notEqual(scriptMatch, null, `${command} must name a script`);
    assert.equal(
      fs.existsSync(path.join(PLUGIN_ROOT, scriptMatch[1])),
      true,
      `${scriptMatch[1]} referenced by a hook must exist`
    );
  }
});

test("every command file references only scripts the plugin ships", () => {
  const commandDir = path.join(PLUGIN_ROOT, "commands");
  const referenced = new Set();

  for (const file of fs.readdirSync(commandDir)) {
    const source = fs.readFileSync(path.join(commandDir, file), "utf8");
    const pattern = /\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g;
    let match = pattern.exec(source);
    while (match) {
      referenced.add(match[1]);
      match = pattern.exec(source);
    }
  }

  assert.equal(referenced.size > 0, true);
  for (const relative of referenced) {
    assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, relative)), true, `${relative} must ship with the plugin`);
  }
});

test("the plugin manifest and marketplace entry agree on identity", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = marketplace.plugins.find((candidate) => candidate.name === plugin.name);

  assert.notEqual(entry, undefined, "the marketplace must list the plugin");
  assert.equal(entry.version, plugin.version);
  assert.equal(entry.source, "./plugins/codex");
  assert.equal(marketplace.owner.name, plugin.author.name);
});

test("the archived prototype is never reachable from plugin code", () => {
  const offenders = [];
  for (const file of walk(PLUGIN_ROOT, (candidate) => candidate.endsWith(".mjs") || candidate.endsWith(".md"))) {
    const source = fs.readFileSync(file, "utf8");
    if (/from\s+["'][^"']*archive\/fleet-v0/.test(source) || /import\(\s*["'][^"']*archive\/fleet-v0/.test(source)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], "FORK_SCOPE forbids importing the archived Fleet prototype");
});

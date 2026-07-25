import { execFile as execFileCallback } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { inspectCodexAccount } from "./codex/auth.mjs";
import {
  getFleetCodexHome,
  getVendoredCodexPath,
} from "./codex/client.mjs";
import { TOOL_DEFINITIONS } from "./mcp/server.mjs";

const execFile = promisify(execFileCallback);
const MINIMUM_NODE_MAJOR = 22;
const EXPECTED_MCP_TOOL_COUNT = 5;

function check(name, passed, detail) {
  return {
    name,
    status: passed ? "pass" : "fail",
    detail,
  };
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function readPackageVersion(repoRoot, packageName) {
  const manifestPath = path.join(
    repoRoot,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return manifest.version;
}

async function defaultGitWorktreeProbe(repoRoot) {
  await execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  return true;
}

export async function runDoctor({
  repoRoot,
  codexHome = getFleetCodexHome(),
  environment = process.env,
  inspectAccount = inspectCodexAccount,
  nodeVersion = process.versions.node,
  probeGitWorktree = defaultGitWorktreeProbe,
} = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot ?? process.cwd());
  const resolvedCodexHome = path.resolve(codexHome);
  const checks = [];

  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  checks.push(
    check("node", nodeMajor >= MINIMUM_NODE_MAJOR, {
      minimumMajor: MINIMUM_NODE_MAJOR,
      version: nodeVersion,
    }),
  );

  const anthropicBaseUrl = environment.ANTHROPIC_BASE_URL;
  checks.push(
    check(
      "anthropic-base-url",
      anthropicBaseUrl === undefined || anthropicBaseUrl === "",
      {
        configured: anthropicBaseUrl !== undefined && anthropicBaseUrl !== "",
      },
    ),
  );

  const codexPath = getVendoredCodexPath(resolvedRepoRoot);
  try {
    const [sdkVersion, codexVersion] = await Promise.all([
      readPackageVersion(resolvedRepoRoot, "@openai/codex-sdk"),
      readPackageVersion(resolvedRepoRoot, "@openai/codex"),
      access(codexPath),
    ]);
    checks.push(
      check(
        "vendored-codex",
        sdkVersion === codexVersion && sdkVersion === "0.145.0",
        {
          codexPath,
          codexVersion,
          sdkVersion,
          usesPath: false,
        },
      ),
    );
  } catch (error) {
    checks.push(
      check("vendored-codex", false, {
        codexPath,
        error: error instanceof Error ? error.message : String(error),
        usesPath: false,
      }),
    );
  }

  let codexHomeReady = false;
  if (isInside(resolvedRepoRoot, resolvedCodexHome)) {
    checks.push(
      check("codex-home", false, {
        codexHome: resolvedCodexHome,
        outsideRepo: false,
      }),
    );
  } else {
    try {
      const homeStat = await stat(resolvedCodexHome);
      const mode = homeStat.mode & 0o777;
      codexHomeReady = homeStat.isDirectory() && mode === 0o700;
      checks.push(
        check("codex-home", codexHomeReady, {
          codexHome: resolvedCodexHome,
          mode: mode.toString(8).padStart(3, "0"),
          outsideRepo: true,
        }),
      );
    } catch (error) {
      checks.push(
        check("codex-home", false, {
          codexHome: resolvedCodexHome,
          error: error instanceof Error ? error.message : String(error),
          outsideRepo: true,
        }),
      );
    }
  }

  let account;
  if (codexHomeReady) {
    try {
      account = await inspectAccount({
        repoRoot: resolvedRepoRoot,
        codexHome: resolvedCodexHome,
      });
    } catch (error) {
      account = {
        authenticated: false,
        models: [],
        planType: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  checks.push(
    check(
      "codex-login",
      account?.authenticated === true &&
        typeof account.planType === "string" &&
        account.planType.length > 0,
      {
        authenticated: account?.authenticated === true,
        authMode: account?.authMode ?? null,
        planType: account?.planType ?? null,
        ...(account?.error === undefined ? {} : { error: account.error }),
      },
    ),
  );
  checks.push(
    check("codex-models", (account?.models?.length ?? 0) > 0, {
      count: account?.models?.length ?? 0,
    }),
  );

  try {
    const available = await probeGitWorktree(resolvedRepoRoot);
    checks.push(check("git-worktree", available === true, { available }));
  } catch (error) {
    checks.push(
      check("git-worktree", false, {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  checks.push(
    check(
      "mcp-tools",
      TOOL_DEFINITIONS.length === EXPECTED_MCP_TOOL_COUNT,
      {
        count: TOOL_DEFINITIONS.length,
        expected: EXPECTED_MCP_TOOL_COUNT,
        names: TOOL_DEFINITIONS.map(({ name }) => name),
      },
    ),
  );

  return {
    ok: checks.every(({ status }) => status === "pass"),
    checks,
  };
}

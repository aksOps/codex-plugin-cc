import fs from "node:fs";
import path from "node:path";

import { POLICY_RELATIVE_PATH, SUPPORTED_POLICY_VERSION, loadPolicy, resolvePolicyPath } from "./policy.mjs";

// Generate a starting .codex-plugin/policy.json from what the repository already declares
// about itself: its directory layout and its toolchain marker files. The output is a
// suggestion for the human to review and commit, never a widening of anything — a generated
// policy grants exactly what a hand-written one would, and the fail-closed rule (no committed
// policy file, no write agents) is unchanged.

// Directories that must never become writable by default: VCS state, dependency trees, build
// output, CI definitions, and the policy's own directory.
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".github",
  ".claude",
  ".claude-plugin",
  ".codex-plugin",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "tmp"
]);

const TEST_DIRECTORY_NAMES = new Set(["test", "tests", "__tests__", "spec", "e2e"]);

const ROOT_CODE_EXTENSIONS = new Set(["js", "mjs", "cjs", "ts", "mts", "tsx", "jsx", "py", "go", "rs", "sh"]);

const NPM_DEFAULT_TEST_SCRIPT = 'echo "Error: no test specified" && exit 1';

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function detectNodePackageManager(repoRoot) {
  if (fs.existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(repoRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (fs.existsSync(path.join(repoRoot, "bun.lockb")) || fs.existsSync(path.join(repoRoot, "bun.lock"))) {
    return "bun";
  }
  return "npm";
}

function detectToolchain(repoRoot) {
  const packageJson = readJsonFile(path.join(repoRoot, "package.json"));
  if (packageJson !== null) {
    const testScript = packageJson?.scripts?.test;
    const packageManager = detectNodePackageManager(repoRoot);
    const hasRealTestScript = typeof testScript === "string" && testScript.trim() !== "" && testScript !== NPM_DEFAULT_TEST_SCRIPT;
    return {
      name: "node",
      testGlobs: ["**/*.test.*", "**/*.spec.*"],
      verification: hasRealTestScript
        ? [{ id: "test", argv: [packageManager, "test"], expect: { exitCode: 0 }, required: true }]
        : []
    };
  }
  if (fs.existsSync(path.join(repoRoot, "go.mod"))) {
    return {
      name: "go",
      testGlobs: ["**/*_test.go"],
      verification: [{ id: "test", argv: ["go", "test", "./..."], expect: { exitCode: 0 }, required: true }]
    };
  }
  if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
    return {
      name: "rust",
      testGlobs: ["tests/**", "benches/**"],
      verification: [{ id: "test", argv: ["cargo", "test"], expect: { exitCode: 0 }, required: true }]
    };
  }
  const hasPytestMarker =
    fs.existsSync(path.join(repoRoot, "pytest.ini")) ||
    fs.existsSync(path.join(repoRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(repoRoot, "setup.py"));
  if (hasPytestMarker) {
    return {
      name: "python",
      testGlobs: ["**/test_*.py", "**/*_test.py"],
      verification: [{ id: "test", argv: ["python3", "-m", "pytest"], expect: { exitCode: 0 }, required: true }]
    };
  }
  if (fs.existsSync(path.join(repoRoot, "Makefile"))) {
    const makefile = fs.readFileSync(path.join(repoRoot, "Makefile"), "utf8");
    if (/^test\s*:/m.test(makefile)) {
      return {
        name: "make",
        testGlobs: [],
        verification: [{ id: "test", argv: ["make", "test"], expect: { exitCode: 0 }, required: true }]
      };
    }
  }
  return { name: "unknown", testGlobs: [], verification: [] };
}

/**
 * Inspect the repository and report what the generator has to work with. Pure read.
 */
export function detectRepoProfile(repoRoot) {
  const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  const sourceDirectories = [];
  const testDirectories = [];
  const rootExtensions = new Set();

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      if (TEST_DIRECTORY_NAMES.has(entry.name)) {
        testDirectories.push(entry.name);
      } else {
        sourceDirectories.push(entry.name);
      }
      continue;
    }
    if (entry.isFile()) {
      const extension = path.extname(entry.name).slice(1);
      if (ROOT_CODE_EXTENSIONS.has(extension)) {
        rootExtensions.add(extension);
      }
    }
  }

  return {
    toolchain: detectToolchain(repoRoot),
    sourceDirectories: sourceDirectories.sort(),
    testDirectories: testDirectories.sort(),
    rootExtensions: [...rootExtensions].sort()
  };
}

/**
 * Build a policy object from a profile. Write agents get the detected source tree plus
 * Markdown; the test agent gets test directories and the toolchain's test-file patterns.
 * Landing stays manual (`allowAutoLand: false`) — enabling auto-land is a deliberate,
 * human decision, not something a generator should default on.
 */
export function generatePolicy(profile) {
  const sourceGlobs = [
    ...profile.sourceDirectories.map((name) => `${name}/**`),
    ...profile.testDirectories.map((name) => `${name}/**`),
    ...profile.rootExtensions.map((extension) => `*.${extension}`),
    "*.md"
  ];

  const testGlobs = [
    ...profile.testDirectories.map((name) => `${name}/**`),
    ...profile.toolchain.testGlobs
  ];

  return {
    version: SUPPORTED_POLICY_VERSION,
    agents: {
      explore: { capability: "read" },
      verify: { capability: "read" },
      implement: { capability: "write", writableGlobs: sourceGlobs },
      test: { capability: "write", writableGlobs: testGlobs.length > 0 ? testGlobs : sourceGlobs },
      rescue: { capability: "write", writableGlobs: sourceGlobs }
    },
    verification: profile.toolchain.verification,
    limits: {
      maxDurationMs: 900000,
      maxOutputBytes: 1048576,
      maxConcurrentJobs: 3,
      network: "off",
      envPassthrough: ["PATH", "HOME", "LANG"]
    },
    landing: {
      allowAutoLand: false,
      requireCleanTree: true
    }
  };
}

/**
 * Write the generated policy and prove it loads under the same fail-closed validation the
 * runtime uses. A generated file the runtime would reject is a generator bug, so it is
 * removed rather than left in place looking authoritative.
 *
 * @returns {{ policyPath: string, overwritten: boolean }}
 */
export function writeGeneratedPolicy(repoRoot, policy, options = {}) {
  const policyPath = resolvePolicyPath(repoRoot);
  const exists = fs.existsSync(policyPath);
  if (exists && !options.force) {
    throw new Error(`${POLICY_RELATIVE_PATH} already exists. Re-run with --force to overwrite it.`);
  }

  const previous = exists ? fs.readFileSync(policyPath) : null;
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

  const loaded = loadPolicy(repoRoot);
  if (!loaded.ok) {
    if (previous !== null) {
      fs.writeFileSync(policyPath, previous);
    } else {
      fs.rmSync(policyPath, { force: true });
    }
    throw new Error(`Generated policy failed validation and was not kept: ${loaded.reason}`);
  }

  return { policyPath, overwritten: exists };
}

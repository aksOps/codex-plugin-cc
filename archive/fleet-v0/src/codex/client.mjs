import { access, chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Codex } from "@openai/codex-sdk";

const FORWARDED_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
];

export const DEFAULT_CODEX_HOME = path.join(
  os.homedir(),
  ".local",
  "share",
  "fleet",
  "codex-home",
);

export function getFleetCodexHome() {
  return DEFAULT_CODEX_HOME;
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

function sanitizeSearchPath(searchPath, homeDirectory) {
  const globalCodexHome = path.join(homeDirectory, ".codex");
  return searchPath
    .split(path.delimiter)
    .filter(
      (entry) =>
        entry === "" ||
        !path.isAbsolute(entry) ||
        !isInside(globalCodexHome, entry),
    )
    .join(path.delimiter);
}

export class CodexIsolationError extends Error {
  name = "CodexIsolationError";

  constructor(codexHome) {
    super(`Fleet CODEX_HOME must be outside the repository: ${codexHome}`);
    this.codexHome = codexHome;
  }
}

export class VendoredCodexError extends Error {
  name = "VendoredCodexError";

  constructor(codexPath, options) {
    super(`Fleet's vendored Codex binary is unavailable: ${codexPath}`, options);
    this.codexPath = codexPath;
  }
}

export function resolveVendoredCodexPath(repoRoot) {
  return path.resolve(repoRoot, "node_modules", ".bin", "codex");
}

export function getVendoredCodexPath(repoRoot) {
  return resolveVendoredCodexPath(repoRoot);
}

export function buildCodexEnvironment({
  codexHome,
  environment = process.env,
}) {
  const result = {};
  for (const key of FORWARDED_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) {
      result[key] = environment[key];
    }
  }
  if (result.PATH !== undefined) {
    result.PATH = sanitizeSearchPath(
      result.PATH,
      environment.HOME ?? os.homedir(),
    );
  }
  result.CODEX_HOME = path.resolve(codexHome);
  return result;
}

export async function prepareCodexHome({
  repoRoot,
  codexHome = DEFAULT_CODEX_HOME,
}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedCodexHome = path.resolve(codexHome);

  if (isInside(resolvedRepoRoot, resolvedCodexHome)) {
    throw new CodexIsolationError(resolvedCodexHome);
  }

  await mkdir(resolvedCodexHome, { mode: 0o700, recursive: true });
  await chmod(resolvedCodexHome, 0o700);
  return resolvedCodexHome;
}

export async function createCodexClient({
  repoRoot,
  codexHome = DEFAULT_CODEX_HOME,
  environment = process.env,
}) {
  const preparedHome = await prepareCodexHome({ repoRoot, codexHome });
  const codexPath = resolveVendoredCodexPath(repoRoot);

  try {
    await access(codexPath);
  } catch (error) {
    throw new VendoredCodexError(codexPath, { cause: error });
  }

  return new Codex({
    codexPathOverride: codexPath,
    env: buildCodexEnvironment({
      codexHome: preparedHome,
      environment,
    }),
  });
}

// Environment isolation for processes the plugin spawns on a job's behalf.
//
// Codex owns authentication and reads its credentials from the Codex home directory, not from
// the environment, so a spawned process needs only enough environment to find its interpreter
// and home. Everything credential-shaped is dropped even when a policy lists it: a policy
// mistake should not be able to hand an API key to a verification command.

const BASELINE_NAMES = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "CODEX_HOME",
  // Windows needs these to resolve a usable process environment at all.
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "windir"
];

const CREDENTIAL_PATTERNS = [
  /(^|_)TOKEN$/i,
  /(^|_)TOKENS$/i,
  /(^|_)KEY$/i,
  /(^|_)KEYS$/i,
  /(^|_)SECRET$/i,
  /(^|_)SECRETS$/i,
  /(^|_)PASSWORD$/i,
  /(^|_)PASSWD$/i,
  /(^|_)CREDENTIALS$/i,
  /(^|_)SESSION$/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
  /^GOOGLE_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^NPM_/i,
  /^SSH_/i,
  /^GPG_/i
];

export function isCredentialLikeName(name) {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Build an allowlisted environment.
 *
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {{ passthrough?: string[], extra?: Record<string, string> }} [options]
 *   `passthrough` adds policy-declared names; `extra` sets values the plugin controls itself and
 *   is applied after filtering, so callers can inject values the allowlist would otherwise drop.
 * @returns {{ env: Record<string, string>, dropped: string[] }}
 */
export function buildIsolatedEnv(baseEnv = {}, options = {}) {
  const allowed = new Set([...BASELINE_NAMES, ...(options.passthrough ?? [])]);
  const env = {};
  const dropped = [];

  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) {
      continue;
    }
    if (!allowed.has(name)) {
      dropped.push(name);
      continue;
    }
    if (isCredentialLikeName(name)) {
      // Allowlisted but credential-shaped: policy does not get to override this.
      dropped.push(name);
      continue;
    }
    env[name] = value;
  }

  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value !== undefined) {
      env[name] = String(value);
    }
  }

  return { env, dropped: dropped.sort() };
}

export { BASELINE_NAMES };

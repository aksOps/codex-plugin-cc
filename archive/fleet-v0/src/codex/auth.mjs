import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import readline from "node:readline";

import {
  buildCodexEnvironment,
  DEFAULT_CODEX_HOME,
  prepareCodexHome,
  resolveVendoredCodexPath,
} from "./client.mjs";

const CLIENT_INFO = {
  name: "fleet",
  version: "0.1.0",
};
const INITIALIZE_PARAMS = {
  capabilities: { experimentalApi: true },
  clientInfo: CLIENT_INFO,
};

export class CodexAppServerError extends Error {
  name = "CodexAppServerError";

  constructor(message, options) {
    super(message, options);
  }
}

class AppServerSession {
  #child;
  #events = new EventEmitter();
  #nextId = 1;
  #pending = new Map();
  #stderr = "";

  constructor({ codexPath, environment }) {
    this.#child = spawn(codexPath, ["app-server", "--stdio"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4_096);
    });
    this.#child.on("error", (error) => this.#failPending(error));
    this.#child.on("exit", (code, signal) => {
      this.#failPending(
        new CodexAppServerError(
          `Codex app-server exited before responding (code=${code}, signal=${signal})${this.#stderr ? `: ${this.#stderr}` : ""}`,
        ),
      );
    });

    const lines = readline.createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
  }

  async initialize() {
    await this.request("initialize", INITIALIZE_PARAMS);
    this.notify("initialized", {});
  }

  request(method, params) {
    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
    this.#write({ id, method, params });
    return response;
  }

  notify(method, params) {
    this.#write({ method, params });
  }

  waitForNotification(method) {
    return once(this.#events, method).then(([params]) => params);
  }

  onNotification(method, handler) {
    this.#events.on(method, handler);
    return () => this.#events.off(method, handler);
  }

  async close() {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return;
    }
    const exited = once(this.#child, "exit");
    this.#child.kill("SIGTERM");
    await exited;
  }

  #write(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#failPending(
        new CodexAppServerError("Codex app-server emitted invalid JSON", {
          cause: error,
        }),
      );
      return;
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(
          new CodexAppServerError(
            `Codex app-server request failed: ${JSON.stringify(message.error)}`,
          ),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      this.#events.emit(message.method, message.params);
    }
  }

  #failPending(error) {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export async function openCodexAppServer({
  repoRoot,
  codexHome = DEFAULT_CODEX_HOME,
  codexPath,
  environment = process.env,
}) {
  const preparedHome = await prepareCodexHome({ repoRoot, codexHome });
  const session = new AppServerSession({
    codexPath: codexPath ?? resolveVendoredCodexPath(repoRoot),
    environment: buildCodexEnvironment({
      codexHome: preparedHome,
      environment,
    }),
  });

  try {
    await session.initialize();
    return session;
  } catch (error) {
    await session.close();
    throw new CodexAppServerError(
      "Unable to initialize the Codex app-server",
      { cause: error },
    );
  }
}

export async function inspectCodexAccount(options) {
  const session = await openCodexAppServer(options);
  try {
    const accountResult = await session.request("account/read", {
      refreshToken: false,
    });
    const modelResult =
      accountResult.account === null
        ? { data: [] }
        : await session.request("model/list", {
            includeHidden: false,
          });
    return {
      authenticated: accountResult.account !== null,
      authMode: accountResult.account?.type ?? null,
      models: modelResult.data
        .filter((model) => model.hidden !== true)
        .map((model) => model.id),
      planType: accountResult.account?.planType ?? null,
      requiresOpenaiAuth: accountResult.requiresOpenaiAuth,
    };
  } finally {
    await session.close();
  }
}

export async function getCodexAuthStatus(options) {
  const account = await inspectCodexAccount(options);
  return {
    authenticated: account.authenticated,
    authMode: account.authMode,
    planType: account.planType,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
  };
}

export async function startCodexDeviceLogin(options) {
  const session = await openCodexAppServer(options);
  const completedNotification = session.waitForNotification(
    "account/login/completed",
  );

  try {
    const login = await session.request("account/login/start", {
      type: "chatgptDeviceCode",
    });
    const completed = completedNotification.then((result) => {
      if (result.loginId !== login.loginId) {
        throw new CodexAppServerError(
          `Codex login completion did not match ${login.loginId}`,
        );
      }
      return {
        loginId: result.loginId,
        success: result.success,
      };
    });

    return {
      close: () => session.close(),
      completed,
      loginId: login.loginId,
      userCode: login.userCode,
      verificationUrl: login.verificationUrl,
    };
  } catch (error) {
    await session.close();
    throw new CodexAppServerError("Unable to start Codex device login", {
      cause: error,
    });
  }
}

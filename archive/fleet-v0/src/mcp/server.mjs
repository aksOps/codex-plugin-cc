import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startCodexQuotaMonitor } from "../codex/quota.mjs";
import { TOOL_DEFINITIONS } from "./definitions.mjs";
import { createToolHandler } from "./tools.mjs";

const SERVER_INFO = Object.freeze({ name: "fleet", version: "0.1.0" });
const PROTOCOL_VERSION = "2025-06-18";
const FLEET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export { TOOL_DEFINITIONS };

export function createFleetMcpServer(dependencies = {}) {
  const callTool = createToolHandler(dependencies);

  async function handleRequest(message) {
    const { id, method, params = {} } = message;
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOL_DEFINITIONS },
        };
      case "tools/call":
        try {
          return {
            jsonrpc: "2.0",
            id,
            result: toolResult(
              await callTool(params.name, params.arguments),
            ),
          };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id,
            result: toolResult(
              {
                error: errorMessage(error),
                next: "Correct the arguments or inspect the Run with status.",
              },
              true,
            ),
          };
        }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  return Object.freeze({ callTool, handleRequest });
}

export async function runStdioServer(options = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    dependencies = {},
    environment = process.env,
  } = options;
  let quotaMonitor;
  let quotaSnapshot;
  if (dependencies.getQuota === undefined) {
    try {
      quotaMonitor = await startCodexQuotaMonitor({
        repoRoot: FLEET_ROOT,
        quotaPath: resolve(FLEET_ROOT, ".fleet", "quota.json"),
        codexFloor: Number(environment.FLEET_CODEX_FLOOR ?? 85),
        ...(environment.FLEET_CODEX_HOME === undefined
          ? {}
          : { codexHome: environment.FLEET_CODEX_HOME }),
        environment,
      });
    } catch (error) {
      quotaSnapshot = {
        codexAvailable: false,
        claudeAvailable: true,
        error: errorMessage(error),
      };
    }
  }
  const server = createFleetMcpServer({
    ...dependencies,
    ...(dependencies.getQuota !== undefined
      ? {}
      : {
          getQuota: () =>
            quotaMonitor?.getSnapshot() ?? quotaSnapshot,
        }),
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      let response;
      try {
        response = await server.handleRequest(JSON.parse(line));
      } catch (error) {
        response = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: errorMessage(error) },
        };
      }
      if (response !== undefined) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    }
  } finally {
    await quotaMonitor?.close();
  }
}

const entryUrl =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(resolve(process.argv[1])).href;

if (entryUrl === import.meta.url) {
  runStdioServer().catch((error) => {
    process.stderr.write(`fleet MCP server failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor } from "./doctor.mjs";
import { readEvents } from "./fleet/events.mjs";
import { calculateStats } from "./fleet/stats.mjs";
import { route } from "./router/rules.mjs";

function parseDoctorArguments(arguments_) {
  const options = {
    codexHome: undefined,
    json: false,
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--codex-home") {
      options.codexHome = arguments_[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown doctor option: ${argument}`);
  }

  return options;
}

function printDoctorReport(report) {
  for (const item of report.checks) {
    const marker = item.status === "pass" ? "PASS" : "FAIL";
    process.stdout.write(
      `${marker} ${item.name} ${JSON.stringify(item.detail)}\n`,
    );
  }
  process.stdout.write(report.ok ? "Fleet doctor passed.\n" : "Fleet doctor failed.\n");
}

function parseRouteArguments(arguments_) {
  const explain = arguments_.includes("--explain");
  const positional = arguments_.filter((argument) => argument !== "--explain");
  if (positional.length !== 1 || positional[0].trim() === "") {
    throw new Error("Usage: node src/cli.mjs route <step> [--explain]");
  }
  return { explain, step: positional[0] };
}

function printRoute(decision, explain) {
  if (!explain) {
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Rule: ${decision.rule}\n`);
  process.stdout.write(
    `Tiers: ${decision.tiers.map(({ tier }) => tier).join(" + ")}\n`,
  );
  process.stdout.write(`Shape: ${JSON.stringify(decision.shape)}\n`);
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "stats") {
    if (arguments_.length !== 1 || arguments_[0].trim() === "") {
      throw new Error("Usage: node src/cli.mjs stats <events.jsonl>");
    }
    const report = calculateStats(await readEvents(path.resolve(arguments_[0])));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command === "route") {
    const options = parseRouteArguments(arguments_);
    printRoute(route(options.step), options.explain);
    return;
  }
  if (command !== "doctor") {
    throw new Error(
      "Usage: node src/cli.mjs <doctor|route|stats> [options]",
    );
  }

  const options = parseDoctorArguments(arguments_);
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const report = await runDoctor({
    repoRoot,
    ...(options.codexHome === undefined
      ? {}
      : { codexHome: options.codexHome }),
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printDoctorReport(report);
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `fleet: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

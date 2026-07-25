#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LARGE_INLINE_CHARACTERS = 4_000;
const LARGE_INLINE_LINES = 80;
const INTERNAL_AGENT_TYPES = new Set(["fleet:planner"]);
const ROUTE_CONTEXT_PATTERN =
  /<fleet-route approved="true">\nIntent: (?<intent>[^\n]+)\nFiles: (?<files>[^\n]+)\nCheck Kind: (?<checkKind>command|review)\n<\/fleet-route>/;
const FORWARD_CONTEXT_PATTERN =
  /^\n<fleet-forward>\n(?<payload>[^\r\n]+)\n<\/fleet-forward>(?:\n|$)/;
const FORWARD_TOOL = "mcp__plugin_fleet_fleet__forward";

function hookOutput(fields) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...fields,
    },
  };
}

function passThrough(context) {
  return hookOutput({ additionalContext: context });
}

function toolName(input) {
  return input.tool_name ?? input.toolName;
}

function toolInput(input) {
  const value = input.tool_input ?? input.toolInput;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function inlineEditText(input) {
  return [input.content, input.new_string, input.newString]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function isLargeInlineEdit(input) {
  const text = inlineEditText(input);
  return (
    text.length >= LARGE_INLINE_CHARACTERS ||
    text.split("\n").length >= LARGE_INLINE_LINES
  );
}

function routeContext(decision) {
  const targets = decision.tiers.map(({ tier }) => tier).join(" + ");
  return `fleet: rule ${decision.rule} -> ${targets}`;
}

function approvedRoutingStep(prompt) {
  const match = ROUTE_CONTEXT_PATTERN.exec(prompt);
  if (match?.groups === undefined) {
    return null;
  }
  return {
    envelope: match[0],
    envelopeEnd: match.index + match[0].length,
    intent: match.groups.intent,
    files:
      match.groups.files === "none"
        ? []
        : match.groups.files.split(",").map((file) => file.trim()),
    checkKind: match.groups.checkKind,
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function forwardPayload(prompt, step) {
  const match = FORWARD_CONTEXT_PATTERN.exec(prompt.slice(step.envelopeEnd));
  if (match?.groups === undefined) {
    return { ok: false, reason: "missing <fleet-forward> block" };
  }

  let payload;
  try {
    payload = JSON.parse(match.groups.payload);
  } catch {
    return { ok: false, reason: "malformed <fleet-forward> JSON" };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "forward payload must be a JSON object" };
  }
  if (
    payload.provider !== "codex" ||
    !nonEmptyString(payload.stepId) ||
    !nonEmptyString(payload.intent)
  ) {
    return {
      ok: false,
      reason: "forward payload requires provider codex, stepId, and intent",
    };
  }
  if (payload.intent !== step.intent) {
    return { ok: false, reason: "forward intent does not match route intent" };
  }

  const isExistingRun = Object.hasOwn(payload, "runId");
  const expectedKeys = isExistingRun
    ? ["provider", "intent", "stepId", "runId"]
    : ["provider", "intent", "stepId", "repoPath", "plan", "approved"];
  if (!exactKeys(payload, expectedKeys)) {
    return { ok: false, reason: "forward payload fields are not exact" };
  }
  if (isExistingRun) {
    if (!nonEmptyString(payload.runId)) {
      return { ok: false, reason: "existing Run requires a nonempty runId" };
    }
  } else if (
    !nonEmptyString(payload.repoPath) ||
    !nonEmptyString(payload.plan) ||
    payload.approved !== true
  ) {
    return {
      ok: false,
      reason: "new Run requires repoPath, plan, and approved true",
    };
  }
  return { ok: true, payload };
}

function canonicalProxyPrompt(step, payload) {
  return `${step.envelope}
<fleet-forward>
${JSON.stringify(payload)}
</fleet-forward>
Call ${FORWARD_TOOL} exactly once using the exact JSON object in <fleet-forward>. Do not retry. Return the result unchanged.`;
}

function handleAgent(input, routeStep) {
  const currentInput = toolInput(input);
  const requestedTier = currentInput.subagent_type ?? currentInput.subagentType;
  if (INTERNAL_AGENT_TYPES.has(requestedTier)) {
    return passThrough("fleet: planner is lifecycle infrastructure; routing skipped.");
  }

  const prompt =
    typeof currentInput.prompt === "string" ? currentInput.prompt : "";
  const step = approvedRoutingStep(prompt);
  if (step === null) {
    return passThrough(
      "fleet: routing requires an approved /fleet Plan; original Agent input preserved.",
    );
  }

  const decision = routeStep(step);
  const targets = decision.tiers.map(({ tier }) => tier);
  if (decision.provider === "codex") {
    const forward = forwardPayload(prompt, step);
    if (!forward.ok) {
      return passThrough(
        `fleet: Codex routing skipped: ${forward.reason}; original Agent input preserved.`,
      );
    }
    return hookOutput({
      permissionDecision: "allow",
      permissionDecisionReason: routeContext(decision),
      updatedInput: {
        ...currentInput,
        prompt: canonicalProxyPrompt(step, forward.payload),
        subagent_type: decision.tiers[0].tier,
      },
      additionalContext:
        targets.length === 1
          ? routeContext(decision)
          : `${routeContext(decision)}; the hook starts the primary tier only.`,
    });
  }
  if (targets.includes(requestedTier)) {
    return passThrough(`${routeContext(decision)}; requested tier already fits.`);
  }

  const replacementTier = decision.tiers[0].tier;
  return hookOutput({
    permissionDecision: "allow",
    permissionDecisionReason: routeContext(decision),
    updatedInput: {
      ...currentInput,
      subagent_type: replacementTier,
    },
    additionalContext:
      targets.length === 1
        ? routeContext(decision)
        : `${routeContext(decision)}; the hook starts the primary tier only.`,
  });
}

function handleInlineEdit(input, routeStep) {
  const currentInput = toolInput(input);
  if (!isLargeInlineEdit(currentInput)) {
    return passThrough("fleet: inline edit is below the delegation threshold.");
  }

  const filePath =
    currentInput.file_path ?? currentInput.filePath ?? "the target file";
  const decision = routeStep({
    intent: `Implement a large change in ${filePath}`,
    files: [filePath],
    size: "large",
  });
  return hookOutput({
    permissionDecision: "deny",
    permissionDecisionReason:
      `${routeContext(decision)}. Do not retry this large inline edit. ` +
      `Start /fleet so the change is planned, approved, and delegated to ` +
      `${decision.tiers[0].tier}.`,
  });
}

export function handleHookInput(input, environment = process.env, routeStep) {
  if (environment.FLEET_HOOK_DISABLE === "1") {
    return passThrough("fleet: routing disabled by FLEET_HOOK_DISABLE=1.");
  }
  if (environment.FLEET_HOOK_INJECT_ERROR === "1") {
    throw new Error("injected Fleet hook failure");
  }
  if (typeof routeStep !== "function") {
    throw new Error("Fleet router is unavailable");
  }

  const name = toolName(input);
  if (name === "Agent" || name === "Task") {
    return handleAgent(input, routeStep);
  }
  if (name === "Edit" || name === "Write") {
    return handleInlineEdit(input, routeStep);
  }
  return passThrough("fleet: tool is outside the routing surface.");
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let output;
  try {
    const source = await readStandardInput();
    const { route } = await import("../../../src/router/rules.mjs");
    output = handleHookInput(JSON.parse(source), process.env, route);
  } catch {
    output = passThrough("fleet: router unavailable; original tool input preserved.");
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}

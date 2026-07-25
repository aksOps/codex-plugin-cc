import { createHash } from "node:crypto";

const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECK_KINDS = new Set(["command", "review"]);
const OUTCOMES = new Set(["pass", "fail", "halt", "unverified"]);

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanError";
  }
}

function fail(message, lineNumber) {
  const location = lineNumber === undefined ? "" : ` at line ${lineNumber}`;
  throw new PlanError(`${message}${location}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has invalid fields`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
    fail(`${label} must be a non-empty single-line string`);
  }
  return value.trim();
}

function stepId(value, label) {
  const id = nonEmptyString(value, label);
  if (!STEP_ID.test(id)) {
    fail(`${label} must be a valid Step ID`);
  }
  return id;
}

function ownedFile(value) {
  const file = nonEmptyString(value, "Owned file");
  if (
    file.startsWith("/") || file.includes("\\") || file.endsWith("/") ||
    file.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("Owned file must be a repository-relative file path");
  }
  return file;
}

function stringList(value, label, parser) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  const parsed = value.map((item) => parser(item, label));
  if (new Set(parsed).size !== parsed.length) {
    fail(`${label} must not contain duplicates`);
  }
  return parsed;
}

function validateCriteria(step) {
  if (step.checkKind === "command") {
    if (!isRecord(step.criteria)) {
      fail(`Step ${step.id} command criteria must be an object`);
    }
    exactKeys(step.criteria, ["command", "expected"], `Step ${step.id} criteria`);
    return {
      command: nonEmptyString(step.criteria.command, `Step ${step.id} Command`),
      expected: nonEmptyString(step.criteria.expected, `Step ${step.id} Expected`),
    };
  }
  if (!isRecord(step.criteria)) {
    fail(`Step ${step.id} review criteria must be an object`);
  }
  exactKeys(step.criteria, ["review"], `Step ${step.id} criteria`);
  return { review: nonEmptyString(step.criteria.review, `Step ${step.id} Review`) };
}

function assertAcyclic(steps) {
  const state = new Map();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (step) => {
    const status = state.get(step.id);
    if (status === "visiting") {
      fail(`Plan dependencies contain a cycle at Step ${step.id}`);
    }
    if (status === "visited") {
      return;
    }
    state.set(step.id, "visiting");
    step.dependencies.forEach((dependency) => visit(byId.get(dependency)));
    state.set(step.id, "visited");
  };
  steps.forEach(visit);
}

export function validatePlan(value) {
  if (!isRecord(value)) {
    fail("Plan must be an object");
  }
  exactKeys(value, ["intent", "steps"], "Plan");
  const intent = nonEmptyString(value.intent, "Plan Intent");
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    fail("Plan must contain at least one Step");
  }
  const steps = value.steps.map((rawStep) => {
    if (!isRecord(rawStep)) {
      fail("Step must be an object");
    }
    exactKeys(rawStep, ["id", "intent", "dependencies", "files", "checkKind", "criteria"], "Step");
    const id = stepId(rawStep.id, "Step ID");
    const checkKind = nonEmptyString(rawStep.checkKind, `Step ${id} Check Kind`);
    if (!CHECK_KINDS.has(checkKind)) {
      fail(`Step ${id} Check Kind must be command or review`);
    }
    const step = {
      id,
      intent: nonEmptyString(rawStep.intent, `Step ${id} Intent`),
      dependencies: stringList(rawStep.dependencies, `Step ${id} Dependencies`, stepId),
      files: stringList(rawStep.files, `Step ${id} Files`, ownedFile),
      checkKind,
      criteria: rawStep.criteria,
    };
    if (step.files.length === 0) {
      fail(`Step ${id} must own at least one file`);
    }
    return { ...step, criteria: validateCriteria(step) };
  });
  if (new Set(steps.map((step) => step.id)).size !== steps.length) {
    fail("Plan Step IDs must be unique");
  }
  const knownSteps = new Set(steps.map((step) => step.id));
  steps.forEach((step) => step.dependencies.forEach((dependency) => {
    if (dependency === step.id || !knownSteps.has(dependency)) {
      fail(`Step ${step.id} has an invalid dependency: ${dependency}`);
    }
  }));
  assertAcyclic(steps);
  return { intent, steps };
}

function parseField(line, lineNumber) {
  const match = /^([A-Za-z][A-Za-z ]*):[ \t]*(\S(?:.*\S)?)$/.exec(line);
  if (match === null) {
    fail("Expected a named Plan field", lineNumber);
  }
  return { name: match[1], value: match[2] };
}

function parseFields(fields, allowed, lineNumber) {
  const parsed = new Map();
  fields.forEach(({ name, value }) => {
    if (!allowed.has(name) || parsed.has(name)) {
      fail(`Unexpected or repeated field: ${name}`, lineNumber);
    }
    parsed.set(name, value);
  });
  return parsed;
}

function required(fields, name, lineNumber) {
  const value = fields.get(name);
  if (value === undefined) {
    fail(`Missing required field: ${name}`, lineNumber);
  }
  return value;
}

function parseDelimited(value, label, lineNumber) {
  if (value === "none") {
    return [];
  }
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "")) {
    fail(`${label} must be comma-separated values or none`, lineNumber);
  }
  return entries;
}

export function parsePlan(markdown) {
  if (typeof markdown !== "string") {
    fail("Plan Markdown must be a string");
  }
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1 || lines[first] !== "# Fleet Plan") {
    fail("Plan must begin with # Fleet Plan");
  }
  const rootFields = [];
  const sections = [];
  let current = null;
  for (let index = first + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      continue;
    }
    const heading = /^## Step ([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(line);
    if (heading !== null) {
      current = { id: heading[1], fields: [], lineNumber: index + 1 };
      sections.push(current);
      continue;
    }
    const field = parseField(line, index + 1);
    (current === null ? rootFields : current.fields).push(field);
  }
  const root = parseFields(rootFields, new Set(["Intent"]), first + 1);
  const steps = sections.map((section) => {
    const common = new Set(["Intent", "Dependencies", "Files", "Check Kind", "Command", "Expected", "Review"]);
    const fields = parseFields(section.fields, common, section.lineNumber);
    const checkKind = required(fields, "Check Kind", section.lineNumber);
    const requiredNames = checkKind === "command"
      ? ["Intent", "Dependencies", "Files", "Check Kind", "Command", "Expected"]
      : ["Intent", "Dependencies", "Files", "Check Kind", "Review"];
    if (!CHECK_KINDS.has(checkKind) || fields.size !== requiredNames.length || requiredNames.some((name) => !fields.has(name))) {
      fail(`Step ${section.id} fields do not match Check Kind`, section.lineNumber);
    }
    return {
      id: section.id,
      intent: required(fields, "Intent", section.lineNumber),
      dependencies: parseDelimited(required(fields, "Dependencies", section.lineNumber), "Dependencies", section.lineNumber),
      files: parseDelimited(required(fields, "Files", section.lineNumber), "Files", section.lineNumber),
      checkKind,
      criteria: checkKind === "command"
        ? { command: required(fields, "Command", section.lineNumber), expected: required(fields, "Expected", section.lineNumber) }
        : { review: required(fields, "Review", section.lineNumber) },
    };
  });
  return validatePlan({ intent: required(root, "Intent", first + 1), steps });
}

export function serializePlan(value) {
  const plan = validatePlan(value);
  const lines = ["# Fleet Plan", "", `Intent: ${plan.intent}`];
  plan.steps.forEach((step) => {
    lines.push("", `## Step ${step.id}`, `Intent: ${step.intent}`);
    lines.push(`Dependencies: ${step.dependencies.join(", ") || "none"}`);
    lines.push(`Files: ${step.files.join(", ")}`, `Check Kind: ${step.checkKind}`);
    if (step.checkKind === "command") {
      lines.push(`Command: ${step.criteria.command}`, `Expected: ${step.criteria.expected}`);
    } else {
      lines.push(`Review: ${step.criteria.review}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

export function digestPlan(markdown) {
  if (typeof markdown !== "string") {
    fail("Plan Markdown must be a string");
  }
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

export function resolveCriterionOutcome({ checkKind, checked, outcome }) {
  if (!CHECK_KINDS.has(checkKind) || typeof checked !== "boolean" || !OUTCOMES.has(outcome)) {
    fail("Criterion outcome has an invalid shape");
  }
  return checkKind === "review" || !checked ? "unverified" : outcome;
}

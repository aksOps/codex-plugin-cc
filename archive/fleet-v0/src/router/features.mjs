import { parseRoutingStep } from "../contracts.mjs";

const RISK_PATTERNS = [
  ["security", /\b(?:auth(?:entication|orization)?|credential|permission|security|vulnerabilit)/],
  ["concurrency", /\b(?:async race|concurren|deadlock|race condition|thread safety)/],
  ["migration", /\b(?:data|database|schema)?\s*migrat(?:e|ion|ing)\b/],
];

function inferKind(intent) {
  for (const [kind, pattern] of RISK_PATTERNS) {
    if (pattern.test(intent)) {
      return kind;
    }
  }
  if (/\b(?:debug|diagnos|root cause|unexplained|reproduce (?:a |the )?(?:bug|failure))/.test(intent)) {
    return "debug";
  }
  if (/\brefactor(?:ing)?\b/.test(intent)) {
    return "refactor";
  }
  if (
    /\b(?:add|author|create|implement|write)\b.*\btests?\b/.test(intent) ||
    /\btest authoring\b/.test(intent)
  ) {
    return "test";
  }
  if (/\b(?:explore|find|inspect|locate|search|survey|trace)\b/.test(intent)) {
    return "explore";
  }
  if (/\b(?:format|mechanical|rename|reorder|sort|typo|whitespace)\b/.test(intent)) {
    return "mechanical";
  }
  return "implement";
}

function inferredFileCount(intent, files) {
  if (files.length > 0) {
    return files.length;
  }
  const count = /\b(\d+|one|two|three)\s+files?\b/.exec(intent)?.[1];
  if (count === undefined) {
    if (/\bsingle[- ]file\b/.test(intent)) {
      return 1;
    }
    return new Set(
      intent.match(/\b(?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]+\b/g) ?? [],
    ).size;
  }
  return { one: 1, two: 2, three: 3 }[count] ?? Number.parseInt(count, 10);
}

function filesCrossModules(files) {
  const roots = new Set(
    files
      .filter((file) => file.includes("/"))
      .map((file) => file.split("/", 1)[0]),
  );
  return roots.size > 1;
}

function inferSize(intent, fileCount, crossModule, newModule) {
  if (
    newModule ||
    crossModule ||
    fileCount >= 3 ||
    /\b(?:large|multi[- ]module|project[- ]wide)\b/.test(intent)
  ) {
    return "large";
  }
  if (
    (fileCount >= 1 && fileCount <= 2) ||
    /\b(?:small|tiny)\b/.test(intent)
  ) {
    return "small";
  }
  return "medium";
}

export function extractFeatures(value) {
  const step = parseRoutingStep(value);
  const intent = step.intent.toLowerCase();
  const fileCount = inferredFileCount(intent, step.files);
  const crossModule =
    step.crossModule ??
    (/\b(?:across|cross|multiple|several)[- ]modules?\b/.test(intent) ||
      filesCrossModules(step.files));
  const newModule =
    step.newModule ?? /\b(?:create|new|introduce)\b.*\bmodule\b/.test(intent);
  const kind = step.kind ?? inferKind(intent);
  const unknownRootCause =
    step.unknownRootCause ??
    (kind === "debug" &&
      /\b(?:unknown|unclear|unexplained)\b.*\b(?:cause|failure|bug)?\b/.test(intent));
  const verifiable =
    step.verifiable ??
    (step.checkKind === "command" ||
      /\b(?:command check|machine[- ]checkable|verifiable)\b/.test(intent) ||
      /\b(?:execute|run)\b.*\b(?:build|check|lint|tests?)\b/.test(intent));
  return {
    kind,
    size: step.size ?? inferSize(intent, fileCount, crossModule, newModule),
    fileCount,
    verifiable,
    crossModule,
    newModule,
    unknownRootCause,
  };
}

export function featuresFromText(text, options = {}) {
  return extractFeatures({ ...options, intent: text });
}

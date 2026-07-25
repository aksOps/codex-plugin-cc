export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "forward",
    description:
      "Forward one dependency-eligible approved Step attempt to its actual Fleet Route in an isolated child worktree. Independent file-disjoint Steps may run concurrently. After a failed check, the next forward uses the returned ladder Route. An optional provider asserts the expected Route and is rejected on mismatch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "stepId"],
      properties: {
        repoPath: {
          type: "string",
          minLength: 1,
          description: "Absolute target git repository path for a new Run.",
        },
        runId: {
          type: "string",
          minLength: 1,
          description: "Existing Run ID for a subsequent approved Step.",
        },
        provider: {
          type: "string",
          enum: ["codex", "claude"],
          description: "Optional Route assertion. Rejected if it differs from the actual Route.",
        },
        intent: {
          type: "string",
          minLength: 1,
          description: "Exact approved Step intent.",
        },
        stepId: {
          type: "string",
          minLength: 1,
          description: "Plan Step ID used in the Event log.",
        },
        plan: {
          type: "string",
          minLength: 1,
          description:
            "Exact approved Fleet Plan. Required when creating a Run.",
        },
        approved: {
          type: "boolean",
          description:
            "True only after the user explicitly approved the supplied Plan.",
        },
      },
      anyOf: [{ required: ["repoPath"] }, { required: ["runId"] }],
    },
  },
  {
    name: "route",
    description:
      "Resolve the deterministic Route for one exact approved Plan Step without starting it. Use the approved Plan before creating a Run, or an existing runId after creation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "stepId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Existing Run ID whose persisted approved Plan supplies the Step.",
        },
        intent: {
          type: "string",
          minLength: 1,
          description: "Exact approved Step intent.",
        },
        stepId: {
          type: "string",
          minLength: 1,
          description: "Exact approved Plan Step ID.",
        },
        plan: {
          type: "string",
          minLength: 1,
          description: "Exact approved Fleet Plan when no runId exists yet.",
        },
        approved: {
          type: "boolean",
          description: "True only after the user explicitly approved the supplied Plan.",
        },
      },
      anyOf: [{ required: ["runId"] }, { required: ["plan", "approved"] }],
    },
  },
  {
    name: "await",
    description:
      "Wait for the exact Codex Step and rung previously started by forward. Returns the worker result and child diff. Call check afterward even when the worker fails. Use status instead for non-blocking scheduler and pool state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "stepId", "rung"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Opaque Run ID returned by forward.",
        },
        stepId: {
          type: "string",
          minLength: 1,
          description: "Exact approved Plan Step ID returned by forward.",
        },
        rung: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Exact ladder rung returned by forward.",
        },
      },
    },
  },
  {
    name: "status",
    description:
      "Read Fleet Run scheduler, exact attempt, Codex pool, and reviewable Run diff state without waiting.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Opaque Run ID returned by forward.",
        },
      },
    },
  },
  {
    name: "check",
    description:
      "Evaluate the exact forwarded Step attempt. Command criteria run in its child worktree. Terminal pass or unverified merges declared files into the Run worktree and reaps the child; failure returns the next bounded ladder Route or halts after rung 3.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "stepId", "rung"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Opaque Run ID returned by forward.",
        },
        stepId: {
          type: "string",
          minLength: 1,
          description: "Exact approved Plan Step ID forwarded for this attempt.",
        },
        rung: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "Exact ladder rung returned by forward.",
        },
        workerError: {
          type: "string",
          minLength: 1,
          description: "Optional Claude worker error for this attempt.",
        },
        failureEvidence: {
          type: "string",
          minLength: 1,
          description: "Optional Claude failure evidence for this attempt.",
        },
      },
    },
  },
]);

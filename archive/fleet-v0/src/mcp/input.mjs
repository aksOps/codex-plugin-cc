export class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function parseObject(value, toolName) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${toolName} requires an arguments object.`);
  }
  return value;
}

export function stringField(input, field, toolName, optional = false) {
  const value = input[field];
  if (optional && value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`${toolName} requires a non-empty ${field}.`);
  }
  return value;
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Row contract shared with the Python replay engine
 * (`.docs/SPECS/harness-core/parity-meter-replay.md`).
 *
 * The ledger row is the single contract between the live extension and replay.
 * `tests/row-schema.json` mirrors `ROW_JSON_SCHEMA`; the row contract test fails on drift.
 */

export const SCHEMA_VERSION = 1;

/**
 * Rule calibration version (spec `parity-meter-rule-calibration`, decision 3).
 * Version 2 = rule 1 counts ghosts against the session-start/agent-end union,
 * rule 3 counts only repeats inside `REPEAT_WINDOW_SEC`.
 * The Python engine declares the same value; the row contract test compares them through the schema fixture.
 */
export const RULES_VERSION = 2;

/**
 * Repeat-read window in seconds: a repeat read of an untouched path counts
 * only inside this gap. Fixed by decision (RSI-08), never tuned: the observed
 * true positive was 39s, the observed false positive was 4.5h.
 * Mirrored in `parity_meter/rules.py` as `REPEAT_WINDOW_SEC`.
 */
export const REPEAT_WINDOW_SEC = 900;

/** Field order of a ledger row. The replay engine lists the same fields. */
export const ROW_FIELDS = [
  "schema_version",
  "rules_version",
  "session_id",
  "session_file",
  "provider",
  "model",
  "thinking",
  "req",
  "avg_input",
  "avg_cache_read",
  "avg_output",
  "reasoning",
  "reasoning_share",
  "cost_total",
  "cost_cache_share",
  "cost_output_share",
  "protocol_errors",
  "tool_seq_sha",
  "tool_seq_len",
  "parse_errors",
  "attribution",
  "schema_snapshot",
  "schema_basis",
  "emitted_at",
] as const;

export type Attribution = "full" | "partial" | "unknown";

export interface ProtocolErrors {
  total: number;
  tool_name_not_in_schema: number;
  args_fail_schema: number;
  repeat_read_unchanged: number;
}

export interface ParityRow {
  schema_version: number;
  rules_version: number;
  session_id: string;
  session_file: string;
  provider: string;
  model: string;
  thinking: string;
  req: number;
  avg_input: number;
  avg_cache_read: number;
  avg_output: number;
  reasoning: number;
  reasoning_share: number;
  cost_total: number;
  cost_cache_share: number;
  cost_output_share: number;
  protocol_errors: ProtocolErrors | null;
  tool_seq_sha: string;
  tool_seq_len: number;
  parse_errors: number;
  attribution: Attribution;
  schema_snapshot: boolean;
  schema_basis: string;
  emitted_at: string;
}

/** JSON Schema of one tool as registered with pi (a TypeBox schema serialized to JSON). */
export type JsonSchema = Record<string, unknown>;

/** Sidecar written at session start: registered tool schemas replay validates against. */
export interface ToolSchemaSnapshot {
  schema_version: number;
  captured_at: string;
  tools: Record<string, JsonSchema>;
}

const PROTOCOL_ERRORS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["total", "tool_name_not_in_schema", "args_fail_schema", "repeat_read_unchanged"],
  properties: {
    total: { type: "integer", minimum: 0 },
    tool_name_not_in_schema: { type: "integer", minimum: 0 },
    args_fail_schema: { type: "integer", minimum: 0 },
    repeat_read_unchanged: { type: "integer", minimum: 0 },
  },
};

/**
 * Canonical row schema, `schema_version: 1`, `rules_version: 2`.
 * `tests/row-schema.json` is the fixture copy compared by the row contract test.
 */
export const ROW_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://parity-meter/row.schema.json",
  title: "parity-meter ledger row",
  type: "object",
  additionalProperties: false,
  required: [...ROW_FIELDS],
  properties: {
    schema_version: { type: "integer", const: SCHEMA_VERSION },
    rules_version: { type: "integer", const: RULES_VERSION },
    session_id: { type: "string", minLength: 1 },
    session_file: { type: "string", minLength: 1 },
    provider: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    thinking: { type: "string", minLength: 1 },
    req: { type: "integer", minimum: 0 },
    avg_input: { type: "number", minimum: 0 },
    avg_cache_read: { type: "number", minimum: 0 },
    avg_output: { type: "number", minimum: 0 },
    reasoning: { type: "number", minimum: 0 },
    reasoning_share: { type: "number", minimum: 0, maximum: 1 },
    cost_total: { type: "number", minimum: 0 },
    cost_cache_share: { type: "number", minimum: 0, maximum: 1 },
    cost_output_share: { type: "number", minimum: 0, maximum: 1 },
    protocol_errors: {
      anyOf: [{ type: "null" }, PROTOCOL_ERRORS_SCHEMA],
    },
    tool_seq_sha: { type: "string", pattern: "^[0-9a-f]{64}$" },
    tool_seq_len: { type: "integer", minimum: 0 },
    parse_errors: { type: "integer", minimum: 0 },
    attribution: { type: "string", enum: ["full", "partial", "unknown"] },
    schema_snapshot: { type: "boolean" },
    schema_basis: { type: "string", minLength: 1 },
    emitted_at: { type: "string", minLength: 1 },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (isObject(left) && isObject(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function matchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((item) => matchesType(value, item));
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return true;
  }
}

/**
 * Minimal JSON Schema validator for the keywords this contract uses.
 * Returns a list of violations; an empty list means the value conforms.
 */
export function validateValue(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (!isObject(schema)) return errors;

  if ("const" in schema && !sameValue(value, schema.const)) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameValue(item, value))) {
    errors.push(`${path}: value is outside the enum`);
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    const matched = branches.some((branch) => validateValue(value, branch, path).length === 0);
    if (!matched) errors.push(`${path}: matches no allowed branch`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf as JsonSchema[]) {
      errors.push(...validateValue(value, branch, path));
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as JsonSchema[];
    const matches = branches.filter((branch) => validateValue(value, branch, path).length === 0).length;
    if (matches !== 1) errors.push(`${path}: matches ${matches} branches, expected exactly one`);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}`);
    return errors;
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) errors.push(`${path}: missing required field "${key}"`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) errors.push(...validateValue(value[key], child as JsonSchema, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}: unexpected field "${key}"`);
      }
    } else if (isObject(schema.additionalProperties)) {
      for (const [key, child] of Object.entries(value)) {
        if (!(key in properties)) {
          errors.push(...validateValue(child, schema.additionalProperties, `${path}.${key}`));
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: needs at least ${schema.minItems} items`);
    }
    if (isObject(schema.items)) {
      value.forEach((item, index) => errors.push(...validateValue(item, schema.items as JsonSchema, `${path}[${index}]`)));
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  return errors;
}

import { isPlainObject, type BoardState, type Template, type TemplateField, type TemplateFieldType, type TemplateValues } from "./types.js";

export const TEMPLATE_FIELD_TYPES = ["text", "textarea", "number", "select", "checkbox"] as const;

const FIELD_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const MAX_FIELDS = 32;
const MAX_TEXT = 500;
const MAX_TEXTAREA = 4000;

export type TemplateUpsertInput = {
  id?: string;
  key?: string;
  title: string;
  description?: string;
  html: string;
  fields?: unknown;
  titleTemplate?: string;
  initialState?: BoardState;
  stateVersion?: number;
};

export function parseTemplateFields(raw: unknown): TemplateField[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("fields must be an array");
  }
  if (raw.length > MAX_FIELDS) {
    throw new Error(`fields is too long (max ${MAX_FIELDS})`);
  }
  const seen = new Set<string>();
  return raw.map((item, index) => parseField(item, index, seen));
}

export function parseTemplateValues(fields: TemplateField[], raw: unknown): TemplateValues {
  const input = isPlainObject(raw) ? raw : {};
  const values: TemplateValues = {};
  for (const field of fields) {
    if (field.key in input) {
      values[field.key] = coerceFieldValue(field, input[field.key]);
    } else if (field.default !== undefined) {
      values[field.key] = field.default;
    } else if (field.type === "checkbox") {
      values[field.key] = false;
    } else if (field.type === "number") {
      values[field.key] = field.min ?? 0;
    } else {
      values[field.key] = "";
    }
    if (field.required && isEmptyValue(field, values[field.key])) {
      throw new Error(`${field.label} is required`);
    }
  }
  return values;
}

export function substituteTemplate(source: string, values: TemplateValues, escape: boolean): string {
  return source.replace(PLACEHOLDER, (_, key: string) => {
    const raw = values[key];
    const text = raw === undefined || raw === null ? "" : String(raw);
    return escape ? escapeHtml(text) : text;
  });
}

export function renderTemplateTitle(template: Pick<Template, "title" | "titleTemplate" | "fields">, values: TemplateValues): string {
  if (template.titleTemplate?.trim()) {
    const title = substituteTemplate(template.titleTemplate, values, false).trim();
    return title || template.title;
  }
  if (template.fields.some((field) => field.key === "title")) {
    const title = String(values.title ?? "").trim();
    if (title) {
      return title;
    }
  }
  return template.title;
}

export function normalizeTemplateInput(input: TemplateUpsertInput): {
  title: string;
  description: string;
  html: string;
  fields: TemplateField[];
  titleTemplate?: string;
  initialState?: BoardState;
  stateVersion?: number;
} {
  const title = input.title.trim();
  if (!title) {
    throw new Error("title is required");
  }
  const html = input.html.trim();
  if (!html) {
    throw new Error("html is required");
  }
  const fields = parseTemplateFields(input.fields);
  const titleTemplate = optionalTrimmed(input.titleTemplate);
  if (titleTemplate) {
    assertKnownPlaceholders(titleTemplate, fields, "titleTemplate");
  }
  assertKnownPlaceholders(html, fields, "html");
  let initialState: BoardState | undefined;
  if (input.initialState !== undefined) {
    if (!isPlainObject(input.initialState)) {
      throw new Error("initialState must be a JSON object");
    }
    initialState = { ...input.initialState };
  }
  let stateVersion: number | undefined;
  if (input.stateVersion !== undefined) {
    if (!Number.isInteger(input.stateVersion) || input.stateVersion < 1) {
      throw new Error("stateVersion must be an integer >= 1");
    }
    stateVersion = input.stateVersion;
  }
  return {
    title,
    description: (input.description ?? "").trim(),
    html: input.html,
    fields,
    ...(titleTemplate ? { titleTemplate } : {}),
    ...(initialState ? { initialState } : {}),
    ...(stateVersion !== undefined ? { stateVersion } : {}),
  };
}

/** Same content means the same template, regardless of id, key, or timestamps. */
export function templateFingerprint(
  template: Pick<Template, "title" | "description" | "html" | "fields" | "titleTemplate" | "initialState" | "stateVersion">
): string {
  return stableJson({
    title: template.title,
    description: template.description,
    html: template.html,
    fields: template.fields,
    titleTemplate: template.titleTemplate ?? null,
    initialState: template.initialState ?? null,
    stateVersion: template.stateVersion,
  });
}

export function mergeTemplateValues(fields: TemplateField[], current: TemplateValues | undefined): TemplateValues {
  return parseTemplateValues(fields, current ?? {});
}

function parseField(raw: unknown, index: number, seen: Set<string>): TemplateField {
  if (!isPlainObject(raw)) {
    throw new Error(`fields[${index}] must be an object`);
  }
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  if (!FIELD_KEY.test(key)) {
    throw new Error(`fields[${index}].key must be a JS identifier`);
  }
  if (seen.has(key)) {
    throw new Error(`fields[${index}].key is duplicated: ${key}`);
  }
  seen.add(key);
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) {
    throw new Error(`fields[${index}].label is required`);
  }
  const type = parseFieldType(raw.type, index);
  const field: TemplateField = { key, label, type };
  if (raw.required === true) {
    field.required = true;
  }
  if (typeof raw.placeholder === "string" && raw.placeholder.trim()) {
    field.placeholder = raw.placeholder.trim();
  }
  if (typeof raw.help === "string" && raw.help.trim()) {
    field.help = raw.help.trim();
  }
  if (typeof raw.min === "number" && Number.isFinite(raw.min)) {
    field.min = raw.min;
  }
  if (typeof raw.max === "number" && Number.isFinite(raw.max)) {
    field.max = raw.max;
  }
  if (type === "select") {
    field.options = parseOptions(raw.options, index);
  }
  if (raw.default !== undefined) {
    field.default = coerceFieldValue(field, raw.default);
  }
  return field;
}

function parseFieldType(value: unknown, index: number): TemplateFieldType {
  if (typeof value !== "string") {
    throw new Error(`fields[${index}].type is required`);
  }
  for (const type of TEMPLATE_FIELD_TYPES) {
    if (value === type) {
      return type;
    }
  }
  throw new Error(`fields[${index}].type must be text, textarea, number, select, or checkbox`);
}

function parseOptions(raw: unknown, index: number): { value: string; label: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`fields[${index}].options is required for select`);
  }
  return raw.map((item, optionIndex) => {
    if (typeof item === "string") {
      const value = item.trim();
      if (!value) {
        throw new Error(`fields[${index}].options[${optionIndex}] is empty`);
      }
      return { value, label: value };
    }
    if (!isPlainObject(item)) {
      throw new Error(`fields[${index}].options[${optionIndex}] is invalid`);
    }
    const value = typeof item.value === "string" ? item.value.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : value;
    if (!value) {
      throw new Error(`fields[${index}].options[${optionIndex}].value is required`);
    }
    return { value, label: label || value };
  });
}

function coerceFieldValue(field: TemplateField, raw: unknown): string | number | boolean {
  switch (field.type) {
    case "text":
    case "textarea": {
      const text = raw == null ? "" : String(raw);
      const max = field.type === "textarea" ? MAX_TEXTAREA : MAX_TEXT;
      if (text.length > max) {
        throw new Error(`${field.label} is too long (max ${max})`);
      }
      return text;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) {
        throw new Error(`${field.label} must be a number`);
      }
      if (field.min !== undefined && n < field.min) {
        throw new Error(`${field.label} must be at least ${field.min}`);
      }
      if (field.max !== undefined && n > field.max) {
        throw new Error(`${field.label} must be at most ${field.max}`);
      }
      return n;
    }
    case "checkbox":
      if (typeof raw === "boolean") {
        return raw;
      }
      if (raw === "true" || raw === 1 || raw === "1") {
        return true;
      }
      if (raw === "false" || raw === 0 || raw === "0" || raw === "") {
        return false;
      }
      throw new Error(`${field.label} must be true or false`);
    case "select": {
      const value = raw == null ? "" : String(raw);
      const options = field.options ?? [];
      if (!options.some((option) => option.value === value)) {
        throw new Error(`${field.label} must be one of the listed options`);
      }
      return value;
    }
    default: {
      const _never: never = field.type;
      return _never;
    }
  }
}

function isEmptyValue(field: TemplateField, value: string | number | boolean): boolean {
  switch (field.type) {
    case "text":
    case "textarea":
    case "select":
      return String(value).trim() === "";
    case "number":
      return typeof value !== "number";
    case "checkbox":
      return false;
    default: {
      const _never: never = field.type;
      return _never;
    }
  }
}

function assertKnownPlaceholders(source: string, fields: TemplateField[], where: string): void {
  const keys = new Set(fields.map((field) => field.key));
  const unknown = new Set<string>();
  source.replace(PLACEHOLDER, (_, key: string) => {
    if (!keys.has(key)) {
      unknown.add(key);
    }
    return "";
  });
  if (unknown.size) {
    throw new Error(`${where} uses unknown field(s): ${[...unknown].join(", ")}`);
  }
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

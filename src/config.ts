import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Config, Ref } from "./types.ts";

/** An explicit path wins; otherwise a project override wins over the user default. */
export function configPath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.PI_FUSION_CONFIG) return resolve(cwd, env.PI_FUSION_CONFIG);
  const project = resolve(cwd, ".pi/fusion.json");
  if (existsSync(project)) return project;
  const configHome =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
  return join(configHome, "pi", "fusion.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const ROOT_KEYS = new Set([
  "$schema",
  "router",
  "fast",
  "strong",
  "judge",
  "critics",
  "defaultAuthor",
  "timeoutMs",
  "reviewEvidence",
  "budget",
]);
const REF_KEYS = new Set(["provider", "id"]);
const EVIDENCE_KEYS = new Set(["includeUntracked"]);
const BUDGET_KEYS = new Set([
  "maxReviewerCalls",
  "maxTaskCostUsd",
  "maxReviewMs",
]);

function checkUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  errors: string[],
): void {
  for (const key of Object.keys(record))
    if (!allowed.has(key))
      errors.push(`${prefix ? `${prefix}.${key}` : key}: unknown field`);
}

function checkRef(value: unknown, field: string, errors: string[]): void {
  if (!isRecord(value)) return void errors.push(`${field}: expected an object`);
  checkUnknownKeys(value, REF_KEYS, field, errors);
  for (const key of ["provider", "id"])
    if (typeof value[key] !== "string" || !value[key])
      errors.push(`${field}.${key}: expected a non-empty string`);
  if (value.provider === "fusion")
    errors.push(`${field}: must not point to the fusion provider`);
}

/** Collect every problem with a raw config so users can fix them in one pass. */
export function configErrors(parsed: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(parsed)) return ["config: expected a JSON object"];
  checkUnknownKeys(parsed, ROOT_KEYS, "", errors);
  for (const role of ["router", "fast", "strong", "judge"])
    checkRef(parsed[role], role, errors);
  if (!Array.isArray(parsed.critics) || parsed.critics.length === 0)
    errors.push("critics: expected a non-empty array");
  else
    parsed.critics.forEach((c, i) => {
      checkRef(c, `critics[${i}]`, errors);
    });
  if (parsed.defaultAuthor !== "fast" && parsed.defaultAuthor !== "strong")
    errors.push('defaultAuthor: expected "fast" or "strong"');
  if (parsed.timeoutMs !== undefined && !positive(parsed.timeoutMs))
    errors.push("timeoutMs: expected a positive number");
  const evidence = parsed.reviewEvidence;
  if (evidence !== undefined) {
    if (!isRecord(evidence)) errors.push("reviewEvidence: expected an object");
    else {
      checkUnknownKeys(evidence, EVIDENCE_KEYS, "reviewEvidence", errors);
      if (
        evidence.includeUntracked !== undefined &&
        typeof evidence.includeUntracked !== "boolean"
      )
        errors.push("reviewEvidence.includeUntracked: expected a boolean");
    }
  }
  const budget = parsed.budget;
  if (budget !== undefined) {
    if (!isRecord(budget)) errors.push("budget: expected an object");
    else {
      checkUnknownKeys(budget, BUDGET_KEYS, "budget", errors);
      const calls = budget.maxReviewerCalls;
      if (
        calls !== undefined &&
        (!Number.isSafeInteger(calls) || (calls as number) < 0)
      )
        errors.push("budget.maxReviewerCalls: expected a nonnegative integer");
      if (
        budget.maxTaskCostUsd !== undefined &&
        !positive(budget.maxTaskCostUsd)
      )
        errors.push("budget.maxTaskCostUsd: expected a positive number");
      if (budget.maxReviewMs !== undefined && !positive(budget.maxReviewMs))
        errors.push("budget.maxReviewMs: expected a positive number");
    }
  }
  return errors;
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read fusion configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const errors = configErrors(raw);
  if (errors.length)
    throw new Error(
      `Invalid fusion configuration ${path}:\n- ${errors.join("\n- ")}`,
    );
  const typed = raw as Config;
  return { ...typed, timeoutMs: typed.timeoutMs ?? 15000 };
}

/** Every distinct physical chat model the configuration depends on. */
export function configuredRefs(config: Config): Ref[] {
  const seen = new Map<string, Ref>();
  for (const ref of [
    config.fast,
    config.strong,
    config.judge,
    ...config.critics,
  ])
    seen.set(`${ref.provider}/${ref.id}`, ref);
  return [...seen.values()];
}

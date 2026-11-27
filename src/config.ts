import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "./fusion.ts";

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

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
export function loadConfig(path: string): Config {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Config;
  for (const role of [
    parsed.router,
    parsed.fast,
    parsed.strong,
    parsed.judge,
    ...(parsed.critics ?? []),
  ]) {
    if (!role?.provider || !role.id || role.provider === "fusion")
      throw new Error(`Invalid physical model in ${path}`);
  }
  if (
    !parsed.critics?.length ||
    !["fast", "strong"].includes(parsed.defaultAuthor)
  )
    throw new Error(`Invalid fusion configuration: ${path}`);
  parsed.timeoutMs ??= 15000;
  if (!positive(parsed.timeoutMs))
    throw new Error(`Invalid timeoutMs in ${path}`);
  if (
    parsed.reviewEvidence !== undefined &&
    (typeof parsed.reviewEvidence !== "object" ||
      parsed.reviewEvidence === null ||
      Array.isArray(parsed.reviewEvidence) ||
      (typeof parsed.reviewEvidence.includeUntracked !== "undefined" &&
        typeof parsed.reviewEvidence.includeUntracked !== "boolean"))
  )
    throw new Error(`Invalid reviewEvidence in ${path}`);
  const budget = parsed.budget;
  if (
    budget &&
    (typeof budget !== "object" ||
      (budget.maxReviewerCalls !== undefined &&
        (!Number.isSafeInteger(budget.maxReviewerCalls) ||
          budget.maxReviewerCalls < 0)) ||
      (budget.maxTaskCostUsd !== undefined &&
        !positive(budget.maxTaskCostUsd)) ||
      (budget.maxReviewMs !== undefined && !positive(budget.maxReviewMs)))
  )
    throw new Error(`Invalid fusion budget in ${path}`);
  return parsed;
}

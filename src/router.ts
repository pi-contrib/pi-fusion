import type { Message } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { bounded, chat, logFailure, parseJson, text } from "./model.ts";
import { routePrompt, tierPrompt } from "./prompts.ts";
import {
  type Config,
  type FusionEffort,
  type Route,
  type RouteSignal,
  routeSignals,
  type State,
  type Tier,
  type Workflow,
} from "./types.ts";

export function routeExplanation(
  signal: unknown,
  workflow: Workflow,
  tier: Tier,
): string {
  const consistent =
    signal === "fast-draft"
      ? workflow === "cascade"
      : signal === "review-risk"
        ? workflow === "critique"
        : signal === "complex"
          ? workflow === "single" && tier === "strong"
          : signal === "straightforward"
            ? workflow === "single"
            : false;
  return consistent && routeSignals.includes(signal as RouteSignal)
    ? `router signal: ${signal}`
    : `policy: ${workflow}`;
}

export function fusionEffort(level: string): FusionEffort {
  return level === "xhigh" ? "max" : level === "high" ? "high" : "standard";
}

const effortLabels: Record<FusionEffort, string> = {
  standard: "Fusion Standard",
  high: "Fusion High",
  max: "Fusion Max",
};
export function effortLabel(effort: FusionEffort): string {
  return effortLabels[effort];
}

export function routeOptions(
  effort: FusionEffort,
  reviewerLimit = Infinity,
): { workflows: Workflow[]; tiers: Tier[] } {
  const workflows: Workflow[] = ["single"];
  if (effort === "high" && reviewerLimit >= 1) workflows.push("cascade");
  if (effort !== "standard" && reviewerLimit >= 2) workflows.push("critique");
  return {
    workflows,
    tiers: effort === "max" ? ["strong"] : ["fast", "strong"],
  };
}

export function workflowLimit(config: Config): number {
  return config.budget?.maxReviewerCalls === undefined
    ? Infinity
    : Math.min(config.critics.length, config.budget.maxReviewerCalls);
}

export function validateRoute(
  value: unknown,
  effort: FusionEffort,
  reviewerLimit = Infinity,
): Route {
  if (!value || typeof value !== "object") throw new Error("Invalid route");
  const v = value as Record<string, unknown>;
  const { workflows, tiers } = routeOptions(effort, reviewerLimit);
  if (
    !workflows.includes(v.workflow as Workflow) ||
    !tiers.includes(v.tier as Tier)
  )
    throw new Error("Route not allowed at this effort");
  if (v.workflow === "cascade" && v.tier !== "fast")
    throw new Error("Cascade must start fast");
  return { workflow: v.workflow as Workflow, tier: v.tier as Tier };
}

type ClassifyOptions = {
  ctx: ExtensionContext;
  router: Config["router"];
  request: string;
  effort: FusionEffort;
  reviewerLimit: number;
  signal: AbortSignal;
  recordCost: (cost: number) => void;
  recordSignal: (signal: unknown) => void;
  forced?: Workflow;
};

/** Ask a Pi classifier model (supplied by provider extensions) for a route. */
async function classify(o: ClassifyOptions): Promise<Route> {
  const { ctx, router, effort, forced } = o;
  const options = routeOptions(effort, o.reviewerLimit);
  const { tiers } = options;
  const workflows = forced ? [forced] : options.workflows;
  const questions = {
    ...(!forced && workflows.length > 1
      ? {
          workflow: {
            type: "choice" as const,
            instructions: routePrompt,
            criteria: Object.fromEntries(
              workflows.map((w) => [
                w,
                {
                  single: "Routine clear task",
                  cascade: "Fast draft with escalation gate",
                  critique: "Independent parallel review",
                }[w],
              ]),
            ),
          },
        }
      : {}),
    ...(!forced
      ? {
          signal: {
            type: "choice" as const,
            instructions:
              "Select one short task signal from the shared route rubric. Use straightforward or complex for Single, fast-draft for Cascade, review-risk for Critique.",
            criteria: {
              straightforward: "Clear bounded task",
              complex: "Clear task requiring a stronger author",
              "fast-draft": "Fast draft with an escalation gate",
              "review-risk": "Ambiguous, high-risk or cross-cutting task",
            },
          },
        }
      : {}),
    ...(tiers.length > 1
      ? {
          tier: {
            type: "choice" as const,
            instructions: forced ? tierPrompt : routePrompt,
            criteria: { fast: "Efficient author", strong: "Stronger author" },
          },
        }
      : {}),
  };
  const payload = {
    state: {
      request: o.request,
      effort,
      allowed: { workflows, tiers, cascadeStartsFast: true },
    },
    questions,
  };
  const model = ctx.modelRegistry.findOfType(
    "classifier",
    router.provider,
    router.id,
  );
  if (!model) throw new Error("Classifier unavailable");
  const result = await ctx.modelRegistry.classify(model, payload, {
    signal: o.signal,
  });
  o.recordCost(result.usage?.cost.total ?? 0);
  if (result.stopReason !== "stop")
    throw new Error(result.errorMessage ?? "Classifier failed");
  if (
    forced &&
    result.answers.workflow &&
    (result.answers.workflow.type !== "choice" ||
      result.answers.workflow.choice !== forced)
  )
    throw new Error("Router contradicted workflow override");
  const route = validateRoute(
    {
      workflow:
        result.answers.workflow?.type === "choice"
          ? result.answers.workflow.choice
          : workflows.length === 1
            ? workflows[0]
            : undefined,
      tier:
        result.answers.tier?.type === "choice"
          ? result.answers.tier.choice
          : tiers.length === 1
            ? tiers[0]
            : undefined,
    },
    effort,
    o.reviewerLimit,
  );
  o.recordSignal(
    result.answers.signal?.type === "choice"
      ? result.answers.signal.choice
      : undefined,
  );
  return route;
}

/** Task text plus a marker for attachments reviewers cannot see. */
export function describeTask(task: Message): string {
  const original = text(task);
  const images =
    typeof task.content === "string"
      ? 0
      : task.content.filter((part) => part.type === "image").length;
  return images
    ? `${original}\n[${images} image attachment(s) not shown to reviewers]`
    : original;
}

export async function choose(
  ctx: ExtensionContext,
  config: Config,
  request: ModelRouteRequest<State>,
  task: Message,
  forced?: Workflow,
): Promise<State> {
  const original = describeTask(task);
  const effort = fusionEffort(request.thinkingLevel);
  const reviewerCap = config.budget?.maxReviewerCalls ?? Infinity;
  const reviewerLimit = Math.min(config.critics.length, reviewerCap);
  const allowed = routeOptions(effort, workflowLimit(config));
  if (forced && !allowed.workflows.includes(forced))
    throw new Error(
      `${effortLabel(effort)} cannot use ${forced} with the current reviewer cap`,
    );
  if (forced && (forced === "cascade" || effort === "max"))
    return {
      task: task.timestamp,
      request: original,
      effort,
      workflow: forced,
      tier: forced === "cascade" ? "fast" : "strong",
      author: config[forced === "cascade" ? "fast" : "strong"],
      reviewerLimit,
      routingCostUsd: 0,
      routeReason: `override: ${forced}`,
      override: forced,
      phase: "draft",
    };
  let routingCostUsd = 0;
  const recordCost = (cost: number) => {
    if (Number.isFinite(cost) && cost > 0) routingCostUsd += cost;
  };
  let choice: Route;
  let signalChoice: unknown;
  let fallback = false;
  const recordSignal = (signal: unknown) => {
    signalChoice = signal;
  };
  try {
    choice = await bounded(
      async (signal) => {
        if (
          ctx.modelRegistry.findOfType(
            "classifier",
            config.router.provider,
            config.router.id,
          )
        )
          return classify({
            ctx,
            router: config.router,
            request: original,
            effort,
            reviewerLimit: workflowLimit(config),
            signal,
            recordCost,
            recordSignal,
            forced,
          });
        const answer = parseJson(
          await chat(
            ctx,
            config.router,
            `${forced ? tierPrompt : routePrompt}\nTask: ${original}\nFusion effort: ${effort}\nAllowed workflows: ${forced ?? allowed.workflows.join(", ")}\nAllowed initial tiers: ${allowed.tiers.join(", ")} (Cascade always starts fast).\n${forced ? `Workflow is fixed to ${forced}; choose tier only. Return JSON only: {"tier":"fast|strong"}.` : `Return JSON only with workflow${allowed.tiers.length > 1 ? ", tier" : ""}, and signal (straightforward|complex|fast-draft|review-risk).`}`,
            signal,
            recordCost,
          ),
        );
        if (
          forced &&
          answer.workflow !== undefined &&
          answer.workflow !== forced
        )
          throw new Error("Router contradicted workflow override");
        const route = validateRoute(
          {
            workflow:
              forced ??
              answer.workflow ??
              (allowed.workflows.length === 1
                ? allowed.workflows[0]
                : undefined),
            tier:
              answer.tier ??
              (allowed.tiers.length === 1 ? allowed.tiers[0] : undefined),
          },
          effort,
          workflowLimit(config),
        );
        if (!forced) recordSignal(answer.signal);
        return route;
      },
      request.signal,
      config.timeoutMs,
    );
  } catch (error) {
    if (request.signal?.aborted) throw error;
    fallback = true;
    logFailure(ctx, "routing failed", error);
    const author = effort === "max" ? "strong" : "default";
    ctx.ui.setStatus(
      "fusion",
      `${effortLabel(effort)} · Routing unavailable; ${forced ?? "Single"} (${author} author)`,
    );
    ctx.ui.notify(
      `Fusion routing failed (${error instanceof Error ? error.message : String(error)}); using ${forced ?? "Single"} with the ${author} author`,
      "warning",
    );
    choice = {
      workflow: forced ?? "single",
      tier: effort === "max" ? "strong" : config.defaultAuthor,
    };
  }
  const costLimitReached =
    choice.workflow !== "single" &&
    config.budget?.maxTaskCostUsd !== undefined &&
    routingCostUsd >= config.budget.maxTaskCostUsd;
  if (costLimitReached)
    choice = {
      workflow: "single",
      tier: effort === "max" ? "strong" : choice.tier,
    };
  return {
    task: task.timestamp,
    request: original,
    effort,
    ...choice,
    reviewerLimit,
    routingCostUsd,
    routeReason: forced
      ? costLimitReached
        ? `override: ${forced} (review skipped: task cost limit)`
        : fallback
          ? `override: ${forced} (tier routing unavailable; default author)`
          : `override: ${forced}`
      : costLimitReached
        ? "task cost limit"
        : fallback
          ? "routing unavailable"
          : routeExplanation(signalChoice, choice.workflow, choice.tier),
    override: forced,
    budgetNote: costLimitReached
      ? "Router cost reached task soft limit; review disabled"
      : allowed.workflows.length < routeOptions(effort).workflows.length
        ? `Review cap ${reviewerLimit} restricts workflows`
        : undefined,
    author: config[choice.tier],
    phase: "draft",
  };
}

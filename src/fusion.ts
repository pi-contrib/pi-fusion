import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import {
  criticPrompt,
  judgePrompt,
  revisePrompt,
  routePrompt,
  tierPrompt,
} from "./prompts.ts";

export type Ref = { provider: string; id: string };
export type Workflow = "single" | "cascade" | "critique";
export type Tier = "fast" | "strong";
export type FusionEffort = "standard" | "high" | "max";
export type Route = { workflow: Workflow; tier: Tier };
export function isWorkflow(value: string): value is Workflow {
  return value === "single" || value === "cascade" || value === "critique";
}
export type RouteSignal =
  | "straightforward"
  | "complex"
  | "fast-draft"
  | "review-risk";
const routeSignals: RouteSignal[] = [
  "straightforward",
  "complex",
  "fast-draft",
  "review-risk",
];
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
export function effortLabel(effort: FusionEffort): string {
  return `Fusion ${effort[0].toUpperCase()}${effort.slice(1)}`;
}
export function routeOptions(
  effort: FusionEffort,
  reviewerLimit = Infinity,
): {
  workflows: Workflow[];
  tiers: Tier[];
} {
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
export type Config = {
  router: Ref;
  fast: Ref;
  strong: Ref;
  judge: Ref;
  critics: Ref[];
  defaultAuthor: Tier;
  timeoutMs: number;
  reviewEvidence?: { includeUntracked?: boolean };
  budget?: {
    /** Maximum optional reviewer calls; Critique needs at least two. */
    maxReviewerCalls?: number;
    /** Soft USD threshold checked before review, never interrupts the author. */
    maxTaskCostUsd?: number;
    /** Total wall-clock limit for one review round. */
    maxReviewMs?: number;
  };
};
export type State = {
  task: number;
  request: string;
  effort: FusionEffort;
  workflow: Workflow;
  tier: Tier;
  phase: "draft" | "revision" | "done";
  author: Ref;
  reviewerLimit?: number;
  routingCostUsd?: number;
  budgetNote?: string;
  routeReason?: string;
  override?: Workflow;
};
export type Transition = {
  phase: "done" | "revision";
  author: Ref;
  feedback?: string;
  note: string;
};

export function text(message: Message): string {
  const content = message.content;
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
export function lastUser(messages: readonly Message[]): Message | undefined {
  return messages.findLast((m) => m.role === "user");
}
export function physical(ctx: ExtensionContext, ref: Ref): Model<Api> {
  const model = ctx.modelRegistry
    .getAvailable()
    .find(
      (m) =>
        m.provider === ref.provider &&
        m.id === ref.id &&
        m.api !== "pi-virtual",
    );
  if (!model)
    throw new Error(
      `Physical chat model ${ref.provider}/${ref.id} is unavailable`,
    );
  return model;
}
export function parseRoute(value: unknown): Route {
  if (!value || typeof value !== "object") throw new Error("Invalid route");
  const v = value as Record<string, unknown>;
  if (
    !["single", "cascade", "critique"].includes(String(v.workflow)) ||
    !["fast", "strong"].includes(String(v.tier))
  )
    throw new Error("Invalid route");
  return { workflow: v.workflow as Workflow, tier: v.tier as Tier };
}
export function parseJson(output: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output.trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid JSON response");
  return parsed as Record<string, unknown>;
}
export function timeoutSignal(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const timer = AbortSignal.timeout(ms);
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      parent?.aborted ? parent.reason : new Error("Fusion model timeout"),
    );
  parent?.addEventListener("abort", abort, { once: true });
  timer.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => parent?.removeEventListener("abort", abort),
  };
}
export async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  ms: number,
): Promise<T> {
  const { signal, dispose } = timeoutSignal(parent, ms);
  try {
    if (signal.aborted) throw signal.reason;
    return await Promise.race([
      run(signal),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
    ]);
  } finally {
    dispose();
  }
}

async function chat(
  ctx: ExtensionContext,
  ref: Ref,
  prompt: string,
  signal: AbortSignal,
  recordCost?: (cost: number) => void,
): Promise<string> {
  const result = await ctx.modelRegistry
    .streamSimple(
      physical(ctx, ref),
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { signal },
    )
    .result();
  recordCost?.(result.usage?.cost.total ?? 0);
  if (result.stopReason !== "stop")
    throw new Error(
      result.errorMessage ?? `Model stopped: ${result.stopReason}`,
    );
  return text(result);
}

/** OpenCode Go decision models share the System One endpoint. Prefer Pi's registry when present. */
async function classify(
  ctx: ExtensionContext,
  ref: Ref,
  request: string,
  effort: FusionEffort,
  reviewerLimit: number,
  signal: AbortSignal,
  recordCost: (cost: number) => void,
  recordSignal: (signal: unknown) => void,
  forced?: Workflow,
): Promise<Route> {
  const options = routeOptions(effort, reviewerLimit);
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
      request,
      effort,
      allowed: { workflows, tiers, cascadeStartsFast: true },
    },
    questions,
  };
  const model = ctx.modelRegistry.findOfType(
    "classifier",
    ref.provider,
    ref.id,
  );
  if (model) {
    const result = await ctx.modelRegistry.classify(model, payload, { signal });
    recordCost(result.usage?.cost.total ?? 0);
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
      reviewerLimit,
    );
    recordSignal(
      result.answers.signal?.type === "choice"
        ? result.answers.signal.choice
        : undefined,
    );
    return route;
  }
  if (
    ref.provider !== "opencode" ||
    !["jev-1.14", "gemini-decision-1", "gpt-6-luna-decision"].includes(ref.id)
  )
    throw new Error("Classifier unavailable");
  const key = await ctx.modelRegistry.getApiKeyForProvider("opencode");
  if (!key) throw new Error("OpenCode Go credentials unavailable");
  const response = await fetch(
    "https://opencode.ai/inference/systemone/v1/systemone",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: ref.id, ...payload }),
      signal,
    },
  );
  if (!response.ok) throw new Error(`System One HTTP ${response.status}`);
  const data = (await response.json()) as {
    answers?: Record<string, { choice?: string }>;
    usage?: { cost?: { total?: number } };
  };
  recordCost(data.usage?.cost?.total ?? 0);
  if (
    forced &&
    data.answers?.workflow &&
    data.answers.workflow.choice !== forced
  )
    throw new Error("Router contradicted workflow override");
  const route = validateRoute(
    {
      workflow:
        data.answers?.workflow?.choice ??
        (workflows.length === 1 ? workflows[0] : undefined),
      tier:
        data.answers?.tier?.choice ??
        (tiers.length === 1 ? tiers[0] : undefined),
    },
    effort,
    reviewerLimit,
  );
  recordSignal(data.answers?.signal?.choice);
  return route;
}
export async function choose(
  ctx: ExtensionContext,
  config: Config,
  request: ModelRouteRequest<State>,
  task: Message,
  forced?: Workflow,
): Promise<State> {
  const original = text(task);
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
          config.router.provider === "opencode" ||
          ctx.modelRegistry.findOfType(
            "classifier",
            config.router.provider,
            config.router.id,
          )
        )
          return classify(
            ctx,
            config.router,
            original,
            effort,
            workflowLimit(config),
            signal,
            recordCost,
            recordSignal,
            forced,
          );
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
    ctx.ui.setStatus(
      "fusion",
      `${effortLabel(effort)} · Routing unavailable; ${forced ?? "Single"} (${effort === "max" ? "strong" : "default author"})`,
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

export function advance(
  state: State,
  config: Config,
  result: { decision?: string; findings?: string; failures?: string[] },
): Transition {
  if (state.phase !== "draft")
    return {
      phase: "done",
      author: state.author,
      note: "Review limit reached",
    };
  if (state.workflow === "single")
    return { phase: "done", author: state.author, note: "Single complete" };
  const failures = result.failures ?? [];
  if (state.workflow === "cascade") {
    if (result.decision === "accept")
      return { phase: "done", author: state.author, note: "Judge accepted" };
    if (result.decision === "escalate")
      return {
        phase: "revision",
        author: config.strong,
        feedback: result.findings || "Judge requested escalation",
        note: "Escalation",
      };
    return {
      phase: "done",
      author: state.author,
      note: `Judge could not complete: ${failures.join("; ") || "invalid decision"}`,
    };
  }
  if (!result.findings && failures.length)
    return {
      phase: "done",
      author: state.author,
      note: `Review could not complete: ${failures.join("; ")}`,
    };
  return {
    phase: "revision",
    author: state.author,
    feedback: [
      result.findings,
      ...failures.map((f) => `Review could not complete: ${f}`),
    ]
      .filter(Boolean)
      .join("\n"),
    note: "Critique revision",
  };
}

export async function review(
  ctx: ExtensionContext,
  config: Config,
  state: State,
  evidence: string,
  signal?: AbortSignal,
): Promise<Transition> {
  const prompt = `Original request:\n${state.request}\n\nActual draft and evidence:\n${evidence}`;
  if (state.workflow === "cascade") {
    try {
      const answer = parseJson(
        await bounded(
          (s) => chat(ctx, config.judge, `${judgePrompt}\n${prompt}`, s),
          signal,
          config.timeoutMs,
        ),
      );
      if (
        !Array.isArray(answer.findings) &&
        (answer.decision === "accept" || answer.decision === "escalate") &&
        (answer.decision === "accept" ||
          (typeof answer.findings === "string" && answer.findings.length > 0))
      )
        return advance(state, config, {
          decision: answer.decision as string,
          findings: answer.findings as string,
        });
      throw new Error("invalid judge response");
    } catch (error) {
      if (signal?.aborted) throw error;
      return advance(state, config, { failures: [String(error)] });
    }
  }
  const results = await Promise.all(
    config.critics
      .slice(0, state.reviewerLimit ?? config.critics.length)
      .map(async (ref) => {
        try {
          const answer = parseJson(
            await bounded(
              (s) => chat(ctx, ref, `${criticPrompt}\n${prompt}`, s),
              signal,
              config.timeoutMs,
            ),
          );
          if (typeof answer.findings !== "string")
            throw new Error("invalid findings");
          return { finding: `${ref.provider}/${ref.id}: ${answer.findings}` };
        } catch (error) {
          return { failure: `${ref.provider}/${ref.id}: ${String(error)}` };
        }
      }),
  );
  if (signal?.aborted) throw signal.reason;
  return advance(state, config, {
    findings: results
      .map((r) => ("finding" in r ? r.finding : ""))
      .filter(Boolean)
      .join("\n"),
    failures: results
      .map((r) => ("failure" in r ? r.failure : ""))
      .filter(Boolean) as string[],
  });
}
export function revisionMessage(
  state: State,
  transition: Transition,
  evidence: string,
): string {
  return `${revisePrompt}\nOriginal request:\n${state.request}\nDraft and evidence:\n${evidence}\nFindings (verify independently):\n${transition.feedback ?? "none"}`;
}

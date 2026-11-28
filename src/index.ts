import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { configPath, configuredRefs, loadConfig } from "./config.ts";
import { evidence } from "./evidence.ts";
import {
  advance,
  bounded,
  type Config,
  choose,
  effortLabel,
  FUSION_MODEL_ID,
  FUSION_MODEL_NAME,
  FUSION_PROVIDER,
  formatConfigSummary,
  fusionEffort,
  isWorkflow,
  lastUser,
  logFailure,
  modelLabel,
  type PhaseUpdate,
  physical,
  renderReviseCard,
  renderStatus,
  review,
  reviseDetails,
  revisionMessage,
  routeOptions,
  type State,
  setFusionBar,
  type Transition,
  type Workflow,
  workflowLimit,
  workflowName,
  workingLabel,
} from "./fusion.ts";

function isFusionModel(
  model: { provider?: string; id?: string } | undefined,
): boolean {
  return model?.provider === FUSION_PROVIDER && model.id === FUSION_MODEL_ID;
}

function branchState(ctx: ExtensionContext): State | undefined {
  const branch = ctx.sessionManager.getBranch();
  const phase = branch.findLast(
    (e) => e.type === "custom" && e.customType === "fusion.phase",
  );
  const route = branch.findLast(
    (e) =>
      e.type === "custom" &&
      e.customType === "pi.virtual-model-state" &&
      (e.data as { provider?: string })?.provider === FUSION_PROVIDER,
  );
  const base =
    route?.type === "custom"
      ? (route.data as { state: State }).state
      : undefined;
  const update =
    phase?.type === "custom" ? (phase.data as PhaseUpdate) : undefined;
  return base && update?.task === base.task
    ? {
        ...base,
        phase: update.phase,
        author: update.author,
        outcome: update.outcome ?? base.outcome,
        outcomeNote: update.note ?? base.outcomeNote,
      }
    : base;
}

export function pendingOverride(
  ctx: ExtensionContext,
  task?: number,
): Workflow | undefined {
  const branch = ctx.sessionManager.getBranch();
  const index = branch.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === "fusion.next",
  );
  if (index < 0) return;
  const selected = branch[index];
  const value =
    selected?.type === "custom"
      ? (selected.data as { workflow?: unknown } | undefined)?.workflow
      : undefined;
  if (typeof value !== "string" || !isWorkflow(value)) return;
  const later = branch.slice(index + 1);
  if (
    later.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi.virtual-model-state" &&
        (entry.data as { provider?: string })?.provider === FUSION_PROVIDER,
    )
  )
    return;
  const firstUser = later.find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (
    firstUser?.type === "message" &&
    (task === undefined || firstUser.message.timestamp !== task)
  )
    return;
  return value;
}

export function observedTaskCost(
  ctx: ExtensionContext,
  state: State,
): number | undefined {
  const branch = ctx.sessionManager.getBranch();
  const start = branch.findLastIndex(
    (e) =>
      e.type === "message" &&
      e.message.role === "user" &&
      e.message.timestamp === state.task,
  );
  if (start < 0) return undefined;
  return branch.slice(start + 1).reduce((total, e) => {
    if (e.type !== "message" || e.message.role !== "assistant") return total;
    const cost = e.message.usage?.cost.total;
    return (
      total +
      (typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0)
    );
  }, state.routingCostUsd ?? 0);
}

export default function (pi: ExtensionAPI) {
  const settings = new Map<string, Config>();
  const load = (cwd: string) => {
    const path = configPath(cwd);
    let cfg = settings.get(path);
    if (!cfg) {
      cfg = loadConfig(path);
      settings.set(path, cfg);
    }
    return cfg;
  };
  const currentEffort = (ctx: ExtensionContext) =>
    fusionEffort(ctx.thinkingLevel ?? pi.getThinkingLevel());
  const availableModels = (ctx: ExtensionContext) =>
    new Set(
      ctx.modelRegistry
        .getAvailable()
        .filter((m) => m.api !== "pi-virtual")
        .map((m) => `${m.provider}/${m.id}`),
    );
  const isRouterAvailable = (
    ctx: ExtensionContext,
    cfg: Config,
    available: ReadonlySet<string>,
  ) =>
    available.has(`${cfg.router.provider}/${cfg.router.id}`) ||
    Boolean(
      ctx.modelRegistry.findOfType?.(
        "classifier",
        cfg.router.provider,
        cfg.router.id,
      ),
    );
  const showReadyBar = (ctx: ExtensionContext, level?: string) => {
    const effort = level ? fusionEffort(level) : currentEffort(ctx);
    const queued = pendingOverride(ctx);
    setFusionBar(ctx, renderStatus(ctx.ui, { kind: "ready", effort, queued }));
  };
  const activateFusion = (ctx: ExtensionContext) => {
    try {
      const cfg = load(ctx.cwd);
      const available = availableModels(ctx);
      const missing = configuredRefs(cfg)
        .map((ref) => `${ref.provider}/${ref.id}`)
        .filter((name) => !available.has(name));
      const routerKey = `${cfg.router.provider}/${cfg.router.id}`;
      if (
        !isRouterAvailable(ctx, cfg, available) &&
        !missing.includes(routerKey)
      )
        missing.unshift(routerKey);
      if (missing.length)
        ctx.ui.notify(
          `Fusion config references unavailable models: ${missing.join(", ")}`,
          "warning",
        );
    } catch (error) {
      logFailure(ctx, "invalid configuration", error);
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
    showReadyBar(ctx);
  };

  pi.registerMessageRenderer?.("fusion.revise", renderReviseCard);

  pi.registerCommand("fusion", {
    description:
      "Choose workflow for the next Fusion task (single, cascade, critique, auto) or inspect status",
    getArgumentCompletions: (prefix) =>
      ["auto", "single", "cascade", "critique", "status"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      let value = args.trim().toLowerCase();
      if (value === "status") {
        try {
          const path = configPath(ctx.cwd);
          const cfg = load(ctx.cwd);
          const effort = currentEffort(ctx);
          const available = availableModels(ctx);
          ctx.ui.notify(
            formatConfigSummary({
              path,
              config: cfg,
              effort,
              allowedWorkflows: routeOptions(effort, workflowLimit(cfg))
                .workflows,
              queued: pendingOverride(ctx),
              availableModels: available,
              routerAvailable: isRouterAvailable(ctx, cfg, available),
            }),
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
        return;
      }
      if (!isFusionModel(ctx.model) || !ctx.isIdle()) {
        ctx.ui.notify(
          `Select ${FUSION_MODEL_ID} and wait for the current task to finish first`,
          "warning",
        );
        return;
      }
      const effort = currentEffort(ctx);
      if (!value) {
        if (ctx.hasUI && typeof ctx.ui.select === "function") {
          const allowed = routeOptions(effort, workflowLimit(load(ctx.cwd)));
          const queued = pendingOverride(ctx);
          const choices: Array<{ value: string; label: string }> = [
            {
              value: "auto",
              label: `Auto (adaptive)${!queued ? " · active" : ""}`,
            },
            ...allowed.workflows.map((w) => ({
              value: w,
              label: `${workflowName(w)}${queued === w ? " · queued" : ""}`,
            })),
          ];
          const picked = await ctx.ui.select(
            "Choose workflow for next task",
            choices.map((c) => c.label),
          );
          if (!picked) return;
          const match = choices.find((c) => c.label === picked);
          if (!match) return;
          value = match.value;
        } else {
          ctx.ui.notify(
            "Usage: /fusion single|cascade|critique|auto|status",
            "warning",
          );
          return;
        }
      }
      if (value !== "auto" && !isWorkflow(value)) {
        ctx.ui.notify(
          "Usage: /fusion single|cascade|critique|auto|status",
          "warning",
        );
        return;
      }
      if (value !== "auto") {
        const allowed = routeOptions(effort, workflowLimit(load(ctx.cwd)));
        if (!allowed.workflows.includes(value)) {
          ctx.ui.notify(
            `${effortLabel(effort)} cannot use ${value} with the current reviewer cap`,
            "warning",
          );
          return;
        }
      }
      pi.appendEntry("fusion.next", {
        workflow: value === "auto" ? null : value,
      });
      setFusionBar(
        ctx,
        renderStatus(ctx.ui, {
          kind: "ready",
          effort,
          queued: value === "auto" ? undefined : value,
        }),
      );
      ctx.ui.notify(
        value === "auto"
          ? "Next task will use adaptive routing."
          : `Next task will use ${workflowName(value)}.`,
        "info",
      );
    },
  });

  const disclosed = new Set<string>();
  /** Tell the user once per config which remote models will see their code. */
  const discloseReviewers = (
    ctx: ExtensionContext,
    cfg: Config,
    state: State,
  ) => {
    const path = configPath(ctx.cwd);
    if (disclosed.has(path)) return;
    disclosed.add(path);
    const reviewers =
      state.workflow === "cascade"
        ? [cfg.judge]
        : cfg.critics.slice(0, state.reviewerLimit ?? cfg.critics.length);
    ctx.ui.notify(
      `Review will share your request, draft, tool output, and Git diffs with ${reviewers.map((r) => modelLabel(r, cfg)).join(", ")}.`,
      "info",
    );
  };

  pi.on("session_start", (_event, ctx) => {
    if (isFusionModel(ctx.model)) activateFusion(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    if (isFusionModel(event.model)) activateFusion(ctx);
    else if (isFusionModel(event.previousModel)) {
      setFusionBar(ctx, undefined);
      ctx.ui.setWorkingMessage?.();
    }
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (!isFusionModel(ctx.model)) return;
    showReadyBar(ctx, event.level);
    const queued = pendingOverride(ctx);
    if (!queued) return;
    try {
      const effort = fusionEffort(event.level);
      const allowed = routeOptions(effort, workflowLimit(load(ctx.cwd)));
      if (!allowed.workflows.includes(queued))
        ctx.ui.notify(
          `Queued /fusion ${queued} is incompatible with ${effortLabel(effort)}; switch back or run /fusion auto.`,
          "warning",
        );
    } catch {
      // Config errors are already reported on activation.
    }
  });

  pi.registerVirtualModel<State>({
    provider: FUSION_PROVIDER,
    id: FUSION_MODEL_ID,
    name: FUSION_MODEL_NAME,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    async route(request, ctx) {
      const cfg = load(ctx.cwd);
      if (request.reason === "direct")
        return {
          model: physical(ctx, cfg[cfg.defaultAuthor]),
          thinkingLevel: request.thinkingLevel,
        };
      const user = lastUser(request.messages);
      const existing = branchState(ctx) ?? request.state;
      // Extension-authored revision messages are continuations, not new human tasks.
      const fresh =
        request.reason === "user" &&
        user &&
        (!existing || user.timestamp !== existing.task);
      const select = async () => {
        if (!user) return undefined;
        const forced = pendingOverride(ctx, user.timestamp);
        try {
          return await choose(ctx, cfg, request, user, forced);
        } catch (error) {
          if (forced) {
            ctx.ui.setWorkingMessage?.();
            setFusionBar(
              ctx,
              renderStatus(ctx.ui, {
                kind: "warning",
                summary: `${workflowName(forced)} unavailable`,
              }),
            );
            ctx.ui.notify(String(error), "warning");
          }
          throw error;
        }
      };
      const state = fresh
        ? await select()
        : (existing ?? (user ? await select() : undefined));
      if (!state) throw new Error("Fusion needs a user request");
      const model = physical(ctx, state.author);
      const authorName = modelLabel(state.author, cfg);
      const stage = state.phase === "revision" ? "revising" : "drafting";
      // Hide the above-editor widget while streaming so Pi's working border is the single live status line.
      setFusionBar(ctx, undefined);
      ctx.ui.setWorkingMessage?.(
        workingLabel({ kind: stage, model: authorName, effort: state.effort }),
      );
      return {
        model,
        thinkingLevel: request.thinkingLevel,
        state: fresh || !existing ? state : undefined,
      };
    },
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!isFusionModel(ctx.model) || event.outcome !== "completed") return;
    const cfg = load(ctx.cwd);
    const state = branchState(ctx);
    if (state?.phase !== "draft") return;
    const spent = observedTaskCost(ctx, state);
    const overBudget =
      state.workflow !== "single" &&
      cfg.budget?.maxTaskCostUsd !== undefined &&
      spent !== undefined &&
      spent >= cfg.budget.maxTaskCostUsd;
    const proof =
      state.workflow === "single" || overBudget
        ? ""
        : await evidence(
            pi,
            ctx,
            state,
            cfg.reviewEvidence?.includeUntracked ?? false,
          );
    const criticCount = Math.min(
      cfg.critics.length,
      state.reviewerLimit ?? cfg.critics.length,
    );
    const reviewTarget =
      state.workflow === "cascade"
        ? modelLabel(cfg.judge, cfg)
        : `${criticCount} ${criticCount === 1 ? "critic" : "critics"}`;
    if (state.workflow !== "single" && !overBudget) {
      discloseReviewers(ctx, cfg, state);
      setFusionBar(ctx, undefined);
      ctx.ui.setWorkingMessage?.(
        workingLabel({
          kind: "reviewing",
          target: reviewTarget,
          effort: state.effort,
        }),
      );
    }
    let transition: Transition;
    if (overBudget) {
      transition = {
        phase: "done",
        author: state.author,
        outcome: "skipped",
        note: `Review skipped (cost limit ~$${spent?.toFixed(2)} / $${cfg.budget?.maxTaskCostUsd?.toFixed(2)})`,
      };
    } else if (state.workflow === "single") {
      transition = advance(state, cfg, {});
    } else if (cfg.budget?.maxReviewMs !== undefined) {
      try {
        transition = await bounded(
          (signal) => review(ctx, cfg, state, proof, signal),
          ctx.signal,
          cfg.budget.maxReviewMs,
        );
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        logFailure(ctx, "review timed out", error);
        transition = {
          phase: "done",
          author: state.author,
          outcome: "degraded",
          note: "Review timed out",
        };
      }
    } else {
      transition = await review(ctx, cfg, state, proof, ctx.signal);
    }
    const authorName = modelLabel(transition.author, cfg);
    const hasPartialFailure = Boolean(transition.failuresList?.length);
    if (transition.outcome === "skipped" || transition.outcome === "degraded") {
      ctx.ui.notify(transition.note, "warning");
      setFusionBar(
        ctx,
        renderStatus(ctx.ui, {
          kind: "warning",
          summary: transition.note,
          detail: `Kept draft by ${authorName}`,
        }),
      );
    } else if (transition.phase === "revision") {
      if (hasPartialFailure)
        ctx.ui.notify(
          `Some reviewers failed: ${transition.failuresList?.join("; ")}`,
          "warning",
        );
      setFusionBar(ctx, undefined);
      ctx.ui.setWorkingMessage?.(
        workingLabel({
          kind: "revising",
          model: authorName,
          effort: state.effort,
        }),
      );
    } else if (transition.outcome === "accepted") {
      ctx.ui.notify("Review passed — no changes needed.", "info");
      setFusionBar(
        ctx,
        renderStatus(ctx.ui, { kind: "accepted", model: authorName }),
      );
    } else {
      setFusionBar(
        ctx,
        renderStatus(ctx.ui, {
          kind: "completed",
          effort: state.effort,
          model: authorName,
        }),
      );
    }
    const data: PhaseUpdate = {
      task: state.task,
      phase: transition.phase,
      author: transition.author,
      outcome: transition.outcome,
      note: transition.note,
    };
    const entries = [
      ...event.entries,
      { type: "custom" as const, customType: "fusion.phase", data },
    ];
    if (transition.phase === "revision")
      entries.push({
        type: "custom_message" as const,
        customType: "fusion.revise",
        content: revisionMessage(state, transition),
        display: true,
        details: reviseDetails(
          state,
          transition,
          state.workflow === "cascade" ? 1 : criticCount,
        ),
      } as (typeof entries)[number]);
    // Revision runs in Pi's normal tool-capable loop. This boundary never schedules a second review.
    return { entries, continue: transition.phase === "revision" };
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!isFusionModel(ctx.model)) return;
    ctx.ui.setWorkingMessage?.();
    if (event.aborted) {
      setFusionBar(ctx, renderStatus(ctx.ui, { kind: "cancelled" }));
      return;
    }
    const state = branchState(ctx);
    if (!state) return;
    let cfg: Config | undefined;
    try {
      cfg = load(ctx.cwd);
    } catch {
      // Fall back to short model ID if config cannot be loaded.
    }
    const authorName = modelLabel(state.author, cfg);
    if (state.outcome === "degraded" || state.outcome === "skipped") {
      setFusionBar(
        ctx,
        renderStatus(ctx.ui, {
          kind: "warning",
          summary: state.outcomeNote ?? "Review skipped",
          detail: `Kept draft by ${authorName}`,
        }),
      );
    } else if (state.outcome === "accepted") {
      setFusionBar(
        ctx,
        renderStatus(ctx.ui, { kind: "accepted", model: authorName }),
      );
    } else if (state.phase === "revision" || state.outcome === "revised") {
      setFusionBar(
        ctx,
        renderStatus(ctx.ui, { kind: "revised", model: authorName }),
      );
    } else {
      setFusionBar(
        ctx,
        renderStatus(ctx.ui, {
          kind: "completed",
          effort: state.effort,
          model: authorName,
        }),
      );
    }
  });
}

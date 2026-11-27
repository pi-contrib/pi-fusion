import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig } from "./config.ts";
import { evidence } from "./evidence.ts";
import {
  advance,
  bounded,
  type Config,
  choose,
  effortLabel,
  fusionEffort,
  isWorkflow,
  lastUser,
  physical,
  review,
  revisionMessage,
  routeOptions,
  type State,
  type Transition,
  type Workflow,
  workflowLimit,
} from "./fusion.ts";

function branchState(ctx: ExtensionContext): State | undefined {
  const branch = ctx.sessionManager.getBranch();
  const phase = branch.findLast(
    (e) => e.type === "custom" && e.customType === "fusion.phase",
  );
  const route = branch.findLast(
    (e) =>
      e.type === "custom" &&
      e.customType === "pi.virtual-model-state" &&
      (e.data as { provider?: string })?.provider === "fusion",
  );
  const base =
    route?.type === "custom"
      ? (route.data as { state: State }).state
      : undefined;
  const update =
    phase?.type === "custom"
      ? (phase.data as {
          task: number;
          phase: State["phase"];
          author: State["author"];
        })
      : undefined;
  return base && update?.task === base.task
    ? { ...base, phase: update.phase, author: update.author }
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
    selected.type === "custom"
      ? (selected.data as { workflow?: unknown } | undefined)?.workflow
      : undefined;
  if (typeof value !== "string" || !isWorkflow(value)) return;
  const later = branch.slice(index + 1);
  if (
    later.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi.virtual-model-state" &&
        (entry.data as { provider?: string })?.provider === "fusion",
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
  pi.registerCommand("fusion", {
    description:
      "Force Single, Cascade or Critique for the next Fusion task; auto clears",
    getArgumentCompletions: (prefix) =>
      ["single", "cascade", "critique", "auto"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (
        ctx.model?.provider !== "fusion" ||
        ctx.model.id !== "auto" ||
        !ctx.isIdle()
      ) {
        ctx.ui.notify(
          "Select fusion/auto and wait for the agent to finish first",
          "warning",
        );
        return;
      }
      const value = args.trim().toLowerCase();
      if (value !== "auto" && !isWorkflow(value)) {
        ctx.ui.notify("Usage: /fusion single|cascade|critique|auto", "warning");
        return;
      }
      if (value !== "auto") {
        const effort = fusionEffort(ctx.thinkingLevel ?? pi.getThinkingLevel());
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
      ctx.ui.setStatus(
        "fusion",
        value === "auto"
          ? "Fusion · adaptive routing"
          : `Fusion · next task: ${value}`,
      );
      ctx.ui.notify(
        value === "auto"
          ? "Fusion override cleared"
          : `Fusion override queued: ${value}`,
        "info",
      );
    },
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.model?.provider === "fusion" && ctx.model.id === "auto") {
      const queued = pendingOverride(ctx);
      if (queued) ctx.ui.setStatus("fusion", `Fusion · next task: ${queued}`);
    }
  });
  pi.registerVirtualModel<State>({
    provider: "fusion",
    id: "auto",
    name: "Fusion Auto",
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
            ctx.ui.setStatus(
              "fusion",
              `Fusion · override: ${forced} unavailable`,
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
      ctx.ui.setStatus(
        "fusion",
        `${effortLabel(state.effort)} · ${state.workflow} · ${state.phase === "draft" ? "drafting" : state.phase === "revision" ? "revising" : "done"} · ${state.author.provider}/${state.author.id}${state.routeReason ? ` · ${state.routeReason}` : ""}${state.budgetNote ? ` · ${state.budgetNote}` : ""}`,
      );
      return {
        model,
        thinkingLevel: request.thinkingLevel,
        state: fresh || !existing ? state : undefined,
      };
    },
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (
      ctx.model?.provider !== "fusion" ||
      ctx.model.id !== "auto" ||
      event.outcome !== "completed"
    )
      return;
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
    if (state.workflow !== "single" && !overBudget)
      ctx.ui.setStatus(
        "fusion",
        `${effortLabel(state.effort)} · ${state.workflow} · ${state.workflow === "cascade" ? "judging" : "reviewing"}${state.routeReason ? ` · ${state.routeReason}` : ""}`,
      );
    let transition: Transition;
    if (overBudget) {
      transition = {
        phase: "done" as const,
        author: state.author,
        note: `Review skipped: observed task cost ~$${spent?.toFixed(2)} reached $${cfg.budget?.maxTaskCostUsd?.toFixed(2)} soft limit`,
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
        transition = {
          phase: "done" as const,
          author: state.author,
          note: "Review timed out; draft kept",
        };
      }
    } else {
      transition = await review(ctx, cfg, state, proof, ctx.signal);
    }
    if (
      transition.note.includes("could not complete") ||
      transition.feedback?.includes("Review could not complete")
    )
      ctx.ui.notify(transition.feedback ?? transition.note, "warning");
    const data = {
      task: state.task,
      phase: transition.phase,
      author: transition.author,
    };
    ctx.ui.setStatus(
      "fusion",
      `${effortLabel(state.effort)} · ${state.workflow} · ${transition.phase === "revision" ? (state.workflow === "cascade" ? "escalating" : "revising") : "done"} · ${transition.note}${state.routeReason ? ` · ${state.routeReason}` : ""}`,
    );
    const entries = [
      ...event.entries,
      { type: "custom" as const, customType: "fusion.phase", data },
    ];
    if (transition.phase === "revision")
      entries.push({
        type: "custom_message" as const,
        customType: "fusion.revise",
        content: revisionMessage(state, transition, proof),
        display: false,
      } as (typeof entries)[number]);
    // Revision runs in Pi's normal tool-capable loop. This boundary never schedules a second review.
    return { entries, continue: transition.phase === "revision" };
  });
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted)
      ctx.ui.setStatus("fusion", "Fusion · Cancelled; review skipped");
  });
}

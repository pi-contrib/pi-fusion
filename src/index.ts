import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  advance,
  type Config,
  choose,
  lastUser,
  physical,
  review,
  revisionMessage,
  type State,
  text,
} from "./fusion.ts";

function config(cwd: string): Config {
  const path = resolve(cwd, process.env.PI_FUSION_CONFIG ?? ".pi/fusion.json");
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
  return parsed;
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
async function evidence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: State,
): Promise<string> {
  const branch = ctx.sessionManager.getBranch();
  const messages = branch
    .filter((e) => e.type === "message")
    .map((e) => e.message);
  const start = messages.findLastIndex(
    (m) => m.role === "user" && m.timestamp === state.task,
  );
  const draft = messages
    .slice(start + 1)
    .filter((m) => m.role === "assistant" || m.role === "toolResult")
    .map(
      (m) =>
        `${m.role}${m.role === "toolResult" ? ` (${m.toolName}${m.isError ? ", error" : ""})` : ""}: ${text(m)}`,
    )
    .join("\n")
    .slice(-24000);
  const diff = await pi.exec("git", ["diff", "--no-ext-diff", "--", "."], {
    cwd: ctx.cwd,
  });
  const status = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd });
  return `Draft and tool/check results:\n${draft}\n\nGit status (untracked files are listed but not in diff):\n${status.stdout}\nGit diff:\n${diff.stdout.slice(0, 24000)}`;
}
export default function (pi: ExtensionAPI) {
  let settings: Config | undefined;
  const load = (cwd: string) => (settings ??= config(cwd));
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
      const state = fresh
        ? await choose(ctx, cfg, request, user)
        : (existing ??
          (user ? await choose(ctx, cfg, request, user) : undefined));
      if (!state) throw new Error("Fusion needs a user request");
      const model = physical(ctx, state.author);
      ctx.ui.setStatus(
        "fusion",
        `${state.workflow} · ${state.phase} · ${state.author.provider}/${state.author.id}`,
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
    const proof =
      state.workflow === "single" ? "" : await evidence(pi, ctx, state);
    if (state.workflow !== "single")
      ctx.ui.setStatus(
        "fusion",
        `${state.workflow} · ${state.workflow === "cascade" ? "judging" : "reviewing"}`,
      );
    const transition =
      state.workflow === "single"
        ? advance(state, cfg, {})
        : await review(ctx, cfg, state, proof, ctx.signal);
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
    ctx.ui.setStatus("fusion", `${state.workflow} · ${transition.note}`);
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
    if (event.aborted) ctx.ui.setStatus("fusion", "Cancelled; review skipped");
  });
}

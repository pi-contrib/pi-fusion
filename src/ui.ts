import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionContext,
  MessageRenderer,
  MessageRenderOptions,
  Theme,
  ThemeBg,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
  Config,
  FusionEffort,
  Ref,
  ReviseDetails,
  Workflow,
} from "./types.ts";

export type ThemeLike = {
  fg(color: ThemeColor, text: string): string;
  bg(color: ThemeBg, text: string): string;
  bold(text: string): string;
};

const plainTheme: ThemeLike = {
  fg: (_color, value) => value,
  bg: (_color, value) => value,
  bold: (value) => value,
};

function resolveTheme(ui?: { theme?: ThemeLike }): ThemeLike {
  return ui?.theme && typeof ui.theme.fg === "function" ? ui.theme : plainTheme;
}

const EFFORT_NAMES: Record<FusionEffort, string> = {
  standard: "Standard",
  high: "High",
  max: "Max",
};

const WORKFLOW_NAMES: Record<Workflow, string> = {
  single: "Single",
  cascade: "Cascade",
  critique: "Critique",
};

export function shortEffort(effort: FusionEffort): string {
  return EFFORT_NAMES[effort];
}

export function workflowName(workflow: Workflow): string {
  return WORKFLOW_NAMES[workflow];
}

/** Prefer concise model IDs; qualify with provider only when distinct providers share an ID. */
export function modelLabel(ref: Ref, config?: Config): string {
  if (!config) return ref.id;
  const all = [
    config.router,
    config.fast,
    config.strong,
    config.judge,
    ...config.critics,
  ];
  const providers = new Set(
    all.filter((entry) => entry.id === ref.id).map((entry) => entry.provider),
  );
  return providers.size > 1 ? `${ref.provider}/${ref.id}` : ref.id;
}

export type StatusInput =
  | { kind: "ready"; effort: FusionEffort; queued?: Workflow }
  | { kind: "drafting"; effort: FusionEffort; model: string }
  | {
      kind: "reviewing";
      effort: FusionEffort;
      workflow: "cascade" | "critique";
      target: string;
    }
  | { kind: "revising"; effort: FusionEffort; model: string }
  | { kind: "completed"; effort: FusionEffort; model: string }
  | { kind: "accepted"; model: string }
  | { kind: "revised"; model: string }
  | { kind: "warning"; summary: string; detail?: string }
  | { kind: "cancelled" };

export function renderStatus(
  ui: { theme?: ThemeLike } | undefined,
  input: StatusInput,
): string {
  const t = resolveTheme(ui);
  const sep = t.fg("dim", " · ");
  switch (input.kind) {
    case "ready":
      return input.queued
        ? `${t.fg("accent", "◆")} ${t.fg("dim", "Next task:")} ${t.fg("text", workflowName(input.queued))}${sep}${t.fg("muted", shortEffort(input.effort))}`
        : `${t.fg("dim", "◆")} ${t.fg("muted", "Fusion")}${sep}${t.fg("dim", shortEffort(input.effort))}`;
    case "drafting":
      return `${t.fg("accent", "●")} ${t.fg("dim", "Drafting with")} ${t.fg("text", input.model)}${sep}${t.fg("muted", shortEffort(input.effort))}`;
    case "reviewing":
      return `${t.fg("accent", "●")} ${t.fg("dim", "Reviewing draft with")} ${t.fg("text", input.target)}${sep}${t.fg("muted", shortEffort(input.effort))}`;
    case "revising":
      return `${t.fg("accent", "●")} ${t.fg("dim", "Revising with")} ${t.fg("text", input.model)}${sep}${t.fg("muted", shortEffort(input.effort))}`;
    case "completed":
      return `${t.fg("success", "✓")} ${t.fg("dim", `Completed with ${input.model} · ${shortEffort(input.effort)}`)}`;
    case "accepted":
      return `${t.fg("success", "✓")} ${t.fg("dim", `Review passed · Draft by ${input.model}`)}`;
    case "revised":
      return `${t.fg("success", "✓")} ${t.fg("dim", `Revised with ${input.model} after review`)}`;
    case "warning":
      return input.detail
        ? `${t.fg("warning", "⚠")} ${t.fg("warning", input.summary)}${sep}${t.fg("dim", input.detail)}`
        : `${t.fg("warning", "⚠")} ${t.fg("warning", input.summary)}`;
    case "cancelled":
      return `${t.fg("warning", "⚠")} ${t.fg("dim", "Cancelled · Review skipped")}`;
  }
}

function truncateAnsi(line: string, width: number): string {
  if (width <= 0 || visibleLength(line) <= width) return line;
  let visible = 0;
  let out = "";
  let i = 0;
  const max = Math.max(1, width - 1);
  while (i < line.length && visible < max) {
    if (line[i] === "\u001b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end !== -1) {
        out += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += line[i];
    visible++;
    i++;
  }
  return `${out}\u001b[0m…`;
}

/** Update or clear the 1-line Fusion bar right above the input editor (flush-left, no Text padding). */
export function setFusionBar(
  ctx: Pick<ExtensionContext, "ui">,
  line: string | undefined,
): void {
  const ui = ctx.ui as {
    setWidget?: ExtensionContext["ui"]["setWidget"];
    setStatus?: ExtensionContext["ui"]["setStatus"];
  };
  if (typeof ui.setWidget === "function") {
    ui.setWidget(
      "fusion",
      line
        ? () => ({
            invalidate() {},
            render(width: number) {
              return [truncateAnsi(line, width)];
            },
          })
        : undefined,
      { placement: "aboveEditor" },
    );
    return;
  }
  ui.setStatus?.("fusion", line);
}

export function workingLabel(
  stage:
    | { kind: "routing"; effort?: FusionEffort }
    | { kind: "drafting"; model: string; effort?: FusionEffort }
    | { kind: "reviewing"; target: string; effort?: FusionEffort }
    | { kind: "revising"; model: string; effort?: FusionEffort },
): string {
  const suffix = stage.effort ? ` · ${shortEffort(stage.effort)}` : "";
  switch (stage.kind) {
    case "routing":
      return `Choosing workflow${suffix}`;
    case "drafting":
      return `Drafting with ${stage.model}${suffix}`;
    case "reviewing":
      return `Reviewing draft with ${stage.target}${suffix}`;
    case "revising":
      return `Revising with ${stage.model}${suffix}`;
  }
}

function visibleLength(value: string): number {
  return stripVTControlCharacters(value).length;
}

function wrapPlain(text: string, width: number): string[] {
  const limit = Math.max(12, width);
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trimEnd();
    if (!trimmed) {
      out.push("");
      continue;
    }
    let remaining = trimmed;
    while (remaining.length > limit) {
      let cut = remaining.lastIndexOf(" ", limit);
      if (cut < Math.floor(limit / 3)) cut = limit;
      out.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) out.push(remaining);
  }
  return out;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

function padBg(line: string, width: number, theme: ThemeLike): string {
  const pad = Math.max(0, width - visibleLength(line));
  return theme.bg("customMessageBg", line + " ".repeat(pad));
}

/** Custom TUI card for `fusion.revise` messages; zero runtime dependency on pi-tui. */
export function renderReviseCard(
  message: Parameters<MessageRenderer>[0],
  options: MessageRenderOptions,
  theme: Theme,
): Component | undefined {
  const details = message.details as Partial<ReviseDetails> | undefined;
  if (!details?.workflow || !details.author) return undefined;
  const padX = Math.max(0, options.outputPad ?? 1);
  const findings = Array.isArray(details.findings) ? details.findings : [];
  const failures = Array.isArray(details.failures) ? details.failures : [];
  const author = details.author.id;
  const count = details.reviewerCount ?? findings.length;
  const title =
    details.workflow === "cascade"
      ? `Review requested changes · Revising with ${author}`
      : `${count} ${count === 1 ? "reviewer" : "reviewers"} left feedback · Revising with ${author}`;
  return {
    invalidate() {},
    render(width: number): readonly string[] {
      const innerWidth = Math.max(20, width - padX * 2);
      const indent = " ".repeat(padX);
      const lines: string[] = [];
      const header = `${theme.fg("customMessageLabel", theme.bold("Fusion review"))} ${theme.fg("dim", "·")} ${theme.fg("customMessageText", title)}`;
      lines.push(header);
      if (!options.expanded) {
        const first = findings[0] ?? failures[0] ?? "See feedback";
        const hint = options.keyHint("app.tools.expand", "to expand");
        const previewBudget = Math.max(20, innerWidth - 26);
        const preview = clip(first, previewBudget);
        lines.push(
          `${theme.fg("customMessageText", preview)} ${theme.fg("dim", `(${hint})`)}`,
        );
      } else {
        for (const item of findings) {
          for (const [index, wrapped] of wrapPlain(
            item,
            innerWidth - 2,
          ).entries()) {
            const prefix = index === 0 ? "• " : "  ";
            lines.push(theme.fg("customMessageText", `${prefix}${wrapped}`));
          }
        }
        for (const failure of failures) {
          for (const [index, wrapped] of wrapPlain(
            failure,
            innerWidth - 2,
          ).entries()) {
            const prefix = index === 0 ? "⚠ " : "  ";
            lines.push(theme.fg("warning", `${prefix}${wrapped}`));
          }
        }
        const hint = options.keyHint("app.tools.expand", "to collapse");
        lines.push(theme.fg("dim", `(${hint})`));
      }
      const blank = padBg("", width, theme);
      return [
        blank,
        ...lines.map((line) => padBg(`${indent}${line}`, width, theme)),
        blank,
      ];
    },
  };
}

export function formatConfigSummary(input: {
  path: string;
  config: Config;
  effort: FusionEffort;
  allowedWorkflows: Workflow[];
  queued?: Workflow;
  availableModels: ReadonlySet<string>;
  routerAvailable: boolean;
}): string {
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  const fmtRef = (ref: Ref) => {
    const key = `${ref.provider}/${ref.id}`;
    return `${mark(input.availableModels.has(key))} ${key}`;
  };
  const routerKey = `${input.config.router.provider}/${input.config.router.id}`;
  const budgetParts: string[] = [];
  if (input.config.budget?.maxReviewerCalls !== undefined)
    budgetParts.push(`max reviewers: ${input.config.budget.maxReviewerCalls}`);
  if (input.config.budget?.maxTaskCostUsd !== undefined)
    budgetParts.push(
      `soft cost cap: $${input.config.budget.maxTaskCostUsd.toFixed(2)}`,
    );
  if (input.config.budget?.maxReviewMs !== undefined)
    budgetParts.push(`review timeout: ${input.config.budget.maxReviewMs}ms`);
  return [
    `Fusion status (${shortEffort(input.effort)})`,
    `Config: ${input.path}`,
    `Allowed workflows: ${input.allowedWorkflows.map(workflowName).join(", ")}`,
    `Next task: ${input.queued ? `${workflowName(input.queued)} (override)` : "Auto (adaptive)"}`,
    `Router: ${mark(input.routerAvailable)} ${routerKey}`,
    `Fast author: ${fmtRef(input.config.fast)}`,
    `Strong author: ${fmtRef(input.config.strong)}`,
    `Judge: ${fmtRef(input.config.judge)}`,
    `Critics: ${input.config.critics.map(fmtRef).join(", ")}`,
    ...(budgetParts.length ? [`Budgets: ${budgetParts.join(" · ")}`] : []),
  ].join("\n");
}

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  MessageRenderer,
  MessageRenderOptions,
  Theme,
  ThemeBg,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { mockConfig, ref } from "./test-helpers.ts";
import {
  formatConfigSummary,
  modelLabel,
  renderReviseCard,
  renderStatus,
  setFusionBar,
  workingLabel,
} from "./ui.ts";

const taggedTheme = {
  fg: (color: ThemeColor, value: string) => `<${color}>${value}</${color}>`,
  bg: (color: ThemeBg, value: string) => `[${color}:${value}]`,
  bold: (value: string) => `**${value}**`,
};

const renderOptions = (expanded: boolean): MessageRenderOptions => ({
  expanded,
  outputPad: 1,
  keyText: () => "ctrl+o",
  keyHint: (_key, desc) => `ctrl+o ${desc}`,
});

test("renderStatus produces plain-English themed lines without redundant enum jargon", () => {
  const completed = renderStatus(undefined, {
    kind: "completed",
    effort: "standard",
    model: "gpt-5.6-luna",
  });
  assert.equal(completed, "✓ Completed with gpt-5.6-luna · Standard");
  assert.doesNotMatch(completed, /Single complete|router signal:|policy:/);

  const ready = renderStatus(undefined, {
    kind: "ready",
    effort: "high",
    queued: "critique",
  });
  assert.equal(ready, "◆ Next task: Critique · High");

  const idle = renderStatus(undefined, { kind: "ready", effort: "standard" });
  assert.equal(idle, "◆ Fusion · Standard");

  const reviewing = renderStatus(undefined, {
    kind: "reviewing",
    effort: "high",
    workflow: "critique",
    target: "2 critics",
  });
  assert.equal(reviewing, "● Reviewing draft with 2 critics · High");

  const accepted = renderStatus(undefined, {
    kind: "accepted",
    model: "gpt-5.6-luna",
  });
  assert.equal(accepted, "✓ Review passed · Draft by gpt-5.6-luna");

  const revised = renderStatus(undefined, {
    kind: "revised",
    model: "gpt-5.6-sol",
  });
  assert.equal(revised, "✓ Revised with gpt-5.6-sol after review");

  const warned = renderStatus(
    { theme: taggedTheme },
    {
      kind: "warning",
      summary: "Review timed out",
      detail: "Kept draft by gpt-5.6-luna",
    },
  );
  assert.match(warned, /<warning>⚠<\/warning>/);
  assert.match(warned, /<warning>Review timed out<\/warning>/);
  assert.match(warned, /<dim>Kept draft by gpt-5\.6-luna<\/dim>/);
});

test("modelLabel uses short ID unless distinct providers share an ID", () => {
  assert.equal(modelLabel(ref("gpt-5.6-luna", "openai-codex")), "gpt-5.6-luna");
  assert.equal(
    modelLabel(ref("fast", "mock"), {
      ...mockConfig,
      strong: ref("fast", "other"),
    }),
    "mock/fast",
  );
});

test("workingLabel returns natural stage labels", () => {
  assert.equal(workingLabel({ kind: "routing" }), "Choosing workflow");
  assert.equal(
    workingLabel({ kind: "routing", effort: "high" }),
    "Choosing workflow · High",
  );
  assert.equal(
    workingLabel({
      kind: "drafting",
      model: "gpt-5.6-luna",
      effort: "standard",
    }),
    "Drafting with gpt-5.6-luna · Standard",
  );
  assert.equal(
    workingLabel({ kind: "reviewing", target: "2 critics", effort: "high" }),
    "Reviewing draft with 2 critics · High",
  );
  assert.equal(
    workingLabel({ kind: "revising", model: "gpt-5.6-sol", effort: "high" }),
    "Revising with gpt-5.6-sol · High",
  );
});

test("renderReviseCard renders compact collapsed preview and wrapped expanded findings without internal prompt text", () => {
  const message = {
    role: "custom",
    customType: "fusion.revise",
    content: "Verify each finding against the original request and evidence.",
    display: true,
    timestamp: 1,
    details: {
      workflow: "critique",
      effort: "high",
      author: ref("gpt-5.6-luna", "openai-codex"),
      reviewerCount: 2,
      findings: [
        "openai-codex/gpt-5.6-sol: Missing edge-case test for empty input buffer",
        "openai-codex/gpt-5.6-luna: Clarify error message when file is unreadable",
      ],
      failures: ["mock/c3: timeout"],
    },
  } as Parameters<MessageRenderer>[0];

  const collapsed = renderReviseCard(
    message,
    renderOptions(false),
    taggedTheme as unknown as Theme,
  );
  assert.ok(collapsed);
  const collapsedLines = collapsed.render(80);
  const collapsedText = collapsedLines.join("\n");
  assert.match(
    collapsedText,
    /2 reviewers left feedback · Revising with gpt-5\.6-luna/,
  );
  assert.match(collapsedText, /ctrl\+o to expand/);
  assert.doesNotMatch(collapsedText, /Verify each finding/);

  const expanded = renderReviseCard(
    message,
    renderOptions(true),
    taggedTheme as unknown as Theme,
  );
  assert.ok(expanded);
  const expandedText = expanded.render(44).join("\n");
  assert.match(expandedText, /Missing[\s\S]*edge-case test/);
  assert.match(
    expandedText,
    /Clarify error[\s\S]*message when file is unreadable/,
  );
  assert.match(expandedText, /<warning>⚠ mock\/c3: timeout<\/warning>/);
  assert.match(expandedText, /ctrl\+o to collapse/);
  assert.doesNotMatch(expandedText, /Verify each finding/);
});

test("formatConfigSummary lists config path, allowed workflows, and model availability", () => {
  const summary = formatConfigSummary({
    path: "/tmp/fusion.json",
    config: {
      ...mockConfig,
      budget: { maxReviewerCalls: 2, maxTaskCostUsd: 1.5, maxReviewMs: 15000 },
    },
    effort: "high",
    allowedWorkflows: ["single", "cascade", "critique"],
    queued: "critique",
    availableModels: new Set(["mock/fast", "mock/judge", "mock/c1", "mock/c2"]),
    routerAvailable: true,
  });
  assert.match(summary, /Fusion status \(High\)/);
  assert.match(summary, /Config: \/tmp\/fusion\.json/);
  assert.match(summary, /Next task: Critique \(override\)/);
  assert.match(summary, /Router: ✓ mock\/router/);
  assert.match(summary, /Strong author: ✗ mock\/strong/);
  assert.match(summary, /soft cost cap: \$1\.50/);
});

test("setFusionBar renders flush-left without leading whitespace and truncates cleanly", () => {
  let factory: (() => { render(width: number): readonly string[] }) | undefined;
  setFusionBar(
    {
      ui: {
        setWidget: (_key: string, content: unknown) => {
          factory = content as typeof factory;
        },
      } as never,
    },
    "✓ Completed with gpt-5.6-luna · Standard",
  );
  assert.equal(typeof factory, "function");
  const full = factory?.().render(80)[0] ?? "";
  assert.equal(full, "✓ Completed with gpt-5.6-luna · Standard");
  assert.equal(full.startsWith(" "), false);
  const narrow = factory?.().render(17)[0] ?? "";
  assert.match(narrow, /^✓ Completed with/);
  assert.match(narrow, /…$/);
});

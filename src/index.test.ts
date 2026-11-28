import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AgentBeforeSettleEvent,
  ExtensionContext,
  ModelRouteReason,
  ModelRouteRequest,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Config, choose, type State } from "./fusion.ts";
import { observedTaskCost } from "./index.ts";
import {
  exampleCatalog,
  mountExtension,
  routeRequest,
  userMessage,
} from "./test-helpers.ts";

process.env.PI_FUSION_CONFIG = resolve("examples/fusion.json");

test("virtual route persists through tool continuations and retry; direct uses default; branch revision switches author", async () => {
  const ext = mountExtension();
  assert.equal(ext.definition.provider, "fusion");
  const statuses: Array<string | undefined> = [];
  const user = userMessage("Fix this", 100);
  const ctx = {
    cwd: process.cwd(),
    ui: {
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
      },
      notify() {},
    },
    sessionManager: { getBranch: () => ext.entries },
    modelRegistry: {
      getAvailable: () => exampleCatalog,
      findOfType: (_type: string, provider: string, id: string) =>
        provider === "typesafe" && id === "jev-latest"
          ? { provider, id }
          : undefined,
      classify: async () => ({
        stopReason: "stop",
        answers: {
          workflow: { type: "choice", choice: "cascade" },
          tier: { type: "choice", choice: "fast" },
          signal: { type: "choice", choice: "fast-draft" },
        },
      }),
    },
  } as unknown as ExtensionContext;
  const request = routeRequest([user], "high");
  const first = await ext.route(request, ctx);
  assert.equal(first.model.id, "gpt-5.6-luna");
  assert.equal(first.state?.effort, "high");
  assert.equal(first.state?.workflow, "cascade");
  assert.equal(first.state?.routeReason, "router signal: fast-draft");
  assert.ok(statuses.some((s) => s?.includes("router signal: fast-draft")));
  const next = await ext.route(
    routeRequest([user], "high", {
      reason: "continuation",
      state: first.state,
      previous: { model: first.model, thinkingLevel: "high" },
    }),
    ctx,
  );
  assert.equal(next.model.id, first.model.id);
  assert.ok(statuses.at(-1)?.includes(first.state?.routeReason ?? ""));
  const retry = await ext.route(
    routeRequest([user], "high", {
      reason: "retry",
      state: first.state,
      failed: {
        model: first.model,
        thinkingLevel: "high",
        message: { role: "assistant", content: [] } as never,
      },
    }),
    ctx,
  );
  assert.equal(retry.model.id, first.model.id);
  assert.equal(
    (await ext.route(routeRequest([user], "high", { reason: "direct" }), ctx))
      .model.id,
    "gpt-5.6-luna",
  );
  ext.entries.push({
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "fusion", modelId: "auto", state: first.state },
  } as SessionEntry);
  ext.entries.push({
    type: "custom",
    customType: "fusion.phase",
    data: {
      task: 100,
      phase: "revision",
      author: { provider: "openai-codex", id: "gpt-5.6-sol" },
    },
  } as SessionEntry);
  assert.equal(
    (
      await ext.route(
        routeRequest([user], "high", {
          reason: "continuation",
          state: first.state,
        }),
        ctx,
      )
    ).model.id,
    "gpt-5.6-sol",
  );
  assert.ok(ext.handlers.agent_before_settle);
  assert.ok(statuses.at(-1)?.includes(first.state?.routeReason ?? ""));
  // A fork with the saved route but without the revision marker retains its original author.
  ext.entries.pop();
  const fork = await ext.route(
    routeRequest([user], "high", {
      reason: "continuation",
      state: first.state,
    }),
    ctx,
  );
  assert.equal(fork.model.id, "gpt-5.6-luna");
  assert.ok(statuses.at(-1)?.includes(first.state?.routeReason ?? ""));
});

test("Standard runs one author across tools and retry without evidence or review", async () => {
  let executions = 0;
  const ext = mountExtension({
    exec: async () => {
      executions++;
      return {
        code: 0,
        stdout: "",
        stderr: "",
        killed: false,
        truncated: false,
      };
    },
  });
  const statuses: Array<string | undefined> = [];
  const user = userMessage("Fix this", 102);
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "fusion", id: "auto" },
    ui: {
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
      },
      notify() {},
    },
    sessionManager: { getBranch: () => ext.entries },
    modelRegistry: {
      getAvailable: () => exampleCatalog,
      findOfType: () => ({}),
      classify: async () => ({
        stopReason: "stop",
        answers: { tier: { type: "choice", choice: "strong" } },
      }),
    },
  } as unknown as ExtensionContext;
  const request = routeRequest([user], "medium");
  const first = await ext.route(request, ctx);
  assert.equal(first.state?.workflow, "single");
  assert.equal(first.state?.effort, "standard");
  assert.equal(first.model.id, "gpt-5.6-sol");
  ext.entries.push({
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "fusion", state: first.state },
  } as SessionEntry);
  for (const reason of ["continuation", "retry"] as ModelRouteReason[]) {
    const next = await ext.route(
      routeRequest([user], "medium", { reason, state: first.state }),
      ctx,
    );
    assert.equal(next.model.id, "gpt-5.6-sol");
    assert.equal(next.state, undefined);
  }
  const settled = await ext.handlers.agent_before_settle?.(
    { outcome: "completed", entries: [] } as unknown as AgentBeforeSettleEvent,
    ctx,
  );
  assert.equal(settled?.continue, false);
  assert.equal(executions, 0);
  assert.ok(statuses.some((s) => s?.includes("Fusion Standard")));
});

test("soft task cost skips review without interrupting author; review timeout keeps draft", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PI_FUSION_CONFIG;
  const cfgPath = join(dir, "fusion.json");
  process.env.PI_FUSION_CONFIG = cfgPath;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_FUSION_CONFIG;
    else process.env.PI_FUSION_CONFIG = previous;
  });
  const settings = JSON.parse(
    readFileSync(resolve("examples/fusion.json"), "utf8"),
  );
  settings.budget = { maxTaskCostUsd: 0.5, maxReviewMs: 5 };
  writeFileSync(cfgPath, JSON.stringify(settings));
  let executions = 0;
  const ext = mountExtension({
    exec: async () => {
      executions++;
      return {
        code: 0,
        stdout: "",
        stderr: "",
        killed: false,
        truncated: false,
      };
    },
  });
  const state: State = {
    task: 100,
    request: "Fix",
    effort: "high",
    workflow: "critique",
    tier: "fast",
    author: { provider: "openai-codex", id: "gpt-5.6-luna" },
    phase: "draft",
    reviewerLimit: 2,
    routingCostUsd: 0.05,
  };
  const assistantMessage = {
    role: "assistant",
    content: "Draft",
    usage: { cost: { total: 0.46 } },
  };
  ext.entries.push(
    {
      type: "message",
      message: { role: "user", timestamp: 100 },
    } as SessionEntry,
    {
      type: "custom",
      customType: "pi.virtual-model-state",
      data: { provider: "fusion", state },
    } as SessionEntry,
    {
      type: "message",
      message: assistantMessage,
    } as unknown as SessionEntry,
  );
  let reviewCalls = 0;
  const notices: Array<{ message: string; type?: string }> = [];
  const ctx = {
    cwd: dir,
    model: { provider: "fusion", id: "auto" },
    ui: {
      setStatus() {},
      notify: (message: string, type?: string) =>
        notices.push({ message, type }),
    },
    sessionManager: { getBranch: () => ext.entries },
    modelRegistry: {
      getAvailable: () => exampleCatalog,
      streamSimple: () => {
        reviewCalls++;
        return {
          result: () =>
            new Promise((r) =>
              setTimeout(
                () =>
                  r({
                    stopReason: "stop",
                    content: [{ type: "text", text: '{"findings":"none"}' }],
                  }),
                40,
              ),
            ),
        };
      },
    },
  } as unknown as ExtensionContext;
  assert.equal(observedTaskCost(ctx, state), 0.51);
  let result = await ext.handlers.agent_before_settle?.(
    { outcome: "completed", entries: [] } as unknown as AgentBeforeSettleEvent,
    ctx,
  );
  assert.equal(result?.continue, false);
  const firstEntry = result?.entries?.[0];
  assert.equal(firstEntry?.type, "custom");
  if (firstEntry?.type === "custom")
    assert.equal((firstEntry.data as { phase: string }).phase, "done");
  assert.equal(reviewCalls, 0);
  assert.equal(executions, 0);
  assert.equal(notices.at(-1)?.type, "warning");
  assistantMessage.usage.cost.total = 0.1;
  result = await ext.handlers.agent_before_settle?.(
    { outcome: "completed", entries: [] } as unknown as AgentBeforeSettleEvent,
    ctx,
  );
  assert.equal(result?.continue, false);
  assert.equal(reviewCalls, 2);
  assert.equal(executions, 3);
  assert.equal(notices.at(-1)?.type, "warning");
});

test("classifier offers only meaningful choices and rejects contrary answers", async () => {
  const payloads: Array<{
    state: { effort: string };
    questions: Record<string, { criteria: Record<string, string> }>;
  }> = [];
  const config: Config = {
    router: { provider: "typesafe", id: "jev-latest" },
    fast: { provider: "openai-codex", id: "gpt-5.6-luna" },
    strong: { provider: "openai-codex", id: "gpt-5.6-sol" },
    judge: { provider: "openai-codex", id: "gpt-5.6-sol" },
    defaultAuthor: "fast",
    critics: [
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "openai-codex", id: "gpt-5.6-luna" },
    ],
    timeoutMs: 1000,
  };
  let answer: Record<string, { type: string; choice: string }> = {};
  let classifyCalls = 0;
  const ctx = {
    ui: { setStatus() {}, notify() {} },
    modelRegistry: {
      findOfType: () => ({}),
      classify: async (_model: unknown, payload: unknown) => {
        classifyCalls++;
        payloads.push(payload as (typeof payloads)[number]);
        return { stopReason: "stop", answers: answer };
      },
    },
  } as unknown as ExtensionContext;
  const user = userMessage("Fix bug", 1);
  const valid: Array<[ThinkingLevel, string, string]> = [
    ["low", "single", "strong"],
    ["medium", "single", "fast"],
    ["high", "cascade", "fast"],
    ["xhigh", "critique", "strong"],
    ["xhigh", "single", "strong"],
  ];
  for (const [level, workflow, tier] of valid) {
    answer = {
      workflow: { type: "choice", choice: workflow },
      tier: { type: "choice", choice: tier },
    };
    const before = classifyCalls;
    const state = await choose(
      ctx,
      config,
      { thinkingLevel: level } as ModelRouteRequest<State>,
      user,
    );
    assert.equal(classifyCalls, before + 1);
    assert.equal(state.workflow, workflow);
    assert.equal(state.tier, tier);
    const payload = payloads.at(-1);
    assert.equal(payload?.state.effort, state.effort);
    assert.equal(
      "workflow" in (payload?.questions ?? {}),
      level !== "low" && level !== "medium",
    );
    assert.equal("tier" in (payload?.questions ?? {}), level !== "xhigh");
    assert.deepEqual(Object.keys(payload?.questions.signal?.criteria ?? {}), [
      "straightforward",
      "complex",
      "fast-draft",
      "review-risk",
    ]);
  }
  answer = {
    workflow: { type: "choice", choice: "critique" },
    tier: { type: "choice", choice: "strong" },
    signal: { type: "choice", choice: "review-risk" },
  };
  assert.equal(
    (
      await choose(
        ctx,
        config,
        { thinkingLevel: "high" } as ModelRouteRequest<State>,
        user,
      )
    ).routeReason,
    "router signal: review-risk",
  );
  answer = {
    ...answer,
    signal: { type: "choice", choice: "malformed" },
  };
  assert.equal(
    (
      await choose(
        ctx,
        config,
        { thinkingLevel: "high" } as ModelRouteRequest<State>,
        user,
      )
    ).routeReason,
    "policy: critique",
  );
  const contrary: Array<[ThinkingLevel, string, string]> = [
    ["low", "cascade", "fast"],
    ["high", "cascade", "strong"],
    ["xhigh", "cascade", "strong"],
    ["xhigh", "single", "fast"],
  ];
  for (const [level, workflow, tier] of contrary) {
    answer = {
      workflow: { type: "choice", choice: workflow },
      tier: { type: "choice", choice: tier },
    };
    const state = await choose(
      ctx,
      config,
      { thinkingLevel: level } as ModelRouteRequest<State>,
      user,
    );
    assert.equal(state.workflow, "single");
    assert.equal(state.tier, level === "xhigh" ? "strong" : "fast");
  }
});

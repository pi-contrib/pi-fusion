import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import extension, { observedTaskCost } from "./index.ts";

process.env.PI_FUSION_CONFIG = resolve("examples/fusion.json");
const models = ["gpt-5.6-luna", "gpt-5.6-sol"].map((id) => ({
  provider: "openai-codex",
  id,
  api: "mock",
}));
test("virtual route persists through tool continuations and retry; direct uses default; branch revision switches author", async () => {
  const handlers = {};
  let definition;
  extension({
    registerCommand() {},
    registerVirtualModel: (d) => {
      definition = d;
    },
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  assert.equal(definition.provider, "fusion");
  const entries = [];
  const statuses = [];
  const user = { role: "user", content: "Fix this", timestamp: 100 };
  const ctx = {
    cwd: process.cwd(),
    ui: { setStatus: (_, value) => statuses.push(value) },
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      getAvailable: () => models,
      findOfType: () => undefined,
      classify: async () => ({
        stopReason: "stop",
        answers: {
          workflow: { type: "choice", choice: "cascade" },
          tier: { type: "choice", choice: "fast" },
          signal: { type: "choice", choice: "fast-draft" },
        },
      }),
    },
  };
  // The classifier is installed for the router only.
  ctx.modelRegistry.findOfType = (_, provider, id) =>
    provider === "typesafe" && id === "jev-latest"
      ? { provider, id }
      : undefined;
  const request = { reason: "user", thinkingLevel: "high", messages: [user] };
  const first = await definition.route(request, ctx);
  assert.equal(first.model.id, "gpt-5.6-luna");
  assert.equal(first.state.effort, "high");
  assert.equal(first.state.workflow, "cascade");
  assert.equal(first.state.routeReason, "router signal: fast-draft");
  assert.ok(statuses.some((s) => s.includes("router signal: fast-draft")));
  const next = await definition.route(
    {
      ...request,
      reason: "continuation",
      state: first.state,
      previous: { model: first.model },
    },
    ctx,
  );
  assert.equal(next.model.id, first.model.id);
  assert.ok(statuses.at(-1).includes(first.state.routeReason));
  const retry = await definition.route(
    {
      ...request,
      reason: "retry",
      state: first.state,
      failed: { model: first.model },
    },
    ctx,
  );
  assert.equal(retry.model.id, first.model.id);
  assert.equal(
    (await definition.route({ ...request, reason: "direct" }, ctx)).model.id,
    "gpt-5.6-luna",
  );
  entries.push({
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "fusion", modelId: "auto", state: first.state },
  });
  entries.push({
    type: "custom",
    customType: "fusion.phase",
    data: {
      task: 100,
      phase: "revision",
      author: { provider: "openai-codex", id: "gpt-5.6-sol" },
    },
  });
  assert.equal(
    (
      await definition.route(
        { ...request, reason: "continuation", state: first.state },
        ctx,
      )
    ).model.id,
    "gpt-5.6-sol",
  );
  assert.ok(handlers.agent_before_settle);
  assert.ok(statuses.at(-1).includes(first.state.routeReason));
  // A fork with the saved route but without the revision marker retains its original author.
  entries.pop();
  const fork = await definition.route(
    { ...request, reason: "continuation", state: first.state },
    ctx,
  );
  assert.equal(fork.model.id, "gpt-5.6-luna");
  assert.ok(statuses.at(-1).includes(first.state.routeReason));
  assert.equal(first.state.effort, "high");
});

test("Standard runs one author across tools and retry without evidence or review", async () => {
  const handlers = {};
  let definition;
  let executions = 0;
  const statuses = [];
  extension({
    registerCommand() {},
    registerVirtualModel: (d) => {
      definition = d;
    },
    on: (name, fn) => {
      handlers[name] = fn;
    },
    exec: async () => {
      executions++;
      return { stdout: "" };
    },
  });
  const entries = [];
  const user = { role: "user", content: "Fix this", timestamp: 102 };
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "fusion", id: "auto" },
    ui: { setStatus: (_, value) => statuses.push(value) },
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      getAvailable: () => models,
      findOfType: () => ({}),
      classify: async () => ({
        stopReason: "stop",
        answers: {
          tier: { type: "choice", choice: "strong" },
        },
      }),
    },
  };
  const request = { reason: "user", thinkingLevel: "medium", messages: [user] };
  const first = await definition.route(request, ctx);
  assert.equal(first.state.workflow, "single");
  assert.equal(first.state.effort, "standard");
  assert.equal(first.model.id, "gpt-5.6-sol");
  entries.push({
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "fusion", state: first.state },
  });
  for (const reason of ["continuation", "retry"]) {
    const next = await definition.route(
      { ...request, reason, state: first.state },
      ctx,
    );
    assert.equal(next.model.id, "gpt-5.6-sol");
    assert.equal(next.state, undefined);
  }
  const settled = await handlers.agent_before_settle(
    { outcome: "completed", entries: [] },
    ctx,
  );
  assert.equal(settled.continue, false);
  assert.equal(executions, 0);
  assert.ok(statuses.some((s) => s.includes("Fusion Standard")));
});

test("soft task cost skips review without interrupting author; review timeout keeps draft", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PI_FUSION_CONFIG;
  process.env.PI_FUSION_CONFIG = join(dir, "fusion.json");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_FUSION_CONFIG;
    else process.env.PI_FUSION_CONFIG = previous;
  });
  const settings = JSON.parse(
    readFileSync(resolve("examples/fusion.json"), "utf8"),
  );
  settings.budget = { maxTaskCostUsd: 0.5, maxReviewMs: 5 };
  writeFileSync(process.env.PI_FUSION_CONFIG, JSON.stringify(settings));
  const handlers = {};
  let executions = 0;
  extension({
    registerCommand() {},
    registerVirtualModel() {},
    on: (name, fn) => {
      handlers[name] = fn;
    },
    exec: async () => {
      executions++;
      return { stdout: "" };
    },
  });
  const state = {
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
  const entries = [
    { type: "message", message: { role: "user", timestamp: 100 } },
    {
      type: "custom",
      customType: "pi.virtual-model-state",
      data: { provider: "fusion", state },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: "Draft",
        usage: { cost: { total: 0.46 } },
      },
    },
  ];
  let reviewCalls = 0;
  const ctx = {
    cwd: dir,
    model: { provider: "fusion", id: "auto" },
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      getAvailable: () => [
        ...models,
        { provider: "openai-codex", id: "gpt-5.6-sol", api: "mock" },
      ],
      streamSimple: () => {
        reviewCalls++;
        return {
          result: () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    stopReason: "stop",
                    content: [{ type: "text", text: '{"findings":"none"}' }],
                  }),
                40,
              ),
            ),
        };
      },
    },
  };
  assert.equal(observedTaskCost(ctx, state), 0.51);
  let result = await handlers.agent_before_settle(
    { outcome: "completed", entries: [] },
    ctx,
  );
  assert.equal(result.continue, false);
  assert.match(result.entries[0].data.phase, /done/);
  assert.equal(reviewCalls, 0);
  assert.equal(executions, 0);
  entries[2].message.usage.cost.total = 0.1;
  result = await handlers.agent_before_settle(
    { outcome: "completed", entries: [] },
    ctx,
  );
  assert.equal(result.continue, false);
  assert.equal(reviewCalls, 2);
  assert.equal(executions, 3);
});

test("classifier offers only meaningful choices and rejects contrary answers", async () => {
  const { choose } = await import("./fusion.ts");
  const calls = [];
  const config = {
    router: { provider: "typesafe", id: "jev-latest" },
    fast: { provider: "openai-codex", id: "gpt-5.6-luna" },
    strong: { provider: "openai-codex", id: "gpt-5.6-sol" },
    defaultAuthor: "fast",
    critics: [
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "openai-codex", id: "gpt-5.6-luna" },
    ],
    timeoutMs: 1000,
  };
  let answer;
  let classifyCalls = 0;
  const ctx = {
    ui: { setStatus: (...args) => calls.push(args) },
    modelRegistry: {
      findOfType: () => ({}),
      classify: async (_, payload) => {
        classifyCalls++;
        calls.push(payload);
        return { stopReason: "stop", answers: answer };
      },
    },
  };
  const user = { role: "user", content: "Fix bug", timestamp: 1 };
  for (const [level, workflow, tier] of [
    ["low", "single", "strong"],
    ["medium", "single", "fast"],
    ["high", "cascade", "fast"],
    ["xhigh", "critique", "strong"],
    ["xhigh", "single", "strong"],
  ]) {
    answer = {
      workflow: { type: "choice", choice: workflow },
      tier: { type: "choice", choice: tier },
    };
    const before = classifyCalls;
    const state = await choose(ctx, config, { thinkingLevel: level }, user);
    assert.equal(classifyCalls, before + 1);
    assert.equal(state.workflow, workflow);
    assert.equal(state.tier, tier);
    const payload = calls.findLast((v) => v.state);
    assert.equal(payload.state.effort, state.effort);
    assert.equal(
      "workflow" in payload.questions,
      level !== "low" && level !== "medium",
    );
    assert.equal("tier" in payload.questions, level !== "xhigh");
    assert.deepEqual(Object.keys(payload.questions.signal.criteria), [
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
    (await choose(ctx, config, { thinkingLevel: "high" }, user)).routeReason,
    "router signal: review-risk",
  );
  answer.signal.choice = "malformed";
  assert.equal(
    (await choose(ctx, config, { thinkingLevel: "high" }, user)).routeReason,
    "policy: critique",
  );
  for (const [level, workflow, tier] of [
    ["low", "cascade", "fast"],
    ["high", "cascade", "strong"],
    ["xhigh", "cascade", "strong"],
    ["xhigh", "single", "fast"],
  ]) {
    answer = {
      workflow: { type: "choice", choice: workflow },
      tier: { type: "choice", choice: tier },
    };
    const state = await choose(ctx, config, { thinkingLevel: level }, user);
    assert.equal(state.workflow, "single");
    assert.equal(state.tier, level === "xhigh" ? "strong" : "fast");
  }
});

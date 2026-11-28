import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import {
  advance,
  bounded,
  choose,
  type FusionEffort,
  fusionEffort,
  review,
  routeExplanation,
  routeOptions,
  type State,
  type Tier,
  validateRoute,
  type Workflow,
} from "./fusion.ts";
import {
  createMockChatContext,
  draftState,
  mockConfig,
  userMessage,
} from "./test-helpers.ts";

const user = userMessage();
const routeReq = (
  thinkingLevel: ThinkingLevel,
  signal?: AbortSignal,
): ModelRouteRequest<State> =>
  ({
    thinkingLevel,
    signal,
  }) as ModelRouteRequest<State>;

test("Single routes once and ends without review; continuations keep the author", async () => {
  const { ctx, calls } = createMockChatContext({
    router: '{"workflow":"single","tier":"fast"}',
  });
  const first = await choose(ctx, mockConfig, routeReq("low"), user);
  assert.equal(first.author.id, "fast");
  assert.equal(first.effort, "standard");
  assert.equal(advance(first, mockConfig, {}).phase, "done");
  assert.equal(calls.length, 1);
});

test("Pi level mapping and allowed route combinations", () => {
  const cases: Array<[ThinkingLevel, FusionEffort, string[]]> = [
    ["low", "standard", ["single/fast", "single/strong"]],
    ["medium", "standard", ["single/fast", "single/strong"]],
    [
      "high",
      "high",
      [
        "single/fast",
        "single/strong",
        "cascade/fast",
        "critique/fast",
        "critique/strong",
      ],
    ],
    ["xhigh", "max", ["single/strong", "critique/strong"]],
  ];
  for (const [level, effort, allowed] of cases) {
    assert.equal(fusionEffort(level), effort);
    assert.ok(routeOptions(effort).workflows.length > 0);
    for (const workflow of ["single", "cascade", "critique"] as Workflow[])
      for (const tier of ["fast", "strong"] as Tier[]) {
        const value = { workflow, tier };
        if (allowed.includes(`${workflow}/${tier}`))
          assert.deepEqual(validateRoute(value, effort), value);
        else assert.throws(() => validateRoute(value, effort));
      }
  }
});

test("chat routing enforces effort and falls back on forbidden answers", async () => {
  const cases: Array<[ThinkingLevel, string, string]> = [
    ["low", '{"workflow":"critique","tier":"fast"}', "fast"],
    ["medium", '{"workflow":"cascade","tier":"strong"}', "fast"],
    ["high", '{"workflow":"cascade","tier":"fast"}', "fast"],
    ["xhigh", '{"workflow":"cascade","tier":"fast"}', "strong"],
    ["xhigh", '{"workflow":"critique","tier":"strong"}', "strong"],
  ];
  for (const [level, answer, expected] of cases) {
    const { ctx } = createMockChatContext({ router: answer });
    const result = await choose(ctx, mockConfig, routeReq(level), user);
    assert.equal(result.author.id, expected);
    if (level === "xhigh") assert.notEqual(result.workflow, "cascade");
    if (level === "low" || level === "medium")
      assert.equal(result.workflow, "single");
  }
});

test("reviewer caps constrain router choices and preserve Max strong-first", async () => {
  const cases: Array<[ThinkingLevel, number, string, Workflow, Tier]> = [
    ["high", 0, '{"workflow":"critique","tier":"fast"}', "single", "fast"],
    ["high", 1, '{"workflow":"cascade","tier":"fast"}', "cascade", "fast"],
    ["high", 1, '{"workflow":"critique","tier":"fast"}', "single", "fast"],
    [
      "high",
      2,
      '{"workflow":"critique","tier":"strong"}',
      "critique",
      "strong",
    ],
    ["xhigh", 1, '{"workflow":"critique","tier":"strong"}', "single", "strong"],
  ];
  for (const [level, cap, reply, expectedWorkflow, expectedTier] of cases) {
    const { ctx, calls } = createMockChatContext({ router: reply });
    const cfg = { ...mockConfig, budget: { maxReviewerCalls: cap } };
    const result = await choose(ctx, cfg, routeReq(level), user);
    assert.equal(result.workflow, expectedWorkflow);
    assert.equal(result.tier, expectedTier);
    assert.equal(result.reviewerLimit, cap);
    assert.match(
      calls[0]?.prompt ?? "",
      new RegExp(
        `Allowed workflows: ${cap === 0 || level === "xhigh" ? "single" : "single, cascade"}`,
      ),
    );
  }
  const { ctx, calls } = createMockChatContext({
    c1: '{"findings":"one"}',
    c2: '{"findings":"two"}',
  });
  const limited = draftState("critique", { reviewerLimit: 1 });
  await review(ctx, mockConfig, limited, "draft");
  assert.deepEqual(
    calls.map((call) => call.id),
    ["c1"],
  );
});

test("reported router cost can disable optional review before drafting", async () => {
  const { ctx, raw } = createMockChatContext({});
  raw.modelRegistry.findOfType = () => ({});
  raw.modelRegistry.classify = async () => ({
    stopReason: "stop",
    answers: {
      workflow: { type: "choice", choice: "critique" },
      tier: { type: "choice", choice: "strong" },
    },
    usage: { cost: { total: 0.6 } },
  });
  const routed = await choose(
    ctx,
    { ...mockConfig, budget: { maxTaskCostUsd: 0.5 } },
    routeReq("xhigh"),
    user,
  );
  assert.equal(routed.workflow, "single");
  assert.equal(routed.tier, "strong");
  assert.equal(routed.routingCostUsd, 0.6);
  assert.match(routed.budgetNote ?? "", /review disabled/);
  assert.equal(routed.routeReason, "task cost limit");
});

test("chat routing records consistent categorical signal without an extra call", async () => {
  const cases: Array<[string, string]> = [
    [
      '{"workflow":"single","tier":"fast","signal":"straightforward"}',
      "router signal: straightforward",
    ],
    [
      '{"workflow":"single","tier":"strong","signal":"complex"}',
      "router signal: complex",
    ],
    [
      '{"workflow":"cascade","tier":"fast","signal":"fast-draft"}',
      "router signal: fast-draft",
    ],
    [
      '{"workflow":"critique","tier":"strong","signal":"review-risk"}',
      "router signal: review-risk",
    ],
    [
      '{"workflow":"single","tier":"fast","signal":"review-risk"}',
      "policy: single",
    ],
    [
      '{"workflow":"single","tier":"fast","signal":"complex"}',
      "policy: single",
    ],
    [
      '{"workflow":"single","tier":"fast","signal":"some untrusted free text"}',
      "policy: single",
    ],
    ['{"workflow":"single","tier":"fast"}', "policy: single"],
  ];
  for (const [reply, expected] of cases) {
    const { ctx, calls } = createMockChatContext({ router: reply });
    const result = await choose(ctx, mockConfig, routeReq("high"), user);
    assert.equal(result.routeReason, expected);
    assert.equal(calls.length, 1);
  }
  assert.equal(
    routeExplanation(undefined, "cascade", "fast"),
    "policy: cascade",
  );
  const fallback = await choose(
    createMockChatContext({
      router: '{"workflow":"invalid","signal":"review-risk"}',
    }).ctx,
    mockConfig,
    routeReq("xhigh"),
    user,
  );
  assert.equal(fallback.routeReason, "routing unavailable");
});

test("forced routes use only meaningful tier choices; fixed tiers skip router", async () => {
  const forced: Array<[ThinkingLevel, Workflow, Tier, number]> = [
    ["high", "cascade", "fast", 0],
    ["xhigh", "critique", "strong", 0],
    ["xhigh", "single", "strong", 0],
    ["medium", "single", "strong", 1],
    ["high", "critique", "strong", 1],
  ];
  for (const [level, workflow, tier, expectedCalls] of forced) {
    const { ctx, calls } = createMockChatContext({
      router: '{"tier":"strong"}',
    });
    const state = await choose(
      ctx,
      mockConfig,
      routeReq(level),
      user,
      workflow,
    );
    assert.equal(state.workflow, workflow);
    assert.equal(state.tier, tier);
    assert.equal(state.routeReason, `override: ${workflow}`);
    assert.equal(calls.length, expectedCalls);
    if (expectedCalls) {
      assert.match(calls[0]?.prompt ?? "", /choose tier only/);
      assert.doesNotMatch(
        calls[0]?.prompt ?? "",
        /Return JSON only with workflow/,
      );
    }
  }
  const rejected: Array<[ThinkingLevel, Workflow, number]> = [
    ["low", "critique", 2],
    ["high", "critique", 1],
    ["xhigh", "cascade", 2],
  ];
  for (const [level, workflow, cap] of rejected) {
    const cfg = { ...mockConfig, budget: { maxReviewerCalls: cap } };
    await assert.rejects(
      choose(
        createMockChatContext({}).ctx,
        cfg,
        routeReq(level),
        user,
        workflow,
      ),
      /cannot use/,
    );
  }
});

test("forced classifier asks tier only, contradictory or invalid answers retain forced workflow with default author", async () => {
  const payloads: Array<{
    questions: Record<string, unknown>;
    state: { allowed: { workflows: string[] } };
  }> = [];
  let answers: Record<string, unknown> = {
    tier: { type: "choice", choice: "strong" },
  };
  const { ctx, raw } = createMockChatContext({});
  raw.modelRegistry.findOfType = () => ({});
  raw.modelRegistry.classify = async (_, payload) => {
    payloads.push(payload as (typeof payloads)[number]);
    return { stopReason: "stop", answers };
  };
  let result = await choose(
    ctx,
    mockConfig,
    routeReq("high"),
    user,
    "critique",
  );
  assert.equal(result.tier, "strong");
  assert.deepEqual(Object.keys(payloads[0]?.questions ?? {}), ["tier"]);
  assert.deepEqual(payloads[0]?.state.allowed.workflows, ["critique"]);
  answers = {
    workflow: { type: "choice", choice: "single" },
    tier: { type: "choice", choice: "strong" },
  };
  result = await choose(ctx, mockConfig, routeReq("high"), user, "critique");
  assert.equal(result.workflow, "critique");
  assert.equal(result.tier, "fast");
  assert.match(
    result.routeReason ?? "",
    /override: critique.*tier routing unavailable/,
  );
  const invalidChat = createMockChatContext({
    router: '{"workflow":"single","tier":"strong"}',
  });
  result = await choose(
    invalidChat.ctx,
    mockConfig,
    routeReq("high"),
    user,
    "critique",
  );
  assert.equal(result.workflow, "critique");
  assert.equal(result.tier, "fast");
  assert.match(result.routeReason ?? "", /tier routing unavailable/);
  const hanging = createMockChatContext(
    { router: "{}" },
    { delay: () => new Promise((resolve) => setTimeout(resolve, 50)) },
  );
  result = await choose(
    hanging.ctx,
    { ...mockConfig, timeoutMs: 5 },
    routeReq("high"),
    user,
    "critique",
  );
  assert.equal(result.workflow, "critique");
  assert.equal(result.tier, "fast");
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled"));
  await assert.rejects(
    choose(
      ctx,
      mockConfig,
      routeReq("high", cancelled.signal),
      user,
      "critique",
    ),
    /cancelled/,
  );
});

test("forced Critique keeps the initial author after parallel review and stops after one revision", async () => {
  const { ctx, calls } = createMockChatContext({
    router: '{"tier":"strong"}',
    c1: '{"findings":"fix test"}',
    c2: '{"findings":"check edge"}',
  });
  const routed = await choose(
    ctx,
    mockConfig,
    routeReq("high"),
    user,
    "critique",
  );
  const next = await review(ctx, mockConfig, routed, "draft");
  assert.equal(next.author.id, "strong");
  assert.equal(next.phase, "revision");
  assert.deepEqual(
    calls.map((call) => call.id),
    ["router", "c1", "c2"],
  );
  assert.equal(
    advance({ ...routed, phase: "revision" }, mockConfig, {}).phase,
    "done",
  );
});

test("forced critique still observes task cost and existing review limits", async () => {
  const { ctx, raw } = createMockChatContext({ router: '{"tier":"fast"}' });
  raw.modelRegistry.streamSimple = () => ({
    result: async () => ({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: '{"tier":"fast"}' }],
      usage: { cost: { total: 1 } },
    }),
  });
  const result = await choose(
    ctx,
    { ...mockConfig, budget: { maxTaskCostUsd: 0.5 } },
    routeReq("high"),
    user,
    "critique",
  );
  assert.equal(result.workflow, "single");
  assert.equal(result.override, "critique");
  assert.match(result.routeReason ?? "", /review skipped: task cost limit/);
});

test("routing timeout falls back by effort; cancellation propagates", async () => {
  const { ctx } = createMockChatContext(
    { router: "{}" },
    { delay: () => new Promise((resolve) => setTimeout(resolve, 50)) },
  );
  const cfg = { ...mockConfig, timeoutMs: 5 };
  const cases: Array<[ThinkingLevel, string]> = [
    ["medium", "fast"],
    ["xhigh", "strong"],
  ];
  for (const [level, author] of cases) {
    const result = await choose(ctx, cfg, routeReq(level), user);
    assert.equal(result.workflow, "single");
    assert.equal(result.author.id, author);
  }
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    choose(ctx, cfg, routeReq("xhigh", controller.signal), user),
  );
});

test("Max Critique retains the strong author", async () => {
  const { ctx } = createMockChatContext({
    router: '{"workflow":"critique","tier":"strong"}',
    c1: '{"findings":"none"}',
    c2: '{"findings":"check edge cases"}',
  });
  const routed = await choose(ctx, mockConfig, routeReq("xhigh"), user);
  const next = await review(ctx, mockConfig, routed, "draft");
  assert.equal(next.author.id, "strong");
  assert.equal(next.phase, "revision");
  assert.equal(
    advance({ ...routed, phase: "revision" }, mockConfig, {}).phase,
    "done",
  );
});

test("Cascade accepts without revision", async () => {
  const { ctx, calls } = createMockChatContext({
    judge: '{"decision":"accept","findings":""}',
  });
  const next = await review(
    ctx,
    mockConfig,
    draftState("cascade"),
    "draft and diff",
  );
  assert.equal(next.phase, "done");
  assert.match(calls[0]?.prompt ?? "", /Fix the bug[\s\S]*draft and diff/);
});

test("Cascade escalates once to strong; revision cannot be reviewed again", async () => {
  const { ctx } = createMockChatContext({
    judge: '{"decision":"escalate","findings":"missing test"}',
  });
  const next = await review(ctx, mockConfig, draftState("cascade"), "draft");
  assert.equal(next.author.id, "strong");
  assert.match(next.feedback ?? "", /missing test/);
  assert.equal(
    advance(
      { ...draftState("cascade"), phase: "revision", author: next.author },
      mockConfig,
      { decision: "escalate" },
    ).phase,
    "done",
  );
});

test("Critique runs in parallel, retains disagreement, and revises with original author", async () => {
  let pending = 0;
  const { ctx } = createMockChatContext(
    {
      c1: '{"findings":"missing test"}',
      c2: '{"findings":"test is sufficient"}',
    },
    {
      delay: async () => {
        pending++;
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(pending, 2);
      },
    },
  );
  const next = await review(ctx, mockConfig, draftState("critique"), "draft");
  assert.equal(next.author.id, "fast");
  assert.equal(next.phase, "revision");
  assert.match(next.feedback ?? "", /missing test[\s\S]*test is sufficient/);
});

test("invalid routing falls back to Single; cancellation propagates", async () => {
  const { ctx } = createMockChatContext({ router: '{"workflow":"unknown"}' });
  assert.equal(
    (await choose(ctx, mockConfig, routeReq("low"), user)).workflow,
    "single",
  );
  assert.throws(() =>
    validateRoute({ workflow: "unknown", tier: "fast" }, "high"),
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    choose(ctx, mockConfig, routeReq("low", controller.signal), user),
  );
  await assert.rejects(
    bounded(async () => new Promise(() => {}), controller.signal, 10),
  );
});

test("judge failure reports incomplete review; partial critic failure is identified", async () => {
  const { ctx } = createMockChatContext({
    judge: new Error("offline"),
    c1: new Error("offline"),
    c2: '{"findings":"none"}',
  });
  assert.match(
    (await review(ctx, mockConfig, draftState("cascade"), "draft")).note,
    /could not complete/,
  );
  assert.match(
    (await review(ctx, mockConfig, draftState("critique"), "draft")).feedback ??
      "",
    /Review could not complete/,
  );
});

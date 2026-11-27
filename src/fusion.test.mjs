import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  advance,
  bounded,
  choose,
  fusionEffort,
  parseRoute,
  review,
  routeOptions,
  validateRoute,
} from "./fusion.ts";

const ref = (id) => ({ provider: "mock", id });
const config = {
  router: ref("router"),
  fast: ref("fast"),
  strong: ref("strong"),
  judge: ref("judge"),
  critics: [ref("c1"), ref("c2")],
  defaultAuthor: "fast",
  timeoutMs: 1000,
};
const models = ["router", "fast", "strong", "judge", "c1", "c2"].map((id) => ({
  ...ref(id),
  api: "mock",
}));
const user = { role: "user", content: "Fix the bug", timestamp: 101 };
const state = (workflow) => ({
  task: 101,
  request: user.content,
  workflow,
  effort: "high",
  tier: "fast",
  author: config.fast,
  phase: "draft",
});
function mock(reply, delay = () => Promise.resolve()) {
  const calls = [];
  return {
    calls,
    ui: { setStatus() {} },
    modelRegistry: {
      getAvailable: () => models,
      findOfType: () => undefined,
      streamSimple(model, context, { signal }) {
        calls.push({
          id: model.id,
          prompt: context.messages[0].content,
          signal,
        });
        return {
          result: async () => {
            await delay(model.id);
            const value = reply[model.id];
            if (value instanceof Error) throw value;
            return {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: value }],
            };
          },
        };
      },
    },
  };
}
test("Single routes once and ends without review; continuations keep the author", async () => {
  const ctx = mock({ router: '{"workflow":"single","tier":"fast"}' });
  const first = await choose(
    ctx,
    config,
    { thinkingLevel: "low", signal: undefined },
    user,
  );
  assert.equal(first.author.id, "fast");
  assert.equal(first.effort, "standard");
  assert.equal(advance(first, config, {}).phase, "done");
  assert.equal(ctx.calls.length, 1);
  assert.equal(first.author.id, "fast");
});
test("Pi level mapping and allowed route combinations", () => {
  for (const [level, effort, allowed] of [
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
  ]) {
    assert.equal(fusionEffort(level), effort);
    assert.ok(routeOptions(effort).workflows.length > 0);
    for (const workflow of ["single", "cascade", "critique"])
      for (const tier of ["fast", "strong"]) {
        const value = { workflow, tier };
        if (allowed.includes(`${workflow}/${tier}`))
          assert.deepEqual(validateRoute(value, effort), value);
        else assert.throws(() => validateRoute(value, effort));
      }
  }
});
test("chat routing enforces effort and falls back on forbidden answers", async () => {
  for (const [level, answer, expected] of [
    ["low", '{"workflow":"critique","tier":"fast"}', "fast"],
    ["medium", '{"workflow":"cascade","tier":"strong"}', "fast"],
    ["high", '{"workflow":"cascade","tier":"fast"}', "fast"],
    ["xhigh", '{"workflow":"cascade","tier":"fast"}', "strong"],
    ["xhigh", '{"workflow":"critique","tier":"strong"}', "strong"],
  ]) {
    const ctx = mock({ router: answer });
    const result = await choose(ctx, config, { thinkingLevel: level }, user);
    assert.equal(result.author.id, expected);
    if (level === "xhigh") assert.notEqual(result.workflow, "cascade");
    if (level === "low" || level === "medium")
      assert.equal(result.workflow, "single");
  }
});
test("routing timeout falls back by effort; cancellation propagates", async () => {
  const ctx = mock(
    { router: "{}" },
    () => new Promise((resolve) => setTimeout(resolve, 50)),
  );
  const cfg = { ...config, timeoutMs: 5 };
  for (const [level, author] of [
    ["medium", "fast"],
    ["xhigh", "strong"],
  ]) {
    const result = await choose(ctx, cfg, { thinkingLevel: level }, user);
    assert.equal(result.workflow, "single");
    assert.equal(result.author.id, author);
  }
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    choose(
      ctx,
      cfg,
      { thinkingLevel: "xhigh", signal: controller.signal },
      user,
    ),
  );
});
test("Max Critique retains the strong author", async () => {
  const ctx = mock({
    router: '{"workflow":"critique","tier":"strong"}',
    c1: '{"findings":"none"}',
    c2: '{"findings":"check edge cases"}',
  });
  const routed = await choose(ctx, config, { thinkingLevel: "xhigh" }, user);
  const next = await review(ctx, config, routed, "draft");
  assert.equal(next.author.id, "strong");
  assert.equal(next.phase, "revision");
  assert.equal(
    advance({ ...routed, phase: "revision" }, config, {}).phase,
    "done",
  );
});
test("Cascade accepts without revision", async () => {
  const ctx = mock({ judge: '{"decision":"accept","findings":""}' });
  const next = await review(
    ctx,
    config,
    state("cascade"),
    "draft and diff",
    undefined,
  );
  assert.equal(next.phase, "done");
  assert.match(ctx.calls[0].prompt, /Fix the bug[\s\S]*draft and diff/);
});
test("Cascade escalates once to strong; revision cannot be reviewed again", async () => {
  const ctx = mock({
    judge: '{"decision":"escalate","findings":"missing test"}',
  });
  const next = await review(ctx, config, state("cascade"), "draft", undefined);
  assert.equal(next.author.id, "strong");
  assert.match(next.feedback, /missing test/);
  assert.equal(
    advance(
      { ...state("cascade"), phase: "revision", author: next.author },
      config,
      { decision: "escalate" },
    ).phase,
    "done",
  );
});
test("Critique runs in parallel, retains disagreement, and revises with original author", async () => {
  let pending = 0;
  const ctx = mock(
    {
      c1: '{"findings":"missing test"}',
      c2: '{"findings":"test is sufficient"}',
    },
    async () => {
      pending++;
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(pending, 2);
    },
  );
  const next = await review(ctx, config, state("critique"), "draft", undefined);
  assert.equal(next.author.id, "fast");
  assert.equal(next.phase, "revision");
  assert.match(next.feedback, /missing test[\s\S]*test is sufficient/);
});
test("invalid routing falls back to Single; cancellation propagates", async () => {
  const ctx = mock({ router: '{"workflow":"unknown"}' });
  assert.equal(
    (await choose(ctx, config, { thinkingLevel: "low" }, user)).workflow,
    "single",
  );
  assert.throws(() => parseRoute({ workflow: "unknown", tier: "fast" }));
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    choose(
      ctx,
      config,
      { thinkingLevel: "low", signal: controller.signal },
      user,
    ),
  );
  await assert.rejects(
    bounded(async () => new Promise(() => {}), controller.signal, 10),
  );
});
test("judge failure reports incomplete review; partial critic failure is identified", async () => {
  const ctx = mock({
    judge: new Error("offline"),
    c1: new Error("offline"),
    c2: '{"findings":"none"}',
  });
  assert.match(
    (await review(ctx, config, state("cascade"), "draft")).note,
    /could not complete/,
  );
  assert.match(
    (await review(ctx, config, state("critique"), "draft")).feedback,
    /Review could not complete/,
  );
});

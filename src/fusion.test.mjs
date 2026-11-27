import { strict as assert } from "node:assert";
import { test } from "node:test";
import { advance, bounded, choose, parseRoute, review } from "./fusion.ts";

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
  assert.equal(advance(first, config, {}).phase, "done");
  assert.equal(ctx.calls.length, 1);
  assert.equal(first.author.id, "fast");
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

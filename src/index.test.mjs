import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "node:test";
import extension from "./index.ts";

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
    registerVirtualModel: (d) => {
      definition = d;
    },
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  assert.equal(definition.provider, "fusion");
  const entries = [];
  const user = { role: "user", content: "Fix this", timestamp: 100 };
  const ctx = {
    cwd: process.cwd(),
    ui: { setStatus() {} },
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      getAvailable: () => models,
      findOfType: () => undefined,
      classify: async () => ({
        stopReason: "stop",
        answers: {
          workflow: { type: "choice", choice: "cascade" },
          tier: { type: "choice", choice: "fast" },
        },
      }),
    },
  };
  // The classifier is installed for the router only.
  ctx.modelRegistry.findOfType = (_, provider, id) =>
    provider === "typesafe" && id === "jev-latest"
      ? { provider, id }
      : undefined;
  const request = { reason: "user", thinkingLevel: "medium", messages: [user] };
  const first = await definition.route(request, ctx);
  assert.equal(first.model.id, "gpt-5.6-luna");
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
});

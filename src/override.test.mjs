import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import extension, { pendingOverride } from "./index.ts";

process.env.PI_FUSION_CONFIG = resolve("examples/fusion.json");

function setup() {
  const entries = [];
  const statuses = [];
  const notices = [];
  const calls = [];
  let route;
  let command;
  let commandName;
  let sessionStart;
  const pi = {
    registerVirtualModel: (definition) => {
      route = definition.route;
    },
    registerCommand: (name, options) => {
      commandName = name;
      command = options.handler;
    },
    on: (event, handler) => {
      if (event === "session_start") sessionStart = handler;
    },
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data }),
    getThinkingLevel: () => "high",
  };
  extension(pi);
  assert.equal(commandName, "fusion");
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "fusion", id: "auto" },
    thinkingLevel: "high",
    isIdle: () => true,
    ui: {
      setStatus: (_, value) => statuses.push(value),
      notify: (text) => notices.push(text),
    },
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      getAvailable: () =>
        ["gpt-5.6-luna", "gpt-5.6-sol"].map((id) => ({
          provider: "openai-codex",
          id,
          api: "mock",
        })),
      findOfType: () => ({}),
      classify: async (_, payload) => {
        calls.push(payload);
        return {
          stopReason: "stop",
          answers: { tier: { type: "choice", choice: "fast" } },
        };
      },
    },
  };
  return {
    entries,
    calls,
    statuses,
    notices,
    route,
    command,
    sessionStart,
    ctx,
    pi,
  };
}
const user = (timestamp) => ({
  role: "user",
  content: "Fix parser",
  timestamp,
});
const request = (message, level = "high") => ({
  reason: "user",
  thinkingLevel: level,
  messages: [message],
});

test("one-shot command persists through branches and reload, not continuations, direct calls or later tasks", async () => {
  const s = setup();
  await s.command("critique", s.ctx);
  assert.equal(pendingOverride(s.ctx), "critique");
  assert.ok(s.statuses.at(-1).includes("next task: critique"));
  const branchBefore = [...s.entries];
  s.sessionStart({ reason: "reload" }, s.ctx);
  assert.ok(s.statuses.at(-1).includes("next task: critique"));
  assert.equal(
    (await s.route({ ...request(user(100)), reason: "direct" }, s.ctx)).model
      .id,
    "gpt-5.6-luna",
  );
  assert.equal(pendingOverride(s.ctx), "critique");
  s.entries.push({ type: "message", message: user(100) });
  const first = await s.route(request(user(100)), s.ctx);
  assert.equal(first.state.workflow, "critique");
  assert.equal(first.state.override, "critique");
  assert.equal(first.state.routeReason, "override: critique");
  assert.equal(first.model.id, "gpt-5.6-luna");
  assert.deepEqual(Object.keys(s.calls[0].questions), ["tier"]);
  s.entries.push({
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "fusion", state: first.state },
  });
  assert.equal(pendingOverride(s.ctx), undefined);
  for (const reason of ["continuation", "retry"]) {
    const next = await s.route(
      { ...request(user(100)), reason, state: first.state },
      s.ctx,
    );
    assert.equal(next.model.id, "gpt-5.6-luna");
    assert.equal(next.state, undefined);
  }
  assert.equal(s.calls.length, 1);
  const beforeFork = setup();
  beforeFork.entries.push(...branchBefore);
  assert.equal(pendingOverride(beforeFork.ctx), "critique");
  const afterFork = setup();
  afterFork.entries.push(...s.entries);
  assert.equal(pendingOverride(afterFork.ctx), undefined);
  s.entries.push({ type: "message", message: user(200) });
  const later = await s.route(request(user(200)), s.ctx);
  assert.equal(later.state.override, undefined);
  assert.notEqual(later.state.routeReason, "override: critique");
});

test("command keeps multimodal user content unchanged and does not ask for a workflow", async () => {
  const s = setup();
  const message = {
    role: "user",
    timestamp: 500,
    content: [
      { type: "text", text: "Describe this screenshot" },
      { type: "image", data: "mock-image", mimeType: "image/png" },
    ],
  };
  const original = structuredClone(message.content);
  await s.command("single", s.ctx);
  s.entries.push({ type: "message", message });
  const result = await s.route(request(message), s.ctx);
  assert.equal(result.state.workflow, "single");
  assert.equal(result.state.request, "Describe this screenshot");
  assert.deepEqual(message.content, original);
  assert.deepEqual(Object.keys(s.calls[0].questions), ["tier"]);
});

test("command rejects bad input, busy or wrong model; replacement and clear are branch-local", async () => {
  const s = setup();
  await s.command("nonsense", s.ctx);
  assert.equal(s.entries.length, 0);
  await s.command("critique", { ...s.ctx, isIdle: () => false });
  await s.command("critique", {
    ...s.ctx,
    model: { provider: "else", id: "x" },
  });
  assert.equal(s.entries.length, 0);
  await s.command("cascade", s.ctx);
  await s.command("single", s.ctx);
  assert.equal(pendingOverride(s.ctx), "single");
  await s.command("auto", s.ctx);
  assert.equal(pendingOverride(s.ctx), undefined);
  assert.equal(s.entries.length, 3);
  assert.ok(s.notices.some((notice) => notice.includes("cleared")));
  // Switching sessions changes the branch, not a process-global pending variable.
  await s.command("cascade", s.ctx);
  const otherSession = { ...s.ctx, sessionManager: { getBranch: () => [] } };
  assert.equal(pendingOverride(otherSession), undefined);
  assert.equal(pendingOverride(s.ctx), "cascade");
});

test("effort and reviewer cap reject commands; changed level before task errors without consuming override", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-override-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PI_FUSION_CONFIG;
  process.env.PI_FUSION_CONFIG = join(dir, "fusion.json");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_FUSION_CONFIG;
    else process.env.PI_FUSION_CONFIG = previous;
  });
  const config = JSON.parse(
    readFileSync(resolve("examples/fusion.json"), "utf8"),
  );
  config.budget = { maxReviewerCalls: 0 };
  writeFileSync(process.env.PI_FUSION_CONFIG, JSON.stringify(config));
  const s = setup();
  await s.command("critique", s.ctx);
  assert.equal(pendingOverride(s.ctx), undefined);
  assert.match(s.notices.at(-1), /cannot use/);
  await s.command("critique", { ...s.ctx, thinkingLevel: "low" });
  assert.equal(pendingOverride(s.ctx), undefined);
  // A separate extension/config instance allows the command, then a later thinking-level change invalidates it.
  const allowedPath = join(dir, "allowed.json");
  delete config.budget;
  writeFileSync(allowedPath, JSON.stringify(config));
  process.env.PI_FUSION_CONFIG = allowedPath;
  const allowed = setup();
  await allowed.command("critique", allowed.ctx);
  allowed.entries.push({ type: "message", message: user(100) });
  await assert.rejects(
    allowed.route(request(user(100), "low"), allowed.ctx),
    /cannot use/,
  );
  assert.equal(pendingOverride(allowed.ctx, 100), "critique");
  const retry = await allowed.route(
    { ...request(user(100), "high"), reason: "retry" },
    allowed.ctx,
  );
  assert.equal(retry.state.workflow, "critique");
  assert.ok(allowed.notices.some((notice) => notice.includes("cannot use")));
});

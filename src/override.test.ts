import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRouteReason,
  ModelRouteRequest,
  SessionEntry,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { State } from "./fusion.ts";
import { pendingOverride } from "./index.ts";
import {
  exampleCatalog,
  fusionModelRef,
  mountExtension,
  readWidgetLine,
  routeRequest,
  userMessage,
} from "./test-helpers.ts";

process.env.PI_FUSION_CONFIG = resolve("examples/fusion.json");

function setup() {
  const ext = mountExtension();
  assert.equal(ext.commandName, "fusion");
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  const calls: Array<{ questions: Record<string, unknown> }> = [];
  const ctx = {
    cwd: process.cwd(),
    model: fusionModelRef,
    thinkingLevel: "high",
    hasUI: false,
    isIdle: () => true,
    ui: {
      setWidget: (
        _key: string,
        content: Parameters<typeof readWidgetLine>[0],
      ) => {
        statuses.push(readWidgetLine(content));
      },
      setWorkingMessage() {},
      notify: (text: string) => {
        notices.push(text);
      },
    },
    sessionManager: { getBranch: () => ext.entries },
    modelRegistry: {
      getAvailable: () => exampleCatalog,
      findOfType: () => ({}),
      classify: async (_model: unknown, payload: unknown) => {
        calls.push(payload as (typeof calls)[number]);
        return {
          stopReason: "stop",
          answers: { tier: { type: "choice", choice: "fast" } },
        };
      },
    },
  } as unknown as ExtensionContext;
  return {
    entries: ext.entries,
    calls,
    statuses,
    notices,
    route: ext.route,
    command: ext.command,
    sessionStart: ext.handlers.session_start,
    ctx,
  };
}

const user = (timestamp: number) => userMessage("Fix parser", timestamp);
const request = (
  message: Message,
  level: ThinkingLevel = "high",
): ModelRouteRequest<State> => routeRequest([message], level);

test("one-shot command persists through branches and reload, not continuations, direct calls or later tasks", async () => {
  const s = setup();
  await s.command("critique", s.ctx);
  assert.equal(pendingOverride(s.ctx), "critique");
  assert.ok(s.statuses.at(-1)?.includes("Next task: Critique"));
  const branchBefore = [...s.entries];
  await s.sessionStart?.(
    { type: "session_start", reason: "reload" } as SessionStartEvent,
    s.ctx,
  );
  assert.ok(s.statuses.at(-1)?.includes("Next task: Critique"));
  assert.equal(
    (
      await s.route(
        { ...request(user(100)), reason: "direct" } as ModelRouteRequest<State>,
        s.ctx,
      )
    ).model.id,
    "gpt-5.6-luna",
  );
  assert.equal(pendingOverride(s.ctx), "critique");
  s.entries.push({ type: "message", message: user(100) } as SessionEntry);
  const first = await s.route(request(user(100)), s.ctx);
  assert.equal(first.state?.workflow, "critique");
  assert.equal(first.state?.override, "critique");
  assert.equal(first.state?.routeReason, "override: critique");
  assert.equal(first.model.id, "gpt-5.6-luna");
  assert.deepEqual(Object.keys(s.calls[0]?.questions ?? {}), ["tier"]);
  s.entries.push({
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "fusion", state: first.state },
  } as SessionEntry);
  assert.equal(pendingOverride(s.ctx), undefined);
  for (const reason of ["continuation", "retry"] as ModelRouteReason[]) {
    const next = await s.route(
      {
        ...request(user(100)),
        reason,
        state: first.state,
      } as ModelRouteRequest<State>,
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
  s.entries.push({ type: "message", message: user(200) } as SessionEntry);
  const later = await s.route(request(user(200)), s.ctx);
  assert.equal(later.state?.override, undefined);
  assert.notEqual(later.state?.routeReason, "override: critique");
});

test("command keeps multimodal user content unchanged and does not ask for a workflow", async () => {
  const s = setup();
  const message = userMessage(
    [
      { type: "text", text: "Describe this screenshot" },
      { type: "image", data: "mock-image", mimeType: "image/png" },
    ],
    500,
  );
  const original = structuredClone(message.content);
  await s.command("single", s.ctx);
  s.entries.push({ type: "message", message } as SessionEntry);
  const result = await s.route(request(message), s.ctx);
  assert.equal(result.state?.workflow, "single");
  assert.equal(
    result.state?.request,
    "Describe this screenshot\n[1 image attachment(s) not shown to reviewers]",
  );
  assert.deepEqual(message.content, original);
  assert.deepEqual(Object.keys(s.calls[0]?.questions ?? {}), ["tier"]);
});

test("command rejects bad input, busy or wrong model; replacement and clear are branch-local", async () => {
  const s = setup();
  await s.command("nonsense", s.ctx);
  assert.equal(s.entries.length, 0);
  await s.command("critique", {
    ...s.ctx,
    isIdle: () => false,
  } as ExtensionContext);
  await s.command("critique", {
    ...s.ctx,
    model: { provider: "else", id: "x" },
  } as ExtensionContext);
  assert.equal(s.entries.length, 0);
  await s.command("cascade", s.ctx);
  await s.command("single", s.ctx);
  assert.equal(pendingOverride(s.ctx), "single");
  await s.command("auto", s.ctx);
  assert.equal(pendingOverride(s.ctx), undefined);
  assert.equal(s.entries.length, 3);
  assert.ok(s.notices.some((notice) => notice.includes("adaptive routing")));
  // Switching sessions changes the branch, not a process-global pending variable.
  await s.command("cascade", s.ctx);
  const otherSession = {
    ...s.ctx,
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  assert.equal(pendingOverride(otherSession), undefined);
  assert.equal(pendingOverride(s.ctx), "cascade");
});

test("effort and reviewer cap reject commands; changed level before task errors without consuming override", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-override-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PI_FUSION_CONFIG;
  const cfgPath = join(dir, "fusion.json");
  process.env.PI_FUSION_CONFIG = cfgPath;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_FUSION_CONFIG;
    else process.env.PI_FUSION_CONFIG = previous;
  });
  const config = JSON.parse(
    readFileSync(resolve("examples/fusion.json"), "utf8"),
  );
  config.budget = { maxReviewerCalls: 0 };
  writeFileSync(cfgPath, JSON.stringify(config));
  const s = setup();
  await s.command("critique", s.ctx);
  assert.equal(pendingOverride(s.ctx), undefined);
  assert.match(s.notices.at(-1) ?? "", /cannot use/);
  await s.command("critique", {
    ...s.ctx,
    thinkingLevel: "low",
  } as ExtensionContext);
  assert.equal(pendingOverride(s.ctx), undefined);
  // A separate extension/config instance allows the command, then a later thinking-level change invalidates it.
  const allowedPath = join(dir, "allowed.json");
  delete config.budget;
  writeFileSync(allowedPath, JSON.stringify(config));
  process.env.PI_FUSION_CONFIG = allowedPath;
  const allowed = setup();
  await allowed.command("critique", allowed.ctx);
  allowed.entries.push({ type: "message", message: user(100) } as SessionEntry);
  await assert.rejects(
    allowed.route(request(user(100), "low"), allowed.ctx),
    /cannot use/,
  );
  assert.equal(pendingOverride(allowed.ctx, 100), "critique");
  const retry = await allowed.route(
    {
      ...request(user(100), "high"),
      reason: "retry",
    } as ModelRouteRequest<State>,
    allowed.ctx,
  );
  assert.equal(retry.state?.workflow, "critique");
  assert.ok(allowed.notices.some((notice) => notice.includes("cannot use")));
});

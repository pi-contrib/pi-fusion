import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type {
  AgentBeforeSettleEvent,
  ExtensionContext,
  ModelRouteRequest,
  ModelSelectEvent,
  SessionEntry,
  SessionStartEvent,
  ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import { configErrors, loadConfig } from "./config.ts";
import { evidence } from "./evidence.ts";
import {
  choose,
  describeTask,
  parseJson,
  review,
  reviewNotice,
  revisionMessage,
  type State,
  type Transition,
} from "./fusion.ts";
import {
  createMockChatContext,
  draftState,
  exampleCatalog,
  mockConfig,
  mountExtension,
  ref,
  userMessage,
} from "./test-helpers.ts";

test("config validation reports every problem with field paths and rejects unknown fields", (t) => {
  const errors = configErrors({
    router: { provider: "fusion", id: "auto", extra: 1 },
    fast: { provider: "mock" },
    strong: ref("strong"),
    judge: ref("judge"),
    critics: [],
    defaultAuthor: "medium",
    timeoutMs: -1,
    timoutMs: 5000,
    reviewEvidence: { includeUntracked: true, bogus: true },
    budget: { maxReviewerCalls: 1.5, maxCost: 2 },
  });
  const joined = errors.join("\n");
  for (const field of [
    "timoutMs: unknown field",
    "router.extra: unknown field",
    "router: must not point to the fusion provider",
    "fast.id",
    "critics",
    "defaultAuthor",
    "timeoutMs",
    "reviewEvidence.bogus: unknown field",
    "budget.maxCost: unknown field",
    "budget.maxReviewerCalls",
  ])
    assert.ok(joined.includes(field), `expected error containing ${field}`);
  assert.deepEqual(
    configErrors({ $schema: "https://example.org/schema.json", ...mockConfig }),
    [],
  );
  const root = mkdtempSync(join(tmpdir(), "fusion-bad-json-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const broken = join(root, "broken.json");
  writeFileSync(broken, "{not json");
  assert.throws(() => loadConfig(broken), /Cannot read fusion configuration/);
});

test("parseJson accepts markdown-fenced JSON objects from chat models", () => {
  assert.deepEqual(
    parseJson('```json\n{"workflow":"single","tier":"fast"}\n```'),
    { workflow: "single", tier: "fast" },
  );
  assert.throws(() => parseJson("[1, 2, 3]"), /Invalid JSON/);
});

test("opencode router uses Pi classifier registry or chat fallback without direct fetch", async (t) => {
  let fetchCalled = false;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalled = true;
    throw new Error("fetch must not be called");
  });
  const opencodeRouter = { provider: "opencode", id: "jev-1.14" };
  const { ctx, calls } = createMockChatContext(
    {
      "jev-1.14": '{"workflow":"cascade","tier":"fast","signal":"fast-draft"}',
    },
    {
      available: [
        { provider: "opencode", id: "jev-1.14", api: "mock" },
        { provider: "mock", id: "fast", api: "mock" },
        { provider: "mock", id: "strong", api: "mock" },
      ],
    },
  );
  const routed = await choose(
    ctx,
    { ...mockConfig, router: opencodeRouter },
    { thinkingLevel: "high" } as ModelRouteRequest<State>,
    userMessage(),
  );
  assert.equal(fetchCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(routed.workflow, "cascade");
});

test("routing and review failures warn the user and log underlying errors outside TUI mode", async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args);
  });
  const { ctx, notices } = createMockChatContext(
    {},
    { mode: "print", available: [] },
  );
  const state = await choose(
    ctx,
    mockConfig,
    { thinkingLevel: "high" } as ModelRouteRequest<State>,
    userMessage("Fix", 1),
  );
  assert.equal(state.workflow, "single");
  assert.equal(state.routeReason, "routing unavailable");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.type, "warning");
  assert.match(notices[0]?.message ?? "", /routing failed.*Single/);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]?.[0]), /routing failed/);

  const failingReview = createMockChatContext(
    { judge: new Error("judge boom") },
    { mode: "print" },
  );
  const transition = await review(
    failingReview.ctx,
    mockConfig,
    draftState("cascade"),
    "evidence",
  );
  assert.match(transition.note, /Judge could not complete/);
  assert.equal(logged.length, 2);
  assert.match(String(logged[1]?.[0]), /judge review failed/);
});

test("session_start and model_select validate configured models, clear status on exit, and warn on incompatible thinking level", async (t) => {
  const previous = process.env.PI_FUSION_CONFIG;
  process.env.PI_FUSION_CONFIG = resolve("examples/fusion.json");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_FUSION_CONFIG;
    else process.env.PI_FUSION_CONFIG = previous;
  });
  const ext = mountExtension();
  const notices: Array<{ message: string; type?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    model: { provider: "fusion", id: "auto" },
    thinkingLevel: "high",
    isIdle: () => true,
    ui: {
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
      },
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
    },
    sessionManager: { getBranch: () => ext.entries },
    modelRegistry: {
      // Missing gpt-5.6-sol and no classifier registered for typesafe/jev-latest.
      getAvailable: () => exampleCatalog.slice(0, 1),
      findOfType: () => undefined,
    },
  } as unknown as ExtensionContext;
  await ext.handlers.session_start?.(
    { type: "session_start", reason: "startup" } as SessionStartEvent,
    ctx,
  );
  assert.equal(notices.at(-1)?.type, "warning");
  assert.match(
    notices.at(-1)?.message ?? "",
    /unavailable models.*typesafe\/jev-latest.*openai-codex\/gpt-5\.6-sol/,
  );

  // Queue /fusion critique at high, then switch thinking level to low -> immediate warning.
  await ext.command("critique", ctx);
  await ext.handlers.thinking_level_select?.(
    {
      type: "thinking_level_select",
      level: "low",
      previousLevel: "high",
    } as ThinkingLevelSelectEvent,
    ctx,
  );
  assert.equal(notices.at(-1)?.type, "warning");
  assert.match(
    notices.at(-1)?.message ?? "",
    /incompatible with Fusion Standard/,
  );

  // Switching away from fusion/auto clears the footer status.
  await ext.handlers.model_select?.(
    {
      type: "model_select",
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      previousModel: { provider: "fusion", id: "auto" },
      source: "set",
    } as unknown as ModelSelectEvent,
    ctx,
  );
  assert.equal(statuses.at(-1), undefined);
});

test("visible review UX posts reviewer disclosure once, verdict summary notice, and display:true labeled revision message", async (t) => {
  const previous = process.env.PI_FUSION_CONFIG;
  process.env.PI_FUSION_CONFIG = resolve("examples/fusion.json");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_FUSION_CONFIG;
    else process.env.PI_FUSION_CONFIG = previous;
  });
  const ext = mountExtension();
  const state: State = {
    task: 10,
    request: "Add parser test",
    effort: "high",
    workflow: "cascade",
    tier: "fast",
    author: { provider: "openai-codex", id: "gpt-5.6-luna" },
    phase: "draft",
  };
  ext.entries.push(
    {
      type: "message",
      message: userMessage("Add parser test", 10),
    } as SessionEntry,
    {
      type: "custom",
      customType: "pi.virtual-model-state",
      data: { provider: "fusion", state },
    } as SessionEntry,
  );
  const notices: Array<{ message: string; type?: string }> = [];
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "fusion", id: "auto" },
    ui: {
      setStatus() {},
      notify: (message: string, type?: string) =>
        notices.push({ message, type }),
    },
    sessionManager: { getBranch: () => ext.entries },
    modelRegistry: {
      getAvailable: () => exampleCatalog,
      streamSimple: () => ({
        result: async () => ({
          stopReason: "stop",
          role: "assistant",
          content: [
            {
              type: "text",
              text: '{"decision":"escalate","findings":"Missing edge-case assertion for empty input"}',
            },
          ],
        }),
      }),
    },
  } as unknown as ExtensionContext;
  const settled = await ext.handlers.agent_before_settle?.(
    { outcome: "completed", entries: [] } as unknown as AgentBeforeSettleEvent,
    ctx,
  );
  assert.equal(settled?.continue, true);
  // First review discloses the judge model, then posts the verdict + findings summary.
  assert.equal(notices.length, 2);
  assert.match(notices[0]?.message ?? "", /sends your request.*gpt-5\.6-sol/);
  assert.match(
    notices[1]?.message ?? "",
    /Fusion review \(judge escalated\): Missing edge-case assertion.*revising/,
  );
  const reviseEntry = settled?.entries?.find(
    (e) => e.type === "custom_message",
  );
  assert.equal(reviseEntry?.type, "custom_message");
  if (reviseEntry?.type === "custom_message") {
    assert.equal(reviseEntry.display, true);
    assert.match(String(reviseEntry.content), /^\*\*Fusion review \(judge\)/);
    assert.doesNotMatch(String(reviseEntry.content), /Unstaged Git diff:/);
  }

  // Second review on the same config does not repeat the disclosure notice.
  const second = await ext.handlers.agent_before_settle?.(
    { outcome: "completed", entries: [] } as unknown as AgentBeforeSettleEvent,
    ctx,
  );
  assert.equal(second?.continue, true);
  assert.equal(notices.length, 3);
});

test("image attachments and labeled revision helpers format cleanly", () => {
  const message = userMessage([
    { type: "text", text: "Look" },
    { type: "image", data: "x", mimeType: "image/png" },
  ]);
  assert.match(describeTask(message), /1 image attachment/);
  assert.equal(describeTask(userMessage("plain")), "plain");
  const state = draftState("critique", { request: "Do it" });
  const transition: Transition = {
    phase: "revision",
    author: mockConfig.fast,
    note: "Critique revision",
    feedback: "missing test",
  };
  assert.match(
    revisionMessage(state, transition),
    /^\*\*Fusion review \(critics\)/,
  );
  assert.match(reviewNotice(state, transition), /missing test — revising/);
});

test("diffs and status exclude tracked sensitive files and sensitive directories", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "fusion-sensitive-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.org", ...args],
      { cwd },
    );
  git("init", "-q");
  mkdirSync(join(cwd, "secrets"));
  mkdirSync(join(cwd, "config"));
  writeFileSync(join(cwd, ".env"), "TOKEN=old\n");
  writeFileSync(join(cwd, "config", ".env.prod"), "PROD=old\n");
  writeFileSync(join(cwd, "secrets", "db.txt"), "PASS=old\n");
  writeFileSync(join(cwd, "app.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(cwd, ".env"), "TOKEN=SECRET-ROOT\n");
  writeFileSync(join(cwd, "config", ".env.prod"), "PROD=SECRET-NESTED\n");
  writeFileSync(join(cwd, "secrets", "db.txt"), "PASS=SECRET-DIR\n");
  writeFileSync(join(cwd, "app.txt"), "two\n");
  git("add", "config/.env.prod");
  const pi = {
    exec: async (command: string, args: string[]) => {
      const r = spawnSync(command, args, { cwd, encoding: "utf8" });
      return {
        code: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        killed: false,
      };
    },
  };
  const ctx = {
    cwd,
    sessionManager: { getBranch: () => [] },
  };
  const result = await evidence(
    pi as never,
    ctx as never,
    draftState("critique"),
  );
  assert.match(result, /\+two/);
  assert.doesNotMatch(result, /SECRET-ROOT|SECRET-NESTED|SECRET-DIR/);
  assert.doesNotMatch(result, /\.env|secrets\/db\.txt/);
});

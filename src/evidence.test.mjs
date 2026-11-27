import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evidence, untrackedEvidence } from "./evidence.ts";
import { review } from "./fusion.ts";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "fusion-evidence-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd });
  const commands = [];
  const pi = {
    exec: async (command, args) => {
      commands.push(args);
      const result = spawnSync(command, args, { cwd, encoding: "utf8" });
      return {
        code: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
  const ctx = {
    cwd,
    signal: undefined,
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", timestamp: 101 } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: "draft",
            usage: { cost: { total: 0 } },
          },
        },
      ],
    },
  };
  const state = { task: 101, request: "test", workflow: "critique" };
  return { cwd, pi, ctx, state, commands };
}

test("review evidence includes staged and unstaged diffs, while new contents require opt-in", async (t) => {
  const { cwd, pi, ctx, state, commands } = fixture(t);
  writeFileSync(join(cwd, "tracked.txt"), "original\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.org",
      "commit",
      "-qm",
      "init",
    ],
    { cwd },
  );
  writeFileSync(join(cwd, "tracked.txt"), "staged\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd });
  writeFileSync(join(cwd, "tracked.txt"), "unstaged\n");
  writeFileSync(join(cwd, "new file\nname.txt"), "NEW FILE MARKER");
  writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(cwd, "ignored.txt"), "SHOULD NOT LEAK");
  const defaultEvidence = await evidence(pi, ctx, state);
  assert.match(defaultEvidence, /\+staged/);
  assert.match(defaultEvidence, /\+unstaged/);
  assert.match(defaultEvidence, /draft/);
  assert.doesNotMatch(defaultEvidence, /NEW FILE MARKER|SHOULD NOT LEAK/);
  assert.equal(commands.length, 3);
  const optedIn = await evidence(pi, ctx, state, true);
  assert.match(optedIn, /NEW FILE MARKER/);
  assert.match(optedIn, /new file\\nname.txt/);
  assert.doesNotMatch(optedIn, /SHOULD NOT LEAK/);
  assert.equal(commands.length, 7);
});

test("judge and parallel critics receive the same bounded evidence", async (t) => {
  const { cwd, pi, ctx, state } = fixture(t);
  writeFileSync(join(cwd, "test.txt"), "NEW TEST");
  const proof = await evidence(pi, ctx, state, true);
  const calls = [];
  const config = {
    judge: { provider: "mock", id: "judge" },
    critics: [
      { provider: "mock", id: "c1" },
      { provider: "mock", id: "c2" },
    ],
    timeoutMs: 1000,
  };
  ctx.modelRegistry = {
    getAvailable: () =>
      [config.judge, ...config.critics].map((ref) => ({ ...ref, api: "mock" })),
    streamSimple: (model, context) => {
      calls.push({ id: model.id, prompt: context.messages[0].content });
      return {
        result: async () => ({
          stopReason: "stop",
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                model.id === "judge"
                  ? '{"decision":"accept","findings":""}'
                  : '{"findings":"none"}',
            },
          ],
        }),
      };
    },
  };
  await review(
    ctx,
    config,
    { ...state, phase: "draft", author: config.judge, workflow: "cascade" },
    proof,
  );
  await review(
    ctx,
    config,
    { ...state, phase: "draft", author: config.judge, workflow: "critique" },
    proof,
  );
  assert.deepEqual(
    calls.map((call) => call.id),
    ["judge", "c1", "c2"],
  );
  for (const call of calls) assert.match(call.prompt, /NEW TEST/);
});

test("new-file evidence rejects sensitive names, symlinks, binaries, oversized and unsafe paths", async (t) => {
  const { cwd, pi, ctx } = fixture(t);
  const outside = join(tmpdir(), `fusion-outside-${Date.now()}`);
  writeFileSync(outside, "SECRET OUTSIDE");
  t.after(() => rmSync(outside, { force: true }));
  writeFileSync(join(cwd, ".env.local"), "SECRET ENV");
  writeFileSync(join(cwd, "private-key.pem"), "SECRET KEY");
  writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(cwd, "oversize.txt"), "L".repeat(16 * 1024 + 1));
  symlinkSync(outside, join(cwd, "link.txt"));
  mkdirSync(join(cwd, "nested"));
  writeFileSync(join(cwd, "nested", "okay.txt"), "SAFE CONTENT");
  const result = await untrackedEvidence(pi, ctx);
  assert.match(result, /SAFE CONTENT/);
  assert.doesNotMatch(
    result,
    /SECRET ENV|SECRET KEY|SECRET OUTSIDE|LLLLLLLLLL/,
  );
  assert.match(result, /omitted/);
  const bad = {
    ...pi,
    exec: async () => ({
      code: 0,
      stdout: `../${outside.split("/").at(-1)}\0nested/okay.txt\0`,
      stderr: "",
    }),
  };
  const guarded = await untrackedEvidence(bad, ctx);
  assert.match(guarded, /SAFE CONTENT/);
  assert.doesNotMatch(guarded, /SECRET OUTSIDE/);
});

test("caps new-file count and bytes, reports Git failures and truncates diffs", async (t) => {
  const { cwd, pi, ctx, state } = fixture(t);
  for (let n = 0; n < 12; n++)
    writeFileSync(
      join(cwd, `file-${String(n).padStart(2, "0")}.txt`),
      "x".repeat(3000),
    );
  const capped = await untrackedEvidence(pi, ctx);
  assert.match(capped, /file-00/);
  assert.doesNotMatch(capped, /File "file-11/);
  assert.match(capped, /omitted/);
  const bytesDir = join(cwd, "bytes");
  mkdirSync(bytesDir);
  for (let n = 0; n < 4; n++)
    writeFileSync(join(bytesDir, `${n}.txt`), "b".repeat(12000));
  const byteCapped = await untrackedEvidence(pi, ctx);
  assert.match(byteCapped, /File "bytes\/0.txt/);
  assert.doesNotMatch(byteCapped, /File "bytes\/3.txt/);
  const failed = {
    exec: async () => ({ code: 128, stdout: "", stderr: "not a git repo" }),
  };
  const unavailable = await evidence(failed, ctx, state, true);
  assert.match(unavailable, /\[unavailable\]/);
  assert.match(unavailable, /untracked file listing unavailable/);
  const giant = {
    exec: async () => ({ code: 0, stdout: "+".repeat(50000), stderr: "" }),
  };
  const bounded = await evidence(giant, ctx, state);
  assert.match(bounded, /\[truncated/);
  assert.ok(bounded.length < 60000);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    evidence(giant, { ...ctx, signal: controller.signal }, state),
    /cancelled/,
  );
});

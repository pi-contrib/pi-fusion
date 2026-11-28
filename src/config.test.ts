import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig } from "./config.ts";
import { mockConfig } from "./test-helpers.ts";

const example = JSON.stringify({
  router: mockConfig.router,
  fast: mockConfig.fast,
  strong: mockConfig.strong,
  judge: mockConfig.judge,
  critics: mockConfig.critics,
  defaultAuthor: mockConfig.defaultAuthor,
});

test("config priority: environment > project > XDG > home; separate projects do not share paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fusion-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const other = join(root, "other");
  const xdg = join(root, "xdg");
  const home = join(root, "home");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(other);
  assert.equal(
    configPath(other, {}, home),
    join(home, ".config/pi/fusion.json"),
  );
  assert.equal(
    configPath(other, { XDG_CONFIG_HOME: "relative" }, home),
    join(home, ".config/pi/fusion.json"),
  );
  assert.equal(
    configPath(other, { XDG_CONFIG_HOME: xdg }, home),
    join(xdg, "pi/fusion.json"),
  );
  const override = join(project, ".pi/fusion.json");
  writeFileSync(override, example);
  assert.equal(configPath(project, { XDG_CONFIG_HOME: xdg }, home), override);
  assert.equal(
    configPath(project, { PI_FUSION_CONFIG: "custom.json" }, home),
    join(project, "custom.json"),
  );
  assert.equal(loadConfig(override).timeoutMs, 15000);
});

test("new-file review evidence remains opt-in and requires a boolean", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fusion-evidence-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "fusion.json");
  const cases: Array<[unknown, boolean]> = [
    [{ includeUntracked: true }, true],
    [{ includeUntracked: "true" }, false],
    [[], false],
  ];
  for (const [value, valid] of cases) {
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(example), reviewEvidence: value }),
    );
    if (valid)
      assert.equal(loadConfig(path).reviewEvidence?.includeUntracked, true);
    else assert.throws(() => loadConfig(path), /reviewEvidence/);
  }
});

test("budget fields are optional and invalid settings fail at load", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fusion-budget-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "fusion.json");
  const cases: Array<[unknown, boolean]> = [
    [{ maxReviewerCalls: 0, maxTaskCostUsd: 0.5, maxReviewMs: 25 }, true],
    [{ maxReviewerCalls: -1 }, false],
    [{ maxReviewerCalls: 1.2 }, false],
    [{ maxTaskCostUsd: 0 }, false],
    [{ maxTaskCostUsd: "1" }, false],
    [{ maxReviewMs: -10 }, false],
  ];
  for (const [budget, valid] of cases) {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(example), budget }));
    if (valid) assert.deepEqual(loadConfig(path).budget, budget);
    else assert.throws(() => loadConfig(path), /budget/);
  }
});

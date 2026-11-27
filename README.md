# Pi Fusion

One selectable virtual model for [Pi](https://pi.dev) with task-aware Standard, High, and Max effort. Inspired by, not an exact implementation of, GitHub Copilot's orchestration.

## How it works

Select `fusion/auto` once, then use Pi's thinking-level selector. Pi's visible labels remain **Low / Medium / High / XHigh**; Fusion maps **Low and Medium → Fusion Standard**, **High → Fusion High**, and **XHigh → Fusion Max**. Pi 1.6.1 does not support custom virtual-model thinking-level labels. Fusion Fast is not user-selectable. Low and Medium share the Standard orchestration policy but retain their respective physical-model reasoning budgets.

The router applies the same task-aware rubric within each effort's allowed choices. **Standard** always runs Single, choosing fast or strong once without judges or critics. **High** can choose Single, fast-first Cascade, or Critique; Single and Critique may start fast or strong. **Max** always starts strong and chooses Single for straightforward tasks or parallel Critique when risk or complexity warrants it; Cascade is excluded. The chosen physical author works in Pi's ordinary streaming agent loop, including tools and retries. The initial draft may be visible before review.

- **Single**: one author completes the task without review.
- **Cascade**: an efficient author drafts; after its tool work finishes, a judge accepts or escalates. Acceptance ends immediately; escalation sends specific findings and evidence to the configured stronger author for one revision.
- **Critique**: one author drafts; configured critics evaluate the same draft independently in parallel. Their separate findings, including disagreements, go back to the **original** author for one revision. Critics have no tools or write access.

Reviews start at Pi's `agent_before_settle` boundary, after automatic recovery and queued work. A task has at most one review round and one revision. The active author alone can edit. Continuations and retries preserve the current author; direct calls route to the default physical author. State follows session branches. Status displays Fusion Standard/High/Max, the workflow, author, and current drafting/judging/reviewing/escalation/revision stage; the draft and review/revision can appear as separate streamed responses. Git diff/status and the recorded tool/check results accompany the draft (untracked contents are not included). Checks are not run automatically by Fusion.

If routing times out or returns invalid output, Fusion shows a status and runs Single with the default author at Standard/High, or strong at Max. If the judge fails, the draft completes with a visible incomplete-review status; if some critics fail, their failures accompany the successful findings for revision. If all critics fail, the draft completes with an incomplete-review status. Escape/cancellation skips further review or revision and propagates to nested calls.

## Requirements

- Pi 1.6.0 or newer (developed against Pi 1.6.1)
- Credentials and access for each configured physical model; decision-model access for a classifier router

## Installation

Install the latest code from GitHub without a registry login:

```sh
pi install git:github.com/pi-contrib/pi-fusion
```

Or, after configuring npm authentication for `npm.pkg.github.com` and the `@pi-contrib` scope, install the latest release from GitHub Packages:

```sh
pi install npm:@pi-contrib/pi-fusion
```

For a reproducible install, append a release tag (GitHub) or version (npm). Restart Pi or run `/reload`.

## Configuration

Create `.pi/fusion.json` in your working directory (or set `PI_FUSION_CONFIG` to an absolute path). Start with [examples/fusion.json](examples/fusion.json) and change the provider/model IDs to models in your Pi catalog with credentials. The example needs TypeSafe and OpenAI Codex access. The `router`, `fast`, `strong`, `judge`, and each `critics` entry are independent physical models; they may share the same provider/model. `defaultAuthor` is `fast` or `strong`; `timeoutMs` bounds internal calls. No role may point to `fusion/auto`.

The router first uses Pi's classifier registry when the selected decision model is present (for example `typesafe/jev-latest`). For OpenCode Go's `opencode/jev-1.14`, `opencode/gemini-decision-1`, and `opencode/gpt-6-luna-decision`, it can use the shared System One endpoint with `OPENCODE_API_KEY` if those models are not in Pi's classifier catalog. A configured, available Pi chat model instead returns validated JSON using the same rubric (for example a Muse Ember chat model). The four editable runtime prompts are in [src/prompts.ts](src/prompts.ts); workflow limits live in TypeScript.

Select the model with `/model` → `fusion/auto`, or run `pi --model fusion/auto`. For example, ask: “Add a regression test for the parser bug and fix it.” At **Fusion Standard** (Pi Low or Medium), one selected author inspects and edits the parser and runs tests without a judge. At **Fusion High** (Pi High), the router may instead choose Cascade: the fast author drafts and a judge sees the request, draft, test output, and diff; if the regression test is missing, the strong author gets that finding for one final revision. At **Fusion Max** (Pi XHigh), an ambiguous or high-risk change may get parallel Critique and one revision by the same strong author; a straightforward change may use strong Single.

## Development

Use Node.js 22 locally or enter the Nix dev shell with `nix develop`:

```sh
npm ci --ignore-scripts
npm run check
npm run lint
npm test
npm pack --dry-run
nix flake check
pi -e ./src/index.ts --model fusion/auto
```

`nix flake check` runs the tests and package dry-run offline on the current system; CI additionally installs dependencies and runs TypeScript and Biome. Run `npm run format` to apply Biome formatting, import sorting, and safe lint fixes.

Release Please creates release PRs from conventional commits on `main`. Merging one updates the manifest and changelog, tags `vX.Y.Z`, creates a GitHub Release, and publishes the tagged npm package to GitHub Packages after CI passes. Configure Actions to create pull requests (workflow read/write permissions), allow `GITHUB_TOKEN` package publication in the organization, and grant the workflow `contents`, `issues`, `pull-requests`, and `packages` permissions as shown in [CI](.github/workflows/ci.yml). No separate npm token is needed for the reference GitHub Packages flow. No release is triggered merely by this checkout.

## License

MIT.

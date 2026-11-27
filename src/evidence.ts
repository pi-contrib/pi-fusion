import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { State } from "./fusion.ts";
import { text } from "./fusion.ts";

const MAX_DIFF = 24000;
const MAX_STATUS = 8000;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;

function boundedSection(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, limit)}\n[truncated ${value.length - limit} characters]`
    : value;
}
function sensitive(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((part) =>
      /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|.*(?:secret|credential|private.?key|api.?key|token|id_rsa|id_ed25519|\.key|\.pem|\.p12|\.pfx).*)$/i.test(
        part,
      ),
    );
}
function safePath(cwd: string, path: string): string | undefined {
  if (!path || isAbsolute(path) || path.includes("\0")) return;
  const full = resolve(cwd, path);
  const rel = relative(cwd, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return;
  return full;
}

async function git(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string[],
): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    if (result.code !== undefined && result.code !== 0) return;
    return result.stdout;
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return;
  }
}

/** Read only small, regular, non-ignored new files; an opt-in is still needed for privacy. */
export async function untrackedEvidence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string> {
  const listed = await git(pi, ctx, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (listed === undefined) return "[untracked file listing unavailable]";
  const paths = listed.split("\0").filter(Boolean);
  const notes: string[] = [];
  let included = 0;
  let used = 0;
  let omitted = 0;
  const root = realpathSync(ctx.cwd);
  for (const path of paths) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    if (included >= MAX_FILES || used >= MAX_TOTAL_BYTES) {
      omitted++;
      continue;
    }
    const full = safePath(ctx.cwd, path);
    if (!full || sensitive(path)) {
      omitted++;
      continue;
    }
    let fd: number | undefined;
    try {
      // O_NOFOLLOW rejects symlinks; O_NONBLOCK avoids hanging if a file changes to a pipe.
      fd = openSync(
        full,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = fstatSync(fd);
      const actual = realpathSync(full);
      if (
        !stat.isFile() ||
        stat.size > MAX_FILE_BYTES ||
        (actual !== root && !actual.startsWith(`${root}${sep}`))
      ) {
        omitted++;
        continue;
      }
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      if (size > MAX_FILE_BYTES || used + size > MAX_TOTAL_BYTES) {
        omitted++;
        continue;
      }
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      );
      if (
        Array.from(content).some((char) => {
          const code = char.codePointAt(0) ?? 0;
          return code < 32 && code !== 9 && code !== 10 && code !== 13;
        })
      ) {
        omitted++;
        continue;
      }
      notes.push(`File ${JSON.stringify(path)}:\n${content}`);
      included++;
      used += size;
    } catch {
      omitted++;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (omitted)
    notes.push(
      `[${omitted} untracked file(s) omitted: limit, sensitive name, non-text, unsafe or unreadable]`,
    );
  return notes.join("\n\n") || "[no eligible untracked text files]";
}

export async function evidence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: State,
  includeUntracked = false,
): Promise<string> {
  const messages = ctx.sessionManager
    .getBranch()
    .filter((e) => e.type === "message")
    .map((e) => e.message);
  const start = messages.findLastIndex(
    (m) => m.role === "user" && m.timestamp === state.task,
  );
  const draft = messages
    .slice(start + 1)
    .filter((m) => m.role === "assistant" || m.role === "toolResult")
    .map(
      (m) =>
        `${m.role}${m.role === "toolResult" ? ` (${m.toolName}${m.isError ? ", error" : ""})` : ""}: ${text(m)}`,
    )
    .join("\n");
  const [unstaged, staged, status] = await Promise.all([
    git(pi, ctx, ["diff", "--no-ext-diff", "--no-textconv", "--", "."]),
    git(pi, ctx, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ".",
    ]),
    git(pi, ctx, ["status", "--short"]),
  ]);
  const untracked = includeUntracked
    ? await untrackedEvidence(pi, ctx)
    : "[untracked contents disabled; paths only in status]";
  const boundedDraft =
    draft.length > 24000
      ? `[truncated ${draft.length - 24000} leading characters]\n${draft.slice(-24000)}`
      : draft;
  return `Draft and tool/check results:\n${boundedDraft}\n\nGit status:\n${status === undefined ? "[unavailable]" : boundedSection(status, MAX_STATUS)}\nUnstaged Git diff:\n${unstaged === undefined ? "[unavailable]" : boundedSection(unstaged, MAX_DIFF)}\nStaged Git diff:\n${staged === undefined ? "[unavailable]" : boundedSection(staged, MAX_DIFF)}\nUntracked files:\n${untracked}`;
}

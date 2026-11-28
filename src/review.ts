import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bounded, chat, logFailure, parseJson } from "./model.ts";
import { criticPrompt, judgePrompt, revisePrompt } from "./prompts.ts";
import type { Config, State, Transition } from "./types.ts";

export function advance(
  state: State,
  config: Config,
  result: { decision?: string; findings?: string; failures?: string[] },
): Transition {
  if (state.phase !== "draft")
    return {
      phase: "done",
      author: state.author,
      note: "Review limit reached",
    };
  if (state.workflow === "single")
    return { phase: "done", author: state.author, note: "Single complete" };
  const failures = result.failures ?? [];
  if (state.workflow === "cascade") {
    if (result.decision === "accept")
      return { phase: "done", author: state.author, note: "Judge accepted" };
    if (result.decision === "escalate")
      return {
        phase: "revision",
        author: config.strong,
        feedback: result.findings || "Judge requested escalation",
        note: "Escalation",
      };
    return {
      phase: "done",
      author: state.author,
      note: `Judge could not complete: ${failures.join("; ") || "invalid decision"}`,
    };
  }
  if (!result.findings && failures.length)
    return {
      phase: "done",
      author: state.author,
      note: `Review could not complete: ${failures.join("; ")}`,
    };
  return {
    phase: "revision",
    author: state.author,
    feedback: [
      result.findings,
      ...failures.map((f) => `Review could not complete: ${f}`),
    ]
      .filter(Boolean)
      .join("\n"),
    note: "Critique revision",
  };
}

export async function review(
  ctx: ExtensionContext,
  config: Config,
  state: State,
  evidence: string,
  signal?: AbortSignal,
): Promise<Transition> {
  const prompt = `Original request:\n${state.request}\n\nActual draft and evidence:\n${evidence}`;
  if (state.workflow === "cascade") {
    try {
      const answer = parseJson(
        await bounded(
          (s) => chat(ctx, config.judge, `${judgePrompt}\n${prompt}`, s),
          signal,
          config.timeoutMs,
        ),
      );
      if (
        !Array.isArray(answer.findings) &&
        (answer.decision === "accept" || answer.decision === "escalate") &&
        (answer.decision === "accept" ||
          (typeof answer.findings === "string" && answer.findings.length > 0))
      )
        return advance(state, config, {
          decision: answer.decision as string,
          findings: answer.findings as string,
        });
      throw new Error("invalid judge response");
    } catch (error) {
      if (signal?.aborted) throw error;
      logFailure(ctx, "judge review failed", error);
      return advance(state, config, { failures: [String(error)] });
    }
  }
  const results = await Promise.all(
    config.critics
      .slice(0, state.reviewerLimit ?? config.critics.length)
      .map(async (ref) => {
        try {
          const answer = parseJson(
            await bounded(
              (s) => chat(ctx, ref, `${criticPrompt}\n${prompt}`, s),
              signal,
              config.timeoutMs,
            ),
          );
          if (typeof answer.findings !== "string")
            throw new Error("invalid findings");
          return { finding: `${ref.provider}/${ref.id}: ${answer.findings}` };
        } catch (error) {
          if (!signal?.aborted)
            logFailure(ctx, `critic ${ref.provider}/${ref.id} failed`, error);
          return { failure: `${ref.provider}/${ref.id}: ${String(error)}` };
        }
      }),
  );
  if (signal?.aborted) throw signal.reason;
  return advance(state, config, {
    findings: results
      .map((r) => ("finding" in r ? r.finding : ""))
      .filter(Boolean)
      .join("\n"),
    failures: results
      .map((r) => ("failure" in r ? r.failure : ""))
      .filter(Boolean) as string[],
  });
}

/** Concise one-line notice summarizing the review verdict and findings. */
export function reviewNotice(state: State, transition: Transition): string {
  if (transition.phase !== "revision")
    return `Fusion review: ${transition.note}`;
  const summary = (transition.feedback ?? "").replace(/\s+/g, " ").trim();
  const clipped = summary.length > 120 ? `${summary.slice(0, 119)}…` : summary;
  const label =
    state.workflow === "cascade" ? "judge escalated" : "critics reviewed";
  return clipped
    ? `Fusion review (${label}): ${clipped} — revising`
    : `Fusion review (${label}): revising`;
}

/** Visible to the user and the author; the author already holds the draft in its own transcript. */
export function revisionMessage(state: State, transition: Transition): string {
  const label = state.workflow === "cascade" ? "judge" : "critics";
  return `**Fusion review (${label}): ${transition.note}**\n\n${revisePrompt}\n\nOriginal request:\n${state.request}\n\nFindings (verify independently):\n${transition.feedback ?? "none"}`;
}

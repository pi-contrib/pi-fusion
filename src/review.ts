import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bounded, chat, logFailure, parseJson } from "./model.ts";
import { criticPrompt, judgePrompt, revisePrompt } from "./prompts.ts";
import type { Config, ReviseDetails, State, Transition } from "./types.ts";

export function advance(
  state: State,
  config: Config,
  result: {
    decision?: string;
    findings?: string;
    findingsList?: string[];
    failures?: string[];
  },
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
  const findingsList =
    result.findingsList ??
    (result.findings ? [result.findings].filter(Boolean) : []);
  if (state.workflow === "cascade") {
    if (result.decision === "accept")
      return {
        phase: "done",
        author: state.author,
        note: "Review passed",
        outcome: "accepted",
      };
    if (result.decision === "escalate") {
      const feedback = result.findings || "Judge requested escalation";
      return {
        phase: "revision",
        author: config.strong,
        feedback,
        note: "Review requested changes",
        outcome: "revised",
        findingsList: findingsList.length ? findingsList : [feedback],
        failuresList: [],
      };
    }
    return {
      phase: "done",
      author: state.author,
      note: `Judge could not complete: ${failures.join("; ") || "invalid decision"}`,
      outcome: "degraded",
      failuresList: failures,
    };
  }
  if (!result.findings && failures.length)
    return {
      phase: "done",
      author: state.author,
      note: `Review could not complete: ${failures.join("; ")}`,
      outcome: "degraded",
      failuresList: failures,
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
    outcome: "revised",
    findingsList,
    failuresList: failures,
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
          findingsList:
            typeof answer.findings === "string" && answer.findings.length > 0
              ? [answer.findings]
              : [],
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
  const findingsList = results
    .map((r) => ("finding" in r ? r.finding : undefined))
    .filter((v): v is string => Boolean(v));
  const failures = results
    .map((r) => ("failure" in r ? r.failure : undefined))
    .filter((v): v is string => Boolean(v));
  return advance(state, config, {
    findings: findingsList.join("\n"),
    findingsList,
    failures,
  });
}

/** Structured metadata rendered by the custom `fusion.revise` TUI card. */
export function reviseDetails(
  state: State,
  transition: Transition,
  reviewerCount: number,
): ReviseDetails {
  return {
    workflow: state.workflow === "cascade" ? "cascade" : "critique",
    effort: state.effort,
    author: transition.author,
    reviewerCount,
    findings:
      transition.findingsList ??
      (transition.feedback ? [transition.feedback] : []),
    failures: transition.failuresList ?? [],
  };
}

/** Revision instructions sent to the author; TUI renders `ReviseDetails` via `renderReviseCard`. */
export function revisionMessage(state: State, transition: Transition): string {
  return `${revisePrompt}\n\nOriginal request:\n${state.request}\n\nFindings (verify independently):\n${transition.feedback ?? "none"}`;
}

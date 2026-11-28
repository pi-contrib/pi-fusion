import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Ref } from "./types.ts";

export function text(message: Message): string {
  const content = message.content;
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export function lastUser(messages: readonly Message[]): Message | undefined {
  return messages.findLast((m) => m.role === "user");
}

export function physical(ctx: ExtensionContext, ref: Ref): Model<Api> {
  const model = ctx.modelRegistry
    .getAvailable()
    .find(
      (m) =>
        m.provider === ref.provider &&
        m.id === ref.id &&
        m.api !== "pi-virtual",
    );
  if (!model)
    throw new Error(
      `Physical chat model ${ref.provider}/${ref.id} is unavailable`,
    );
  return model;
}

export function parseJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  const unwrapped = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const parsed: unknown = JSON.parse(unwrapped.trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid JSON response");
  return parsed as Record<string, unknown>;
}

/** Log underlying error details to stderr outside interactive TUI mode (where raw stderr corrupts rendering). */
export function logFailure(
  ctx: Pick<ExtensionContext, "mode">,
  scope: string,
  error: unknown,
): void {
  if (ctx.mode && ctx.mode !== "tui")
    console.error(`[pi-fusion] ${scope}:`, error);
}

export function timeoutSignal(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const timer = AbortSignal.timeout(ms);
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      parent?.aborted ? parent.reason : new Error("Fusion model timeout"),
    );
  parent?.addEventListener("abort", abort, { once: true });
  timer.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => parent?.removeEventListener("abort", abort),
  };
}

export async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  ms: number,
): Promise<T> {
  const { signal, dispose } = timeoutSignal(parent, ms);
  try {
    if (signal.aborted) throw signal.reason;
    return await Promise.race([
      run(signal),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
    ]);
  } finally {
    dispose();
  }
}

export async function chat(
  ctx: ExtensionContext,
  ref: Ref,
  prompt: string,
  signal: AbortSignal,
  recordCost?: (cost: number) => void,
): Promise<string> {
  const result = await ctx.modelRegistry
    .streamSimple(
      physical(ctx, ref),
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { signal },
    )
    .result();
  recordCost?.(result.usage?.cost.total ?? 0);
  if (result.stopReason !== "stop")
    throw new Error(
      result.errorMessage ?? `Model stopped: ${result.stopReason}`,
    );
  return text(result);
}

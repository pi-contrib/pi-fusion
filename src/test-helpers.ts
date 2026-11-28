import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentSettledEvent,
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionVirtualModel,
  ModelRoute,
  ModelRouteReason,
  ModelRouteRequest,
  ModelSelectEvent,
  RegisteredCommand,
  SessionEntry,
  SessionStartEvent,
  ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { text } from "./model.ts";
import type { Config, Ref, State, Workflow } from "./types.ts";

export const ref = (id: string, provider = "mock"): Ref => ({ provider, id });

export const mockConfig: Config = {
  router: ref("router"),
  fast: ref("fast"),
  strong: ref("strong"),
  judge: ref("judge"),
  critics: [ref("c1"), ref("c2")],
  defaultAuthor: "fast",
  timeoutMs: 1000,
};

export const mockCatalog = [
  "router",
  "fast",
  "strong",
  "judge",
  "c1",
  "c2",
].map((id) => ({
  ...ref(id),
  api: "mock",
}));

export const exampleCatalog = ["gpt-5.6-luna", "gpt-5.6-sol"].map((id) => ({
  provider: "openai-codex",
  id,
  api: "mock",
}));

export const userMessage = (
  content: Message["content"] = "Fix the bug",
  timestamp = 101,
): Message =>
  ({
    role: "user",
    content,
    timestamp,
  }) as Message;

export const routeRequest = (
  messages: readonly Message[],
  thinkingLevel: ThinkingLevel = "high",
  overrides: Partial<ModelRouteRequest<State>> = {},
): ModelRouteRequest<State> =>
  ({
    reason: "user" as ModelRouteReason,
    thinkingLevel,
    messages,
    ...overrides,
  }) as unknown as ModelRouteRequest<State>;

export const draftState = (
  workflow: Workflow,
  overrides: Partial<State> = {},
): State => ({
  task: 101,
  request: "Fix the bug",
  workflow,
  effort: "high",
  tier: "fast",
  author: mockConfig.fast,
  phase: "draft",
  ...overrides,
});

export type NoticeRecord = {
  message: string;
  type: "info" | "warning" | "error" | undefined;
};

export type StreamCall = {
  id: string;
  provider: string;
  prompt: string;
  signal: AbortSignal | undefined;
};

export function createMockChatContext(
  reply: Record<string, string | Error>,
  options: {
    delay?: (modelId: string) => Promise<void>;
    mode?: ExtensionContext["mode"];
    available?: Array<{ provider: string; id: string; api: string }>;
  } = {},
) {
  const calls: StreamCall[] = [];
  const statuses: Array<string | undefined> = [];
  const notices: NoticeRecord[] = [];
  const delay = options.delay ?? (() => Promise.resolve());
  const available = options.available ?? mockCatalog;
  const ctx = {
    cwd: process.cwd(),
    mode: options.mode ?? "tui",
    ui: {
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
      },
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notices.push({ message, type });
      },
    },
    sessionManager: { getBranch: () => [] as SessionEntry[] },
    modelRegistry: {
      getAvailable: () => available,
      findOfType: (): unknown => undefined,
      classify: undefined as
        | ((
            model: unknown,
            payload: unknown,
            opts: { signal?: AbortSignal },
          ) => Promise<unknown>)
        | undefined,
      streamSimple(
        model: { id: string; provider: string },
        context: { messages: readonly Message[] },
        opts?: { signal?: AbortSignal },
      ) {
        const first = context.messages[0];
        calls.push({
          id: model.id,
          provider: model.provider,
          prompt: first ? text(first) : "",
          signal: opts?.signal,
        });
        return {
          result: async () => {
            await delay(model.id);
            const value = reply[model.id];
            if (value instanceof Error) throw value;
            return {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: value ?? "" }],
            };
          },
        };
      },
    },
  };
  return {
    ctx: ctx as unknown as ExtensionContext,
    raw: ctx,
    calls,
    statuses,
    notices,
  };
}

export type MountedHandlers = {
  session_start?: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<undefined> | undefined;
  model_select?: (
    event: ModelSelectEvent,
    ctx: ExtensionContext,
  ) => Promise<undefined> | undefined;
  thinking_level_select?: (
    event: ThinkingLevelSelectEvent,
    ctx: ExtensionContext,
  ) => Promise<undefined> | undefined;
  agent_before_settle?: (
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
  ) => Promise<AgentBeforeSettleEventResult | undefined>;
  agent_settled?: (
    event: AgentSettledEvent,
    ctx: ExtensionContext,
  ) => Promise<undefined> | undefined;
};

export function mountExtension(
  options: {
    exec?: (
      command: string,
      args: string[],
      opts?: ExecOptions,
    ) => Promise<ExecResult>;
    thinkingLevel?: "low" | "medium" | "high" | "xhigh";
  } = {},
) {
  const entries: SessionEntry[] = [];
  const handlers: MountedHandlers = {};
  let definition: ExtensionVirtualModel<State> | undefined;
  let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  let commandName: string | undefined;
  const pi = {
    registerVirtualModel(d: ExtensionVirtualModel<State>) {
      definition = d;
    },
    registerCommand(
      name: string,
      opts: Omit<RegisteredCommand, "name" | "sourceInfo">,
    ) {
      commandName = name;
      command = opts;
    },
    on(name: string, fn: (...args: never[]) => unknown) {
      (handlers as Record<string, unknown>)[name] = fn;
      return () => {};
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data } as SessionEntry);
    },
    getThinkingLevel: () => options.thinkingLevel ?? "high",
    exec:
      options.exec ??
      (async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        killed: false,
        truncated: false,
      })),
  };
  extension(pi as unknown as ExtensionAPI);
  const registeredModel = definition;
  const registeredCommand = command;
  if (!registeredModel || !registeredCommand)
    throw new Error("Extension failed to register virtual model or command");
  return {
    pi: pi as unknown as ExtensionAPI,
    definition: registeredModel,
    route: async (
      req: ModelRouteRequest<State>,
      ctx: ExtensionContext,
    ): Promise<ModelRoute<State>> => registeredModel.route(req, ctx),
    commandName,
    command: (args: string, ctx: ExtensionContext) =>
      registeredCommand.handler(args, ctx as ExtensionCommandContext),
    completions: registeredCommand.getArgumentCompletions,
    handlers,
    entries,
  };
}

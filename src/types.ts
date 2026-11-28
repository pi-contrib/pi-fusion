export type Ref = { provider: string; id: string };
export type Workflow = "single" | "cascade" | "critique";
export type Tier = "fast" | "strong";
export type FusionEffort = "standard" | "high" | "max";
export type Route = { workflow: Workflow; tier: Tier };
export type RouteSignal =
  | "straightforward"
  | "complex"
  | "fast-draft"
  | "review-risk";

export const routeSignals: RouteSignal[] = [
  "straightforward",
  "complex",
  "fast-draft",
  "review-risk",
];

export function isWorkflow(value: string): value is Workflow {
  return value === "single" || value === "cascade" || value === "critique";
}

export type Config = {
  router: Ref;
  fast: Ref;
  strong: Ref;
  judge: Ref;
  critics: Ref[];
  defaultAuthor: Tier;
  timeoutMs: number;
  reviewEvidence?: { includeUntracked?: boolean };
  budget?: {
    /** Maximum optional reviewer calls; Critique needs at least two. */
    maxReviewerCalls?: number;
    /** Soft USD threshold checked before review, never interrupts the author. */
    maxTaskCostUsd?: number;
    /** Total wall-clock limit for one review round. */
    maxReviewMs?: number;
  };
};

export type State = {
  task: number;
  request: string;
  effort: FusionEffort;
  workflow: Workflow;
  tier: Tier;
  phase: "draft" | "revision" | "done";
  author: Ref;
  reviewerLimit?: number;
  routingCostUsd?: number;
  budgetNote?: string;
  routeReason?: string;
  override?: Workflow;
};

export type Transition = {
  phase: "done" | "revision";
  author: Ref;
  feedback?: string;
  note: string;
};

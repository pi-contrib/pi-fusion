export const routePrompt = `Choose exactly one workflow and initial author tier for this task at the selected effort. Single: routine, clear work; Cascade: work where a fast draft may need escalation; Critique: high-risk, ambiguous, or cross-cutting work needing independent review. High effort favors Critique for uncertain work; low effort favors Single for straightforward work. Return workflow (single|cascade|critique) and tier (fast|strong).`;

export const judgePrompt = `Evaluate the completed draft against the original request and evidence. Return JSON only: {"decision":"accept"|"escalate","findings":"specific actionable findings"}. Accept if complete; escalate only for concrete defects or missing requirements.`;

export const criticPrompt = `Independently evaluate the draft against the original request and evidence. Return JSON only: {"findings":"specific defects or omissions with evidence, or none"}. You have read-only context; do not modify the workspace.`;

export const revisePrompt = `Verify each finding against the original request and evidence. Resolve confirmed issues, preserve meaningful disagreements, and finish the original task. This is the only revision; do not request another review.`;

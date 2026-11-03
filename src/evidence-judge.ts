import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";

export interface PlanningReplyCheck {
  concernId: string;
  disposition: "changed" | "rebutted" | "unable_to_address";
  reply: string;
  previousPlan: string;
  currentPlan: string;
}

export interface PlanningReplyJudgment {
  concernId: string;
  verdict: "addressed" | "not_addressed" | "unclear";
  reason: string;
}

export interface PlanningReadinessChoices {
  steps: "concrete" | "investigation_only" | "vague" | "unknown";
  evidence: "linked" | "decisive_fact_missing" | "unsupported" | "unknown";
  validation: "reported_path" | "narrower" | "missing" | "unknown";
  uncertainty:
    "nonblocking" | "bounded_blocker" | "unbounded_blocker" | "unknown";
}

export interface PlanningReadinessJudgment {
  verdict: "ready" | "needs-investigation" | "revise";
  choices: PlanningReadinessChoices;
  inputTokens?: number;
  estimatedCostUsd: number;
}

const MODEL = "@cf/cloudflare/clef-flash";

function tomlString(source: string, key: string): string | undefined {
  const match = source.match(
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]*)"\\s*$`, "m"),
  );
  return match?.[1];
}

export function readWranglerOAuthToken(
  path = join(homedir(), ".config", ".wrangler", "config", "default.toml"),
): string | undefined {
  try {
    const source = readFileSync(path, "utf8");
    const expiration = tomlString(source, "expiration_time");
    if (expiration && Date.parse(expiration) <= Date.now()) return undefined;
    return tomlString(source, "oauth_token");
  } catch {
    return undefined;
  }
}

function usageInputTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  for (const key of ["input_tokens", "inputTokens", "prompt_tokens"]) {
    const tokens = usage[key];
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0)
      return tokens;
  }
  return undefined;
}

export async function judgePlanningReplies(args: {
  config: Config;
  replies: PlanningReplyCheck[];
  stage?: "planning" | "implementation";
  currentCostUsd: number;
  maxCostUsd: number;
  signal?: AbortSignal;
}): Promise<{
  judgments: PlanningReplyJudgment[];
  inputTokens?: number;
  estimatedCostUsd: number;
}> {
  if (args.replies.length === 0) return { judgments: [], estimatedCostUsd: 0 };
  const settings = args.config.reviewer.pairedWorkflow.evidenceJudge;
  const accountId = process.env[settings.accountIdEnv];
  if (!accountId)
    throw new Error(
      `Set ${settings.accountIdEnv} for the planning reply check`,
    );
  const token = process.env[settings.apiTokenEnv] ?? readWranglerOAuthToken();
  if (!token)
    throw new Error(
      `Set ${settings.apiTokenEnv} or sign in with Wrangler before checking planning replies`,
    );

  const stage = args.stage ?? "planning";
  const subject = stage === "implementation" ? "patch" : "plan";
  const requests = args.replies.map((reply) =>
    JSON.stringify({
      model: "clef-flash",
      state: JSON.stringify({
        instruction: `This is a narrow pre-review completeness check, not a substantive review. For a changed reply, check only whether the claimed ${subject} change is present in the submitted ${subject}. Do not assess the concern, acceptance criteria, or whether the change is sufficient. Rebuttals and unable_to_address replies must reach the reviewer unchanged for judgment. If evidence is ambiguous, return unclear so the reviewer can assess it.`,
        disposition: reply.disposition,
        plannerReply: reply.reply,
        previousPlan: reply.previousPlan,
        submittedPlan: reply.currentPlan,
      }),
      questions: {
        assessment: {
          type: "choice",
          instructions: `For a changed reply, is the claimed change present in the submitted ${subject}? For rebutted or unable_to_address, return addressed so the reviewer can judge it.`,
          criteria: {
            addressed:
              "The disposition is rebutted or unable_to_address, or the claimed change in a changed reply appears in the submitted plan.",
            not_addressed:
              "A changed reply claims a plan change that is absent from the submitted plan.",
            unclear:
              "For a changed reply, the submitted plan does not establish whether the claimed change is present.",
          },
        },
      },
    }),
  );
  const estimatedInputTokens = requests.reduce(
    (sum, body) => sum + Math.ceil(Buffer.byteLength(body) / 3),
    0,
  );
  const reserveUsd =
    (estimatedInputTokens * settings.inputUsdPerMillion) / 1_000_000;
  if (args.currentCostUsd + reserveUsd > args.maxCostUsd)
    throw new Error("Cost budget exceeded before the planning reply check");

  const judgments: PlanningReplyJudgment[] = [];
  let inputTokens = 0;
  let usageKnown = true;
  for (let index = 0; index < args.replies.length; index++) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${MODEL}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: requests[index],
        signal: args.signal
          ? AbortSignal.any([
              args.signal,
              AbortSignal.timeout(
                args.config.agent.modelRequestTimeoutSeconds * 1000,
              ),
            ])
          : AbortSignal.timeout(
              args.config.agent.modelRequestTimeoutSeconds * 1000,
            ),
      },
    );
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new Error(
        `Cloudflare Clef-Flash planning reply check failed (${response.status}): ${JSON.stringify(responseBody).slice(0, 1000)}`,
      );
    if (!responseBody || typeof responseBody !== "object")
      throw new Error("Cloudflare Clef-Flash returned an invalid response");
    const envelope = responseBody as Record<string, unknown>;
    const result = (envelope.result ?? envelope) as Record<string, unknown>;
    const answers = result.answers as Record<string, unknown> | undefined;
    const answer = answers?.assessment as Record<string, unknown> | undefined;
    const choice = answer?.choice;
    const verdict = ["addressed", "not_addressed", "unclear"].includes(
      String(choice),
    )
      ? (choice as PlanningReplyJudgment["verdict"])
      : "unclear";
    const fallbackReason =
      verdict === "addressed"
        ? "The claimed plan change is present, or the reply was passed through for reviewer judgment."
        : verdict === "not_addressed"
          ? "The changed reply claims a plan change that is absent from the submitted plan."
          : "The submitted plan does not make the claimed change clear; the reviewer should assess it.";
    judgments.push({
      concernId: args.replies[index]!.concernId,
      verdict,
      reason: String(
        answer?.reason ?? answer?.explanation ?? fallbackReason,
      ).slice(0, 500),
    });
    const usage = usageInputTokens(result.usage);
    if (usage === undefined) usageKnown = false;
    else inputTokens += usage;
  }
  const countedInput = usageKnown ? inputTokens : undefined;
  return {
    judgments,
    inputTokens: countedInput,
    estimatedCostUsd:
      ((countedInput ?? estimatedInputTokens) * settings.inputUsdPerMillion) /
      1_000_000,
  };
}

export async function judgePlanningReadiness(args: {
  config: Config;
  issue: { title: string; body: string };
  revisionId: string;
  plan: unknown;
  repositoryNotes: string;
  currentCostUsd: number;
  maxCostUsd: number;
  signal?: AbortSignal;
}): Promise<PlanningReadinessJudgment> {
  const settings = args.config.reviewer.pairedWorkflow.evidenceJudge;
  const accountId = process.env[settings.accountIdEnv];
  if (!accountId)
    throw new Error(
      `Set ${settings.accountIdEnv} for the planning readiness check`,
    );
  const token = process.env[settings.apiTokenEnv] ?? readWranglerOAuthToken();
  if (!token)
    throw new Error(
      `Set ${settings.apiTokenEnv} or sign in with Wrangler before checking planning readiness`,
    );

  const body = JSON.stringify({
    model: "clef-flash",
    state: JSON.stringify({
      instruction:
        "Classify whether the submitted artifact is ready for substantive review as an implementation plan. Judge only the supplied issue, plan, and repository notes. Do not propose a fix or write freeform feedback. A broad investigation plan is not an implementation plan. Use the fixed choices in each question; the harness applies the pass rule.",
      issue: args.issue,
      revisionId: args.revisionId,
      plan: args.plan,
      repositoryNotes: args.repositoryNotes,
    }),
    questions: {
      steps: {
        type: "choice",
        instructions:
          "Are proposedChanges executable implementation steps for this issue?",
        criteria: {
          concrete:
            "Names a supported target file/function or bounded area, behavior to change, and expected result; includes an actual fix when a fix is requested.",
          investigation_only:
            "Only diagnoses, explores, or defers choosing the fix.",
          vague: "Target, behavior, or result is generic or missing.",
        },
      },
      evidence: {
        type: "choice",
        instructions:
          "Does the cited evidence support why these implementation steps address the reported behavior?",
        criteria: {
          linked:
            "Observations connect the reported path to the proposed change.",
          decisive_fact_missing:
            "A specific missing observation determines which change is safe.",
          unsupported:
            "There is no clear link, or the concrete edit goes beyond the evidence.",
        },
      },
      validation: {
        type: "choice",
        instructions:
          "Does the validation check the reported behavior and state an observable success?",
        criteria: {
          reported_path:
            "States a check and observable success on the reported path.",
          narrower: "Only a component or narrower path is checked.",
          missing: "No usable check or expected observation is given.",
        },
      },
      uncertainty: {
        type: "choice",
        instructions:
          "How does the artifact handle uncertainty that could change the safe fix?",
        criteria: {
          nonblocking: "Open questions do not determine the fix.",
          bounded_blocker:
            "Names the decisive question, a feasible read-only check, outcomes that distinguish possible fixes, and a stop condition.",
          unbounded_blocker:
            "A fix-blocking unknown remains without a bounded decisive check.",
        },
      },
    },
  });
  const estimatedInputTokens = Math.ceil(Buffer.byteLength(body) / 3);
  const reserveUsd =
    (estimatedInputTokens * settings.inputUsdPerMillion) / 1_000_000;
  if (args.currentCostUsd + reserveUsd > args.maxCostUsd)
    throw new Error("Cost budget exceeded before the planning readiness check");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
      signal: args.signal
        ? AbortSignal.any([
            args.signal,
            AbortSignal.timeout(
              args.config.agent.modelRequestTimeoutSeconds * 1000,
            ),
          ])
        : AbortSignal.timeout(
            args.config.agent.modelRequestTimeoutSeconds * 1000,
          ),
    },
  );
  const responseBody: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      `Cloudflare Clef-Flash planning readiness check failed (${response.status}): ${JSON.stringify(responseBody).slice(0, 1000)}`,
    );
  if (!responseBody || typeof responseBody !== "object")
    throw new Error("Cloudflare Clef-Flash returned an invalid response");
  const envelope = responseBody as Record<string, unknown>;
  const result = (envelope.result ?? envelope) as Record<string, unknown>;
  const answers = result.answers as Record<string, unknown> | undefined;
  const choice = (key: string, allowed: string[]): string => {
    const answer = answers?.[key];
    const value =
      answer && typeof answer === "object"
        ? (answer as Record<string, unknown>).choice
        : undefined;
    return typeof value === "string" && allowed.includes(value)
      ? value
      : "unknown";
  };
  const choices: PlanningReadinessChoices = {
    steps: choice("steps", [
      "concrete",
      "investigation_only",
      "vague",
    ]) as PlanningReadinessChoices["steps"],
    evidence: choice("evidence", [
      "linked",
      "decisive_fact_missing",
      "unsupported",
    ]) as PlanningReadinessChoices["evidence"],
    validation: choice("validation", [
      "reported_path",
      "narrower",
      "missing",
    ]) as PlanningReadinessChoices["validation"],
    uncertainty: choice("uncertainty", [
      "nonblocking",
      "bounded_blocker",
      "unbounded_blocker",
    ]) as PlanningReadinessChoices["uncertainty"],
  };
  const ready =
    choices.steps === "concrete" &&
    choices.evidence === "linked" &&
    choices.validation === "reported_path" &&
    choices.uncertainty === "nonblocking";
  const needsInvestigation =
    choices.evidence === "decisive_fact_missing" &&
    choices.uncertainty === "bounded_blocker";
  const verdict = ready
    ? "ready"
    : needsInvestigation
      ? "needs-investigation"
      : "revise";
  const usage = usageInputTokens(result.usage);
  return {
    verdict,
    choices,
    inputTokens: usage,
    estimatedCostUsd:
      ((usage ?? estimatedInputTokens) * settings.inputUsdPerMillion) /
      1_000_000,
  };
}

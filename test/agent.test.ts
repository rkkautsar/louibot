import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { toolStrategy } from "langchain";
import {
  compactMalformedRecoveryContext,
  compactValidationRepairContext,
  implementationInvocationThreadId,
  handlePlanningStructuredOutputError,
  invokeWithMalformedToolCallRecovery,
  invokeWithCompletionRecovery,
  invokeWithCostBudget,
  hasNonTestSourceChange,
  controllerValidationRecords,
  optionalPlannedTestFiles,
  referencedTestFiles,
  requiredValidationIssues,
  validationPatchFingerprint,
  implementationReviewInput,
  implementationReviewIssues,
  investigationReviewSchema,
  normalizeInvestigationReview,
  pairedPatchReviewSchema,
  pairedPatchApprovalIssues,
  pairedCarryoverFindingsFromText,
  implementationRecursionLimit,
  investigationCommandCap,
  investigationRecursionLimit,
  pairedInvestigationContinuation,
  pairedImplementationContinuation,
  pairedReviewApprovalEvidenceRequirement,
  pairedReviewOutcomeRequirement,
  requestedChecksNeedingReview,
  pairedReviewEvidenceFollowUp,
  needsBlockedContinuation,
  needsCompletionContinuation,
  parseAgentResponse,
  pairedReviewMessages,
  resultSchemaFor,
  missingBlockingPlanningReplies,
  planningApprovalIsValid,
  planningReviewIssues,
  planningRevisionDiff,
  mergePlanningEvidenceLedger,
  normalizePlanningSubmission,
  planningSubmissionSchema,
} from "../src/agent.js";

const resultSchema = z.object({ status: z.string() });

test("planning evidence ledger preserves completed checks across fresh submissions", () => {
  const merged = mergePlanningEvidenceLedger(
    {
      discoverySummary:
        "A transformer-only test passes but does not exercise the reported path.",
      completedChecks: [
        {
          command: "yarn test transformer",
          observation: "6 tests passed",
          establishes: "Existing transformer cases pass",
        },
      ],
      ruledOut: ["The focused transformer cases do not cover the report"],
      nextExperiment: "Build a minimal site using the reported layout",
    },
    {
      discoverySummary:
        "The reported URL is rewritten before image transformation; confirm through the docs build.",
      completedChecks: [
        {
          command: "yarn test transformer",
          observation: "6 tests passed",
          establishes: "Existing transformer cases pass",
        },
        {
          command: "node reproduce-markdown-rewrite.js",
          observation: "The URL prefix was rewritten",
          establishes: "The corruption happens before image transformation",
        },
      ],
      ruledOut: ["The focused transformer cases do not cover the report"],
      nextExperiment: "Run the focused utility regression test",
    },
  );

  assert.equal(merged.completedChecks.length, 2);
  assert.equal(
    merged.discoverySummary,
    "The reported URL is rewritten before image transformation; confirm through the docs build.",
  );
  assert.equal(merged.ruledOut.length, 1);
  assert.equal(
    merged.nextExperiment,
    "Run the focused utility regression test",
  );
  assert.equal(merged.completedChecks[0]?.command, "yarn test transformer");
});

test("planning submissions accept omitted replies and normalize them to empty", () => {
  const parsed = planningSubmissionSchema.parse({
    plan: {
      problem: "Reported path fails.",
      proposedExplanation: "A path rewrite causes the failure.",
      evidence: [],
      proposedChanges: [],
      validationChecks: [
        {
          id: "check-1",
          command: "yarn test reported-path",
          expectedOutcome: "The reported behavior passes.",
          reportedBehaviorQuotes: ["reported behavior"],
        },
      ],
      validation: "Run the reported reproduction and verify it passes.",
      openQuestions: [],
    },
    repositoryNotes: "",
  });
  const submission = normalizePlanningSubmission(parsed);

  const [{ schema: responseSchema }] = toolStrategy(
    planningSubmissionSchema,
  ) as unknown as Array<{ schema: { required: string[] } }>;

  assert.deepEqual(submission.replies, []);
  assert.equal(responseSchema.required.includes("replies"), false);
  assert.deepEqual(
    missingBlockingPlanningReplies(
      [
        {
          id: "thread-1",
          openedOnRevisionId: "plan-1",
          concern: "The plan misses a case.",
          blocking: true,
          acceptanceCriteria: "Address the case.",
          status: "open",
        },
      ],
      submission.replies,
    ),
    ["thread-1"],
  );
});

test("planning evidence ledger accepts shell commands up to the shell limit", () => {
  const command = `grep -RIn '${"x".repeat(580)}' packages`;
  assert.equal(command.length, 601);
  assert.equal(
    planningSubmissionSchema.safeParse({
      plan: {
        problem: "Reported path fails.",
        proposedExplanation: "A path rewrite causes the failure.",
        evidence: [],
        proposedChanges: [],
        validationChecks: [
          {
            id: "check-1",
            command: "yarn test reported-path",
            expectedOutcome: "The reported behavior passes.",
            reportedBehaviorQuotes: ["reported behavior"],
          },
        ],
        validation: "Run the reported reproduction and verify it passes.",
        openQuestions: [],
      },
      repositoryNotes: "",
      evidenceLedger: {
        discoverySummary: "",
        completedChecks: [
          {
            command,
            observation: "The search returned a focused source location.",
            establishes: "The command ran successfully.",
          },
        ],
        ruledOut: [],
        nextExperiment: "Inspect the matching source range.",
      },
    }).success,
    true,
  );
  const [{ schema: responseSchema }] = toolStrategy(
    planningSubmissionSchema,
  ) as unknown as Array<{
    schema: {
      properties: {
        evidenceLedger: {
          properties: {
            completedChecks: {
              items: { properties: { command: { maxLength: number } } };
            };
          };
        };
      };
    };
  }>;
  assert.equal(
    responseSchema.properties.evidenceLedger.properties.completedChecks.items
      .properties.command.maxLength,
    2_000,
  );
});

test("planning structured output gets one compact repair before failing", () => {
  const state = { attempts: 0 };
  const logged: number[] = [];
  const first = handlePlanningStructuredOutputError(
    state,
    new Error('Instance does not have required property "replies".'),
    (attempt) => logged.push(attempt),
  );

  assert.match(first, /Correct only the output shape/);
  assert.deepEqual(logged, [1]);
  assert.throws(
    () =>
      handlePlanningStructuredOutputError(
        state,
        new Error('Instance does not have required property "replies".'),
        (attempt) => logged.push(attempt),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "PlanningStructuredOutputError" &&
      error.message.includes("after one correction"),
  );
  assert.deepEqual(logged, [1, 2]);
});

test("planning approval is tied to the reviewed revision and closed blocking threads", () => {
  const concerns = [
    {
      id: "thread-1",
      openedOnRevisionId: "plan-1",
      concern: "The proposed change omits the reported path.",
      blocking: true,
      acceptanceCriteria: "The path is covered by the plan.",
      status: "open" as const,
    },
  ];
  assert.deepEqual(missingBlockingPlanningReplies(concerns, []), ["thread-1"]);
  assert.deepEqual(
    missingBlockingPlanningReplies(concerns, [{ concernId: "thread-1" }]),
    [],
  );
  assert.equal(
    planningApprovalIsValid({
      decision: "approve",
      reviewedRevisionId: "plan-1",
      currentRevisionId: "plan-2",
      concerns: [],
    }),
    false,
  );
  assert.equal(
    planningApprovalIsValid({
      decision: "approve",
      reviewedRevisionId: "plan-1",
      currentRevisionId: "plan-1",
      concerns,
    }),
    false,
  );
  assert.equal(
    planningApprovalIsValid({
      decision: "approve",
      reviewedRevisionId: "plan-1",
      currentRevisionId: "plan-1",
      concerns: concerns.map((item) => ({ ...item, status: "resolved" })),
    }),
    true,
  );
});

test("planning reviewer output must match the revision and resolve each open thread", () => {
  const concerns = [
    {
      id: "thread-1",
      openedOnRevisionId: "plan-1",
      concern: "The plan misses a case.",
      blocking: true,
      acceptanceCriteria: "Cover the case.",
      status: "open" as const,
    },
  ];
  const review = {
    reviewedRevisionId: "plan-0",
    decision: "request-changes" as const,
    summary: "Needs another look.",
    reportedBehaviors: [
      {
        quote: "reported behavior",
        expectedOutcome: "works",
        planStepId: "step-1",
        validation: "focused test",
      },
    ],
    concernUpdates: [],
    newConcerns: [
      {
        concern: "A nonblocking detail.",
        blocking: false,
        acceptanceCriteria: "Clarify the detail.",
      },
    ],
  };
  const issues = planningReviewIssues({
    review,
    revisionId: "plan-1",
    concerns,
  });
  assert.equal(
    issues.some((issue) => issue.includes("submitted revision")),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.includes("thread-1")),
    true,
  );
});

test("request-changes without a blocking concern is rejected", () => {
  const review = {
    reviewedRevisionId: "plan-1",
    decision: "request-changes" as const,
    summary: "Needs another look.",
    reportedBehaviors: [
      {
        quote: "reported behavior",
        expectedOutcome: "works",
        planStepId: "step-1",
        validation: "focused test",
      },
    ],
    concernUpdates: [],
    newConcerns: [
      {
        concern: "A nonblocking detail.",
        blocking: false,
        acceptanceCriteria: "Clarify the detail.",
      },
    ],
  };
  assert.equal(
    planningReviewIssues({ review, revisionId: "plan-1", concerns: [] }).some(
      (issue) => issue.includes("at least one concrete blocking concern"),
    ),
    true,
  );
});

test("planning reviewer can request changes only while a blocking concern remains", () => {
  const review = {
    reviewedRevisionId: "plan-1",
    decision: "request-changes" as const,
    summary: "There is still a blocking issue.",
    reportedBehaviors: [
      {
        quote: "reported behavior",
        expectedOutcome: "works",
        planStepId: "step-1",
        validation: "focused test",
      },
    ],
    concernUpdates: [],
    newConcerns: [
      {
        concern: "The plan omits the reported route.",
        blocking: true,
        acceptanceCriteria: "Include the route in the plan.",
      },
    ],
  };
  assert.deepEqual(
    planningReviewIssues({ review, revisionId: "plan-1", concerns: [] }),
    [],
  );
});

test("planning approval requires each quoted behavior to map to a plan step and validation", () => {
  const base = {
    reviewedRevisionId: "plan-1",
    decision: "approve" as const,
    summary: "Covered.",
    concernUpdates: [],
    newConcerns: [],
  };
  const plan = {
    problem: "Reported issue",
    proposedExplanation: "",
    evidence: [],
    proposedChanges: [
      { id: "step-1", title: "Fix", description: "Support the behavior." },
    ],
    validationChecks: [
      {
        id: "check-1",
        command: "yarn test uppercase-language",
        expectedOutcome: "Uppercase PHP configuration is normalized.",
        reportedBehaviorQuotes: ["uppercase PHP fails"],
      },
    ],
    validation: "Run tests",
    openQuestions: [],
  };
  const uncovered = planningReviewIssues({
    review: {
      ...base,
      reportedBehaviors: [
        {
          quote: "uppercase PHP never works",
          expectedOutcome: "uppercase PHP works",
        },
      ],
    },
    revisionId: "plan-1",
    concerns: [],
    issueText: "The report says uppercase PHP fails.",
    plan,
  });
  assert.ok(
    uncovered.some((issue) => issue.includes("copied from the report")),
  );
  assert.ok(uncovered.some((issue) => issue.includes("plan step")));
  assert.ok(uncovered.some((issue) => issue.includes("validation")));
  assert.ok(
    uncovered.some((issue) => issue.includes("executable validation check")),
  );

  assert.deepEqual(
    planningReviewIssues({
      review: {
        ...base,
        reportedBehaviors: [
          {
            quote: "uppercase PHP fails",
            expectedOutcome: "uppercase PHP works",
            planStepId: "step-1",
            validation: "test uppercase language identifiers",
          },
        ],
      },
      revisionId: "plan-1",
      concerns: [],
      issueText: "The report says uppercase PHP fails.",
      plan,
    }),
    [],
  );
});

test("implementation approval requires evidence for every reported behavior", () => {
  const reportedBehaviors = [
    {
      quote: "uppercase PHP fails",
      expectedOutcome: "uppercase PHP works",
      planStepId: "step-1",
      validation: "case-sensitive language test",
    },
  ];
  const review = {
    reviewedRevisionId: "patch-1",
    decision: "approve" as const,
    summary: "Patch covers the report.",
    behaviorChecks: [
      {
        quote: "uppercase PHP fails",
        status: "missing" as const,
        evidence: "Only the rendered class name is normalized.",
      },
    ],
    concernUpdates: [],
    newConcerns: [],
  };
  const issues = implementationReviewIssues({
    review,
    revisionId: "patch-1",
    concerns: [],
    reportedBehaviors,
  });
  assert.ok(issues.some((issue) => issue.includes("not verified")));
});

test("legacy paired patch approval carries unresolved review findings into its gate", () => {
  const quote = "uppercase PHP fails";
  const command = "yarn test php-language";
  const diff = "candidate patch";
  const fingerprint = validationPatchFingerprint(diff);
  const validationChecks = [
    {
      id: "check-1",
      command,
      expectedOutcome: "Uppercase and lowercase PHP both highlight.",
      reportedBehaviorQuotes: [quote],
    },
  ];
  const carryoverFindings = [
    {
      findingId: "pre-edit-1",
      text: "Check configured PHP component loading.",
    },
  ];
  const review = {
    status: "pass" as const,
    summary: "The issue is fixed.",
    findings: [],
    behaviorChecks: [
      {
        quote,
        status: "verified" as const,
        evidence: "The focused test passes.",
      },
    ],
    carryoverFindings: [
      {
        findingId: "pre-edit-1",
        status: "verified" as const,
        evidence:
          "The check covers both configured component loading and rendering.",
      },
    ],
    evidence: [
      {
        findingId: "pre-edit-1",
        claim: "The focused PHP test covers the carried concern.",
        command,
      },
    ],
  };
  const base = {
    review,
    reportedExamples: [{ literal: quote }],
    carryoverFindings,
    evidenceSupported: [true],
    requiredChecks: validationChecks,
    controllerValidationResults: controllerValidationRecords({
      checks: [
        {
          checkId: "check-1",
          command,
          status: "passed",
          output: "1 test passed",
        },
      ],
      diff,
      attempt: 1,
    }),
    currentPatchFingerprint: fingerprint,
  };
  assert.deepEqual(pairedPatchApprovalIssues(base), []);
  assert.ok(
    pairedPatchApprovalIssues({
      ...base,
      evidenceSupported: [false],
      controllerValidationResults: [],
    }).some((issue) => issue.includes("independently supported")),
  );
});

test("planned checks for absent tests are optional rather than failed", async () => {
  const command =
    "yarn jest packages/widget/src/__tests__/Widget.test.tsx --runInBand";
  assert.deepEqual(referencedTestFiles(command), [
    "packages/widget/src/__tests__/Widget.test.tsx",
  ]);
  assert.deepEqual(
    await optionalPlannedTestFiles({
      command,
      diff: "",
      fileExists: () => false,
    }),
    ["packages/widget/src/__tests__/Widget.test.tsx"],
  );
  assert.deepEqual(
    await optionalPlannedTestFiles({
      command,
      diff: "diff --git a/packages/widget/src/__tests__/Widget.test.tsx b/packages/widget/src/__tests__/Widget.test.tsx\nnew file mode 100644",
      fileExists: () => true,
    }),
    ["packages/widget/src/__tests__/Widget.test.tsx"],
  );
  const fingerprint = validationPatchFingerprint("current patch");
  assert.deepEqual(
    requiredValidationIssues({
      requiredChecks: [
        {
          id: "check-1",
          command,
          expectedOutcome: "The report is fixed.",
          reportedBehaviorQuotes: ["the reported behavior"],
        },
      ],
      results: controllerValidationRecords({
        checks: [
          {
            checkId: "check-1",
            command,
            status: "skipped",
            output: "Optional test file is absent.",
          },
        ],
        diff: "current patch",
        attempt: 1,
      }),
      currentPatchFingerprint: fingerprint,
    }),
    [],
  );
});

test("validation repair gets a distinct checkpoint and compact failure evidence", () => {
  const baseThreadId = "issue-9183-attempt-1";
  assert.notEqual(
    implementationInvocationThreadId({
      baseThreadId,
      invocation: 1,
      attempt: 0,
      recovery: false,
    }),
    baseThreadId,
  );
  assert.notEqual(
    implementationInvocationThreadId({
      baseThreadId,
      invocation: 1,
      attempt: 0,
      recovery: false,
    }),
    implementationInvocationThreadId({
      baseThreadId,
      invocation: 1,
      attempt: 1,
      recovery: false,
    }),
  );
  const compact = compactValidationRepairContext(
    "start" + "x".repeat(9_000) + "end",
  );
  assert.ok(compact.length <= 8_000);
  assert.match(compact, /^start/);
  assert.match(compact, /end$/);
});

test("unapproved investigation findings receive stable IDs for final review", () => {
  assert.deepEqual(
    pairedCarryoverFindingsFromText(
      "First unresolved check.\n- Second finding.",
    ),
    [
      { findingId: "pre-edit-1", text: "First unresolved check." },
      { findingId: "pre-edit-2", text: "Second finding." },
    ],
  );
});

test("implementation review receives approved plan without stale plan thread IDs", () => {
  const approvedPlan = {
    approved: true as const,
    revisionId: "plan-2",
    plan: {
      problem: "Uppercase PHP configuration fails.",
      proposedExplanation: "Component names are case-sensitive.",
      evidence: [],
      proposedChanges: [
        {
          id: "step-1",
          title: "Normalize language names",
          description: "Resolve identifiers case-insensitively.",
        },
      ],
      validationChecks: [
        {
          id: "check-1",
          command: "yarn test uppercase-language",
          expectedOutcome: "Both PHP casing forms pass.",
          reportedBehaviorQuotes: ["uppercase PHP fails"],
        },
      ],
      validation: "Test uppercase and lowercase PHP configuration.",
      openQuestions: [],
    },
    reportedBehaviors: [
      {
        quote: "uppercase PHP fails",
        expectedOutcome: "uppercase PHP works",
        planStepId: "step-1",
        validation: "case-sensitive language test",
      },
    ],
    repositoryNotes: "The component registry uses lowercase names.",
    evidenceLedger: undefined,
    threads: [
      {
        id: "thread-1",
        status: "resolved",
        concern: "Preserve lowercase PHP behavior.",
      },
    ],
    approvalSummary: "Plan approved.",
  };
  const input = implementationReviewInput({
    task: { issue: "Uppercase PHP does not load." },
    approvedPlan,
    revisionId: "patch-1",
    diff: "diff --git a/file.ts b/file.ts",
    agentReportedTests: "Focused test passed.",
    controllerValidationResults: [],
    threads: [],
  });

  assert.equal("planReviewThreads" in input, false);
  assert.deepEqual(input.threads, []);
  assert.equal(input.agentReportedTests, "Focused test passed.");
  assert.deepEqual(input.controllerValidationResults, []);
  assert.deepEqual(input.reportedBehaviors, approvedPlan.reportedBehaviors);
  const review = {
    reviewedRevisionId: "patch-1",
    decision: "approve" as const,
    summary: "The behavior is implemented.",
    behaviorChecks: [
      {
        quote: "uppercase PHP fails",
        status: "verified" as const,
        evidence: "Focused test passed.",
      },
    ],
    concernUpdates: [
      {
        concernId: "thread-1",
        status: "resolved" as const,
        resolutionReason: "The test passes.",
      },
    ],
    newConcerns: [],
  };
  assert.ok(
    implementationReviewIssues({
      review,
      revisionId: "patch-1",
      concerns: input.threads,
      reportedBehaviors: input.reportedBehaviors,
    }).some((issue) => issue.includes("unknown or closed concern thread-1")),
  );
});

test("required implementation checks must pass for the current patch", () => {
  const requiredChecks = [
    {
      id: "check-1",
      command: "yarn test configuration",
      expectedOutcome: "Uppercase configuration normalizes to canonical names.",
      reportedBehaviorQuotes: ["uppercase PHP fails"],
    },
  ];
  const fingerprint = "current-patch";
  const missing = requiredValidationIssues({
    requiredChecks,
    results: [],
    currentPatchFingerprint: fingerprint,
  });
  assert.match(missing[0] ?? "", /was not run by the controller/);
  const review = {
    reviewedRevisionId: "patch-1",
    decision: "approve" as const,
    summary: "The behavior is covered.",
    behaviorChecks: [
      {
        quote: "uppercase PHP fails",
        status: "verified" as const,
        evidence: "The patch changes the configured language handling.",
      },
    ],
    concernUpdates: [],
    newConcerns: [],
  };
  assert.ok(
    implementationReviewIssues({
      review,
      revisionId: "patch-1",
      concerns: [],
      reportedBehaviors: [
        {
          quote: "uppercase PHP fails",
          expectedOutcome: "uppercase PHP works",
          planStepId: "step-1",
          validation: "configuration test",
        },
      ],
      requiredChecks,
      controllerValidationResults: [],
      currentPatchFingerprint: fingerprint,
    }).some((issue) => issue.includes("was not run by the controller")),
  );

  const stalePass = controllerValidationRecords({
    checks: [
      {
        checkId: "check-1",
        command: "yarn test configuration",
        status: "passed",
        output: "1 test passed",
      },
    ],
    diff: "old patch",
    attempt: 1,
  });
  assert.match(
    requiredValidationIssues({
      requiredChecks,
      results: stalePass,
      currentPatchFingerprint: fingerprint,
    })[0] ?? "",
    /is stale for the current patch/,
  );

  const failedCurrentPatch = controllerValidationRecords({
    checks: [
      {
        checkId: "check-1",
        command: "yarn test configuration",
        status: "failed",
        output: "expected canonical value",
      },
    ],
    diff: "current diff",
    attempt: 2,
  });
  assert.match(
    requiredValidationIssues({
      requiredChecks,
      results: failedCurrentPatch,
      currentPatchFingerprint: validationPatchFingerprint("current diff"),
    })[0] ?? "",
    /did not pass/,
  );

  const passingCurrentPatch = controllerValidationRecords({
    checks: [
      {
        checkId: "check-1",
        command: "yarn test configuration",
        status: "passed",
        output: "1 test passed",
      },
    ],
    diff: "current diff",
    attempt: 3,
  });
  assert.deepEqual(
    requiredValidationIssues({
      requiredChecks,
      results: passingCurrentPatch,
      currentPatchFingerprint: validationPatchFingerprint("current diff"),
    }),
    [],
  );
});

test("planning revision diff includes only changed plan fields", () => {
  const before = {
    problem: "A reported link is rewritten.",
    proposedExplanation: "The link pass is too broad.",
    evidence: [],
    proposedChanges: [],
    validationChecks: [
      {
        id: "check-1",
        command: "yarn test markdown-link",
        expectedOutcome: "The reported link is preserved.",
        reportedBehaviorQuotes: ["reported link is rewritten"],
      },
    ],
    validation: "Run the focused test.",
    openQuestions: [],
  };
  const after = {
    ...before,
    validation: "Run the focused test and full build.",
  };
  assert.deepEqual(planningRevisionDiff(undefined, before), "initial plan");
  assert.deepEqual(planningRevisionDiff(before, after), [
    {
      field: "validation",
      before: "Run the focused test.",
      after: "Run the focused test and full build.",
    },
  ]);
});

test("all blocked results get one controller continuation, while done results do not", () => {
  const result = {
    status: "blocked" as const,
    summary: "The reported behavior could not be reproduced in this component.",
    tests: "The current tests do not reproduce the failure.",
    questions: [],
  };
  assert.equal(needsBlockedContinuation(result), true);
  assert.equal(
    needsBlockedContinuation({
      ...result,
      summary:
        "The reported failure could not be connected to a faulty path in this checkout.",
      tests: "No tests run because no actionable defect was identified.",
    }),
    true,
  );
  assert.equal(needsBlockedContinuation({ ...result, status: "done" }), false);
  assert.equal(
    needsBlockedContinuation({
      ...result,
      summary: "The sandbox could not start.",
      tests: "Docker daemon unavailable.",
    }),
    true,
  );
});

test("done results need baseline red-green evidence before the controller accepts them", () => {
  const result = {
    status: "done" as const,
    summary: "Fixed the reported failure.",
    tests: "The targeted tests passed.",
    questions: [],
  };
  assert.equal(needsCompletionContinuation(result), true);
  assert.equal(
    needsCompletionContinuation({
      ...result,
      tests:
        "Regression test failed against the original baseline and passed after the change.",
    }),
    false,
  );
  assert.equal(
    needsCompletionContinuation({ ...result, status: "clarify" }),
    false,
  );
  assert.equal(
    needsCompletionContinuation({ ...result, status: "inconclusive" }),
    true,
  );
});

test("paired implementation requires product source changes, not tests or docs alone", () => {
  assert.equal(
    hasNonTestSourceChange(
      "diff --git a/src/feature.ts b/src/feature.ts\n+++ b/src/feature.ts\n+fix",
    ),
    true,
  );
  assert.equal(
    hasNonTestSourceChange(
      "diff --git a/src/feature.test.ts b/src/feature.test.ts\n+++ b/src/feature.test.ts\n+test",
    ),
    false,
  );
  assert.equal(
    hasNonTestSourceChange(
      "diff --git a/README.md b/README.md\n+++ b/README.md\n+docs",
    ),
    false,
  );
});

test("paired continuation acknowledges an existing source patch", () => {
  const prompt = pairedImplementationContinuation(
    "blocked",
    true,
    '{"summary":"patch exists but task is unfinished"}',
  );
  assert.match(prompt, /A non-test source change already exists/);
  assert.match(prompt, /complete the task/);
  assert.doesNotMatch(prompt, /without changing product source/);

  const missingPatchPrompt = pairedImplementationContinuation(
    "blocked",
    false,
    "no patch",
  );
  assert.match(
    missingPatchPrompt,
    /source-code change is a blocking requirement/,
  );
});

test("paired investigation cannot approve without reviewer-run cited evidence", () => {
  const missingEvidence = pairedReviewApprovalEvidenceRequirement(
    "approve",
    [],
    [],
  );
  assert.equal(missingEvidence.length, 1);
  assert.match(missingEvidence[0], /decisive check run by the reviewer/);

  assert.deepEqual(
    pairedReviewApprovalEvidenceRequirement(
      "approve",
      [{ claim: "Build resolves the reported image", command: "yarn build" }],
      [{ command: "yarn build", output: "Build passed" }],
    ),
    [],
  );
  assert.deepEqual(
    pairedReviewApprovalEvidenceRequirement("request-changes", [], []),
    [],
  );

  const followUp = pairedReviewEvidenceFollowUp(
    "Build resolution is unverified.",
  );
  assert.match(followUp, /approval was not accepted/);
  assert.match(followUp, /smallest decisive check/);
  assert.match(followUp, /focused existing test/);
  assert.match(followUp, /exact command and observed result/);
});

test("verified requested checks are cleared while unverified experiments return to review", () => {
  const checks = [
    { action: "Run the focused test", observationToRecord: "Test output" },
    {
      action: "Inspect integration result",
      observationToRecord: "Build output",
    },
  ];
  const unresolved = requestedChecksNeedingReview(checks, [
    { supported: true, verdict: "supported" },
    {
      supported: false,
      verdict: "unverifiable",
      concern: "No integration output was recorded.",
    },
  ]);
  assert.deepEqual(unresolved, [
    {
      check: checks[1],
      verdict: "unverifiable",
      concern: "No integration output was recorded.",
    },
  ]);
  assert.equal(requestedChecksNeedingReview(checks, []).length, checks.length);
});

test("paired review sends the task once, then only the latest implementer output", () => {
  const firstRound = pairedReviewMessages(
    "Original task: stable report",
    "Plan from round one",
  );
  const nextRound = pairedReviewMessages(
    undefined,
    "Revised plan from round two",
  );

  assert.equal(firstRound.length, 2);
  assert.equal(firstRound[0].content, "Original task: stable report");
  assert.deepEqual(nextRound, [
    { role: "user", content: "Revised plan from round two" },
  ]);
});

test("planning review requested checks contain no command field", () => {
  const review = {
    status: "request-changes",
    reportedOutcome: "unresolved",
    summary: "The reported path is not isolated yet.",
    findings: [],
    requestedChecks: [
      {
        action: "Run a focused test covering the markdown image rewrite.",
        observationToRecord:
          "The test output showing whether the reported path is rewritten.",
      },
    ],
    evidence: [],
  };
  assert.equal(investigationReviewSchema.safeParse(review).success, true);
  assert.equal(
    investigationReviewSchema.safeParse({
      ...review,
      requestedChecks: [
        {
          action: "Run a focused test covering the markdown image rewrite.",
          command: "yarn test --runInBand",
          observationToRecord:
            "The test output showing whether the reported path is rewritten.",
        },
      ],
    }).success,
    false,
  );
});

test("optional review arrays stay optional in model schemas and normalize to empty", () => {
  const investigation = {
    status: "approve" as const,
    reportedOutcome: "established" as const,
    summary: "The plan is supported.",
    findings: [],
  };
  const parsedInvestigation = investigationReviewSchema.parse(investigation);
  const normalizedInvestigation =
    normalizeInvestigationReview(parsedInvestigation);
  const [{ schema: investigationResponseSchema }] = toolStrategy(
    investigationReviewSchema,
  ) as unknown as Array<{ schema: { required?: string[] } }>;
  assert.deepEqual(normalizedInvestigation.requestedChecks, []);
  assert.deepEqual(normalizedInvestigation.evidence, []);
  assert.equal(
    investigationResponseSchema.required?.includes("requestedChecks"),
    false,
  );
  assert.equal(
    investigationResponseSchema.required?.includes("evidence"),
    false,
  );

  const patchReview = {
    status: "pass" as const,
    summary: "The patch addresses the issue.",
    findings: [],
    behaviorChecks: [
      {
        quote: "uppercase PHP fails",
        status: "verified" as const,
        evidence: "The focused test passes.",
      },
    ],
    carryoverFindings: [],
    evidence: [],
  };
  const parsedPatchReview = pairedPatchReviewSchema.parse(patchReview);
  const [{ schema: patchResponseSchema }] = toolStrategy(
    pairedPatchReviewSchema,
  ) as unknown as Array<{ schema: { required?: string[] } }>;
  assert.deepEqual(parsedPatchReview.evidence, []);
  assert.equal(patchResponseSchema.required?.includes("evidence"), true);
});

test("an unresolved reported outcome blocks reviewer approval", () => {
  assert.deepEqual(pairedReviewOutcomeRequirement("approve", "unresolved"), [
    "Approval is blocked because the reported behavior remains unresolved. Continue with the next decisive check.",
  ]);
  assert.deepEqual(
    pairedReviewOutcomeRequirement("approve", "established"),
    [],
  );
  assert.deepEqual(
    pairedReviewOutcomeRequirement("request-changes", "unresolved"),
    [],
  );
});

test("investigation continuation carries compact handoff and bounded recent evidence", () => {
  const previous = {
    summary: "The URL rewrite is a likely cause.",
    reportedExamples: [
      {
        source: "docs page",
        literal: "image URL",
        expected: "image resolves",
        reportedActual: "image missing",
        outcome: "reproduced" as const,
        observation: "The path is rewritten during Markdown processing.",
      },
    ],
    hypotheses: [
      {
        explanation: "Markdown linkification rewrites a URL prefix.",
        evidenceFor: ["The resolver accepts the prefix."],
        evidenceAgainst: [],
        distinguishingCheck: "Run the focused transformation test.",
      },
      {
        explanation: "Static path resolution changes the suffix.",
        evidenceFor: [],
        evidenceAgainst: [
          "The resolver output already contains the changed path.",
        ],
        distinguishingCheck: "Inspect the transformed URL.",
      },
    ],
    implementationPlan: {
      reportedBehavior: "The adjacent image fails to resolve.",
      codePath: "Markdown linkification to image transform.",
      pathEvidence: "The output URL contains the rewritten prefix.",
      proposedChange: "Constrain the Markdown link match.",
      validation: "Run focused linkification tests.",
      validationChecks: [
        {
          id: "check-1",
          command: "yarn test linkification",
          expectedOutcome: "The reported image URL remains unchanged.",
          reportedBehaviorQuotes: ["image URL"],
        },
      ],
      edgeCases: ["Existing Markdown links"],
    },
  };
  const continuation = pairedInvestigationContinuation(
    "Original issue text",
    previous,
    "Run the focused test and report its output.",
    [{ command: "cat useful.log", output: "x".repeat(5_000) }],
  );
  assert.match(continuation, /Original issue text/);
  assert.match(continuation, /Latest structured investigation/);
  assert.match(continuation, /Run the focused test/);
  assert.match(continuation, /characters omitted/);
  assert.ok(continuation.length < 10_000);
});

test("implementation step limit allows a model and tool cycle plus final response", () => {
  assert.equal(implementationRecursionLimit(60), 121);
});

test("investigation limit leaves room to return a handoff at its command cap", () => {
  assert.equal(investigationCommandCap(60), 50);
  assert.equal(investigationCommandCap(24), 24);
  assert.equal(
    investigationRecursionLimit(investigationCommandCap(60), 0),
    103,
  );
  assert.equal(investigationRecursionLimit(60, 0), 123);
  assert.equal(investigationRecursionLimit(60, 59), 5);
  assert.equal(investigationRecursionLimit(60, 60), 3);
});

test("result schema supports inconclusive and respects disabled clarification", () => {
  const schema = resultSchemaFor(false);
  const valid = {
    status: "done",
    summary: "Fixed the reported failure.",
    tests: "The targeted test passed.",
    questions: [],
  };
  assert.equal(schema.safeParse(valid).success, true);
  assert.equal(
    schema.safeParse({ ...valid, questions: ["Can you clarify?"] }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...valid, status: "clarify" }).success,
    false,
  );
  const [{ schema: responseSchema }] = toolStrategy(
    schema,
  ) as unknown as Array<{
    schema: { properties: { status: { enum: string[] } } };
  }>;
  assert.deepEqual(responseSchema.properties.status.enum, [
    "done",
    "blocked",
    "inconclusive",
  ]);
  assert.equal(
    schema.safeParse({ ...valid, status: "inconclusive" }).success,
    true,
  );
});

test("transient completion failures get bounded retries", async () => {
  let calls = 0;
  const result = await invokeWithCompletionRecovery(async (attempt) => {
    calls++;
    assert.equal(attempt, calls - 1);
    if (calls < 3)
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    return "ok";
  }, 2);
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("malformed provider SSE events get a bounded completion retry", async () => {
  let calls = 0;
  const result = await invokeWithCompletionRecovery(async () => {
    calls++;
    if (calls === 1)
      throw new SyntaxError(
        "Error reading response: malformed server-sent event JSON.",
      );
    return "ok";
  }, 2);
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("a timed-out model call releases its cost reservation before retry", async () => {
  const job = { cost: 0 };
  let calls = 0;
  const result = await invokeWithCompletionRecovery(
    (attempt) =>
      invokeWithCostBudget(
        job,
        1,
        0.6,
        () => {},
        () => {},
        async () => {
          calls++;
          if (attempt === 0)
            throw Object.assign(new Error("Request timed out"), {
              name: "TimeoutError",
            });
          return "ok";
        },
      ),
    1,
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.equal(job.cost, 0.6);
});

test("completion recovery does not retry authentication or other permanent errors", async () => {
  let calls = 0;
  await assert.rejects(
    invokeWithCompletionRecovery(async () => {
      calls++;
      throw Object.assign(new Error("invalid API key"), { status: 401 });
    }, 2),
    /invalid API key/,
  );
  assert.equal(calls, 1);
});

test("malformed or truncated model tool calls get an actionable output-limit error", () => {
  assert.throws(
    () =>
      parseAgentResponse(
        undefined,
        [
          {
            invalid_tool_calls: [{ name: "shell", error: "invalid JSON" }],
          },
        ],
        resultSchema,
        4096,
      ),
    /malformed or truncated tool call.*4096-token output limit/,
  );
  assert.throws(
    () =>
      parseAgentResponse(
        undefined,
        [{ response_metadata: { finish_reason: "length" } }],
        resultSchema,
        4096,
      ),
    /exhausted the 4096-token output limit.*Automatic recovery was skipped/,
  );
});

test("an output-token-truncated tool call skips the same expensive recovery", async () => {
  let calls = 0;
  await assert.rejects(
    invokeWithMalformedToolCallRecovery(
      async () => {
        calls++;
        return {
          structuredResponse: undefined,
          messages: [
            {
              invalid_tool_calls: [{ name: "shell", args: "x".repeat(20_000) }],
              response_metadata: {
                incomplete_details: { reason: "max_output_tokens" },
              },
            },
          ],
        };
      },
      (out) =>
        parseAgentResponse(
          out.structuredResponse,
          out.messages,
          resultSchema,
          12_000,
        ),
    ),
    /Automatic recovery was skipped/,
  );
  assert.equal(calls, 1);
});

test("a structured model result is validated normally", () => {
  assert.deepEqual(
    parseAgentResponse({ status: "done" }, [], resultSchema, 4096),
    { status: "done" },
  );
});

test("a final assistant JSON message recovers when structured output is absent", () => {
  assert.deepEqual(
    parseAgentResponse(
      undefined,
      [
        { type: "human", content: '{"status":"wrong"}' },
        {
          type: "ai",
          content: [{ type: "text", text: '{"status":"done"}' }],
          tool_calls: [],
        },
      ],
      resultSchema,
      4096,
    ),
    { status: "done" },
  );
});

test("tool output is never accepted as a structured agent result", () => {
  assert.throws(() =>
    parseAgentResponse(
      undefined,
      [{ type: "tool", content: '{"status":"done"}' }],
      resultSchema,
      4096,
    ),
  );
});

test("malformed tool calls receive exactly one recovery attempt", async () => {
  let calls = 0;
  const result = await invokeWithMalformedToolCallRecovery(
    async (recovery) => {
      calls++;
      assert.equal(recovery, calls === 2);
      return recovery
        ? { structuredResponse: { status: "done" }, messages: [] }
        : {
            structuredResponse: undefined,
            messages: [{ invalid_tool_calls: [{ error: "invalid JSON" }] }],
          };
    },
    (out) =>
      parseAgentResponse(
        out.structuredResponse,
        out.messages,
        resultSchema,
        4096,
      ),
  );
  assert.deepEqual(result, { status: "done" });
  assert.equal(calls, 2);
});

test("malformed-call recovery context is bounded while retaining both ends", () => {
  const context = `start${"x".repeat(20_000)}end`;
  const compacted = compactMalformedRecoveryContext(context);
  assert.ok(compacted.length <= 8_000);
  assert.match(compacted, /^start/);
  assert.match(
    compacted,
    /characters omitted from malformed-call recovery context/,
  );
  assert.match(compacted, /end$/);
  assert.equal(
    compactMalformedRecoveryContext("short context"),
    "short context",
  );
});

test("repeated malformed tool calls stop after the bounded recovery attempt", async () => {
  let calls = 0;
  await assert.rejects(
    invokeWithMalformedToolCallRecovery(
      async () => {
        calls++;
        return {
          structuredResponse: undefined,
          messages: [{ invalid_tool_calls: [{ error: "invalid JSON" }] }],
        };
      },
      (out) =>
        parseAgentResponse(
          out.structuredResponse,
          out.messages,
          resultSchema,
          4096,
        ),
    ),
    /after Louibot's one recovery attempt/,
  );
  assert.equal(calls, 2);
});

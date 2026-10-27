import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

type Case = {
  id: string;
  taskId?: string;
  instanceId?: string;
  baseCommit: string;
  prompt: string;
  repositoryPath: string;
  repository?: string;
  mode?: "stateless" | "code-map" | "chronological-memory";
  date?: string;
  memoryApproval?: {
    approved: true;
    repository: string;
    sourceCaseIds: string[];
    throughDate: string;
  };
  memory?: Array<{
    date: string;
    sourceCaseId: string;
    repository: string;
    text: string;
  }>;
  expectedFirstAction?: "implement" | "clarify" | "breakdown" | "decline";
  scriptedReplies?: string[];
  evaluator: {
    commands: string[];
    prepareCommand?: string;
    waitCommand?: string;
    cleanupCommand?: string;
  };
};
const harnessRoot = process.cwd();
const runCommand = async (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 300_000,
) =>
  new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn("sh", ["-lc", command], {
        cwd,
        env: { ...process.env, ...env },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      const outputCap = 200_000;
      child.stdout.setEncoding("utf8").on("data", (s: string) => {
        stdout = `${stdout}${s}`.slice(-outputCap);
      });
      child.stderr.setEncoding("utf8").on("data", (s: string) => {
        stderr = `${stderr}${s}`.slice(-outputCap);
      });
      const timer = setTimeout(() => {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      }, timeoutMs);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    },
  );
const git = async (cwd: string, args: string[]) => {
  const result = await runCommand(
    `git ${args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}`,
    cwd,
  );
  if (result.code) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
};
async function isolatedCheckout(
  source: string,
  destination: string,
  commit: string,
) {
  await mkdir(destination, { recursive: true });
  const commands = [
    "git init --quiet",
    `git fetch --quiet --depth=1 --no-tags '${source.replaceAll("'", "'\\''")}' '${commit}'`,
    "git checkout --quiet --detach FETCH_HEAD",
  ];
  for (const command of commands) {
    const result = await runCommand(command, destination);
    if (result.code)
      throw new Error(
        result.stderr || "Could not create shallow isolated benchmark checkout",
      );
  }
}
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "_");

async function loadCase(file: string): Promise<Case> {
  const value = JSON.parse(await readFile(resolve(file), "utf8")) as Case;
  if (
    !value.id ||
    !value.baseCommit ||
    !value.prompt ||
    !value.repositoryPath ||
    !Array.isArray(value.evaluator?.commands) ||
    !value.evaluator.commands.length
  )
    throw new Error(
      "Case requires id, repositoryPath, baseCommit, prompt and evaluator.commands",
    );
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value.baseCommit))
    throw new Error("baseCommit must be a full immutable Git commit hash");
  if (
    value.mode &&
    !["stateless", "code-map", "chronological-memory"].includes(value.mode)
  )
    throw new Error("Unknown benchmark mode");
  return value;
}

function memoryFor(value: Case): string {
  if (value.mode !== "chronological-memory") return "";
  const approval = value.memoryApproval;
  if (
    !value.date ||
    !/^\d{4}-\d\d-\d\d$/.test(value.date) ||
    value.date > new Date().toISOString().slice(0, 10) ||
    !approval?.approved ||
    approval.repository !== value.repository ||
    ((value.memory ?? []).length > 0 && !approval.sourceCaseIds.length) ||
    !approval.throughDate ||
    approval.throughDate >= value.date
  )
    throw new Error(
      "Chronological memory requires explicit repository, source case IDs, and throughDate approval",
    );
  return (value.memory ?? [])
    .filter(
      (item) =>
        item.repository === approval.repository &&
        item.sourceCaseId !== value.id &&
        approval.sourceCaseIds.includes(item.sourceCaseId) &&
        item.date < value.date! &&
        item.date <= approval.throughDate,
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.sourceCaseId.localeCompare(b.sourceCaseId),
    )
    .map((item) => `## ${item.date} (${item.sourceCaseId})\n${item.text}`)
    .join("\n\n");
}

export async function runBenchmarkCase(
  file: string,
  agentCommand: string,
  timeoutMs = 300_000,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Benchmark timeout must be a positive finite number");
  const value = await loadCase(file),
    id = `${safe(value.id)}-${randomUUID().slice(0, 8)}`;
  const repo = resolve(value.repositoryPath),
    dir = join(harnessRoot, ".louibot", "benchmarks", "runs", id),
    candidate = join(dir, "candidate"),
    evaluator = join(dir, "evaluator");
  const caseStarted = Date.now();
  const planningOnlyRequested = process.env.BENCHMARK_PLANNING_ONLY === "1";
  const implementationPlanSource =
    process.env.BENCHMARK_IMPLEMENTATION_PLAN_FILE;
  if (planningOnlyRequested && implementationPlanSource)
    throw new Error(
      "Planning-only and approved-plan implementation modes cannot be combined",
    );
  let deadline = caseStarted + timeoutMs;
  await mkdir(dir, { recursive: true });
  const base = await git(repo, ["rev-parse", `${value.baseCommit}^{commit}`]);
  let implementationPlanFile: string | undefined;
  if (implementationPlanSource) {
    const report = JSON.parse(
      await readFile(resolve(implementationPlanSource), "utf8"),
    ) as Record<string, any>;
    const expectedTask = value.taskId ?? value.instanceId;
    if (report.status !== "planning-approved")
      throw new Error(
        "Implementation handoff requires a planning-approved report",
      );
    if (report.baseCommit !== base)
      throw new Error(
        "Approved plan base commit does not match benchmark base",
      );
    if (expectedTask && report.taskId !== expectedTask)
      throw new Error("Approved plan task ID does not match benchmark case");
    if (report.behavior?.planningReviewApproved !== true)
      throw new Error("Approved plan report has no reviewer approval");
    const handoff = {
      approved: true,
      revisionId: report.behavior.planningRevisionId,
      plan: report.behavior.planning,
      reportedBehaviors: report.behavior.planningReportedBehaviors,
      repositoryNotes: report.behavior.planningNotes,
      evidenceLedger: report.behavior.planningEvidenceLedger,
      threads: report.behavior.planningThreads ?? [],
      approvalSummary:
        report.behavior.summary ?? "Approved implementation plan",
    };
    implementationPlanFile = join(dir, "approved-plan-handoff.json");
    await writeFile(implementationPlanFile, JSON.stringify(handoff));
  }
  const caseHash = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  let configHash: string | null = null;
  if (process.env.BENCHMARK_CONFIG_PATH)
    configHash = createHash("sha256")
      .update(await readFile(process.env.BENCHMARK_CONFIG_PATH))
      .digest("hex");
  const memory = memoryFor(value);
  let prompt = [
    value.prompt,
    value.mode === "code-map"
      ? "A base-tree file map is available at BENCHMARK_CODE_MAP."
      : "",
    memory ? `Approved prior memory:\n${memory}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const checkouts: string[] = [];
  let evaluatorSetupStarted: number | null = null;
  let evaluatorSetupLaunchSeconds: number | null = null;
  let evaluatorSetupWaitSeconds: number | null = null;
  let evaluatorSetupSeconds: number | null = null;
  let evaluatorSetupError: string | null = null;
  let evaluationStarted: number | null = null;
  let solveSeconds: number | null = null;
  try {
    await isolatedCheckout(repo, candidate, base);
    checkouts.push(candidate);
    if (!planningOnlyRequested) {
      await isolatedCheckout(repo, evaluator, base);
      checkouts.push(evaluator);
    }
    if (!planningOnlyRequested && value.evaluator.prepareCommand) {
      evaluatorSetupStarted = Date.now();
      const prepared = await runCommand(
        value.evaluator.prepareCommand,
        evaluator,
        { BENCHMARK_CASE_ID: value.instanceId ?? value.id },
        60_000,
      );
      evaluatorSetupLaunchSeconds =
        Math.round((Date.now() - evaluatorSetupStarted) / 10) / 100;
      if (prepared.code)
        evaluatorSetupError =
          prepared.stderr || "Evaluator setup could not be started";
    }
    // The setup container is isolated and runs concurrently with the agent.
    deadline = Date.now() + timeoutMs;
    if (value.mode === "code-map") {
      const files = await git(candidate, ["ls-files"]);
      await writeFile(join(dir, "code-map.txt"), files);
    }
    const started = Date.now();
    let agent = { code: 0, stdout: "", stderr: "" };
    let adapterResult: Record<string, unknown> = {};
    const exchanges: Array<{ question: unknown; reply: string }> = [];
    const questionsAsked: Array<{ round: number; questions: string[] }> = [];
    const requestedTokenBudget = Number(process.env.BENCHMARK_TOKEN_BUDGET);
    let tokenBudgetRemaining =
      Number.isFinite(requestedTokenBudget) && requestedTokenBudget > 0
        ? requestedTokenBudget
        : undefined;
    let totalInputTokens = 0,
      totalOutputTokens = 0,
      totalCostUsd = 0;
    let allRoundUsageKnown = true,
      allRoundCostsKnown = true;
    let allRoundBudgetsEnforced = true,
      allRoundToolsKnown = true,
      totalToolCalls = 0,
      firstAction: unknown = null;
    const maxRounds = (value.scriptedReplies?.length ?? 0) + 1;
    for (let round = 0; round < maxRounds; round++) {
      const promptFile = join(dir, `task-${round + 1}.txt`),
        resultFile = join(dir, `adapter-result-${round + 1}.json`);
      await writeFile(promptFile, prompt);
      agent = await runCommand(
        agentCommand,
        candidate,
        {
          BENCHMARK_CASE_ID: value.id,
          BENCHMARK_PROMPT_FILE: promptFile,
          BENCHMARK_MODE: value.mode ?? "stateless",
          BENCHMARK_CODE_MAP:
            value.mode === "code-map" ? join(dir, "code-map.txt") : "",
          BENCHMARK_TIME_BUDGET_SECONDS: String(
            Math.max(1, Math.floor((deadline - Date.now()) / 1000)),
          ),
          BENCHMARK_TOKEN_BUDGET:
            tokenBudgetRemaining === undefined
              ? ""
              : String(tokenBudgetRemaining),
          BENCHMARK_RESULT_FILE: resultFile,
          BENCHMARK_IMPLEMENTATION_PLAN_FILE: implementationPlanFile ?? "",
          BENCHMARK_BASE_COMMIT: base,
          BENCHMARK_TASK_ID: value.taskId ?? value.instanceId ?? "",
        },
        Math.max(1, deadline - Date.now()),
      );
      try {
        adapterResult = JSON.parse(
          await readFile(resultFile, "utf8"),
        ) as Record<string, unknown>;
      } catch {
        adapterResult = {};
      }
      await rm(resultFile, { force: true }).catch(() => {});
      if (!round) firstAction = adapterResult.action ?? null;
      if (Array.isArray(adapterResult.questions))
        questionsAsked.push({
          round: round + 1,
          questions: adapterResult.questions.filter(
            (item): item is string => typeof item === "string",
          ),
        });
      allRoundBudgetsEnforced =
        allRoundBudgetsEnforced && adapterResult.budgetEnforced === true;
      if (
        Number.isFinite(adapterResult.toolCalls) &&
        Number(adapterResult.toolCalls) >= 0
      )
        totalToolCalls += Number(adapterResult.toolCalls);
      else allRoundToolsKnown = false;
      const roundUsageKnown =
        Number.isFinite(adapterResult.inputTokens) &&
        Number.isFinite(adapterResult.outputTokens) &&
        Number(adapterResult.inputTokens) >= 0 &&
        Number(adapterResult.outputTokens) >= 0;
      if (roundUsageKnown) {
        totalInputTokens += Number(adapterResult.inputTokens);
        totalOutputTokens += Number(adapterResult.outputTokens);
        if (tokenBudgetRemaining !== undefined)
          tokenBudgetRemaining -=
            Number(adapterResult.inputTokens) +
            Number(adapterResult.outputTokens);
      } else allRoundUsageKnown = false;
      if (
        typeof adapterResult.costUsd === "number" &&
        Number.isFinite(adapterResult.costUsd) &&
        adapterResult.costUsd >= 0
      )
        totalCostUsd += adapterResult.costUsd;
      else allRoundCostsKnown = false;
      await writeFile(
        join(dir, `agent-round-${round + 1}.stdout.log`),
        agent.stdout,
      );
      await writeFile(
        join(dir, `agent-round-${round + 1}.stderr.log`),
        agent.stderr,
      );
      if (
        agent.code ||
        adapterResult.action !== "clarify" ||
        round >= (value.scriptedReplies?.length ?? 0) ||
        !allRoundUsageKnown ||
        (tokenBudgetRemaining !== undefined && tokenBudgetRemaining <= 4096)
      )
        break;
      const reply = value.scriptedReplies![round];
      exchanges.push({ question: adapterResult.questions ?? [], reply });
      const questions = Array.isArray(adapterResult.questions)
        ? adapterResult.questions.join("\n")
        : String(adapterResult.questions ?? "");
      prompt += `\n\nLouibot asked:\n${questions}\n\nMaintainer reply ${round + 1}: ${reply}`;
    }
    const agentSeconds = Math.round((Date.now() - started) / 10) / 100;
    const planningComplete = adapterResult.action === "plan";
    const planningFailed = planningOnlyRequested && !planningComplete;
    adapterResult.inputTokens = allRoundUsageKnown ? totalInputTokens : null;
    adapterResult.outputTokens = allRoundUsageKnown ? totalOutputTokens : null;
    adapterResult.costUsd = allRoundCostsKnown ? totalCostUsd : null;
    adapterResult.toolCalls = allRoundToolsKnown ? totalToolCalls : null;
    await writeFile(
      join(dir, "agent.stdout.log"),
      "See per-round stdout logs.",
    );
    await writeFile(
      join(dir, "agent.stderr.log"),
      "See per-round stderr logs.",
    );
    await git(candidate, ["add", "-N", "."]);
    const patchResult = await runCommand(
      `git diff --binary '${base}'`,
      candidate,
    );
    if (patchResult.code)
      throw new Error(
        patchResult.stderr || "Could not capture candidate patch",
      );
    const patch = patchResult.stdout;
    await writeFile(join(dir, "candidate.patch"), patch);
    solveSeconds = Math.round((Date.now() - started) / 10) / 100;
    if (!planningOnlyRequested && value.evaluator.waitCommand) {
      const waitStarted = Date.now();
      const waited = await runCommand(
        value.evaluator.waitCommand,
        evaluator,
        { BENCHMARK_CASE_ID: value.instanceId ?? value.id },
        30 * 60 * 1000,
      );
      evaluatorSetupWaitSeconds =
        Math.round((Date.now() - waitStarted) / 10) / 100;
      try {
        const setupMetrics = JSON.parse(waited.stdout) as {
          setupSeconds?: unknown;
        };
        if (
          typeof setupMetrics.setupSeconds === "number" &&
          Number.isFinite(setupMetrics.setupSeconds) &&
          setupMetrics.setupSeconds >= 0
        )
          evaluatorSetupSeconds = setupMetrics.setupSeconds;
      } catch {}
      if (waited.code)
        evaluatorSetupError ??=
          waited.stderr || "Evaluator setup did not become ready";
    }
    // Apply from a fresh evaluator checkout; only the patch and visible base reach it.
    const patchPath = join(dir, "candidate.patch");
    const apply = planningOnlyRequested
      ? { code: 0, stdout: "", stderr: "" }
      : patch
        ? await runCommand(
            `git apply '${patchPath.replaceAll("'", "'\\''")}'`,
            evaluator,
          )
        : { code: 0, stdout: "", stderr: "" };
    const results = [];
    if (!planningOnlyRequested) evaluationStarted = Date.now();
    if (!planningOnlyRequested && !agent.code && !apply.code)
      for (const command of value.evaluator.commands) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          results.push({
            command,
            exitCode: 124,
            stdout: "",
            stderr:
              "Case wall-clock budget exhausted before evaluator command.",
          });
          break;
        }
        const result = await runCommand(
          command,
          evaluator,
          {
            BENCHMARK_CASE_ID: value.instanceId ?? value.id,
            BENCHMARK_PATCH_FILE: patchPath,
          },
          remainingMs,
        );
        results.push({
          command,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
    const usageValid =
      Number.isFinite(adapterResult.inputTokens) &&
      Number.isFinite(adapterResult.outputTokens) &&
      Number(adapterResult.inputTokens) >= 0 &&
      Number(adapterResult.outputTokens) >= 0;
    const tokenUsage = usageValid
      ? {
          input: adapterResult.inputTokens,
          output: adapterResult.outputTokens,
          total:
            Number(adapterResult.inputTokens) +
            Number(adapterResult.outputTokens),
        }
      : null;
    const costUsd =
      typeof adapterResult.costUsd === "number" &&
      Number.isFinite(adapterResult.costUsd) &&
      adapterResult.costUsd >= 0
        ? adapterResult.costUsd
        : null;
    const passed = planningOnlyRequested
      ? planningComplete && adapterResult.planningReviewApproved === true
      : !agent.code &&
        !apply.code &&
        results.length === value.evaluator.commands.length &&
        results.every((result) => result.exitCode === 0);
    const firstActionMatches = value.expectedFirstAction
      ? firstAction === value.expectedFirstAction
      : null;
    const evaluationSeconds =
      evaluationStarted === null
        ? 0
        : Math.round((Date.now() - evaluationStarted) / 10) / 100;
    // Match Mini-SWE's elapsed time: agent sandbox startup/setup through patch
    // capture, stopping before grading. Keep grading-inclusive time separately.
    const elapsedSeconds = solveSeconds;
    const totalSeconds = Math.round((Date.now() - caseStarted) / 10) / 100;
    const report = {
      version: 1,
      caseId: value.id,
      taskId: value.taskId ?? null,
      caseHash,
      configHash,
      model: adapterResult.model ?? null,
      adapterConfigSha256: adapterResult.configSha256 ?? null,
      commandSha256: createHash("sha256").update(agentCommand).digest("hex"),
      runtime: { node: process.version, platform: process.platform },
      baseCommit: base,
      repositoryPath: repo,
      mode: value.mode ?? "stateless",
      status: planningComplete
        ? adapterResult.planningReviewApproved === true
          ? "planning-approved"
          : "planning-unapproved"
        : planningFailed
          ? "planning-failed"
          : agent.code
            ? "agent-failed"
            : apply.code
              ? "patch-invalid"
              : passed
                ? "passed"
                : "failed",
      elapsedSeconds,
      totalSeconds,
      agentSeconds,
      solveSeconds,
      evaluatorSetupLaunchSeconds,
      evaluatorSetupWaitSeconds,
      evaluatorSetupSeconds,
      evaluatorSetupError,
      evaluationSeconds,
      tokenUsage,
      costUsd,
      tokenBudget: process.env.BENCHMARK_TOKEN_BUDGET
        ? Number(process.env.BENCHMARK_TOKEN_BUDGET)
        : null,
      tokenBudgetEnforced: allRoundBudgetsEnforced,
      costBudgetUsd:
        typeof adapterResult.costBudgetUsd === "number"
          ? adapterResult.costBudgetUsd
          : null,
      patchApplyError: apply.code ? apply.stderr : null,
      behavior: {
        firstAction,
        expectedFirstAction: value.expectedFirstAction ?? null,
        firstActionMatches,
        action: adapterResult.action ?? null,
        questions: adapterResult.questions ?? null,
        questionsAsked,
        questionCount: questionsAsked.reduce(
          (sum, item) => sum + item.questions.length,
          0,
        ),
        questionQuality: {
          humanScore: null,
          rubric: "benchmarks/ambiguity-rubric.json",
        },
        scriptedExchanges: exchanges,
        summary: adapterResult.summary ?? null,
        planning: adapterResult.planning ?? null,
        planningEvidenceLedger: adapterResult.planningEvidenceLedger ?? null,
        planningNotes: adapterResult.planningNotes ?? null,
        planningRevisionId: adapterResult.planningRevisionId ?? null,
        planningThreads: adapterResult.planningThreads ?? null,
        planningReviewApproved: adapterResult.planningReviewApproved ?? null,
        planningReportedBehaviors:
          adapterResult.planningReportedBehaviors ?? null,
        investigationRounds: adapterResult.investigationRounds ?? null,
        planningClefBlocks: adapterResult.planningClefBlocks ?? null,
        implementationReviewApproved:
          adapterResult.implementationReviewApproved ?? null,
        implementationReviewRounds:
          adapterResult.implementationReviewRounds ?? null,
        implementationReviewThreads:
          adapterResult.implementationReviewThreads ?? null,
        adapterStatus: adapterResult.status ?? null,
        adapterError: adapterResult.error ?? null,
        toolCalls: adapterResult.toolCalls ?? null,
      },
      agentExitCode: agent.code,
      evaluator: results,
      files: {
        patch: join(dir, "candidate.patch"),
        stdout: join(dir, "agent.stdout.log"),
        stderr: join(dir, "agent.stderr.log"),
      },
    };
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(
      join(dir, "report.md"),
      `# Benchmark ${value.id}\n\nStatus: **${report.status}**  \nBase: \`${base}\`  \nMode: ${report.mode}  \nElapsed to patch (Mini-comparable; includes agent sandbox setup, excludes grading): ${String(elapsedSeconds)}s  \nAgent process: ${agentSeconds}s  \nEvaluator setup: ${String(evaluatorSetupSeconds)}s (overlapped with solving)  \nEvaluation time: ${evaluationSeconds}s  \nTotal wall time through grading: ${totalSeconds}s  \nModel: ${String(report.model ?? "unknown")}  \nToken usage: ${tokenUsage ? `${tokenUsage.total} (${tokenUsage.input} input, ${tokenUsage.output} output)` : "unknown"}  \nToken budget enforced: ${report.tokenBudgetEnforced ? "yes" : "no"}  \nFirst action: ${String(report.behavior.firstAction ?? "unreported")}  \nFinal action: ${String(report.behavior.action ?? "unreported")}  \nFirst-action match: ${String(report.behavior.firstActionMatches)}  \nQuestion quality: pending human rubric scoring\n\n${results.map((result) => `## ${result.exitCode ? "FAIL" : "PASS"}: ${result.command}\n\nExit code: ${result.exitCode}\n`).join("\n")}`,
    );
    return { ...report, runDirectory: dir };
  } finally {
    if (!planningOnlyRequested && value.evaluator.cleanupCommand) {
      await runCommand(
        value.evaluator.cleanupCommand,
        evaluator,
        { BENCHMARK_CASE_ID: value.instanceId ?? value.id },
        60_000,
      ).catch(() => {});
    }
    for (const checkout of checkouts.reverse())
      await rm(checkout, { recursive: true, force: true });
  }
}

export function benchmarkStatusIsSuccessful(status: string): boolean {
  return (
    status === "passed" ||
    status === "planning-complete" ||
    status === "planning-approved"
  );
}

export async function scoreQuestionQuality(
  reportFile: string,
  scoresFile: string,
) {
  const report = JSON.parse(await readFile(resolve(reportFile), "utf8")) as {
    behavior?: {
      questionsAsked?: Array<{ round: number; questions: string[] }>;
      questionQuality?: Record<string, unknown>;
    };
  };
  const input = JSON.parse(await readFile(resolve(scoresFile), "utf8")) as {
    questions?: Array<Record<string, unknown>>;
  };
  const questions =
    report.behavior?.questionsAsked?.flatMap((round) => round.questions) ?? [];
  const dimensions = [
    "relevance",
    "specificity",
    "answerability",
    "decisionImpact",
  ];
  if (
    !questions.length ||
    !Array.isArray(input.questions) ||
    input.questions.length !== questions.length
  )
    throw new Error(
      `Provide one score for each of the ${questions.length} recorded questions`,
    );
  let total = 0;
  for (const [index, score] of input.questions.entries())
    for (const key of dimensions) {
      const value = score[key];
      if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2)
        throw new Error(
          `Question ${index + 1} ${key} must be an integer from 0 to 2`,
        );
      total += Number(value);
    }
  const max = questions.length * dimensions.length * 2;
  const humanScore = total / max;
  const scoresSha256 = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  report.behavior ??= {};
  report.behavior.questionQuality = {
    humanScore,
    rawMean: total / (questions.length * dimensions.length),
    dimensions,
    scores: input.questions,
    scoresSha256,
    rubric: "benchmarks/ambiguity-rubric.json",
  };
  await writeFile(resolve(reportFile), JSON.stringify(report, null, 2));
  const markdownPath = resolve(reportFile).replace(/\.json$/i, ".md");
  let markdown = "";
  try {
    markdown = await readFile(markdownPath, "utf8");
  } catch {}
  markdown = markdown.split("\n## Question quality scoring\n")[0];
  markdown = markdown.replace(
    "Question quality: pending human rubric scoring",
    `Question quality human score: ${humanScore.toFixed(3)} / 1.000`,
  );
  await writeFile(
    markdownPath,
    `${markdown}\n## Question quality scoring\n\nHuman score: ${humanScore.toFixed(3)} / 1.000  \nRaw mean: ${(total / (questions.length * dimensions.length)).toFixed(2)} / 2  \nQuestions scored: ${questions.length}  \nScores SHA-256: ${scoresSha256}\n`,
  );
  return {
    questionCount: questions.length,
    humanScore,
    rawMean: total / (questions.length * dimensions.length),
    scoresSha256,
  };
}

export async function runBenchmarkSuite(
  file: string,
  agentCommand: string,
  timeoutMs = 300_000,
) {
  const suite = JSON.parse(await readFile(resolve(file), "utf8")) as {
    cases: string[];
  };
  if (!Array.isArray(suite.cases) || !suite.cases.length)
    throw new Error("Suite requires cases[]");
  const inputs = await Promise.all(
    suite.cases.map(async (item) => {
      const value = JSON.parse(
        await readFile(resolve(dirname(file), item), "utf8"),
      ) as Case;
      return { item, value };
    }),
  );
  const matchedInputs = new Map<string, Case[]>();
  for (const { value } of inputs) {
    if (!value.taskId) continue;
    const group = matchedInputs.get(value.taskId) ?? [];
    group.push(value);
    matchedInputs.set(value.taskId, group);
  }
  for (const [taskId, group] of matchedInputs) {
    const modes = group.map((item) => item.mode ?? "stateless").sort();
    if (
      group.length !== 3 ||
      modes.join(",") !==
        ["chronological-memory", "code-map", "stateless"].sort().join(",")
    )
      throw new Error(
        `Matched task ${taskId} must include exactly one stateless, code-map, and chronological-memory case`,
      );
    const first = group[0]!;
    for (const item of group.slice(1))
      if (
        item.repository !== first.repository ||
        resolve(item.repositoryPath) !== resolve(first.repositoryPath) ||
        item.baseCommit !== first.baseCommit ||
        item.prompt !== first.prompt ||
        JSON.stringify(item.evaluator) !== JSON.stringify(first.evaluator)
      )
        throw new Error(
          `Matched task ${taskId} cases must share repository, base commit, prompt, and evaluator`,
        );
  }
  const reports: Array<Record<string, any>> = [];
  for (const { item, value } of inputs) {
    try {
      reports.push(
        await runBenchmarkCase(
          resolve(dirname(file), item),
          agentCommand,
          timeoutMs,
        ),
      );
    } catch (error) {
      reports.push({
        caseId: item,
        taskId: value.taskId ?? null,
        mode: value.mode ?? "stateless",
        status: "harness-error",
        error: String(error),
        costUsd: null,
        tokenUsage: null,
      });
    }
  }
  const dir = join(harnessRoot, ".louibot", "benchmarks", "runs");
  await mkdir(dir, { recursive: true });
  const resolved = reports.filter(
    (item) => item.status === "passed" && item.behavior?.action === "implement",
  ).length;
  const scoredActions = reports.filter(
    (item) => typeof item.behavior?.firstActionMatches === "boolean",
  );
  const knownCosts = reports.every((item) => typeof item.costUsd === "number");
  const report = {
    version: 1,
    cases: reports,
    passed: reports.filter((item) => item.status === "passed").length,
    behaviorallyReady: reports.filter(
      (item) =>
        item.status === "passed" &&
        (item.behavior?.firstActionMatches === null ||
          item.behavior?.firstActionMatches === true),
    ).length,
    firstActionAccuracy: scoredActions.length
      ? scoredActions.filter((item) => item.behavior.firstActionMatches)
          .length / scoredActions.length
      : null,
    resolved,
    total: reports.length,
    costPerResolvedUsd:
      knownCosts && resolved
        ? reports.reduce((sum, item) => sum + item.costUsd, 0) / resolved
        : null,
    matchedTasks: [...matchedInputs.entries()].map(([taskId, inputs]) => {
      const cases = reports.filter((item) => item.taskId === taskId);
      const byMode = Object.fromEntries(
        ["stateless", "code-map", "chronological-memory"].map((mode) => {
          const result = cases.find((item) => item.mode === mode);
          return [
            mode,
            result
              ? {
                  status: result.status,
                  passed: result.status === "passed",
                  resolved:
                    result.status === "passed" &&
                    result.behavior?.action === "implement",
                  firstActionMatches:
                    result.behavior?.firstActionMatches ?? null,
                  firstAction: result.behavior?.firstAction ?? null,
                  tokenUsage: result.tokenUsage?.total ?? null,
                  costUsd: result.costUsd,
                  elapsedSeconds: result.elapsedSeconds ?? null,
                  toolCalls: result.behavior?.toolCalls ?? null,
                }
              : null,
          ];
        }),
      );
      return {
        taskId,
        complete: inputs.length === 3 && cases.length === 3,
        modes: byMode,
        memoryVsStateless: comparisonDelta(
          byMode["chronological-memory"],
          byMode.stateless,
        ),
        memoryVsCodeMap: comparisonDelta(
          byMode["chronological-memory"],
          byMode["code-map"],
        ),
      };
    }),
  };
  const completeTasks = report.matchedTasks.filter((item) => item.complete);
  const mean = (values: Array<number | null>) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length
      ? known.reduce((sum, value) => sum + value, 0) / known.length
      : null;
  };
  const averageDelta = (
    key: "memoryVsStateless" | "memoryVsCodeMap",
    metric:
      | "resolved"
      | "pass"
      | "firstActionMatches"
      | "tokenUsage"
      | "costUsd"
      | "elapsedSeconds"
      | "toolCalls",
  ) => mean(completeTasks.map((item) => item[key]?.[metric] ?? null));
  Object.assign(report, {
    matchedSummary: {
      completeTasks: completeTasks.length,
      totalTasks: matchedInputs.size,
      perMode: Object.fromEntries(
        ["stateless", "code-map", "chronological-memory"].map((mode) => {
          const values = completeTasks.map((item) => item.modes[mode]);
          return [
            mode,
            {
              passing: values.filter((value) => value?.passed).length,
              resolved: values.filter((value) => value?.resolved).length,
              meanTokens: mean(
                values.map((value) => value?.tokenUsage ?? null),
              ),
              meanCostUsd: mean(values.map((value) => value?.costUsd ?? null)),
              meanElapsedSeconds: mean(
                values.map((value) => value?.elapsedSeconds ?? null),
              ),
              meanToolCalls: mean(
                values.map((value) => value?.toolCalls ?? null),
              ),
            },
          ];
        }),
      ),
      meanDelta: Object.fromEntries(
        (["memoryVsStateless", "memoryVsCodeMap"] as const).map((key) => [
          key,
          Object.fromEntries(
            (
              [
                "resolved",
                "pass",
                "firstActionMatches",
                "tokenUsage",
                "costUsd",
                "elapsedSeconds",
                "toolCalls",
              ] as const
            ).map((metric) => [metric, averageDelta(key, metric)]),
          ),
        ]),
      ),
    },
  });
  const suiteId = Date.now();
  await writeFile(
    join(dir, `suite-${suiteId}.json`),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    join(dir, `suite-${suiteId}.md`),
    `# Benchmark suite\n\nCases: ${report.total}  \nPassing evaluators: ${report.passed}  \nBehaviorally ready: ${report.behaviorallyReady}  \nFirst-action accuracy: ${report.firstActionAccuracy === null ? "unknown" : `${Math.round(report.firstActionAccuracy * 100)}%`}  \nResolved: ${report.resolved}  \nCost per resolved task: ${report.costPerResolvedUsd === null ? "unknown" : `$${report.costPerResolvedUsd.toFixed(4)}`}\n\n| Case | Task | Status | Mode | First action | Final action | Tokens | Cost |\n|---|---|---|---|---|---|---:|---:|\n${reports.map((item) => `| ${item.caseId} | ${item.taskId ?? ""} | ${item.status} | ${item.mode ?? ""} | ${item.behavior?.firstAction ?? "unknown"} | ${item.behavior?.action ?? "unknown"} | ${item.tokenUsage?.total ?? "unknown"} | ${typeof item.costUsd === "number" ? `$${item.costUsd.toFixed(4)}` : "unknown"} |`).join("\n")}\n\n## Matched memory comparisons\n\n${report.matchedTasks.length ? report.matchedTasks.map((item) => `- ${item.taskId}: memory vs stateless ${JSON.stringify(item.memoryVsStateless)}; memory vs code map ${JSON.stringify(item.memoryVsCodeMap)}`).join("\n") : "No task-matched modes in this suite."}`,
  );
  return report;
}

function comparisonDelta(memory: any, baseline: any) {
  if (!memory || !baseline) return null;
  return {
    pass: Number(memory.passed) - Number(baseline.passed),
    resolved: Number(memory.resolved) - Number(baseline.resolved),
    firstActionMatches:
      memory.firstActionMatches === null || baseline.firstActionMatches === null
        ? null
        : Number(memory.firstActionMatches) -
          Number(baseline.firstActionMatches),
    tokenUsage:
      memory.tokenUsage === null || baseline.tokenUsage === null
        ? null
        : memory.tokenUsage - baseline.tokenUsage,
    costUsd:
      memory.costUsd === null || baseline.costUsd === null
        ? null
        : memory.costUsd - baseline.costUsd,
    elapsedSeconds:
      memory.elapsedSeconds === null || baseline.elapsedSeconds === null
        ? null
        : Math.round((memory.elapsedSeconds - baseline.elapsedSeconds) * 100) /
          100,
    toolCalls:
      memory.toolCalls === null || baseline.toolCalls === null
        ? null
        : memory.toolCalls - baseline.toolCalls,
  };
}

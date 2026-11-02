import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { scoreQuestionQuality } from "../src/benchmark.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("question rubric scoring validates counts and records normalized human scores", async () => {
  const root = await mkdtemp(join(tmpdir(), "louibot-benchmark-score-"));
  roots.push(root);
  const report = join(root, "report.json"),
    scores = join(root, "scores.json");
  await writeFile(
    report,
    JSON.stringify({
      caseId: "clarify",
      behavior: {
        questionsAsked: [
          {
            round: 1,
            questions: [
              "Which storage backend?",
              "Should migration preserve existing data?",
            ],
          },
        ],
      },
    }),
  );
  await writeFile(
    scores,
    JSON.stringify({
      questions: [
        { relevance: 2, specificity: 2, answerability: 2, decisionImpact: 2 },
        { relevance: 1, specificity: 1, answerability: 2, decisionImpact: 2 },
      ],
    }),
  );
  const result = await scoreQuestionQuality(report, scores);
  assert.equal(result.questionCount, 2);
  assert.equal(result.humanScore, 0.875);
  const written = JSON.parse(await readFile(report, "utf8"));
  assert.equal(
    written.behavior.questionQuality.scoresSha256,
    result.scoresSha256,
  );
  assert.match(
    await readFile(join(root, "report.md"), "utf8"),
    /Question quality scoring/,
  );
  await writeFile(
    scores,
    JSON.stringify({
      questions: [
        { relevance: 3, specificity: 2, answerability: 2, decisionImpact: 2 },
      ],
    }),
  );
  await assert.rejects(
    () => scoreQuestionQuality(report, scores),
    /one score for each/,
  );
});

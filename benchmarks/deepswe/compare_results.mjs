#!/usr/bin/env node
// Compare the Louibot DeepSWE-subset results against the published mini-SWE rollouts.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = join(root, ".louibot", "benchmarks", "deepswe-subset-20261115");
const summary = JSON.parse(await readFile(join(base, "louibot-commandcode", "summary.json"), "utf8"));
const trials = JSON.parse(
  await readFile(join(root, ".louibot", "benchmarks", "deepswe-trials-deepseek-20261115.json"), "utf8"),
).rows.filter((r) => r.model === "deepseek-v4-flash");

const TASKS = [
  "ofetch-per-origin-circuit-breaker",
  "true-myth-iterable-collection-combinators",
  "awilix-async-container-initialization",
  "superjson-error-stack-serialization",
];

const mini = (task) => {
  const v = trials.filter((r) => r.task_name === task);
  const passes = v.filter((r) => r.passed).length;
  const meanDur = v.reduce((s, r) => s + (r.trial_duration_seconds ?? 0), 0) / (v.length || 1) / 60;
  const meanCost = v.reduce((s, r) => s + (r.cost_usd ?? 0), 0) / (v.length || 1);
  const f2p = v[0] ? `${v[0].f2p_passed}/${v[0].f2p_total}` : "-";
  return { passes, total: v.length, meanDur, meanCost, f2p };
};

const evaluator = (report) => {
  const raw = report?.evaluator?.[0]?.stdout ?? "";
  try {
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
};

const rows = TASKS.map((task) => {
  const report = summary.reports.find((r) => r.caseId === task);
  const m = mini(task);
  const ev = evaluator(report);
  return {
    task,
    mini: `${m.passes}/${m.total}`,
    miniDetail: `${m.f2p} f2p, ${m.meanDur.toFixed(1)}m, $${m.meanCost.toFixed(3)}`,
    louibot: report?.status ?? "missing",
    louibotTime: report?.solveSeconds != null ? `${(report.solveSeconds / 60).toFixed(1)}m` : "-",
    louibotCost: report?.costUsd != null ? `$${report.costUsd.toFixed(3)}` : "-",
    louibotTokens: report?.tokenUsage?.total ?? "-",
    grade: ev ? `reward=${ev.reward} f2p=${ev.f2p?.passed}/${ev.f2p?.total} p2p=${ev.p2p?.passed}/${ev.p2p?.total}` : "-",
    roles: report?.roleUsage
      ? Object.entries(report.roleUsage)
          .map(([role, usage]) => `${role}:${usage.calls}`)
          .join(" ")
      : "-",
  };
});

console.log("| Task | mini-SWE (4 rollouts) | mini detail | Louibot | Time | Cost | Tokens | Grade | Roles |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.task} | **${r.mini}** | ${r.miniDetail} | ${r.louibot} | ${r.louibotTime} | ${r.louibotCost} | ${r.louibotTokens} | ${r.grade} | ${r.roles} |`,
  );
}
const passed = summary.reports.filter((r) => r.status === "passed").length;
console.log(`\nLouibot: ${passed}/${TASKS.length} passed.`);

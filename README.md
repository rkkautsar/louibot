# Louibot

Locally Orchestrated Issue Implementer Bot. Assign an issue; get a draft PR. [Short tour](https://louibot.rakha.dev).

Louibot runs locally, uses a disposable Docker sandbox, and publishes draft PRs with `gh`. An optional reviewer checks changes in a read-only sandbox. It never merges PRs.

## Quick start

Linux/WSL, Node.js 22+, GitHub CLI (`gh`), and Docker. Run from the repository root; its `origin` must point to GitHub.

```sh
npm install --global louibot
gh auth login
export OPENAI_API_KEY="..."
louibot doctor --model openai/gpt-6-luna
louibot start --model openai/gpt-6-luna
```

`louibot start --help` lists configuration flags. Settings can be saved in `.louibot/config.yaml`.

## Use

Add a separate issue comment containing exactly `@louibot implement` from an account with write permission. The issue body is the task.

```sh
louibot status
louibot logs <issue> --follow
louibot stop <issue>
louibot retry <issue>
```

Use `@louibot revise` on a draft PR for review feedback. Clarification is enabled by default; use `--disable-clarification` for agent tasks and benchmarks. `--review` enables the independent reviewer; `reviewer.pairedWorkflow.enabled: true` adds the planner/investigator workflow.

## Benchmarks

Both agents use `deepseek/deepseek-v4-flash` through CommandCode. The comparison is
[DeepSWE v1.1](https://deepswe.datacurve.ai/), using TypeScript tasks from the published rollouts:
two that mini-SWE solved in all four attempts and two that it failed in all four. Each task was run
as a 2x2 ablation: implementer only, implementer + requirement checklist, implementer + independent
review, and both.

| Task      | Mini-SWE result | Mini-SWE cost | Implementer       | + checklist (default) | + review           | + both            |
| --------- | --------------- | ------------- | ----------------- | --------------------- | ------------------ | ----------------- |
| ofetch    | 4/4             | $0.065        | pass 47/47 $0.119 | pass 47/47 $0.074     | pass 47/47 $0.101  | pass 47/47 $0.066 |
| true-myth | 4/4             | $0.082        | pass 96/96 $0.154 | pass 96/96 $0.074     | pass 96/96 $0.055  | pass 96/96 $0.054 |
| awilix    | 0/4             | $0.082        | fail 23/24 $0.118 | **pass 24/24 $0.075** | fail 23/24 $0.151  | pass 24/24 $0.145 |
| koota     | 0/4             | $0.119        | fail 50/51 $0.209 | fail 47/51 $0.125     | fail 50/51 $0.361* | fail 47/51 $0.085 |

The core finding: **the independent review loop changed no outcome in any pair**, while the
requirement checklist is task-dependent. The checklist recovered awilix's single missed behavior
(23/24 to 24/24) but cost koota three behaviors (50/51 to 47/51) and was neutral where the
implementer already passed; it is also consistently cheaper than implementer-only. Review added
cost and time without moving a score, so it is now bounded to two rounds and 120 reviewer model
calls, and it is **off by default**.

The default workflow is therefore the checklist arm, on for every task: one requirement-extraction
pass (explicit requirements plus repo-grounded inferred ones), the implementer, and no review
rounds. Set `reviewer.pairedWorkflow.review: true` to opt back into adversarial review.

`claude-code-by-agents-recursive-delegation` is excluded from the table: its published mini-SWE
"4/4" is three out-of-memory crashes that the official verifier counted as passes (the verifier
still writes a passing JUnit report when the suite dies). The harness now rejects crash reports and
zero-duration testcases. `*` marks the koota review run that predates the review cap.

Costs are cache-aware, priced with the rate card inferred from the published mini-SWE rollouts
($0.167/M uncached input, $0.0028/M cache read, $0.236/M output). Mini-SWE cost is the mean of its
four published attempts on the same card; Louibot costs are per run.

Harness, task configs, and per-run artifacts: [benchmark harness](benchmarks/README.md).

## Docs

- [Configuration, providers, and operations](docs/README.md)
- [Benchmark harness](benchmarks/README.md)

MIT License.

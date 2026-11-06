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

Both agents use `deepseek/deepseek-v4.1-flash`. The Docusaurus rows use CommandCode DeepSeek for every role.

| Task             | Louibot | Time   | Cost   | Mini-SWE | Time   | Cost   |
| ---------------- | ------- | ------ | ------ | -------- | ------ | ------ |
| docusaurus-9183  | pass    | 15m24s | $0.478 | pass     | 5m22s  | $0.160 |
| docusaurus-10309 | pass    | 14m57s | $0.330 | pass     | 4m10s  | $0.090 |
| docusaurus-10130 | pass    | 12m09s | $0.276 | pass     | 4m49s  | $0.109 |
| docusaurus-8927  | fail    | 18m07s | $0.408 | fail     | 5m03s  | $0.146 |
| preact-2757      | pass    | 2m40s  | $0.051 | pass     | 2m29s  | $0.080 |
| preact-3454      | pass    | 1m18s  | $0.026 | pass     | 1m09s  | $0.018 |
| preact-3010      | pass    | 4m22s  | $0.123 | pass     | 2m29s  | $0.127 |
| preact-4436      | pass    | 9m35s  | $0.663 | pass     | 28m07s | $1.670 |
| preact-2927      | pass    | 3m28s  | $0.116 | pass     | 1m16s  | $0.033 |
| preact-3062      | pass    | 1m43s  | $0.029 | pass     | 1m37s  | $0.039 |
| preact-3345      | pass    | 9m04s  | $0.449 | pass     | 3m42s  | $0.229 |
| preact-3562      | pass    | 3m40s  | $0.106 | pass     | 2m37s  | $0.095 |
| preact-2896      | pass    | 8m04s  | $0.391 | pass     | 30m05s | $0.281 |
| preact-3567      | pass    | 6m21s  | $0.355 | pass     | 54m43s | $0.259 |

Louibot times exclude hidden-test grading. The recorded Preact Mini-SWE times include grading; they are not directly comparable solve times. Costs are estimated from provider usage. The 4436, 2896, and 3567 Mini-SWE patches were regraded on 2026-11-06 in fresh official-image containers after the original browser grading failed or did not complete. All required tests passed; no model calls were made.

Details and additional Preact runs: [benchmark harness](benchmarks/README.md).

## Docs

- [Configuration, providers, and operations](docs/README.md)
- [Benchmark harness](benchmarks/README.md)

MIT License.

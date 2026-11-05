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

Both agents use `deepseek/deepseek-v4.1-flash` with high reasoning.

| Task | Louibot | Time | Cost | Mini-SWE | Time | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| docusaurus-9183 | pass | 20m28s | $0.811 | pass | 5m22s | $0.160 |
| docusaurus-10309 | pass | 33m52s | $0.247 | pass | 4m10s | $0.090 |
| docusaurus-10130 | pass | 29m36s | $0.205 | pass | 4m49s | $0.109 |
| docusaurus-8927 | fail | 14m24s | $0.386 | fail | 5m03s | $0.146 |
| preact-2757 | pass | 10m28s | $0.414 | pass | 2m29s | $0.080 |
| preact-3454 | pass | 7m09s | $0.181 | pass | 1m09s | $0.018 |
| preact-3010 | pass | 13m32s | $0.423 | pass | 2m29s | $0.127 |
| preact-4436 | pass | 25m42s | $1.522 | fail | 28m07s | $1.670 |
| preact-2896 | pass | 24m55s | $1.091 | fail | 30m05s | $0.281 |
| preact-3567 | pass | 23m47s | $1.327 | fail | 54m43s | $0.259 |

Times are solve time and exclude hidden-test grading. Costs are estimated from provider usage.

Details and additional Preact runs: [benchmark harness](benchmarks/README.md).

## Docs

- [Configuration, providers, and operations](docs/README.md)
- [Benchmark harness](benchmarks/README.md)

MIT License.

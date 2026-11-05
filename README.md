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

| Task | Louibot | Mini-SWE-Agent |
| --- | --- | --- |
| docusaurus-9183 | pass | pass |
| docusaurus-10309 | pass | pass |
| docusaurus-10130 | pass | pass |
| docusaurus-8927 | fail | fail |
| preact-2757 | pass | pass |
| preact-3454 | pass | pass |
| preact-3010 | pass | pass |
| preact-4436 | pass | fail |

Details and additional Preact runs: [benchmark harness](benchmarks/README.md).

## Docs

- [Configuration, providers, and operations](docs/README.md)
- [Benchmark harness](benchmarks/README.md)

MIT License.

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

Both agents use `deepseek/deepseek-v4-flash` through CommandCode. The recorded comparison is
[DeepSWE v1.1](https://deepswe.datacurve.ai/), a repo-level issue-resolution benchmark with an
official verifier. Four TypeScript tasks were chosen from the published DeepSeek rollouts: two
that mini-SWE solved in all four attempts, two that it failed in all four.

| Task                                       | Mini-SWE (4 attempts) | Louibot | Louibot time | Louibot cost |
| ------------------------------------------ | --------------------- | ------- | ------------ | ------------ |
| ofetch-per-origin-circuit-breaker          | 4/4 pass              | pass    | 29m42s       | $0.127       |
| true-myth-iterable-collection-combinators  | 4/4 pass              | pass    | 39m30s       | $0.178       |
| superjson-error-stack-serialization        | 0/4 (77–79/80 f2p)    | **pass** | 56m31s      | $0.257       |
| awilix-async-container-initialization      | 0/4 (23/24 f2p)       | fail    | 17m44s*      | $0.066*      |

The deep workflow recovered `superjson`, which mini-SWE failed on all four attempts, and reproduced
mini-SWE's single-test miss on `awilix`. \*`awilix` was resumed from the persisted workflow handoff,
so its time and cost exclude planning.

Costs are cache-aware and priced with the rate card inferred from the published mini-SWE rollouts
($0.167/M uncached input, $0.0028/M cache read, $0.236/M output). On these four tasks Louibot totals
**$0.629** against mini-SWE's **$0.282**, and 143m against 80m wall time.

Harness, task configs, and per-run artifacts: [benchmark harness](benchmarks/README.md).

## Docs

- [Configuration, providers, and operations](docs/README.md)
- [Benchmark harness](benchmarks/README.md)

MIT License.

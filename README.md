# Louibot

Locally Orchestrated Issue Implementer Bot. Assign an issue. Get a draft PR. See [louibot.rakha.dev](https://louibot.rakha.dev) for the short tour.

Louibot runs the coding agent locally, uses a disposable Docker sandbox for shell access, and uses the GitHub CLI for collaboration. It creates draft pull requests and never merges them.

## Install

Install the CLI globally or run it without a global install:

```sh
npm install --global louibot
louibot --help

# Or run the published version on demand.
npx louibot --help
```

## Setup

Linux/WSL, Node.js 22+, GitHub CLI (`gh`), and Docker are required. Run these commands from the root of the GitHub checkout you want Louibot to modify; its `origin` must point to GitHub.

```sh
gh auth login
# Set the model API key on the host.
louibot init --model openai/gpt-6-luna
louibot doctor
louibot start
```

Louibot fills prices for a small catalog of direct OpenAI models. For other providers and all OpenAI-compatible endpoints, pass `--input-price` and `--output-price` as USD per million tokens; compatible services can apply their own gateway, negotiated, or regional rates, and there is no standard API for discovering them safely. The controller reserves a conservative estimated maximum before each call; reported cost is reserved spend, not billing reconciliation. Configuration lives in `.louibot/config.yaml`; never commit that directory.

Verify authentication with `gh auth status` before starting. Use the following commands for operations and recovery:

```sh
louibot status
louibot logs <issue> --follow
louibot stop <issue>
louibot retry <issue>
```

Cancellation preserves state. `retry` requeues failed, blocked, or stopped jobs with their workspace, conversation, processed events, and spending reservation retained. Correct the underlying failure or update the issue/configuration before retrying; retries do not reset the spending budget.

## OpenAI-compatible providers

Choose `openai-compatible/<model-id>` with `--base-url` and `--api-key-env` during init. The controller uses Chat Completions, including tool calling; the selected model must support function tools. Model IDs may include slashes. Keys remain in the host environment and are never written into configuration or passed to Docker.

For example, replace the model in this configuration with your provider's supported tool-calling model:

```yaml
model: openai-compatible/YOUR_MODEL_ID
endpoint:
  baseUrl: https://api.example.com/v1
  apiKeyEnv: PROVIDER_API_KEY
```

Some providers need `endpoint.reasoningEffort` or `endpoint.tokenLimitParameter`; check the provider's Chat Completions documentation before configuring those optional fields.

### Configuration

`init` writes `.louibot/config.yaml`. The generated file can be edited for polling, labels, model limits, and sandbox settings:

```yaml
repository: owner/repository
model: openai/YOUR_MODEL
github:
  issueLabel: louibot:active
  blockedLabel: louibot:blocked
  doneLabel: louibot:done
  pollIntervalSeconds: 30
agent:
  maxConcurrentJobs: 1
  maxSteps: 60
  maxCostUsd: 3
  maxInputTokens: 32000
  maxOutputTokens: 4096
  inputUsdPerMillion: 0.1
  outputUsdPerMillion: 0.5
sandbox:
  image: auto
  commandTimeoutSeconds: 120
  network: bridge
validation:
  commands: []
```

`louibot doctor` checks GitHub access, Docker, the model key, the discovered sandbox image, and repository validation commands. `sandbox.image: auto` uses a directly referenced image from `.devcontainer/devcontainer.json` when available, then selects a common language image from repository files, and finally falls back to `node:22`. Set an explicit image when the repository needs a custom toolchain; Louibot does not build arbitrary Dockerfiles automatically.

An empty `validation.commands` list enables safe command discovery from repository metadata. Add commands to that list to override discovery with the checks your project requires.

OpenAI and Anthropic providers read `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` respectively unless a compatible endpoint specifies another host environment variable. Credentials stay on the host and are never written into this file or passed to Docker.

One local worker runs up to `agent.maxConcurrentJobs` coding jobs in parallel; the default is one. Run only one Louibot coordinator for a repository because separate clones or machines can claim the same comment and race on the issue branch. A collaborator with write, maintain, or admin permission can answer clarification or request revisions. PRs are drafts and Louibot never merges them.

### Starting an issue

Write the issue normally, then add a separate issue comment containing exactly `@louibot implement`. Louibot checks that the commenter has repository write, maintain, or admin permission before claiming the issue. The issue body remains the task specification; the command only starts the worker.

If a draft PR is closed without merging, edit the issue with the clearer requirements and add another `@louibot implement` comment. Louibot starts a fresh attempt on a new retry branch and creates a new draft PR. The previous closed PR remains available for comparison. Use `louibot retry <issue>` for failed, blocked, or stopped jobs that do not have a closed PR.

Louibot uses `louibot:active` while an issue is active, `louibot:blocked` while clarification or failure needs attention, and `louibot:done` after a merged PR. These labels are status indicators; comments trigger implementation and revision. A PR closed without merging removes worker lifecycle labels without marking the issue done. Unrelated labels are preserved. Configure these status labels with `github.issueLabel`, `github.blockedLabel`, and `github.doneLabel`.

### Pull request templates

If the repository has a standard pull request template in `.github/`, the repository root, or `docs/`, Louibot preserves it at the top of the draft PR description. It appends a clearly marked implementation summary, collapsible validation output, and the issue reference below the template so existing checklists and prompts remain intact.

Draft PRs and revision comments include a Louibot run summary with the model, accumulated active agent time, and estimated reserved spend. The spend is intentionally labeled as an estimate because provider billing, caching, and gateway pricing may differ.

### Requesting revisions

Review the draft PR normally, including inline comments, and submit the review. Then add a separate PR conversation comment containing exactly `@louibot revise`.

Louibot checks that the command author is authorized, reads unresolved review threads and submitted review summaries from authorized collaborators, resumes the same conversation/workspace, and pushes to the existing branch. The command is processed once; add another `@louibot revise` comment for a later revision. If no authorized review feedback is open, Louibot records that fact and does not invent a change. Use `retry` to recover failed or stopped jobs.

Sandboxes use Docker bridge networking by default so commands can install dependencies and fetch documentation through the existing shell tool. Set `sandbox.network` to `none` when a repository does not need internet access. A prebuilt image with common dependencies can reduce setup time; configure `sandbox.image` for your repository.

Louibot mounts a Docker-managed named build cache per repository. It exposes common cache locations for npm, pnpm, yarn, pip, Cargo, Go, Maven, and Gradle, so package downloads can survive disposable containers without mounting host credential directories. `node_modules` and other build outputs remain workspace-specific because native dependencies and package trees can differ between branches. Choose a repository-appropriate `sandbox.image` when the default Node image does not contain the required toolchain. The MVP does not provide a browser tool.

## Safety and known limits

The host controller keeps GitHub and model credentials out of the Docker sandbox. The sandbox drops Linux capabilities, runs as an unprivileged user, limits memory, CPU, processes, output, and command time, and excludes common credential files and Git metadata from the staged workspace.

The sandbox has internet access when `sandbox.network` is `bridge`, so projects can install dependencies and fetch documentation. That also means an agent can send repository data to external services. Use `none` for offline jobs when practical. Docker is a containment boundary for this local tool, not a complete data-loss prevention system. Review the repository and network policy before using Louibot with sensitive code.

The default runs one coding job at a time. Set `agent.maxConcurrentJobs` above one only when the host has enough Docker CPU and memory for multiple sandboxes; each job reserves its own model budget. GitHub and Docker failures are persisted for inspection and retry, but crash recovery around external publication side effects remains intentionally conservative. The bot does not merge PRs, create issues, or perform independent code review.

Louibot is released under the [MIT License](LICENSE).

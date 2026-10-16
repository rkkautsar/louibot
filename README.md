# Louibot

Locally Orchestrated Issue Implementer Bot. Assign an issue. Get a draft PR.

Louibot runs the coding agent locally, uses a disposable Docker sandbox for shell access, and uses the GitHub CLI for collaboration. It creates draft pull requests and never merges them.

## Install

After publishing a release, install the CLI globally or run it without a global install:

```sh
npm install --global louibot
louibot --help

# Or run the published version on demand.
npx louibot --help
```

The machine running Louibot still needs Node.js 22+, GitHub CLI, Docker, and a host environment variable for the selected model provider.

### Publishing

The package is published as [`louibot`](https://www.npmjs.com/package/louibot). The first release is bootstrapped once by a maintainer with npm authentication:

```sh
npm login
npm publish --access public
```

Then configure npm Trusted Publishing for the `rkkautsar/louibot` repository and `.github/workflows/publish.yml`. Future releases use the repository workflow: bump the package version, push the commit, and publish a GitHub release for that version. The workflow reruns validation and publishes with short-lived OIDC credentials and npm provenance; no npm token is stored in GitHub.

See npm's [Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/) for the one-time setup.

## Setup

Linux/WSL, Node.js 22+, GitHub CLI (`gh`), and Docker are required. Run these commands from the root of the GitHub checkout you want Louibot to modify; its `origin` must point to GitHub.

```sh
gh auth login
# Set the model API key on the host.
louibot init --model openai/YOUR_MODEL --input-price 1 --output-price 4
docker pull node:22
louibot start
```

Prices above are illustrative USD per million tokens. Set actual provider rates, including any applicable surcharges. The controller reserves a conservative estimated maximum before each call; reported cost is reserved spend, not billing reconciliation. Configuration lives in `.louibot/config.yaml`; never commit that directory.

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

`init` writes `.louibot/config.yaml`. The generated file can be edited for polling, labels, model limits, and the sandbox image:

```yaml
repository: owner/repository
model: openai/YOUR_MODEL
github:
  issueLabel: louibot:active
  blockedLabel: louibot:blocked
  doneLabel: louibot:done
  pollIntervalSeconds: 30
agent:
  maxSteps: 60
  maxCostUsd: 3
  maxInputTokens: 32000
  maxOutputTokens: 4096
  inputUsdPerMillion: 1
  outputUsdPerMillion: 4
sandbox:
  image: node:22
  commandTimeoutSeconds: 120
```

OpenAI and Anthropic providers read `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` respectively unless a compatible endpoint specifies another host environment variable. Credentials stay on the host and are never written into this file or passed to Docker.

## Design

`agent.ts` contains the fixed prompt, LangChain `createAgent`, one Docker shell tool, and model budget middleware. `workflow.ts` contains the outer LangGraph lifecycle, clarification/review interrupts, polling and reconciliation. `github.ts` owns GitHub mutations. `workspace.ts` owns worktrees and disposable sandboxes. `store.ts` stores minimal job metadata and redacted logs in SQLite/local files. Agent and lifecycle checkpoints have separate SQLite databases.

One local worker runs coding jobs sequentially. Run only one Louibot coordinator for a repository: the worker lock protects a single checkout, but separate clones or machines have independent state and can claim the same comment. They may duplicate model work and race on the issue branch; the first successful push and PR normally wins, while another worker fails and must be stopped or retried. Review revisions have the same limitation. A collaborator with write, maintain, or admin permission can answer clarification or request revisions. PRs are drafts and Louibot never merges them.

### Starting an issue

Write the issue normally, then add a separate issue comment containing exactly `@louibot implement`. Louibot checks that the commenter has repository write, maintain, or admin permission before claiming the issue. The issue body remains the task specification; the command only starts the worker.

Louibot uses `louibot:active` while an issue is active, `louibot:blocked` while clarification or failure needs attention, and `louibot:done` after a merged PR. These labels are status indicators; comments trigger implementation and revision. A PR closed without merging removes worker lifecycle labels without marking the issue done. Unrelated labels are preserved. Configure these status labels with `github.issueLabel`, `github.blockedLabel`, and `github.doneLabel`.

### Requesting revisions

Review the draft PR normally, including inline comments, and submit the review. Then add a separate PR conversation comment containing exactly `@louibot revise`.

Louibot checks that the command author is authorized, reads unresolved review threads and submitted review summaries from authorized collaborators, resumes the same conversation/workspace, and pushes to the existing branch. The command is processed once; add another `@louibot revise` comment for a later revision. If no authorized review feedback is open, Louibot records that fact and does not invent a change. Use `retry` to recover failed or stopped jobs.

Sandboxes use Docker bridge networking so commands can install dependencies and fetch documentation through the existing shell tool. A prebuilt image with common dependencies can reduce setup time; configure `sandbox.image` for your repository. Writable temporary home and npm cache directories support installation under the sandbox's unprivileged user. The MVP does not provide a browser tool.

## Validation

```sh
npm run build
npm test
```

Run the live Docker sandbox smoke test with `node scripts/check-sandbox.mjs` after building. It checks configured resource limits, excluded host credentials and Git metadata, npm installation over the network, workspace synchronization, and container/staging cleanup. It pulls `node:22` if necessary and removes its temporary workspace afterward.

The repository's CI runs formatting, type checking, tests, and dependency auditing.

## Safety and known limits

The host controller keeps GitHub and model credentials out of the Docker sandbox. The sandbox drops Linux capabilities, runs as an unprivileged user, limits memory, CPU, processes, output, and command time, and excludes common credential files and Git metadata from the staged workspace.

The sandbox has internet access so projects can install dependencies and fetch documentation. That also means an agent can send repository data to external services. Docker is a containment boundary for this local tool, not a complete data-loss prevention system. Review the repository and network policy before using Louibot with sensitive code.

The MVP runs one coding job at a time. GitHub and Docker failures are persisted for inspection and retry, but crash recovery around external publication side effects remains intentionally conservative. The bot does not merge PRs, create issues, or perform independent code review.

Format source, tests, and maintained scripts with `npm run format`; verify style with `npm run format:check`.

Louibot is released under the [MIT License](LICENSE).

# Louibot

Locally Orchestrated Issue Implementer Bot. Assign an issue. Get a draft PR.

Louibot runs the coding agent locally, uses a disposable Docker sandbox for shell access, and uses the GitHub CLI for collaboration. It creates draft pull requests and never merges them.

## Setup

Linux/WSL, Node.js 22+, GitHub CLI (`gh`), and Docker are required.

```sh
npm ci
npm run build
node dist/cli.js init --model openai/YOUR_MODEL --input-price 1 --output-price 4
# Run `gh auth login` first. Set OPENAI_API_KEY or ANTHROPIC_API_KEY on the host.
docker pull node:22
node dist/cli.js start
```

Prices above are illustrative USD per million tokens. Set actual provider rates, including any applicable surcharges. The controller reserves a conservative estimated maximum before each call; reported cost is reserved spend, not billing reconciliation. Configuration lives in `.louibot/config.yaml`; never commit that directory.

Use `status`, `logs <issue> --follow`, and `stop <issue>` for visibility and cancellation. Cancellation preserves state. Use `retry <issue>` to requeue failed, blocked, or stopped jobs with their workspace, conversation, processed events, and spending reservation retained. Correct the underlying failure or update the issue/configuration before retrying; retries do not reset the spending budget.

## OpenAI-compatible providers

Choose `openai-compatible/<model-id>` with `--base-url` and `--api-key-env` during init. The controller uses Chat Completions, including tool calling; the selected model must support function tools. Model IDs may include slashes. Keys remain in the host environment and are never written into configuration or passed to Docker.

For example, replace the model in this configuration with your provider's supported tool-calling model:

```yaml
model: openai-compatible/YOUR_MODEL_ID
endpoint:
  baseUrl: https://api.deepseek.com
  apiKeyEnv: DEEPSEEK_API_KEY
```

DeepSeek documents that base URL in its [API documentation](https://api-docs.deepseek.com/). For OpenCode Go models using Chat Completions, set `baseUrl: https://opencode.ai/inference/go/openai/v1` and `apiKeyEnv: OPENCODE_API_KEY`; select a compatible model from the [Go endpoint table](https://opencode.ai/v2/docs/console/go/). Some Go models use different API protocols and cannot use this adapter. Optional `endpoint.reasoningEffort` and `endpoint.tokenLimitParameter` support provider-specific request settings; compatibility must be checked for the chosen model.

Custom transport and tool-call parsing are tested with mocked responses. The Cloudflare Luna route below has also been verified live.

### Cloudflare AI Gateway with Luna

A live tool-call request was verified using Wrangler OAuth credentials and Cloudflare's account API. This uses Cloudflare credits, independently of a Codex subscription. See the [Cloudflare REST API documentation](https://developers.cloudflare.com/ai-gateway/usage/rest-api/).

Use these model settings in `.louibot/config.yaml`, alongside the repository and execution limits:

```yaml
model: openai-compatible/openai/gpt-6-luna
endpoint:
  baseUrl: https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1
  apiKeyEnv: CLOUDFLARE_API_TOKEN
  tokenLimitParameter: max_completion_tokens
  reasoningEffort: none
```

Luna requires `max_completion_tokens`. Its Chat Completions endpoint requires `reasoning_effort: none` when using function tools, as verified by the provider's error responses. Reasoning-enabled tool calls require a Responses API adapter, which Louibot does not currently provide.

Before starting the worker, retrieve the token into the host environment without printing it:

```sh
export CLOUDFLARE_API_TOKEN="$(npx wrangler auth token)"
node dist/cli.js start
```

The exported OAuth token is a snapshot; a long-running worker does not automatically refresh it. For a persistent installation, use a Cloudflare API token with the documented Workers AI permission. Never commit or pass this token into the sandbox.

To repeat the small live tool-call check (uses Cloudflare credits, executes no shell command):

```sh
npm run build
node scripts/check-cloudflare.mjs YOUR_ACCOUNT_ID
```

The check captures `wrangler auth token --json` into memory, uses the same model adapter as Louibot, and prints only the result and token usage. Full Docker/GitHub lifecycle validation remains outstanding.

## Design

`agent.ts` contains the fixed prompt, LangChain `createAgent`, one Docker shell tool, and model budget middleware. `workflow.ts` contains the outer LangGraph lifecycle, clarification/review interrupts, polling and reconciliation. `github.ts` owns GitHub mutations. `workspace.ts` owns worktrees and disposable sandboxes. `store.ts` stores minimal job metadata and redacted logs in SQLite/local files. Agent and lifecycle checkpoints have separate SQLite databases.

One local worker runs coding jobs sequentially. A collaborator with write, maintain, or admin permission can answer clarification or request revisions. PRs are drafts and Louibot never merges them.

### Starting an issue

Write the issue normally, then add a separate issue comment containing exactly `@louibot implement`. Louibot checks that the commenter has repository write, maintain, or admin permission before claiming the issue. The issue body remains the task specification; the command only starts the worker.

Louibot uses `louibot:ready` while an issue is active, `louibot:blocked` while clarification or failure needs attention, and `louibot:done` after a merged PR. A PR closed without merging removes worker lifecycle labels without marking the issue done. Unrelated labels are preserved. Configure these status labels with `github.issueLabel`, `github.blockedLabel`, and `github.doneLabel`.

### Requesting revisions

Review the draft PR normally, including inline comments, and submit the review. Then add a separate PR conversation comment containing exactly `@louibot revise`.

Louibot checks that the command author is authorized, reads unresolved review threads and submitted review summaries from authorized collaborators, resumes the same conversation/workspace, and pushes to the existing branch. The command is processed once; add another `@louibot revise` comment for a later revision. If no authorized review feedback is open, Louibot records that fact and does not invent a change. Use `retry` to recover failed or stopped jobs.


Sandboxes use Docker bridge networking so commands can install dependencies and fetch documentation through the existing shell tool. A prebuilt image with common dependencies can reduce setup time; configure `sandbox.image` for your repository. No browser tool is required for the MVP. Writable temporary home and npm cache directories support installation under the sandbox's unprivileged user.

Sandboxes have no host credentials, Docker socket, or host Git metadata. Internet access also permits outbound data transfer and may reach services accessible from the Docker network; it is not an egress security boundary. Common credential files are excluded from the sandbox copy; secrets embedded in arbitrary repository files still require removal from the repository. Only deterministic host code commits, pushes, and creates PRs.

## Validation

```sh
npm run build
npm test
```

Run the live Docker sandbox smoke test with `node scripts/check-sandbox.mjs` after building. It checks configured resource limits, excluded host credentials and Git metadata, npm installation over the network, workspace synchronization, and container/staging cleanup. It pulls `node:22` if necessary and removes its temporary workspace afterward.

The live trial used Cloudflare Luna and a disposable private repository. The repository's CI runs formatting, type checking, tests, and dependency auditing. No PR is automatically merged.

## Safety and known limits

The host controller keeps GitHub and model credentials out of the Docker sandbox. The sandbox drops Linux capabilities, runs as an unprivileged user, limits memory, CPU, processes, output, and command time, and excludes common credential files and Git metadata from the staged workspace.

The sandbox has internet access so projects can install dependencies and fetch documentation. That also means an agent can send repository data to external services. Docker is a containment boundary for this local tool, not a complete data-loss prevention system. Review the repository and network policy before using Louibot with sensitive code.

The MVP runs one coding job at a time. GitHub and Docker failures are persisted for inspection and retry, but crash recovery around external publication side effects remains intentionally conservative. The bot does not merge PRs, create issues, or perform independent code review.

Format source, tests, and maintained scripts with `npm run format`; verify style with `npm run format:check`.

Louibot is released under the [MIT License](LICENSE).

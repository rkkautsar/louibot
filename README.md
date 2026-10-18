# Louibot

Locally Orchestrated Issue Implementer Bot. Assign an issue. Get a draft PR. See [louibot.rakha.dev](https://louibot.rakha.dev) for the short tour.

Louibot runs the coding agent locally, uses a disposable Docker sandbox for shell access, and uses the GitHub CLI for collaboration. An optional fresh-context reviewer can inspect proposed changes in a read-only, offline sandbox before Louibot opens a draft PR. Louibot never merges PRs.

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
export OPENAI_API_KEY="..."
louibot doctor --model openai/gpt-6-luna
louibot start --model openai/gpt-6-luna
```

The repository is inferred from the current checkout's `origin`. Louibot fills prices for a small catalog of direct OpenAI models. For other providers and OpenAI-compatible endpoints, pass `--input-price` and `--output-price` as USD per million tokens; compatible services can apply their own gateway, negotiated, or regional rates, and there is no standard API for discovering them safely. The controller reserves a conservative estimated maximum before each call; reported cost is reserved spend, not billing reconciliation.

Verify authentication with `gh auth status` before starting. Use the following commands for operations and recovery:

```sh
louibot status
louibot logs <issue> --follow
louibot stop <issue>
louibot retry <issue>
```

`louibot status` shows failed-job error codes and recommended next steps. Failed jobs also receive a concise, redacted explanation and recovery instruction on the issue or existing PR; `louibot logs <issue>` retains the detailed event and stack trace. Comments are deduplicated per trigger so polling or restart recovery does not post duplicates.

Cancellation preserves state. For a failed, blocked, or stopped job, post a new `@louibot implement` comment to retry with its existing workspace, conversation, and spending reservation. You can also use `louibot retry <issue>` locally. Fix the underlying problem or clarify the issue before retrying; retries do not reset the spending budget.

## OpenAI-compatible providers

Choose `openai-compatible/<model-id>` with `--base-url` and `--api-key-env`. Set `--base-url` to the API root, such as `https://api.example.com/v1`; do not append `/chat/completions` because Louibot adds that route itself. Use `--token-limit-parameter` and `--reasoning-effort` for provider-specific Chat Completions settings. The selected model must support function tools. Model IDs may include slashes. Keys remain in the host environment and are never written into configuration or passed to Docker.

Cloudflare AI Gateway with `openai/gpt-6-luna` was verified with `max_completion_tokens` and `reasoning_effort: none`. Use the account API root ending in `/ai/v1`; do not add `/chat/completions`. For that endpoint, start Louibot with the following options, supplying the two prices that match your Cloudflare account:

```sh
louibot start \
  --model openai-compatible/openai/gpt-6-luna \
  --base-url "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/v1" \
  --api-key-env CLOUDFLARE_API_TOKEN \
  --token-limit-parameter max_completion_tokens \
  --reasoning-effort none \
  --input-price "$INPUT_USD_PER_MILLION" \
  --output-price "$OUTPUT_USD_PER_MILLION"
```

Use prices that match your Cloudflare account's billing. Other compatible endpoints may need different settings; check their Chat Completions documentation rather than assuming Cloudflare's parameters apply.

All settings can be passed to `louibot start` or `louibot doctor`. For repeated use, save defaults in `.louibot/config.yaml` and override any of them per invocation. CLI flags take precedence; no setup command is required. `louibot start --help` lists the flags. Reviewer options are `--review` / `--no-review`, `--reviewer-model`, `--reviewer-max-steps`, `--reviewer-input-price`, and `--reviewer-output-price`. The reviewer defaults to 24 steps; if review is skipped, the PR run summary names the failure type, suggests increasing the cap when it is reached, and shows the configured limit. Detailed errors remain in local logs. A different reviewer model must use the same provider and endpoint as the implementation model; its price rates are required unless Louibot has published direct-model pricing. The reviewer is disabled by default. The remaining YAML fields map to `--repository`, `--model`, `--base-url`, `--api-key-env`, `--token-limit-parameter`, `--reasoning-effort`, `--issue-label`, `--blocked-label`, `--done-label`, `--poll-interval-seconds`, `--max-concurrent-jobs`, `--max-steps`, `--max-cost-usd`, `--context-window-tokens`, `--max-input-tokens`, `--max-output-tokens`, `--input-price`, `--output-price`, `--sandbox-image`, `--command-timeout-seconds`, `--sandbox-network`, and repeatable `--validation-command`. Use `--clear-validation-commands` to return to automatic validation discovery and `--clear-endpoint` to remove a saved compatible API endpoint. The token defaults reserve headroom inside a 200K context window; raise them only when the selected model and endpoint document larger limits.

`louibot doctor` checks GitHub access, Docker, the model key, the discovered sandbox image, and repository validation commands. It prints the name of the selected host environment variable, hides its value, and sends a small model request with a 256-token output limit to verify the configured endpoint and credentials; the provider may charge a small amount for that request. Louibot reads credentials from the process environment and does not load `.env` files or reuse Wrangler's saved login automatically. For Cloudflare, pass a token with Account Workers AI Read permission through the configured variable; for example, `export CLOUDFLARE_API_TOKEN="$(wrangler auth token)"`. A 401/403 usually means the selected token is missing, invalid, or lacks that permission. `--sandbox-image auto` uses a directly referenced image from `.devcontainer/devcontainer.json` when available, then selects a common language image from repository files, and finally falls back to `node:22`. Set an explicit image when the repository needs a custom toolchain; Louibot does not build arbitrary Dockerfiles automatically. Automatic validation discovery is used unless one or more `--validation-command` flags override it.

If a model returns a malformed or truncated tool call, Louibot makes one recovery attempt in the same conversation. If that also fails, the issue comment and local log explain the output limit and how to retry with a higher `--max-output-tokens` value.

OpenAI and Anthropic providers read `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` respectively unless a compatible endpoint specifies another host environment variable. Credentials stay in the host environment and are never written into configuration or passed to Docker.

One local worker runs up to `agent.maxConcurrentJobs` coding jobs in parallel; the default is one. Run only one Louibot coordinator for a repository because separate clones or machines can claim the same comment and race on the issue branch. A collaborator with write, maintain, or admin permission can answer clarification or request revisions. PRs are drafts and Louibot never merges them.

### Starting an issue

Write the issue normally, then add a separate issue comment containing exactly `@louibot implement` from the GitHub account currently authenticated with `gh`. Louibot checks that account has repository write, maintain, or admin permission before claiming the issue. The issue body remains the task specification; the command only starts the worker. Authorized collaborators can still provide clarification replies and review feedback, but their comments do not trigger a run.

If a draft PR is closed without merging, edit the issue with the clearer requirements and add another `@louibot implement` comment. Louibot starts a fresh attempt on a new retry branch and creates a new draft PR. The previous closed PR remains available for comparison. If implementation fails, post a new `@louibot implement` comment to retry the saved job with the updated issue text. The new comment is the retry signal; duplicate or already-processed comments remain idempotent. The CLI retry command remains available for local recovery.

Louibot uses `louibot:active` while an issue is active, `louibot:blocked` while clarification or failure needs attention, and `louibot:done` after a merged PR. These labels are status indicators; comments trigger implementation and revision. A PR closed without merging removes worker lifecycle labels without marking the issue done. Unrelated labels are preserved. Configure these status labels with `github.issueLabel`, `github.blockedLabel`, and `github.doneLabel`.

### Pull request templates

If the repository has a standard pull request template in `.github/`, the repository root, or `docs/`, Louibot preserves it at the top of the draft PR description. It appends a clearly marked implementation summary, collapsible validation output, and the issue reference below the template so existing checklists and prompts remain intact.

Draft PRs and revision comments include a Louibot run summary with the implementation model, optional reviewer result, accumulated active agent time, and estimated reserved spend. The spend is intentionally labeled as an estimate because provider billing, caching, and gateway pricing may differ.

### Optional independent review

Enable it with `louibot start --review` or `reviewer.enabled: true` in `.louibot/config.yaml`. The reviewer gets a separate conversation, a changed-file list and bounded diff excerpt, and can inspect surrounding repository code and tests. Its Docker workspace is mounted read-only, has no network or shared build cache, and receives no credentials. It reports only concrete findings; valid findings are sent back to the implementer once before publication. Review errors or budget exhaustion are recorded as skipped so an optional reviewer cannot strand a successful implementation. Skipped reviews include the configured step cap in the PR summary; detailed errors remain in local logs. Review calls count against the same per-issue spend limit.

### Requesting revisions

Review the draft PR normally, including inline comments, and submit the review. Then add a separate PR conversation comment containing exactly `@louibot revise`.

The `@louibot revise` command must come from the GitHub account currently authenticated with `gh`, which must have repository write, maintain, or admin permission. Louibot reads authorized collaborators' PR conversation comments, submitted review summaries, and unresolved inline review threads, resumes the same conversation/workspace, and pushes to the existing branch. The command is processed once; add another `@louibot revise` comment for a later revision. Louibot ignores its own marked status comments and command comments as review feedback. If no authorized feedback is available, Louibot records that fact and does not invent a change. Use `retry` to recover failed or stopped jobs.

Sandboxes use Docker bridge networking by default so commands can install dependencies and fetch documentation through the existing shell tool. Set `sandbox.network` to `none` when a repository does not need internet access. A prebuilt image with common dependencies can reduce setup time; configure `sandbox.image` for your repository.

Louibot mounts a Docker-managed named build cache per repository. It exposes common cache locations for npm, pnpm, yarn, pip, Cargo, Go, Maven, and Gradle, so package downloads can survive disposable containers without mounting host credential directories. `node_modules` and other build outputs remain workspace-specific because native dependencies and package trees can differ between branches. Choose a repository-appropriate `sandbox.image` when the default Node image does not contain the required toolchain. The MVP does not provide a browser tool.

## Safety and known limits

The host controller keeps GitHub and model credentials out of the Docker sandbox. The sandbox drops Linux capabilities, runs as an unprivileged user, limits memory, CPU, processes, output, and command time, and excludes common credential files and Git metadata from the staged workspace.

The sandbox has internet access when `sandbox.network` is `bridge`, so projects can install dependencies and fetch documentation. That also means an agent can send repository data to external services. Use `none` for offline jobs when practical. Docker is a containment boundary for this local tool, not a complete data-loss prevention system. Review the repository and network policy before using Louibot with sensitive code.

The default runs one coding job at a time. Set `agent.maxConcurrentJobs` above one only when the host has enough Docker CPU and memory for multiple sandboxes; each job reserves its own model budget. GitHub and Docker failures are persisted for inspection and retry, but crash recovery around external publication side effects remains intentionally conservative. The bot does not merge PRs or create issues.

Louibot is released under the [MIT License](LICENSE).

## Releasing

CI verifies every push and pull request. npm publishing uses trusted publishing, so the package maintainer must add one trusted publisher in the npm package settings first:

- Provider: GitHub Actions
- Organization or user: `rkkautsar`
- Repository: `louibot`
- Workflow filename: `publish.yml`
- Environment: leave empty

After that one-time setup, update the version with `npm version <version>`, push the commit and matching `v<version>` tag, and GitHub Actions publishes the package after the checks pass:

```sh
npm version patch
git push origin main --follow-tags
```

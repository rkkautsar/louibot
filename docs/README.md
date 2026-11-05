# Configuration and operations

## Providers

For OpenAI-compatible services, use `openai-compatible/<model-id>` with:

```sh
--base-url https://api.example.com/v1
--api-key-env PROVIDER_API_KEY
--api-format responses   # or chat-completions
--input-price 0.20 --output-price 0.75
```

Prices are USD per million tokens. Keys remain in the host environment and are never written to configuration or passed to Docker. `louibot doctor` verifies GitHub, Docker, the selected image, the model credential, tool calling, and validation commands.

## Configuration

Settings live in `.louibot/config.yaml`; CLI flags override them. Useful keys:

```yaml
agent:
  maxSteps: 160
  maxCostUsd: 6
  contextWindowTokens: 400000
  maxInputTokens: 300000
  maxOutputTokens: 64000

github:
  issueLabel: "louibot:active"
  blockedLabel: "louibot:blocked"
  doneLabel: "louibot:done"

sandbox:
  image: auto
  network: bridge

validation:
  commands: []
  required: false
```

Use `validation.commands` for explicit checks, or let Louibot discover them. `sandbox.network: none` disables network access. `agent.maxConcurrentJobs` defaults to one; run one coordinator per repository.

## Review

Pass `--review` or set `reviewer.enabled: true`. The reviewer gets a fresh, read-only, offline workspace and reports concrete findings; it cannot publish.

For the paired workflow:

```yaml
reviewer:
  enabled: true
  pairedWorkflow:
    enabled: true
    parallelInvestigations: 6
    maxImplementationReviews: 5
```

The planner selects competing hypotheses; independent investigators test them; the planner synthesizes the plan. Set `plannerModel`/`plannerApiFormat` when the planner uses a different endpoint configuration. `investigatorReasoningEffort` and `implementerReasoningEffort` tune those stages independently.

## Operations

A job preserves its workspace, history, and spending reservation when stopped or failed. Retry with `@louibot implement` on the issue or `louibot retry <issue>`. Failed jobs redact credentials and post a recovery instruction; `louibot logs <issue>` retains the detailed trace.

PR templates are preserved above the generated summary. Draft PRs and revision comments include the model, reviewer result, active agent time, and estimated spend.

## Safety

The host keeps GitHub and model credentials out of Docker. The sandbox is unprivileged, capability-limited, resource-limited, and excludes credentials and Git metadata from the staged workspace.

With bridge networking, commands can install dependencies and fetch documentation, but repository data can also reach external services. Use `sandbox.network: none` when practical. Docker is containment, not a complete data-loss prevention system. Louibot never merges PRs or creates issues.

## Releasing

CI verifies pushes and pull requests. npm publishing uses trusted publishing; configure the GitHub Actions trusted publisher in the npm package settings, then:

```sh
npm version patch
git push origin main --follow-tags
```

# Louibot benchmark v0.1

This is a local-first harness for measuring a real coding agent on a fixed base commit. The repository contains no issue bodies, reference patches, or hidden test data. It freezes a chronological 12-issue SWE-bench Verified Django selection for local acquisition; the catalog marks those cases unprepared until the pinned source, repository checkout, and official evaluator are available. Missing cases are not represented as passing tasks. Do not publish aggregate scores until a suite's requested cases are prepared and reviewed.

## Run a case

Build Louibot, then run a JSON case with the built-in real Louibot adapter and an existing valid `.louibot/config.yaml`:

```sh
npm run build
node dist/cli.js benchmark suite <generated-output>/cases/ambiguity-suite.json \
  --config .louibot/config.yaml --timeout-seconds 300
```

The built-in adapter uses the configured Louibot context, response, step, and monetary limits by default. It has no aggregate token cap unless `--token-budget` is supplied. An explicit token budget uses conservative reservations for estimated input plus maximum output; it can stop well below that amount of measured usage and is unrelated to actual provider pricing. Use verified provider rates for monetary limits and cost reporting.

Alternatively pass `--agent-command 'node /absolute/path/to/adapter.js'`. It receives the task file and isolated candidate checkout through environment variables. It should read `BENCHMARK_PROMPT_FILE`, make changes in its current directory, and write measured behavior and usage to `BENCHMARK_RESULT_FILE`. `--timeout-seconds` bounds the whole case and kills the active process group on timeout. `BENCHMARK_TOKEN_BUDGET` is passed to each invocation with measured prior-round usage deducted; however, Louibot's existing pre-call input estimate is not an exact tokenizer, so reports explicitly leave aggregate token enforcement unverified.

Generate a tiny local arithmetic fixture with `node benchmarks/fixtures/create.mjs`. It prints a new output directory containing a scratch Git repository, host-side evaluator, four action examples (including one deterministic clarification reply), a two-case `quick-suite.json` for implementation plus clarification, and matched stateless/code-map/memory cases. Pass that printed directory in the suite command above. Re-running with an existing explicit output path fails safely. This is an integration fixture, not an official benchmark and should not be included in dataset scores.

For a deterministic check of the built-in adapter without a paid model, run `node scripts/benchmark-adapter-smoke.mjs` after the build. It requires local Docker and a local fake provider; it checks transport, shell-tool execution, clarification results, and usage extraction. The built-in adapter maps Louibot's current result states to `implement`, `clarify`, and `decline`; its current `code()` result schema does not express `breakdown`, so that label can be scored only for adapters that report it.

Case format:

```json
{
  "id": "example-task",
  "repositoryPath": "/absolute/path/to/local/repository",
  "repository": "owner/repository",
  "baseCommit": "<immutable commit SHA>",
  "prompt": "Task text visible to the agent",
  "mode": "stateless",
  "evaluator": { "commands": ["npm test -- --runInBand"] }
}
```

Evaluator commands and case files are host-side harness inputs; the runner does not copy them into the candidate checkout or pass them to the adapter. The evaluator runs against the captured patch in a new shallow repository of the same base commit. Only that commit and its tree are fetched; later Git objects and refs are absent. The harness is not a security boundary against a malicious adapter: commands execute as the local user, and a command with arbitrary host access can inspect host files. Use a trusted adapter and a disposable machine/container when testing untrusted code. Fixture authors should keep hidden tests and reference patches in a separate host-side directory and never put them in task-visible repository files.

Results, patch, stdout, and stderr are written under `.louibot/benchmarks/runs/`. Missing token usage or cost is reported as `null`. A time limit is enforced by the harness; a token limit is not enforced unless the adapter implements and attests it. External usage values are measurements only when the adapter's provider reports them.

## Modes and interaction scoring

- `stateless`: no map or prior memory is attached; each case gets a new checkout.
- `code-map`: a sorted list of tracked paths from the base commit is supplied. It contains no working-tree changes or file contents.
- `chronological-memory`: only memory entries matching the approved repository and source case IDs, at or before the approved cutoff and strictly before the current case date, are supplied. Each case still gets a fresh checkout. Do not share memory across repositories or include future case information.

Compare the same case sequence across all three modes to measure the effect of memory. A memory declaration is invalid without explicit approval fields in the case JSON. Independent cases need no reset beyond their fresh checkout; a suite should not reuse an agent process unless it can prove its conversation state was reset.

For ambiguous requests, author a fixed sequence of scripted user replies and score the first decision separately from the final patch. Label the desired first action `implement`, `clarify`, `breakdown`, or `decline`. Record each question and score relevance, specificity, answerability, and whether it resolves a decision that affects implementation. The runner records every round's questions. After reviewing them, pass one score per question to `louibot benchmark score report.json --scores scores.json`; the scores file has a `questions` array with four integer fields from 0 to 2. The command stores the normalized average and a hash of the score input in the report. `behavior.questionQuality.humanScore` remains null until a human adds scores. A successful patch alone is not evidence of good clarification behavior.

## Dataset acquisition and readiness

The SWE Verified task set is not bundled. Obtain it from its official source under its stated access and license terms; preserve task IDs, source revision, and evaluator provenance. Never invent benchmark tasks, expected patches, or claim official-suite results from local fixtures. Chronological tasks require dated snapshots and explicit permission to use only prior information. Ambiguity cases require authored prompts, deterministic scripted replies, and rubric review. UI cases additionally need reproducible browser/runtime setup and human-checked interaction outcomes.

Upstream references: [SWE-bench quickstart](https://www.swebench.com/SWE-bench/guides/quickstart/) and [SWE-bench evaluation](https://www.swebench.com/SWE-bench/guides/evaluation/).

### Acquiring the first SWE-bench subset

1. Acquire the official [SWE-bench Verified dataset](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified) outside this repository. Pin its dataset revision and the upstream harness version in an acquisition manifest. Use the upstream quickstart below for installation; environment preparation and Docker images can require network access and substantial disk space.
2. Review candidate instance IDs for affordable setup, runtime, and repository diversity. Freeze roughly 20 IDs before measuring systems; record exclusions and never select by whether an agent succeeded. v0.1 does not supply a preselected or validated 20-case list.
3. Fetch each repository locally and pin each task's `base_commit`. Translate only the instance ID, repository identity, base commit, and problem statement into visible case inputs. Keep `patch`, `test_patch`, expected test outcomes, and solution-linked discussion out of agent inputs. Use an explicit host-side adapter to the pinned upstream evaluator for official scoring; generic shell evaluator success alone is not an official SWE-bench result. No such upstream evaluation adapter is bundled yet.
4. Review the dataset card and upstream repository licenses before using or redistributing material. Louibot's license does not relicense third-party issues, code, tests, or images. Keep downloaded datasets, caches, and prepared evaluation environments outside tracked files; retain provenance locally. Original toy fixtures here use this repository's MIT license.
5. For chronological measurements, freeze approximately 12 dated issues from a repository and audit all issue text, base snapshots, and approved memory against the current issue date. Compare the identical sequence independently across modes. The supplied three-mode toy fixture tests mode plumbing only; it is not a chronological multi-issue benchmark. Memory authoring and approval are manual in v0.1.
6. Curate the 12 ambiguity variants with expected first decisions and fixed replies before running agents. Question-quality ratings are human supplied. The optional six UI cases require pinned browser/viewport/runtime and independent behavior checks; screenshot-based scoring is not implemented.

### Chronological same-repository comparison

`swe-verified/django-12-selection.json` freezes 12 real SWE-bench Verified Django issues, evenly spaced by creation date across the repository's Verified instances. The list was selected from metadata before running Louibot; selection does not inspect reference patches, hidden tests, or model outcomes. It pins the Verified dataset revision and each task's immutable base commit. SWE-bench Verified contains 500 expert-validated GitHub issue instances from multiple real repositories; this small subset is a local memory experiment, not an official SWE-bench score.

Install the official `datasets` and `swebench` Python packages, and clone Django locally. Prepare the ignored local cases and private evaluator data:

```sh
python3 benchmarks/swe-verified/prepare_django_memory_suite.py \
  --repository /absolute/path/to/django
npm run build
node dist/cli.js benchmark suite \
  .louibot/benchmarks/swe-verified-django-12/suite.json \
  --config .louibot/config.yaml --timeout-seconds 3600
```

For these historical Django cases, configure a Python environment compatible with each pinned snapshot. Do not rely on `sandbox.image: auto`: Django also has Node tooling, which can cause the current file-based discovery to select a Node image. The official per-instance SWE-bench images contain prepared interpreter and dependency environments; the task environment must be activated explicitly. Confirm that Python imports the candidate checkout and that Django's own test runner starts before paid inference. Controller validation commands should be configured for Django rather than inferred as pytest from `tox.ini`.

The generated suite has 36 runs: each real issue is evaluated from its own pinned base snapshot in stateless, code-map, and chronological-memory modes. Memory consists only of earlier selected issue statements in date order. The generator excludes all `hints_text`, reference patches, and test patches from agent-visible inputs; the complete selected rows are stored under the ignored local `private/` directory for the official SWE-bench evaluator. The raw historical statements are not hand-edited into target-specific hints. This deliberately tests whether uncurated repository issue history helps; it does not test an LLM-generated-and-human-approved memory-writing workflow.

The runner sends the candidate patch to the upstream SWE-bench Docker evaluator through `evaluate_case.py`; a pass requires the official evaluator's `resolved` result. The local checkout must contain all selected base commits. SWE-bench's per-task images and build cache can require substantial disk space. Check the host disk containing Docker's virtual disk before pulling or building them; deleting images may leave that virtual disk allocated until it is compacted. Reports include matched per-issue deltas for memory versus stateless and memory versus code-map. Do not interpret a small, noisy change as a general memory benefit; repeat the fixed suite before drawing a conclusion.

### Small shared-runtime baseline

For a storage-limited diagnostic run, `swe-verified/evaluate_shared_case.mjs` accepts `--dataset <private-json> --runtime <runtime.json>` and the usual `BENCHMARK_CASE_ID` / `BENCHMARK_PATCH_FILE` environment variables. The runtime pins one existing Python image plus `setupCommands`, network policy, and command timeout. `sandbox.setupCommands` runs before the first model call and must use the same pinned dependency setup as grading. This evaluator does not build or pull images.

The evaluator applies the candidate patch to the task's base, restores test files, adds the held-out test patch, and runs the task's original Django test command. The official parser must find every required FAIL_TO_PASS and PASS_TO_PASS test passing, and the test process must exit successfully. Full logs and a grading report are retained beside the candidate patch. The shared grader requires actual PASSED statuses for every required test, and records exact aliases for Python unittest names that differ only by a repeated method suffix. Raw official-parser results remain separate from this strict shared-runtime result. Before paid inference, verify each chosen task with both its known fix (must pass) and an empty patch (must fail).

Label these results `shared-runtime-task-tests`: they use the task tests in a common environment and are not equivalent to official per-task container evaluation. Freeze the subset and runtime before new results, keep reference patches and hidden tests host-side, run sequentially, and bound Docker usage, workspace growth, and free space on the Windows drive holding the VHDX.

### Frontend issue-resolution comparison

The standard SWE-bench and Verified datasets are Python-repository tasks. The SWE-bench family also includes [Multilingual](https://www.swebench.com/multilingual), a text-only set with JavaScript/TypeScript repositories, and [Multimodal](https://www.swebench.com/multimodal), which adds visual issue content. For a frontend comparison without introducing image interpretation as another variable, `swe-multilingual/docusaurus-4-selection.json` freezes four Docusaurus issues from the official Multilingual test split: relative image asset paths, code-block language casing, broken-link slash matching, and version-dropdown routing. Docusaurus is a substantial TypeScript documentation application. The selected issues span distinct behaviors and have 8 fail-to-pass and 89 pass-to-pass checks in the dataset metadata. They were selected before any new agent run; the manifest pins the dataset revision and each base commit.

This is a frozen selection, not a ready-to-run or official SWE-bench score. The catalog keeps it at `readyCases: 0` until preparation has verified the four base snapshots, a single bounded Node runtime, and the independent evaluator. Do not pull four task images or build a per-task image set: the storage-limited follow-up should reuse one runtime and sequentially verify the official task tests. Keep the dataset rows and test patches in the ignored private benchmark directory and expose only issue statements to the agents.

Latest recorded Docusaurus 9183 pass:

```text
.louibot/benchmarks/runs/docusaurus-9183-f749a412
```

It passed in 15m24s with the hidden evaluator exiting `0`, using CommandCode DeepSeek for the planner, investigators, synthesis, implementer, and reviewer. This supersedes the earlier failed 9183 row. The same all-DeepSeek batch also passed 10130 and 10309; 8927 remains failed.

External adapter result example (write to `BENCHMARK_RESULT_FILE`):

```json
{
  "action": "clarify",
  "questions": ["Which storage backend?"],
  "summary": "Backend choice is required",
  "inputTokens": 1200,
  "outputTokens": 80,
  "toolCalls": 2,
  "costUsd": 0.0014,
  "budgetEnforced": false
}
```

Unknown measurements should be omitted or `null`. `budgetEnforced` is an adapter attestation, not independent verification. Pin the exact model snapshot when available and preserve configuration, case, evaluator, and runtime provenance across repetitions. Fixed inputs do not guarantee identical stochastic model outputs. The built-in adapter uses fresh conversations for every invocation, including reply rounds, carrying only the explicit transcript and candidate files forward.

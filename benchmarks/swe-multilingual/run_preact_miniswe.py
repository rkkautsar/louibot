#!/usr/bin/env python3.10
"""Run Mini-SWE-Agent on the frozen Preact selection using official eval images."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / ".louibot/benchmarks/swe-multilingual-preact-20261104"
DATASET = RUN / "private/dataset.json"
SELECTION = json.loads(
    Path(
        os.environ.get(
            "PREACT_SELECTION",
            ROOT / "benchmarks/swe-multilingual/preact-4-selection.json",
        )
    ).read_text()
)
MINISWE_ENV = ROOT / ".louibot/benchmarks/django-lite-20261021/miniswe-agent-env"
OUTPUT = RUN / "miniswe-commandcode"
API_BASE = "https://api.commandcode.ai/provider/v1"
MODEL = "openai/deepseek/deepseek-v4.1-flash"
LABEL = "deepseek-v4.1-flash-high"
REGISTRY = {
    MODEL: {
        "max_tokens": 200000,
        "input_cost_per_token": 2e-7,
        "output_cost_per_token": 7.5e-7,
        "litellm_provider": "openai",
        "mode": "chat",
    }
}


def run(args, *, cwd=None, check=True, timeout=None, capture=True):
    return subprocess.run(
        args,
        cwd=cwd,
        check=check,
        timeout=timeout,
        text=True,
        capture_output=capture,
    )


def short_test_name(name):
    return name.split(" > ")[-1].strip()


def tests_passed(output, row):
    f2p = [short_test_name(name) for name in row.get("FAIL_TO_PASS", [])]
    p2p = [short_test_name(name) for name in row.get("PASS_TO_PASS", [])]
    missing_f2p = [name for name in f2p if f"✔ {name}" not in output]
    failed_p2p = [name for name in p2p if f"✖ {name}" in output]
    return not missing_f2p and not failed_p2p, {
        "missingFailToPass": missing_f2p,
        "failedPassToPass": failed_p2p,
    }


def write_summary(reports, started):
    payload = {
        "started": started,
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dataset": SELECTION["dataset"],
        "datasetRevision": SELECTION["datasetRevision"],
        "model": MODEL,
        "label": LABEL,
        "mode": "stateless",
        "evaluationKind": "swebench-official-image",
        "requested": len(SELECTION["instances"]),
        "completed": len(reports),
        "passed": sum(item.get("passed") is True for item in reports),
        "maxCostUsdPerCase": 3.0,
        "reports": reports,
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "summary.json").write_text(json.dumps(payload, indent=2) + "\n")


def main():
    key = os.environ.get("COMMANDCODE_API_KEY", "").strip()
    if not key:
        raise RuntimeError("COMMANDCODE_API_KEY is required")
    os.environ["OPENAI_API_KEY"] = key
    os.environ["MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT"] = "3"
    os.environ["MSWEA_GLOBAL_CONFIG_DIR"] = str(
        ROOT / ".louibot/benchmarks/django-lite-20261021/miniswe-config"
    )
    os.environ["MSWEA_SILENT_STARTUP"] = "1"
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

    OUTPUT.mkdir(parents=True, exist_ok=True)
    registry_path = OUTPUT / "model-registry.json"
    registry_path.write_text(json.dumps(REGISTRY) + "\n")

    sys.path.insert(0, str(MINISWE_ENV))
    from minisweagent.agents import get_agent
    from minisweagent.config import get_config_from_spec
    from minisweagent.environments import get_environment
    from minisweagent.models import GLOBAL_MODEL_STATS, get_model

    rows = {row["instance_id"]: row for row in json.loads(DATASET.read_text())}
    out_root = OUTPUT / LABEL
    out_root.mkdir(parents=True, exist_ok=True)
    summary_path = OUTPUT / "summary.json"
    reports = (
        json.loads(summary_path.read_text()).get("reports", [])
        if summary_path.exists()
        else []
    )
    completed = {item.get("caseId") for item in reports}
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    only = os.environ.get("MINISWE_ONLY", "").strip()
    stop_on_fail = os.environ.get("MINISWE_STOP_ON_FAIL") == "1"
    for selected in SELECTION["instances"]:
        instance_id = selected["id"]
        if only and selected["version"] != only:
            continue
        if instance_id in completed:
            continue
        row = rows[instance_id]
        out = out_root / instance_id
        out.mkdir(parents=True, exist_ok=True)
        if subprocess.run(
            ["docker", "image", "inspect", row["image"]],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode != 0:
            run(["docker", "pull", row["image"]], timeout=1200, capture=True)
        config = get_config_from_spec("swebench.yaml")
        config["agent"]["system_template"] = (
            config["agent"].get("system_template", "")
            + "\n\nBenchmark constraints: work only in /testbed. Do not modify package-lock.json "
            "or write patch.txt. Wrap long-running test commands with `timeout 600`; never leave "
            "Karma or a watch process running."
        )
        config["agent"].update(
            step_limit=120,
            cost_limit=3.0,
            wall_time_limit_seconds=3600,
            output_path=str(out / "trajectory.json"),
        )
        config["model"].update(
            model_name=MODEL,
            model_kwargs={
                "custom_llm_provider": "openai",
                "api_base": API_BASE,
                "max_completion_tokens": 16000,
                "reasoning_effort": "high",
                "drop_params": True,
                "parallel_tool_calls": False,
                "num_retries": 0,
            },
            litellm_model_registry=str(registry_path),
            cost_tracking="default",
        )
        config["environment"].update(
            image=row["image"],
            cwd="/testbed",
            timeout=600,
            pull_timeout=60,
            container_timeout="2h",
            forward_env=[],
            env={"PAGER": "cat", "PIP_PROGRESS_BAR": "off", "TQDM_DISABLE": "1"},
            run_args=[
                "--rm",
                "--network",
                "bridge",
                "--memory",
                "4g",
                "--cpus",
                "2",
                "--pids-limit",
                "256",
                "--env",
                "HOME=/tmp",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev",
            ],
        )
        prompt = (
            "Benchmark protocol: Work from this pinned checkout at /testbed. "
            "Network access is available. Do not retrieve upstream fixes, reference patches, "
            "or issue/PR discussions for this task. Do not modify package-lock.json and do not "
            "create patch.txt. Use `timeout 600` for test commands and never leave Karma or a "
            "watch process running.\n\n"
            + row["problem_statement"]
        )
        started_case = time.time()
        cost_before = GLOBAL_MODEL_STATS.cost
        environment = None
        agent = None
        error = None
        result = None
        test_output = ""
        passed = False
        failure = None
        try:
            environment = get_environment(config["environment"], default_type="docker")
            agent = get_agent(
                get_model(config=config["model"]),
                environment,
                config["agent"],
                default_type="default",
            )
            result = agent.run(prompt)
            agent.save(Path(config["agent"]["output_path"]))
            patch_result = environment.execute(
                {
                    "command": (
                        "cd /testbed && git add -N . && "
                        "git diff --binary HEAD -- . "
                        "':(exclude)package-lock.json' ':(exclude)patch.txt'"
                    )
                },
                timeout=300,
            )
            patch_text = patch_result.get("output", "")
            (out / "candidate.patch").write_text(patch_text)
            eval_path = out / "eval.sh"
            eval_path.write_text(row["eval_script"])
            cp_result = run(
                [
                    "docker",
                    "cp",
                    str(eval_path),
                    f"{environment.container_id}:/root/eval.sh",
                ],
                check=False,
                timeout=60,
            )
            if cp_result.returncode != 0:
                raise RuntimeError(
                    f"docker cp eval.sh failed: {cp_result.stderr.strip()}"
                )
            check = environment.execute(
                {"command": "test -s /root/eval.sh && echo EVAL_READY"},
                timeout=30,
            )
            if "EVAL_READY" not in check.get("output", ""):
                raise RuntimeError("eval.sh is missing in the container")
            evaluated = environment.execute(
                {"command": "bash /root/eval.sh"}, timeout=1800
            )
            test_output = evaluated.get("output", "")
            (out / "test_output.txt").write_text(test_output)
            passed, failure = tests_passed(test_output, row)
        except BaseException as exc:
            error = f"{type(exc).__name__}: {exc}"
            if environment is not None and agent is not None:
                try:
                    agent.save(Path(config["agent"]["output_path"]), {"error": error})
                except BaseException:
                    pass
        finally:
            if environment is not None and getattr(environment, "container_id", None):
                run(
                    ["docker", "rm", "-f", environment.container_id],
                    check=False,
                    timeout=60,
                )
                environment.container_id = None

        trajectory_path = out / "trajectory.json"
        trajectory = (
            json.loads(trajectory_path.read_text())
            if trajectory_path.exists()
            else {}
        )
        input_tokens = output_tokens = 0
        for message in trajectory.get("messages", []):
            usage = (
                ((message.get("extra") or {}).get("response") or {}).get("usage")
                or {}
            )
            input_tokens += int(
                usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0
            )
            output_tokens += int(
                usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0
            )
        elapsed = round(time.time() - started_case, 2)
        cost = (input_tokens * 0.20 + output_tokens * 0.75) / 1_000_000
        patch_path = out / "candidate.patch"
        report = {
            "caseId": instance_id,
            "model": MODEL,
            "status": (result or {}).get(
                "exit_status", "error" if error else "unknown"
            ),
            "error": error,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "tokenUsage": input_tokens + output_tokens,
            "estimatedCostUsd": cost,
            "litellmReportedCostUsd": GLOBAL_MODEL_STATS.cost - cost_before,
            "elapsedSeconds": elapsed,
            "patchBytes": patch_path.stat().st_size if patch_path.exists() else 0,
            "passed": passed,
            "failure": failure,
            "runDirectory": str(out),
        }
        reports.append(report)
        completed.add(instance_id)
        write_summary(reports, started)
        print(json.dumps({"event": "case.done", **report}), flush=True)
        if stop_on_fail and not passed:
            print(
                json.dumps(
                    {"event": "suite.stopped", "caseId": instance_id, "passed": False}
                ),
                flush=True,
            )
            break

    write_summary(reports, started)
    print(
        json.dumps(
            {
                "event": "suite.done",
                "passed": sorted(
                    item["caseId"] for item in reports if item.get("passed")
                ),
                "passedCount": sum(item.get("passed") is True for item in reports),
                "requested": len(SELECTION["instances"]),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()

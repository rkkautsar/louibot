#!/usr/bin/env python3
"""Run Mini-SWE-Agent on the frozen Docusaurus selection using Louibot's shared runtime."""
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / ".louibot/benchmarks/swe-multilingual-frontend-20261021"
SOURCE = RUN / "source"
DATASET = RUN / "private/dataset.json"
RUNTIME = json.loads((RUN / "runtime.json").read_text())
SELECTION = json.loads((ROOT / "benchmarks/swe-multilingual/docusaurus-4-selection.json").read_text())
MINISWE_ROOT = ROOT / ".louibot/benchmarks/django-lite-20261021"
MINISWE_ENV = MINISWE_ROOT / "miniswe-agent-env"
OUTPUT = RUN / "miniswe"
GRADER = ROOT / "benchmarks/swe-multilingual/evaluate_docusaurus_shared_case.mjs"
ACCOUNT = "3d2c7278332e1314ee55afa8743dd6bc"


def run(args, *, cwd=None, check=True, timeout=None, capture=True):
    return subprocess.run(
        args,
        cwd=cwd,
        check=check,
        timeout=timeout,
        text=True,
        capture_output=capture,
    )


def write_summary(reports, started):
    result = {
        "started": started,
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dataset": SELECTION["dataset"],
        "datasetRevision": SELECTION["datasetRevision"],
        "model": "openai/gpt-6-luna",
        "mode": "stateless",
        "evaluationKind": "shared-runtime-task-tests",
        "requested": len(SELECTION["instances"]),
        "completed": len(reports),
        "passed": sum(item.get("passed") is True for item in reports),
        "maxCostUsdPerCase": 1,
        "reports": reports,
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "summary.json").write_text(json.dumps(result, indent=2) + "\n")


def main():
    rows = {row["instance_id"]: row for row in json.loads(DATASET.read_text())}
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    summary_path = OUTPUT / "summary.json"
    previous = json.loads(summary_path.read_text()) if summary_path.exists() else {}
    reports = previous.get("reports", [])
    completed = {item.get("caseId") for item in reports}

    token = json.loads(
        run(["wrangler", "auth", "token", "--json"], cwd=RUN, timeout=60).stdout
    ).get("token")
    if not token or any(char.isspace() for char in token):
        raise RuntimeError("Wrangler did not return a usable credential")
    os.environ["OPENAI_API_KEY"] = token
    os.environ.pop("LOUIBOT_BENCHMARK_CF_TOKEN", None)
    os.environ["MSWEA_GLOBAL_COST_LIMIT"] = "1.0"
    os.environ["MSWEA_GLOBAL_CALL_LIMIT"] = "60"
    os.environ["MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT"] = "3"
    os.environ["MSWEA_GLOBAL_CONFIG_DIR"] = str(MINISWE_ROOT / "miniswe-config")
    os.environ["MSWEA_SILENT_STARTUP"] = "1"
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    sys.path.insert(0, str(MINISWE_ENV))
    from minisweagent.agents import get_agent
    from minisweagent.config import get_config_from_spec
    from minisweagent.environments import get_environment
    from minisweagent.models import GLOBAL_MODEL_STATS, get_model

    cache = RUNTIME["cacheVolume"]
    image = RUNTIME["image"]
    node_path = f"/cache/node-v{RUNTIME['nodeVersion']}/bin"
    expected_commands = RUNTIME["setupCommands"]
    for selected in SELECTION["instances"]:
        instance_id = selected["id"]
        if instance_id in completed:
            continue
        row = rows[instance_id]
        out = OUTPUT / instance_id
        candidate = out / "candidate"
        out.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(candidate, ignore_errors=True)
        candidate.mkdir(parents=True)

        archive = subprocess.Popen(
            ["git", "-C", str(SOURCE), "archive", "--format=tar", row["base_commit"]],
            stdout=subprocess.PIPE,
        )
        try:
            with tarfile.open(fileobj=archive.stdout, mode="r|*") as stream:
                stream.extractall(candidate)
            if archive.wait() != 0:
                raise RuntimeError("Could not archive the pinned Docusaurus base")
        finally:
            if archive.poll() is None:
                archive.kill()
                archive.wait()
        run(["git", "init", "--quiet"], cwd=candidate)
        run(["git", "config", "user.email", "benchmark@localhost"], cwd=candidate)
        run(["git", "config", "user.name", "Benchmark"], cwd=candidate)
        run(["git", "add", "-A"], cwd=candidate, timeout=300)
        run(["git", "commit", "--quiet", "-m", f"frozen {instance_id}"], cwd=candidate, timeout=300)

        config = get_config_from_spec("swebench.yaml")
        config["agent"]["system_template"] = (
            "You are a software engineering agent. Work from the provided task and the current "
            "checkout. Use shell commands to inspect, edit, and test the code."
        )
        config["agent"]["instance_template"] = config["agent"]["instance_template"].replace(
            "/testbed", "/workspace"
        )
        config["agent"].update(
            step_limit=60,
            cost_limit=1.0,
            wall_time_limit_seconds=3600,
            output_path=str(out / "trajectory.json"),
        )
        config["model"].update(
            model_name="openai/openai/gpt-6-luna",
            model_kwargs={
                "custom_llm_provider": "openai",
                "api_base": f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/v1",
                "max_completion_tokens": 32000,
                "reasoning_effort": "none",
                "drop_params": True,
                "parallel_tool_calls": False,
                "num_retries": 0,
            },
            litellm_model_registry=str(MINISWE_ENV / "mock-model-registry.json"),
            cost_tracking="default",
        )
        config["environment"].update(
            image=image,
            cwd="/workspace",
            timeout=900,
            pull_timeout=30,
            container_timeout="2h",
            forward_env=[],
            env={"PAGER": "cat", "PIP_PROGRESS_BAR": "off", "TQDM_DISABLE": "1"},
            run_args=[
                "--rm", "--network", "bridge", "--memory", "2g", "--cpus", "2",
                "--pids-limit", "256", "--user", f"{os.getuid()}:{os.getgid()}",
                "--env", "HOME=/tmp", "--env", f"PATH={node_path}:/usr/local/bin:/usr/bin:/bin",
                "--env", "COREPACK_HOME=/cache/corepack", "--env", "YARN_CACHE_FOLDER=/cache/yarn",
                "--mount", f"type=bind,src={candidate},dst=/workspace",
                "--mount", f"type=volume,source={cache},destination=/cache",
                "--tmpfs", "/tmp:rw,nosuid,nodev",
            ],
        )

        started_case = time.time()
        cost_before = GLOBAL_MODEL_STATS.cost
        environment = None
        agent = None
        error = None
        result = None
        try:
            environment = get_environment(config["environment"], default_type="docker")
            setup = environment.execute({"command": " && ".join(expected_commands)}, timeout=900)
            (out / "setup.log").write_text(setup.get("output", ""))
            if setup.get("returncode") != 0:
                raise RuntimeError(f"Shared Node runtime setup failed ({setup.get('returncode')})")
            agent = get_agent(
                get_model(config=config["model"]), environment, config["agent"], default_type="default"
            )
            case_file = RUN / "cases" / f"docusaurus-{selected['version']}-stateless.json"
            result = agent.run(json.loads(case_file.read_text())["prompt"])
            agent.save(Path(config["agent"]["output_path"]))
        except BaseException as exc:
            error = f"{type(exc).__name__}: {exc}"
            if environment is not None and agent is not None:
                try:
                    agent.save(Path(config["agent"]["output_path"]), {"error": error})
                except BaseException:
                    pass
        finally:
            if environment is not None and getattr(environment, "container_id", None):
                run(["docker", "rm", "-f", environment.container_id], check=False, timeout=60)
                environment.container_id = None

        run(["git", "add", "-N", "."], cwd=candidate, check=False)
        patch_text = run(["git", "diff", "--binary", "HEAD"], cwd=candidate).stdout
        patch_file = out / "candidate.patch"
        patch_file.write_text(patch_text)
        trajectory_path = out / "trajectory.json"
        trajectory = json.loads(trajectory_path.read_text()) if trajectory_path.exists() else {}
        messages = trajectory.get("messages", [])
        input_tokens = output_tokens = 0
        for message in messages:
            usage = ((message.get("extra") or {}).get("response") or {}).get("usage") or {}
            input_tokens += int(usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0)
            output_tokens += int(usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0)
        elapsed = round(time.time() - started_case, 2)
        cost = (input_tokens * 0.2 + output_tokens * 0.75) / 1_000_000
        (out / "run.json").write_text(json.dumps({
            "caseId": instance_id,
            "baseCommit": row["base_commit"],
            "status": (result or {}).get("exit_status", "error" if error else "unknown"),
            "error": error,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "estimatedCostUsd": cost,
            "litellmReportedCostUsd": GLOBAL_MODEL_STATS.cost - cost_before,
            "elapsedSeconds": elapsed,
            "patchBytes": len(patch_text.encode()),
            "trajectory": str(trajectory_path),
        }, indent=2) + "\n")
        shutil.rmtree(candidate, ignore_errors=True)

        grade = run(
            ["node", str(GRADER), "--mini-patch", instance_id, str(patch_file)],
            cwd=ROOT,
            check=False,
            timeout=1800,
        )
        grade_path = out / "docusaurus-shared-evaluation" / f"{instance_id}.report.json"
        grade_report = json.loads(grade_path.read_text()) if grade_path.exists() else None
        report = {
            "caseId": instance_id,
            "status": (result or {}).get("exit_status", "error" if error else "unknown"),
            "error": error,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "tokenUsage": input_tokens + output_tokens,
            "estimatedCostUsd": cost,
            "litellmReportedCostUsd": GLOBAL_MODEL_STATS.cost - cost_before,
            "elapsedSeconds": elapsed,
            "patchBytes": len(patch_text.encode()),
            "graderExitCode": grade.returncode,
            "evaluator": grade_report,
            "passed": bool(grade_report and grade_report.get("passed")),
            "runDirectory": str(out),
        }
        reports.append(report)
        completed.add(instance_id)
        write_summary(reports, previous.get("started", started))
        print(json.dumps({"event": "case.done", **report}), flush=True)
        if error:
            break

    write_summary(reports, previous.get("started", started))
    print(json.dumps({
        "event": "suite.done",
        "completed": len(reports),
        "passed": sum(item.get("passed") is True for item in reports),
        "estimatedCostUsd": sum(item.get("estimatedCostUsd", 0) for item in reports),
    }), flush=True)


if __name__ == "__main__":
    main()

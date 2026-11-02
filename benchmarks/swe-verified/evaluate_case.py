#!/usr/bin/env python3
"""Run an isolated patch through the official SWE-bench test harness."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, type=Path)
    args = parser.parse_args()
    instance_id = os.environ.get("BENCHMARK_CASE_ID", "")
    patch_path = os.environ.get("BENCHMARK_PATCH_FILE", "")
    if not instance_id or not patch_path:
        raise SystemExit("Benchmark case ID and patch file are required")
    rows = json.loads(args.dataset.read_text())
    if sum(row["instance_id"] == instance_id for row in rows) != 1:
        raise SystemExit(f"Expected exactly one private SWE-bench row for {instance_id}")

    run_id = f"louibot-{instance_id}-{uuid.uuid4().hex[:8]}"
    with tempfile.TemporaryDirectory(prefix="louibot-swe-eval-") as tmp:
        predictions = Path(tmp) / "predictions.json"
        predictions.write_text(
            json.dumps(
                [
                    {
                        "instance_id": instance_id,
                        "model_name_or_path": "louibot",
                        "model_patch": Path(patch_path).read_text(),
                    }
                ]
            )
        )
        command = [
            sys.executable,
            "-m",
            "swebench.harness.run_evaluation",
            "--dataset_name",
            str(args.dataset),
            "--predictions_path",
            str(predictions),
            "--instance_ids",
            instance_id,
            "--max_workers",
            "1",
            "--run_id",
            run_id,
        ]
        subprocess.run(command, check=True)
        reports = list((Path("logs/run_evaluation") / run_id).rglob("report.json"))
        if len(reports) != 1:
            raise SystemExit(f"Expected one official evaluation report, found {len(reports)}")
        evidence = Path(patch_path).resolve().parent / "swebench-evaluation" / run_id
        shutil.copytree(reports[0].parent, evidence)
        report = json.loads((evidence / "report.json").read_text())
        resolved = report.get(instance_id, {}).get("resolved")
        print(json.dumps({"instanceId": instance_id, "resolved": resolved, "report": str(evidence / "report.json")}))
        if resolved is not True:
            raise SystemExit(1)


if __name__ == "__main__":
    main()

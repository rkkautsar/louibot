#!/usr/bin/env python3
"""Prepare a local, chronological 12-issue SWE-bench Verified suite."""

import argparse
import json
import shlex
from pathlib import Path

from datasets import load_dataset


ROOT = Path(__file__).resolve().parents[2]
SELECTION = ROOT / "benchmarks/swe-verified/django-12-selection.json"
EVALUATOR = ROOT / "benchmarks/swe-verified/evaluate_case.py"
REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / ".louibot/benchmarks/swe-verified-django-12",
    )
    args = parser.parse_args()
    repo_path = args.repository.resolve()
    output = args.output.resolve()
    selection = json.loads(SELECTION.read_text())
    ids = {item["id"] for item in selection["instances"]}

    if not (repo_path / ".git").exists():
        raise SystemExit("--repository must point to a local Django Git checkout")
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output directory: {output}")

    dataset = load_dataset(
        selection["dataset"],
        split=selection["split"],
        revision=REVISION,
    )
    rows = {row["instance_id"]: row for row in dataset if row["instance_id"] in ids}
    missing = ids - rows.keys()
    if missing:
        raise SystemExit(f"Pinned dataset is missing selected instances: {sorted(missing)}")

    ordered = [rows[item["id"]] for item in selection["instances"]]
    for row, metadata in zip(ordered, selection["instances"], strict=True):
        if row["repo"] != selection["repository"]:
            raise SystemExit(f"Unexpected repository for {row['instance_id']}")
        if row["base_commit"] != metadata["baseCommit"]:
            raise SystemExit(f"Pinned base commit changed for {row['instance_id']}")
        if row["created_at"] != metadata["createdAt"] or row["version"] != metadata["version"]:
            raise SystemExit(f"Pinned issue metadata changed for {row['instance_id']}")

    cases_dir = output / "cases"
    private_dir = output / "private"
    cases_dir.mkdir(parents=True)
    private_dir.mkdir()
    (private_dir / "dataset.json").write_text(json.dumps(ordered))
    (private_dir / "dataset.json").chmod(0o600)

    cases = []
    prior = []
    evaluator_command = " ".join(
        [
            "python3",
            shlex.quote(str(EVALUATOR)),
            "--dataset",
            shlex.quote(str(private_dir / "dataset.json")),
        ]
    )
    for row in ordered:
        task_id = row["instance_id"]
        date = row["created_at"][:10]
        for mode in ("stateless", "code-map", "chronological-memory"):
            case = {
                "id": f"{task_id}-{mode}",
                "taskId": task_id,
                "instanceId": task_id,
                "repositoryPath": str(repo_path),
                "repository": selection["repository"],
                "baseCommit": row["base_commit"],
                "prompt": row["problem_statement"],
                "mode": mode,
                "date": date,
                "evaluator": {"commands": [evaluator_command]},
            }
            if mode == "chronological-memory":
                case["memoryApproval"] = {
                    "approved": True,
                    "repository": selection["repository"],
                    "sourceCaseIds": [item["instance_id"] for item in prior],
                    "throughDate": prior[-1]["created_at"][:10]
                    if prior
                    else "2016-01-01",
                }
                case["memory"] = [
                    {
                        "date": item["created_at"][:10],
                        "sourceCaseId": item["instance_id"],
                        "repository": selection["repository"],
                        "text": item["problem_statement"],
                    }
                    for item in prior
                ]
            case_path = cases_dir / f"{case['id']}.json"
            case_path.write_text(json.dumps(case, indent=2) + "\n")
            cases.append(f"cases/{case_path.name}")
        prior.append(row)

    manifest = {
        "version": 1,
        "dataset": selection["dataset"],
        "datasetRevision": REVISION,
        "repository": selection["repository"],
        "selection": selection["selection"],
        "memoryPolicy": "Only earlier selected issue statements are carried forward. No hints_text, patch, test_patch, or reference-solution material is included in agent-visible memory.",
        "cases": cases,
    }
    (output / "suite.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"output": str(output), "targetIssues": len(ordered), "cases": len(cases), "modes": 3}, indent=2))


if __name__ == "__main__":
    main()

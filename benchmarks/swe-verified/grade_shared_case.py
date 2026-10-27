#!/usr/bin/env python3
"""Host-only adapter around the bundled SWE-bench parser and grading helpers."""

import json
import sys
from pathlib import Path

from swebench.harness.constants import TestStatus
from swebench.harness.grading import (
    get_eval_report,
    get_logs_eval,
    parse_test_exit_code,
)
from swebench.types import TestSpec


def main() -> int:
    input_path, report_path = map(Path, sys.argv[1:3])
    data = json.loads(input_path.read_text())
    test_spec = TestSpec(
        instance_id=data["caseId"],
        image=data["image"],
        eval_script_list=[],
        repo=data["repo"],
        version=data["version"],
        FAIL_TO_PASS=data["FAIL_TO_PASS"],
        PASS_TO_PASS=data["PASS_TO_PASS"],
        log_parser=data["logParser"],
        eval_type=data["evalType"],
    )
    prediction = {
        "instance_id": data["caseId"],
        "model_name_or_path": "shared-runtime-candidate",
        "model_patch": "provided",
    }
    report = get_eval_report(test_spec, prediction, data["testLogPath"], True)
    case_report = report[data["caseId"]]
    status_map, parser_valid = get_logs_eval(test_spec, data["testLogPath"])
    exit_code = parse_test_exit_code(Path(data["testLogPath"]).read_text())

    original_f2p = data["FAIL_TO_PASS"]
    original_p2p = data["PASS_TO_PASS"]
    expected_labels = original_f2p + original_p2p
    used_targets: dict[str, str] = {}
    normalized_names: dict[str, str] = {}
    aliases = []
    for label in expected_labels:
        target = label
        if target not in status_map and " (" in label and label.endswith(")"):
            method, qualification = label.split(" (", 1)
            qualification = qualification[:-1]
            suffix = "." + method
            if qualification.endswith(suffix) and qualification.rsplit(".", 1)[-1] == method:
                candidate = f"{method} ({qualification[:-len(suffix)]})"
                if candidate in status_map:
                    target = candidate
                    aliases.append({"original": label, "parsedName": target})
        previous = used_targets.get(target)
        if previous is not None and previous != label:
            raise ValueError(
                f"Expected-label normalization collision: {previous!r} and {label!r} map to one parsed test"
            )
        used_targets[target] = label
        normalized_names[label] = target

    def strict_results(labels: list[str]) -> dict[str, list[str]]:
        success, failure = [], []
        for label in labels:
            target = normalized_names[label]
            if parser_valid and status_map.get(target) == TestStatus.PASSED.value:
                success.append(label)
            else:
                failure.append(label)
        return {"success": success, "failure": failure}

    strict_f2p = strict_results(original_f2p)
    strict_p2p = strict_results(original_p2p)
    passed = (
        exit_code == 0
        and parser_valid
        and bool(case_report.get("patch_successfully_applied"))
        and not strict_f2p["failure"]
        and not strict_p2p["failure"]
    )
    result = {
        "caseId": data["caseId"],
        "passed": passed,
        "testCommandExitCode": exit_code,
        "officialGrading": case_report,
        "strictGrading": {
            "parserValid": parser_valid,
            "expectedLabels": {
                "FAIL_TO_PASS": original_f2p,
                "PASS_TO_PASS": original_p2p,
            },
            "normalization": "Strip only a redundant final .method suffix from the qualified class when it exactly equals the first test-name token and the resulting name exists in official parser output.",
            "normalizationAliases": aliases,
            "normalizedTestStatuses": {
                label: status_map.get(target)
                for label, target in normalized_names.items()
            },
            "FAIL_TO_PASS": strict_f2p,
            "PASS_TO_PASS": strict_p2p,
        },
        "requiredCounts": {
            "FAIL_TO_PASS": {
                "expected": len(original_f2p),
                "passed": len(strict_f2p["success"]),
            },
            "PASS_TO_PASS": {
                "expected": len(original_p2p),
                "passed": len(strict_p2p["success"]),
            },
        },
    }
    report_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

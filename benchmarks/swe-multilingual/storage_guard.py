"""Bound Docker and benchmark storage during the shared-runtime run."""
import http.client
import json
import pathlib
import shutil
import socket
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
RUN_DIR = ROOT / ".louibot/benchmarks/swe-multilingual-frontend-20261021"
MAX_DOCKER_BYTES = 5 * 1024**3
MAX_WORKSPACE_BYTES = 5 * 1024**3
MIN_WINDOWS_FREE_BYTES = 20 * 1024**3


class Docker(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(20)
        self.sock.connect("/var/run/docker.sock")


def usage():
    connection = Docker("localhost")
    connection.request("GET", "/system/df")
    response = connection.getresponse()
    data = json.loads(response.read())
    connection.close()
    if response.status != 200:
        raise RuntimeError("Docker storage statistics unavailable")
    image = data.get("LayersSize", 0)
    containers = sum(max(0, item.get("SizeRw", 0)) for item in data.get("Containers") or [])
    volumes = sum(
        max(0, (item.get("UsageData") or {}).get("Size", 0))
        for item in data.get("Volumes") or []
    )
    cache = sum(max(0, item.get("Size", 0)) for item in data.get("BuildCache") or [])
    workspace = 0
    for path in (RUN_DIR, ROOT / ".louibot/benchmarks/runs"):
        if not path.exists():
            continue
        result = subprocess.run(["du", "-sb", str(path)], text=True, capture_output=True)
        if result.returncode and any(
            "No such file or directory" not in line for line in result.stderr.splitlines()
        ):
            raise RuntimeError("Could not measure benchmark workspace: " + result.stderr)
        if result.stdout.strip():
            workspace += int(result.stdout.split()[0])
    return {
        "dockerBytes": image + containers + volumes + cache,
        "imageBytes": image,
        "containerBytes": containers,
        "volumeBytes": volumes,
        "buildCacheBytes": cache,
        "workspaceBytes": workspace,
        "windowsFreeBytes": shutil.disk_usage("/mnt/c").free,
    }


def check():
    current = usage()
    if current["dockerBytes"] > MAX_DOCKER_BYTES:
        raise RuntimeError("Docker storage limit reached: " + json.dumps(current))
    if current["workspaceBytes"] > MAX_WORKSPACE_BYTES:
        raise RuntimeError("Benchmark workspace limit reached: " + json.dumps(current))
    if current["windowsFreeBytes"] < MIN_WINDOWS_FREE_BYTES:
        raise RuntimeError("Windows free-space floor reached: " + json.dumps(current))
    return current


if __name__ == "__main__":
    try:
        print(json.dumps(check()))
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)

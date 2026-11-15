#!/usr/bin/env bash
# Remove DeepSWE subset artefacts after a run: agent/verifier containers, the four
# ~4 GB task images, the four verifier images, and the build cache.
# Safe to run repeatedly; it never touches images outside the DeepSWE labels.
set -u
cd "$(dirname "$0")/../.." || exit 1

echo "== containers"
docker ps -aq --filter "name=louibot-" | xargs -r docker rm -f >/dev/null 2>&1
docker ps -aq --filter "name=deepswe-" | xargs -r docker rm -f >/dev/null 2>&1

echo "== verifier images"
docker images --format '{{.Repository}}' | grep -E '^deepswe-verifier-' | sort -u |
  while read -r img; do docker image rm -f "$img" >/dev/null 2>&1 && echo "  removed $img"; done

echo "== task images"
while read -r task; do
  img=$(grep -oE 'docker_image = "[^"]+"' \
    ".louibot/benchmarks/deepswe-subset-20261115/tasks/$task/task.toml" 2>/dev/null |
    cut -d'"' -f2)
  [ -n "${img:-}" ] && docker image rm -f "$img" >/dev/null 2>&1 && echo "  removed $img"
done < <(ls .louibot/benchmarks/deepswe-subset-20261115/tasks 2>/dev/null)

echo "== build cache"
docker builder prune -af >/dev/null 2>&1

echo "== remaining"
docker ps -aq | wc -l | sed 's/^/  containers: /'
docker system df | sed -n '1,4p'
df -h / | tail -1

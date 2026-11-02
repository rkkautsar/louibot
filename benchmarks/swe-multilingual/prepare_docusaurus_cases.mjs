#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const runDir = join(
  root,
  ".louibot/benchmarks/swe-multilingual-frontend-20261021",
);
const privateDir = join(runDir, "private");
const selection = JSON.parse(
  await readFile(join(here, "docusaurus-4-selection.json"), "utf8"),
);
const datasetFile = join(privateDir, "dataset.json");
const rows = JSON.parse(await readFile(datasetFile, "utf8"));
const source = join(runDir, "source");
const cacheVolume = `louibot-build-cache-${createHash("sha256")
  .update("facebook/docusaurus")
  .digest("hex")
  .slice(0, 24)}`;
const image =
  "node@sha256:ac3f66d9f35a704ec33831a1e90d90eb3eb20506cf24750837b442612728e51a";
const nodeVersion = "18.17.1";
const scripts = new Map();
for (const row of rows) scripts.set(row.instance_id, row);

const setupCommands = [
  "printf 'export COREPACK_HOME=/cache/corepack\\nexport YARN_CACHE_FOLDER=/cache/yarn\\nexport CI=1\\nexport PATH=/cache/corepack-bin:/cache/ripgrep:$PATH\\n' > /tmp/.profile",
  "mkdir -p /cache/corepack-bin && corepack enable --install-directory /cache/corepack-bin && export PATH=/cache/corepack-bin:$PATH COREPACK_HOME=/cache/corepack YARN_CACHE_FOLDER=/cache/yarn CI=1 && corepack prepare yarn@1.22.22 --activate && yarn install --frozen-lockfile --non-interactive --network-timeout 600000 && yarn build:packages --concurrency 1 && node --version && yarn --version",
  `python3 -c 'import hashlib,io,pathlib,tarfile,urllib.request
root=pathlib.Path("/cache/ripgrep")
target=root/"rg"
if not target.is_file():
 url="https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz"
 data=urllib.request.urlopen(url,timeout=60).read()
 digest=urllib.request.urlopen(url+".sha256",timeout=60).read().decode().split()[0]
 if hashlib.sha256(data).hexdigest()!=digest: raise SystemExit("ripgrep checksum mismatch")
 archive=tarfile.open(fileobj=io.BytesIO(data),mode="r:gz")
 member=next(m for m in archive.getmembers() if m.name.endswith("/rg") and m.isfile())
 root.mkdir(parents=True,exist_ok=True)
 target.write_bytes(archive.extractfile(member).read())
 target.chmod(0o755)
' && rg --version | head -1`,
];

const casesDir = join(runDir, "cases");
const configsDir = join(runDir, "configs");
await Promise.all([
  mkdir(casesDir, { recursive: true }),
  mkdir(configsDir, { recursive: true }),
]);
const casePaths = [];
const missing = [];
for (const selected of selection.instances) {
  const row = scripts.get(selected.id);
  if (!row) throw new Error(`Private dataset row missing: ${selected.id}`);
  const testCommands = [
    ...row.eval_script.matchAll(
      /^\s*\(\s*(yarn\s+test\s+.+?)\s*\)\s*\|\s*cat\s*$/gm,
    ),
  ].map((match) => match[1].trim());
  if (!testCommands.length)
    throw new Error(`Could not locate official test command: ${selected.id}`);
  if (row.base_commit !== selected.baseCommit)
    throw new Error(`Base commit mismatch: ${selected.id}`);
  const id = `docusaurus-${selected.version}`;
  const caseFile = join(casesDir, `${id}-stateless.json`);
  const evaluator = join(here, "evaluate_docusaurus_shared_case.mjs");
  const prompt = [
    "Benchmark protocol: Work from this pinned checkout. Network access is available for dependencies and general documentation. Do not retrieve upstream fixes, reference patches, or issue/PR discussions for this task.",
    row.problem_statement.trim(),
  ].join("\n\n");
  const testcase = {
    id,
    taskId: selected.id,
    instanceId: selected.id,
    repositoryPath: source,
    repository: "facebook/docusaurus",
    baseCommit: selected.baseCommit,
    prompt,
    mode: "stateless",
    evaluator: {
      prepareCommand: `node '${evaluator}' --prepare`,
      waitCommand: `node '${evaluator}' --wait`,
      cleanupCommand: `node '${evaluator}' --cleanup`,
      commands: [`node '${evaluator}'`],
    },
  };
  await writeFile(caseFile, `${JSON.stringify(testcase, null, 2)}\n`);
  casePaths.push(caseFile);
  const config = {
    repository: "facebook/docusaurus",
    model: "openai-compatible/openai/gpt-6-luna",
    endpoint: {
      baseUrl:
        "https://api.cloudflare.com/client/v4/accounts/3d2c7278332e1314ee55afa8743dd6bc/ai/v1",
      apiKeyEnv: "LOUIBOT_BENCHMARK_CF_TOKEN",
      tokenLimitParameter: "max_completion_tokens",
      reasoningEffort: "none",
    },
    agent: {
      maxSteps: 60,
      maxCostUsd: 1,
      inputUsdPerMillion: 0.2,
      outputUsdPerMillion: 0.75,
      contextWindowTokens: 200000,
      maxInputTokens: 160000,
      maxOutputTokens: 8192,
      clarificationEnabled: false,
      modelMaxRetries: 2,
      modelRequestTimeoutSeconds: 180,
    },
    sandbox: {
      image,
      commandTimeoutSeconds: 900,
      network: "bridge",
      setupCommands,
    },
    reviewer: { enabled: false },
    validation: { commands: testCommands, required: true },
  };
  await writeFile(
    join(configsDir, `${selected.id}.json`),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  if (selected.failToPassCount < 1 || selected.passToPassCount < 1)
    missing.push(selected.id);
}
const suite = {
  dataset: selection.dataset,
  datasetRevision: selection.datasetRevision,
  mode: "stateless",
  evaluationKind: "shared-runtime-task-tests",
  cases: casePaths,
};
await writeFile(
  join(runDir, "suite.json"),
  `${JSON.stringify(suite, null, 2)}\n`,
);
await writeFile(
  join(runDir, "runtime.json"),
  `${JSON.stringify({ image, nodeVersion, cacheVolume, setupCommands, commandTimeoutSeconds: 900 }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      suite: join(runDir, "suite.json"),
      cases: casePaths.length,
      cacheVolume,
      warnings: missing,
    },
    null,
    2,
  ),
);

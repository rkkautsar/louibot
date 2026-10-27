// Optional integration check: build first; requires local Docker, no paid provider.
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const state = path.join(projectRoot, ".louibot", "benchmarks");
await mkdir(state, { recursive: true });
const root = await mkdtemp(path.join(state, "adapter-smoke-"));
const repo = path.join(root, "repo");
await mkdir(repo, { recursive: true });
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.com",
  "commit",
  "--allow-empty",
  "-qm",
  "base",
]);
await writeFile(
  path.join(root, "task.txt"),
  "Add a feature without enough requirements. Ask which storage backend is intended.",
);
const requests = [];
const setupMarker = ".benchmark-smoke-setup-ready";
let firstRequestSawSetup = false;
const server = http.createServer(async (req, res) => {
  let data = "";
  for await (const chunk of req) data += chunk;
  const body = JSON.parse(data);
  requests.push(body);
  if (requests.length === 1)
    firstRequestSawSetup = existsSync(
      path.join(`${repo}.sandbox`, setupMarker),
    );
  const first = requests.length === 1;
  const fn = first
    ? "shell"
    : body.tools?.find((t) => t.function.name !== "shell")?.function.name;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "fixture-" + requests.length,
      object: "chat.completion",
      created: 0,
      model: "fixture",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "result-1",
                type: "function",
                function: {
                  name: fn,
                  arguments: JSON.stringify(
                    first
                      ? { command: "pwd" }
                      : {
                          status: "clarify",
                          summary: "Need backend choice",
                          tests: "No implementation",
                          questions: ["Which storage backend should be used?"],
                        },
                  ),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const config = {
  repository: "fixture/repo",
  model: "openai-compatible/fixture",
  endpoint: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKeyEnv: "SMOKE_API_KEY",
  },
  agent: {
    maxSteps: 5,
    maxOutputTokens: 6000,
    maxInputTokens: 12000,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  },
  sandbox: {
    image: process.env.LOUIBOT_SMOKE_IMAGE ?? "node:22",
    network: "none",
    setupCommands: [`touch ${setupMarker}`],
  },
  validation: { commands: [] },
};
const configFile = path.join(root, "config.json");
await writeFile(configFile, JSON.stringify(config));
async function run(label, tokenBudget) {
  requests.length = 0;
  firstRequestSawSetup = false;
  await rm(path.join(repo, setupMarker), { force: true });
  await rm(path.join(`${repo}.sandbox`, setupMarker), {
    force: true,
  });
  const resultFile = path.join(root, `${label}.json`);
  const env = {
    ...process.env,
    SMOKE_API_KEY: "local-fixture-only",
    BENCHMARK_PROMPT_FILE: path.join(root, "task.txt"),
    BENCHMARK_RESULT_FILE: resultFile,
    BENCHMARK_TIME_BUDGET_SECONDS: "45",
  };
  if (tokenBudget !== undefined)
    env.BENCHMARK_TOKEN_BUDGET = String(tokenBudget);
  else delete env.BENCHMARK_TOKEN_BUDGET;
  const child = spawn(
    process.execPath,
    [
      path.join(projectRoot, "dist", "benchmark-agent.js"),
      "--config",
      configFile,
    ],
    { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const exit = await new Promise((r) => child.on("exit", r));
  const result = JSON.parse(await readFile(resultFile, "utf8"));
  const sentRequests = [...requests];
  console.log(
    JSON.stringify({
      label,
      exit,
      result,
      requests: sentRequests,
      stderr: stderr.slice(-1000),
    }),
  );
  return { exit, result, sentRequests, firstRequestSawSetup };
}

const explicit = await run("explicit", 20000);
const configured = await run("configured");
server.close();
await rm(root, { recursive: true, force: true });
const validResult = ({ result, sentRequests }) =>
  result.action === "clarify" &&
  result.inputTokens === 200 &&
  result.outputTokens === 100 &&
  result.toolCalls === 2 &&
  sentRequests.length === 2;
if (
  explicit.exit !== 0 ||
  !validResult(explicit) ||
  !explicit.firstRequestSawSetup ||
  explicit.sentRequests.some((body) => body.max_tokens !== 4000) ||
  !explicit.result.budgetPolicy?.includes("one fifth") ||
  configured.exit !== 0 ||
  !validResult(configured) ||
  !configured.firstRequestSawSetup ||
  configured.sentRequests.some((body) => body.max_tokens !== 6000) ||
  configured.result.costUsd !== 0.0004 ||
  configured.result.budgetPolicy?.includes("aggregate token cap") !== true ||
  configured.result.budgetPolicy?.includes("configured Louibot context") !==
    true
)
  process.exitCode = 1;

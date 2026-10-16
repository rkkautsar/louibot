// Host-only connectivity check. Credentials stay in memory and are never printed.
import { execFileSync } from "node:child_process";
import { createModel } from "../dist/model.js";
const account = process.argv[2];
if (!/^[a-f0-9]{32}$/.test(account ?? ""))
  throw new Error(
    "Usage: node scripts/check-cloudflare.mjs <Cloudflare account ID>",
  );
let token;
try {
  const auth = JSON.parse(
    execFileSync("npx", ["--yes", "wrangler", "auth", "token", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  token = auth.token;
  if (typeof token !== "string" || !token)
    throw new Error("No Wrangler token returned");
  process.env.LOUIBOT_CLOUDFLARE_TOKEN = token;
  const model = createModel({
    model: "openai-compatible/openai/gpt-6-luna",
    endpoint: {
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
      apiKeyEnv: "LOUIBOT_CLOUDFLARE_TOKEN",
      reasoningEffort: "none",
    },
    agent: { maxOutputTokens: 1024 },
  });
  const response = await model
    .bindTools(
      [
        {
          type: "function",
          function: {
            name: "shell",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
              additionalProperties: false,
            },
          },
        },
      ],
      { tool_choice: { type: "function", function: { name: "shell" } } },
    )
    .invoke(
      "Call shell with the command printf louibot-ready. Do not execute anything; this is a transport test.",
      { signal: AbortSignal.timeout(60000) },
    );
  const call = response.tool_calls?.[0];
  if (call?.name !== "shell" || typeof call.args.command !== "string")
    throw new Error("Model response did not contain a shell tool call");
  console.log(
    JSON.stringify({
      ok: true,
      model: "openai/gpt-6-luna",
      tool: call.name,
      command: call.args.command,
      usage: response.usage_metadata,
    }),
  );
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  if (token) message = message.split(token).join("[REDACTED]");
  console.error(message.slice(0, 2000));
  process.exitCode = 1;
} finally {
  delete process.env.LOUIBOT_CLOUDFLARE_TOKEN;
}

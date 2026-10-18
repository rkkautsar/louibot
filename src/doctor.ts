import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { config, type Config } from "./config.js";
import { redactErrorText } from "./errors.js";
import { createModel } from "./model.js";
import {
  discoverSandboxImage,
  discoverValidationCommands,
} from "./discovery.js";
import { git, Sandbox } from "./workspace.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
// Keep the connectivity probe small, but leave enough room for providers that
// count reasoning tokens against the requested completion budget.
const MODEL_PROBE_MAX_TOKENS = 256;

type Check = {
  label: string;
  required?: boolean;
  run: () => Promise<string>;
};

export function cleanError(error: unknown): string {
  return redactErrorText(error);
}

async function command(
  executable: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    env: process.env,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function modelKeyEnv(repositoryConfig: Config): string {
  return (
    repositoryConfig.endpoint?.apiKeyEnv ??
    (repositoryConfig.model.startsWith("anthropic/")
      ? "ANTHROPIC_API_KEY"
      : "OPENAI_API_KEY")
  );
}

export function modelCredentialSource(repositoryConfig: Config): string {
  return `host environment variable ${modelKeyEnv(repositoryConfig)} (value hidden)`;
}

export async function probeModelAccess(
  repositoryConfig: Config,
  invoke?: () => Promise<unknown>,
): Promise<string> {
  const envName = modelKeyEnv(repositoryConfig);
  if (!process.env[envName]) throw new Error(`${envName} is not set`);
  try {
    // Use the same host-side credential and route, and require a tool call
    // because issue implementation depends on provider tool-call support.
    const response = await (
      invoke ??
      (() =>
        createModel(
          repositoryConfig,
          repositoryConfig.model,
          MODEL_PROBE_MAX_TOKENS,
        )
          .bindTools([
            {
              name: "louibot_doctor_probe",
              description: "Return the requested marker as a tool argument.",
              schema: z.object({ marker: z.string() }),
            },
          ])
          .invoke(
            "Call louibot_doctor_probe exactly once with marker LOUIBOT_DOCTOR_OK.",
            { signal: AbortSignal.timeout(20_000) },
          ))
    )();
    if (!invoke) {
      if (!response || typeof response !== "object")
        throw new Error("provider returned no tool call");
      const toolCalls = (response as { tool_calls?: unknown }).tool_calls;
      const validToolCall =
        Array.isArray(toolCalls) &&
        toolCalls.some((call) => {
          if (!call || typeof call !== "object") return false;
          const candidate = call as {
            name?: unknown;
            args?: { marker?: unknown };
          };
          return (
            candidate.name === "louibot_doctor_probe" &&
            candidate.args?.marker === "LOUIBOT_DOCTOR_OK"
          );
        });
      if (!validToolCall)
        throw new Error("provider returned no expected tool call");
    }
  } catch (error) {
    throw new Error(
      `Request failed using ${envName}; check the selected key, endpoint, model access, and provider permissions (${cleanError(error)})`,
      { cause: error },
    );
  }
  return `request succeeded using ${envName} (value hidden)`;
}

async function probeSandbox(
  image: string,
  repository: string,
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "louibot-doctor-"));
  const sandbox = new Sandbox(
    image,
    root,
    10,
    () => {},
    "none",
    repository,
    true,
  );
  try {
    await sandbox.start();
    const output = await sandbox.shell("printf 'LOUIBOT_SANDBOX_OK'");
    if (output.trim() !== "LOUIBOT_SANDBOX_OK")
      throw new Error("sandbox command returned an unexpected result");
    return "isolated container started and ran a harmless command";
  } finally {
    await sandbox.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function checks(
  root: string,
  stateDirectory: string,
  repositoryConfig: Config,
  image: string,
  imageSource: string,
  validationCommands: string[],
): Check[] {
  return [
    {
      label: "Git repository",
      required: true,
      run: async () => {
        const top = resolve(await git(root, ["rev-parse", "--show-toplevel"]));
        if (top !== resolve(root))
          throw new Error(`run from repository root ${top}`);
        return top;
      },
    },
    {
      label: "GitHub origin",
      required: true,
      run: async () => {
        const remote = await git(root, ["remote", "get-url", "origin"]);
        const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
        if (!match) throw new Error("origin is not a GitHub repository");
        if (match[1] !== repositoryConfig.repository)
          throw new Error(
            `origin is ${match[1]}, configured repository is ${repositoryConfig.repository}`,
          );
        return "GitHub remote found";
      },
    },
    {
      label: "GitHub authentication",
      required: true,
      run: async () => {
        await command("gh", ["auth", "status", "--hostname", "github.com"]);
        return "gh authentication is active";
      },
    },
    {
      label: "GitHub repository access",
      required: true,
      run: async () => {
        await command("gh", ["api", `repos/${repositoryConfig.repository}`]);
        return repositoryConfig.repository;
      },
    },
    {
      label: "Docker daemon",
      required: true,
      run: async () => {
        const output = await command("docker", [
          "version",
          "--format",
          "{{.Server.Version}}",
        ]);
        return `server ${output}`;
      },
    },
    {
      label: "Sandbox image",
      required: true,
      run: async () => {
        try {
          await command("docker", ["image", "inspect", image]);
        } catch {
          throw new Error(`${image} is not present; run docker pull ${image}`);
        }
        return `${image} (${imageSource})`;
      },
    },
    {
      label: "Sandbox execution",
      required: true,
      run: () => probeSandbox(image, repositoryConfig.repository),
    },
    {
      label: "Model API key",
      required: true,
      run: async () => {
        const envName = modelKeyEnv(repositoryConfig);
        if (!process.env[envName]) throw new Error(`${envName} is not set`);
        return `using ${modelCredentialSource(repositoryConfig)}`;
      },
    },
    {
      label: "Model tool calling",
      required: true,
      run: async () => probeModelAccess(repositoryConfig),
    },
    {
      label: "Louibot state directory",
      required: true,
      run: async () => {
        await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
        await access(stateDirectory, constants.W_OK);
        return stateDirectory;
      },
    },
    {
      label: "Validation discovery",
      required:
        validationCommands.length > 0 || !repositoryConfig.validation.required,
      run: async () =>
        validationCommands.length
          ? validationCommands.join(", ")
          : repositoryConfig.validation.required
            ? "required, but no controller validation command was configured or discovered"
            : "no controller validation command discovered (allowed)",
    },
    {
      label: "Sandbox network",
      run: async () => repositoryConfig.sandbox.network,
    },
  ];
}

export async function runDoctor(
  root: string,
  stateDirectory: string,
  resolvedConfig?: Config,
): Promise<boolean> {
  let repositoryConfig: Config;
  try {
    repositoryConfig = resolvedConfig ?? config(root);
  } catch (error) {
    console.log(`✗ Configuration: ${cleanError(error)}`);
    return false;
  }
  const discovery = await discoverSandboxImage(
    root,
    repositoryConfig.sandbox.image,
  );
  const validationCommands =
    repositoryConfig.validation.commands.length > 0
      ? repositoryConfig.validation.commands
      : await discoverValidationCommands(root);
  let healthy = true;
  for (const check of checks(
    root,
    stateDirectory,
    repositoryConfig,
    discovery.image,
    discovery.source,
    validationCommands,
  )) {
    try {
      const detail = await check.run();
      console.log(`✓ ${check.label}: ${detail}`);
    } catch (error) {
      const prefix = check.required ? "✗" : "!";
      console.log(`${prefix} ${check.label}: ${cleanError(error)}`);
      if (check.required) healthy = false;
    }
  }
  return healthy;
}

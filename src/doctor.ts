import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { config, type Config } from "./config.js";
import { createModel } from "./model.js";
import {
  discoverSandboxImage,
  discoverValidationCommands,
} from "./discovery.js";
import { git } from "./workspace.js";

const execFileAsync = promisify(execFile);

type Check = {
  label: string;
  required?: boolean;
  run: () => Promise<string>;
};

export function cleanError(error: unknown): string {
  let message = String(error).replace(/https?:\/\/[^\s]+/g, "<url>");
  const secretValues = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && Boolean(value),
    )
    .map(([, value]) => value!);
  for (const secret of secretValues)
    message = message.split(secret).join("[REDACTED]");
  return message
    .replace(
      /((?:api[_-]?key|token|password|secret|key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      "[REDACTED]",
    );
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
  invoke: () => Promise<unknown> = () =>
    createModel(repositoryConfig, repositoryConfig.model, 1).invoke(
      "Reply with OK.",
      { signal: AbortSignal.timeout(20_000) },
    ),
): Promise<string> {
  const envName = modelKeyEnv(repositoryConfig);
  if (!process.env[envName]) throw new Error(`${envName} is not set`);
  try {
    // A one-token request exercises the same host-side credential and route as the agent.
    await invoke();
  } catch (error) {
    throw new Error(
      `Request failed using ${envName}; check the selected key, endpoint, model access, and provider permissions (${cleanError(error)})`,
      { cause: error },
    );
  }
  return `request succeeded using ${envName} (value hidden)`;
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
      label: "Model API key",
      required: true,
      run: async () => {
        const envName = modelKeyEnv(repositoryConfig);
        if (!process.env[envName]) throw new Error(`${envName} is not set`);
        return `using ${modelCredentialSource(repositoryConfig)}`;
      },
    },
    {
      label: "Model API access",
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
      run: async () =>
        validationCommands.length
          ? validationCommands.join(", ")
          : "no repository validation command discovered",
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

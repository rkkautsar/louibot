import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { config, type Config } from "./config.js";
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

function cleanError(error: unknown): string {
  return String(error)
    .replace(/https?:\/\/[^\s]+/g, "<url>")
    .replace(/(?:token|password|secret|key)=([^\s]+)/gi, "$1=<redacted>");
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
        if (!remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/))
          throw new Error("origin is not a GitHub repository");
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
        return `${envName} is set`;
      },
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
): Promise<boolean> {
  let repositoryConfig: Config;
  try {
    repositoryConfig = config(root);
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

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_IMAGE = "node:22";
async function present(root: string, name: string): Promise<boolean> {
  try {
    await access(join(root, name));
    return true;
  } catch {
    return false;
  }
}

async function devcontainerImage(root: string): Promise<string | undefined> {
  const candidates = [
    join(root, ".devcontainer", "devcontainer.json"),
    join(root, ".devcontainer.json"),
  ];
  for (const path of candidates) {
    try {
      // Recognize a direct quoted image field without executing or evaluating
      // the devcontainer configuration. Full JSONC features are intentionally
      // outside this small discovery heuristic.
      const text = await readFile(path, "utf8");
      const image = text.match(/\"image\"\s*:\s*\"([^\"]+)\"/)?.[1];
      if (image) return image;
    } catch {
      // Try the next supported devcontainer location.
    }
  }
  return undefined;
}

export type SandboxDiscovery = {
  image: string;
  source: string;
};

export async function discoverSandboxImage(
  root: string,
  configured: string,
): Promise<SandboxDiscovery> {
  if (configured !== "auto")
    return { image: configured, source: "configuration" };

  const image = await devcontainerImage(root);
  if (image) return { image, source: "devcontainer.json" };

  if (
    (await present(root, "package.json")) ||
    (await present(root, "package-lock.json")) ||
    (await present(root, "pnpm-lock.yaml")) ||
    (await present(root, "yarn.lock")) ||
    (await present(root, "bun.lockb")) ||
    (await present(root, "bun.lock"))
  )
    return { image: "node:22", source: "Node project files" };
  if (
    (await present(root, "pyproject.toml")) ||
    (await present(root, "requirements.txt")) ||
    (await present(root, "setup.py"))
  )
    return { image: "python:3.13", source: "Python project files" };
  if (await present(root, "go.mod"))
    return { image: "golang:1.25", source: "go.mod" };
  if (await present(root, "Cargo.toml"))
    return { image: "rust:1.88", source: "Cargo.toml" };
  if ((await present(root, "pom.xml")) || (await present(root, "mvnw")))
    return {
      image: "maven:3.9-eclipse-temurin-21",
      source: "Maven project files",
    };
  if (
    (await present(root, "build.gradle")) ||
    (await present(root, "build.gradle.kts")) ||
    (await present(root, "gradlew"))
  )
    return {
      image: "gradle:8-jdk21",
      source: "Gradle project files",
    };
  if (
    (await present(root, "global.json")) ||
    (await present(root, "Directory.Build.props"))
  )
    return {
      image: "mcr.microsoft.com/dotnet/sdk:9.0",
      source: ".NET project files",
    };
  return { image: DEFAULT_IMAGE, source: "default" };
}

export function serialValidationCommand(command: string): string {
  if (
    /(?:--runInBand|--maxWorkers|--max-workers|--no-file-parallelism)(?:\s|=|$)/.test(
      command,
    )
  )
    return command;
  if (/\bvitest\b/.test(command)) return `${command} --maxWorkers=1`;
  if (
    /^(?:npm|yarn|pnpm|bun)(?: run)? test\b/.test(command.trim()) ||
    /\bjest\b/.test(command)
  )
    return `${command} --runInBand`;
  return command;
}

const infrastructureFailurePatterns = [
  /GlobalPoolAlreadyInitialized/,
  /global thread pool has not been initialized/i,
  /Sandbox is not running/,
  /Cannot connect to the Docker daemon/i,
  /No such container/i,
  /container .* is not running/i,
  /JavaScript heap out of memory/i,
  /\bexit (?:code|status) 137\b/i,
  /\bstatus 137\b/i,
  /OOMKilled/,
  /docker: Error response from daemon/i,
];

export function infrastructureValidationFailure(output: string): boolean {
  return infrastructureFailurePatterns.some((pattern) => pattern.test(output));
}

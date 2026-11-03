import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_IMAGE = "node:22";
const ignoredWorkspaceDirs: Record<string, true> = {
  ".git": true,
  ".louibot": true,
  build: true,
  dist: true,
  node_modules: true,
};

type PackageManifest = {
  scripts?: Record<string, unknown>;
  workspaces?: string[] | { packages?: string[] };
};

async function present(root: string, name: string): Promise<boolean> {
  try {
    await access(join(root, name));
    return true;
  } catch {
    return false;
  }
}

async function readJson(root: string, name: string): Promise<PackageManifest> {
  try {
    return JSON.parse(
      await readFile(join(root, name), "utf8"),
    ) as PackageManifest;
  } catch {
    return {};
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

async function packageManagerFor(
  root: string,
): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  if (await present(root, "pnpm-lock.yaml")) return "pnpm";
  if (await present(root, "yarn.lock")) return "yarn";
  if ((await present(root, "bun.lockb")) || (await present(root, "bun.lock")))
    return "bun";
  return "npm";
}

export async function discoverValidationCommands(
  root: string,
): Promise<string[]> {
  const commands: string[] = [];
  if (await present(root, "package.json")) {
    const manifest = await readJson(root, "package.json");
    const scripts = manifest.scripts ?? {};
    const manager = await packageManagerFor(root);
    const run = manager === "npm" ? "npm run" : `${manager} run`;
    if (typeof scripts.test === "string")
      commands.push(manager === "npm" ? "npm test" : `${manager} test`);
    if (typeof scripts.build === "string") commands.push(`${run} build`);
  }
  const pyproject = await present(root, "pyproject.toml");
  let pyprojectUsesPytest = false;
  if (pyproject) {
    try {
      pyprojectUsesPytest = /pytest/i.test(
        await readFile(join(root, "pyproject.toml"), "utf8"),
      );
    } catch {
      pyprojectUsesPytest = false;
    }
  }
  if (
    (await present(root, "pytest.ini")) ||
    (await present(root, "tox.ini")) ||
    pyprojectUsesPytest
  )
    commands.push("python -m pytest");
  if (await present(root, "go.mod")) commands.push("go test ./...");
  if (await present(root, "Cargo.toml")) commands.push("cargo test");
  if (await present(root, "mvnw")) commands.push("./mvnw test");
  else if (await present(root, "pom.xml")) commands.push("mvn test");
  if (await present(root, "gradlew")) commands.push("./gradlew test");
  else if (
    (await present(root, "build.gradle")) ||
    (await present(root, "build.gradle.kts"))
  )
    commands.push("gradle test");
  if (
    (await present(root, "global.json")) ||
    (await present(root, "Directory.Build.props"))
  )
    commands.push("dotnet test");
  return [...new Set(commands)];
}

export function selectValidationCommands(args: {
  configured: string[];
  discovered: string[];
  planned: string[];
}): string[] {
  const base = args.configured.length
    ? args.configured
    : args.planned.length
      ? []
      : args.discovered;
  return [...new Set([...base, ...args.planned])];
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function expandWorkspacePattern(
  root: string,
  pattern: string,
): Promise<string[]> {
  const parts = pattern.replace(/^\.\//, "").split(/[\\/]/).filter(Boolean);
  const walk = async (base: string, index: number): Promise<string[]> => {
    if (index >= parts.length) return [base];
    const part = parts[index]!;
    if (part === "**") {
      const entries = await readdir(base, { withFileTypes: true }).catch(
        () => [],
      );
      const result = [...(await walk(base, index + 1))];
      for (const entry of entries) {
        if (!entry.isDirectory() || ignoredWorkspaceDirs[entry.name]) continue;
        result.push(...(await walk(join(base, entry.name), index)));
      }
      return result;
    }
    const candidates: string[] = [];
    if (part.includes("*")) {
      const matcher = new RegExp(
        `^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
      );
      for (const entry of await readdir(base, { withFileTypes: true }).catch(
        () => [],
      ))
        if (entry.isDirectory() && matcher.test(entry.name))
          candidates.push(join(base, entry.name));
    } else candidates.push(join(base, part));
    const result: string[] = [];
    for (const candidate of candidates) {
      if (!(await directoryExists(candidate))) continue;
      result.push(...(await walk(candidate, index + 1)));
    }
    return result;
  };
  return walk(root, 0);
}

async function workspacePackageRoots(root: string): Promise<string[]> {
  const manifest = await readJson(root, "package.json");
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : Array.isArray(manifest.workspaces?.packages)
      ? manifest.workspaces.packages
      : [];
  const roots: string[] = [];
  for (const pattern of patterns) {
    for (const candidate of await expandWorkspacePattern(root, pattern)) {
      const relative = candidate.slice(root.length + 1).replaceAll("\\", "/");
      if (!relative) continue;
      if (await present(candidate, "package.json")) roots.push(relative);
    }
  }
  return [...new Set(roots)].sort();
}

function diffPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(
    (match) => match[2]!,
  );
}

export async function changedWorkspacePackageRoots(
  root: string,
  diff: string,
): Promise<string[]> {
  const changed = diffPaths(diff);
  if (!changed.length) return [];
  return (await workspacePackageRoots(root)).filter((workspace) =>
    changed.some((path) => path.startsWith(`${workspace}/`)),
  );
}

export async function scopeValidationCommands(args: {
  root: string;
  diff: string;
  commands: string[];
}): Promise<string[]> {
  const roots = await changedWorkspacePackageRoots(args.root, args.diff);
  if (!roots.length) return args.commands;
  return args.commands.map((command) =>
    /^(?:npm|yarn|pnpm|bun)(?: run)? test$/.test(command.trim())
      ? `${command} ${roots.join(" ")}`
      : command,
  );
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

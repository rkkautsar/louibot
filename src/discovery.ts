import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_IMAGE = "node:22";

type PackageManifest = {
  scripts?: Record<string, unknown>;
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

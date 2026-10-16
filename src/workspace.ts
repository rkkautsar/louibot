import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  rm,
  unlink,
  chmod,
  rmdir,
  readlink,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;
const HOST_COMMAND_TIMEOUT = 120_000;

export type SandboxNetwork = "bridge" | "none";

export function cacheVolumeName(cacheKey: string): string {
  return `louibot-build-cache-${createHash("sha256")
    .update(cacheKey)
    .digest("hex")
    .slice(0, 24)}`;
}

export async function git(
  root: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: MAX_OUTPUT,
    timeout: HOST_COMMAND_TIMEOUT,
    env: {
      ...process.env,
      ...environment,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

export async function prepare(
  root: string,
  worktree: string,
  branch: string,
): Promise<void> {
  const destination = resolve(worktree);
  await mkdir(join(root, ".louibot", "workspaces"), { recursive: true });
  try {
    await lstat(destination);
    const registered = await git(root, ["worktree", "list", "--porcelain"]);
    if (
      registered.split("\n").some((line) => line === `worktree ${destination}`)
    )
      return;
    throw new Error(
      `Workspace path already exists and is not a registered worktree: ${destination}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const branches = await git(root, ["branch", "--list", branch]);
  if (branches) await git(root, ["worktree", "add", destination, branch]);
  else await git(root, ["worktree", "add", "-b", branch, destination, "HEAD"]);
}

function secretPath(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  return (
    /^\.env(?:\.|$)/i.test(name) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(name) ||
    /(?:^|\/)(?:\.aws|\.ssh|\.gnupg)(?:\/|$)/i.test(path)
  );
}

function safeLinkTarget(
  sourceRoot: string,
  rel: string,
  target: string,
): boolean {
  if (isAbsolute(target)) return false;
  const resolvedRoot = resolve(sourceRoot);
  const resolvedTarget = resolve(dirname(join(resolvedRoot, rel)), target);
  const targetRel = relative(resolvedRoot, resolvedTarget);
  if (
    targetRel === ".." ||
    targetRel.startsWith(`..${sep}`) ||
    isAbsolute(targetRel)
  )
    return false;
  const segments = targetRel.split(sep);
  if (segments.some((segment) => segment === ".git" || segment === ".louibot"))
    return false;
  return !secretPath(targetRel.split(sep).join("/"));
}

async function copyTree(
  source: string,
  destination: string,
  sourceRoot = source,
  prefix = "",
  writable = false,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === ".git" || entry.name === ".louibot" || secretPath(rel))
      continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) {
      const target = await readlink(from);
      if (safeLinkTarget(sourceRoot, rel, target)) await symlink(target, to);
    } else if (info.isDirectory()) {
      await mkdir(to, {
        recursive: true,
        mode: writable ? 0o777 : info.mode & 0o777,
      });
      if (writable) await chmod(to, 0o777);
      await copyTree(from, to, sourceRoot, rel, writable);
    } else if (info.isFile()) {
      await cp(from, to, { force: true, preserveTimestamps: true });
      await chmod(
        to,
        writable ? (info.mode & 0o777) | 0o222 : info.mode & 0o777,
      );
    }
  }
}

export async function copyWorkspaceToStage(
  source: string,
  destination: string,
): Promise<void> {
  await copyTree(source, destination, source);
}

async function removeEligible(path: string, prefix = ""): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === ".git" || entry.name === ".louibot" || secretPath(rel))
      continue;
    const full = join(path, entry.name);
    const info = await lstat(full);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await removeEligible(full, rel);
      try {
        await rmdir(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      }
    } else await unlink(full);
  }
}

export async function syncWorkspaceFromStage(
  stage: string,
  worktree: string,
): Promise<void> {
  await removeEligible(worktree);
  await copyWorkspaceToStage(stage, worktree);
}

export class Sandbox {
  private readonly id: string;
  private stage?: string;
  private started = false;
  private finished = false;
  private disposed = false;

  constructor(
    private readonly image: string,
    private readonly worktree: string,
    private readonly timeoutSeconds: number,
    private readonly log: (message: string) => void = () => {},
    private readonly network: SandboxNetwork = "bridge",
    cacheKey = worktree,
  ) {
    this.id = `louibot-${createHash("sha256").update(resolve(worktree)).digest("hex").slice(0, 20)}`;
    this.cacheVolume = cacheVolumeName(cacheKey);
  }

  private readonly cacheVolume: string;

  async start(): Promise<void> {
    if (this.started) return;
    this.stage = `${resolve(this.worktree)}.sandbox`;
    try {
      let stageExists = true;
      try {
        const stageInfo = await lstat(this.stage);
        if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink())
          throw new Error(`Unsafe sandbox staging path: ${this.stage}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        stageExists = false;
      }
      if (!stageExists) {
        await mkdir(this.stage, { mode: 0o777 });
        await chmod(this.stage, 0o777);
        await copyTree(this.worktree, this.stage, this.worktree, "", true);
      }
      const hostUid =
        typeof process.getuid === "function" ? process.getuid() : 1000;
      const hostGid =
        typeof process.getgid === "function" ? process.getgid() : 1000;
      const uid = hostUid === 0 ? 65534 : hostUid;
      const gid = hostUid === 0 ? 65534 : hostGid;
      await this.docker(["rm", "-f", this.id]).catch(() => {});
      // Docker creates named volumes as root-owned directories. Prepare the
      // cache once so the sandbox can use it as its unprivileged user.
      await this.docker([
        "run",
        "--rm",
        "--mount",
        `type=volume,source=${this.cacheVolume},destination=/cache`,
        "--user",
        "0:0",
        this.image,
        "sh",
        "-lc",
        "chmod 0777 /cache",
      ]);
      await this.docker([
        "run",
        "-d",
        "--name",
        this.id,
        "--workdir",
        "/workspace",
        "--mount",
        `type=bind,src=${this.stage},dst=/workspace`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--pids-limit",
        "256",
        "--network",
        this.network,
        "--mount",
        `type=volume,source=${this.cacheVolume},destination=/cache`,
        "--user",
        `${uid}:${gid}`,
        "--env",
        "HOME=/tmp",
        "--env",
        "XDG_CACHE_HOME=/cache/xdg",
        "--env",
        "NPM_CONFIG_CACHE=/cache/npm",
        "--env",
        "PIP_CACHE_DIR=/cache/pip",
        "--env",
        "CARGO_HOME=/cache/cargo",
        "--env",
        "GOMODCACHE=/cache/go-mod",
        "--env",
        "GOCACHE=/cache/go-build",
        "--env",
        "GRADLE_USER_HOME=/cache/gradle",
        "--env",
        "MAVEN_CONFIG=/cache/maven",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=64m",
        this.image,
        "sh",
        "-c",
        "while :; do sleep 3600; done",
      ]);
      this.started = true;
    } catch (error) {
      throw error;
    }
  }

  async shell(command: string, signal?: AbortSignal): Promise<string> {
    if (!this.started || this.disposed)
      throw new Error("Sandbox is not running");
    if (signal?.aborted) throw new Error("Sandbox command cancelled");
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn("docker", ["exec", this.id, "sh", "-lc", command], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) rejectPromise(error);
        else resolvePromise(output);
      };
      const append = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT)
          output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
      };
      const stopContainer = () =>
        this.docker(["kill", this.id]).catch(() => "");
      const abort = () => {
        child.kill("SIGTERM");
        void stopContainer().finally(() =>
          finish(new Error("Sandbox command cancelled")),
        );
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        this.log(
          `Sandbox command timed out after ${this.timeoutSeconds}s: ${command}`,
        );
        void stopContainer().finally(() =>
          finish(
            new Error(
              `Sandbox command timed out after ${this.timeoutSeconds}s`,
            ),
          ),
        );
      }, this.timeoutSeconds * 1000);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        this.log(`Sandbox command exited with ${code}: ${command}\n${output}`);
        code === 0
          ? finish()
          : finish(new Error(`Sandbox command exited with ${code}: ${output}`));
      });
    });
  }

  async finish(): Promise<void> {
    if (this.finished || !this.stage) return;
    if (this.started) {
      await this.docker(["stop", this.id]).catch(() => {});
      this.started = false;
    }
    await syncWorkspaceFromStage(this.stage, this.worktree);
    this.finished = true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      // finish() stops the container before syncing but it still needs removal.
      await this.docker(["rm", "-f", this.id]);
    } catch (error) {
      this.log(`Could not remove sandbox container: ${String(error)}`);
    } finally {
      if (this.stage) {
        if (!this.finished) {
          try {
            await syncWorkspaceFromStage(this.stage, this.worktree);
          } catch (error) {
            this.log(`Could not preserve sandbox changes: ${String(error)}`);
          }
        }
        await rm(this.stage, { recursive: true, force: true });
        this.stage = undefined;
      }
    }
  }

  private async docker(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("docker", args, {
      maxBuffer: MAX_OUTPUT,
      timeout: HOST_COMMAND_TIMEOUT,
    });
    return stdout.trim();
  }
}

export async function cleanup(
  root: string,
  worktree: string,
  _branch: string,
): Promise<void> {
  const target = resolve(worktree);
  const rootPath = resolve(root);
  const rel = relative(rootPath, target);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    resolve(target) === rootPath
  ) {
    throw new Error("Refusing to remove a workspace outside the repository");
  }
  const registered = await git(root, ["worktree", "list", "--porcelain"]);
  if (registered.split("\n").some((line) => line === `worktree ${target}`))
    await git(root, ["worktree", "remove", "--force", target]);
}

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rename,
  unlink,
  writeFile,
  chmod,
  rmdir,
  readlink,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;
export const MAX_SHELL_OUTPUT = 40_000;
const HOST_COMMAND_TIMEOUT = 120_000;
const SHELL_OUTPUT_MARKER =
  "\n\n[output truncated by Louibot; showing the beginning and end]\n\n";

function outputParts(): { head: number; tail: number } {
  const available = MAX_SHELL_OUTPUT - SHELL_OUTPUT_MARKER.length;
  return { head: Math.ceil(available / 2), tail: Math.floor(available / 2) };
}

export function truncateShellOutput(output: string): string {
  if (output.length <= MAX_SHELL_OUTPUT) return output;
  const { head, tail } = outputParts();
  return `${output.slice(0, head)}${SHELL_OUTPUT_MARKER}${output.slice(-tail)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildShellCaptureCommand(
  command: string,
  outputPath: string,
): string {
  const marker = `\n\n[output truncated by Louibot; full output: ${outputPath}]\n\n`;
  const available = MAX_SHELL_OUTPUT - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return [
    "set +e",
    `output_file=${shellQuote(outputPath)}`,
    `eval ${shellQuote(command)} >\"$output_file\" 2>&1`,
    "status=$?",
    'bytes=$(wc -c <"$output_file")',
    `if [ "$bytes" -gt ${MAX_SHELL_OUTPUT} ]; then`,
    `  head -c ${head} "$output_file"`,
    `  printf '%s' ${shellQuote(marker)}`,
    `  tail -c ${tail} "$output_file"`,
    "else",
    '  cat "$output_file"',
    '  rm -f "$output_file"',
    "fi",
    'exit "$status"',
  ].join("\n");
}

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
  const normalized = path.split(/[\\/]/).join("/");
  const name = normalized.split("/").at(-1) ?? "";
  return (
    /^\.env(?:\.|$)/i.test(name) ||
    /^(?:\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(?:\.json)?|secrets\.json|application_default_credentials\.json)$/i.test(
      name,
    ) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(name) ||
    /(?:^|\/)(?:\.aws|\.ssh|\.gnupg|\.config\/gcloud|\.azure|\.kube|\.docker|\.terraform\.d)(?:\/|$)/i.test(
      normalized,
    )
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

const STAGE_MARKER_CONTENT = "louibot-stage-v1\n";

async function isCompleteStage(stage: string): Promise<boolean> {
  try {
    const stageInfo = await lstat(stage);
    if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink())
      throw new Error(`Unsafe sandbox staging path: ${stage}`);
    const marker = `${stage}.complete`;
    const markerInfo = await lstat(marker);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) return false;
    return (await readFile(marker, "utf8")) === STAGE_MARKER_CONTENT;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function prepareSandboxStage(
  worktree: string,
  stage: string,
): Promise<void> {
  if (await isCompleteStage(stage)) return;

  const marker = `${stage}.complete`;
  const temporaryStage = `${stage}.tmp`;
  await rm(stage, { recursive: true, force: true });
  await rm(marker, { force: true });
  await rm(temporaryStage, { recursive: true, force: true });
  await mkdir(temporaryStage, { mode: 0o777 });
  await chmod(temporaryStage, 0o777);
  try {
    await copyTree(worktree, temporaryStage, worktree, "", true);
    await rename(temporaryStage, stage);
    await writeFile(marker, STAGE_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(temporaryStage, { recursive: true, force: true });
    if (!(await isCompleteStage(stage).catch(() => false))) {
      await rm(stage, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
    throw error;
  }
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
  private stageReady = false;
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
    private readonly readOnly = false,
  ) {
    this.id = `louibot-${createHash("sha256").update(resolve(worktree)).digest("hex").slice(0, 20)}${readOnly ? "-review" : ""}`;
    this.cacheVolume = cacheVolumeName(cacheKey);
  }

  private readonly cacheVolume: string;

  async start(): Promise<void> {
    if (this.started) return;
    try {
      if (!this.stage) {
        this.stage = `${resolve(this.worktree)}.sandbox`;
        await prepareSandboxStage(this.worktree, this.stage);
        this.stageReady = true;
      }
      const hostUid =
        typeof process.getuid === "function" ? process.getuid() : 1000;
      const hostGid =
        typeof process.getgid === "function" ? process.getgid() : 1000;
      const uid = hostUid === 0 ? 65534 : hostUid;
      const gid = hostUid === 0 ? 65534 : hostGid;
      await this.docker(["rm", "-f", this.id]).catch(() => {});
      if (!this.readOnly) {
        // Docker creates named volumes as root-owned directories. Prepare the
        // cache once so the implementation sandbox can use it unprivileged.
        await this.docker([
          "run",
          "--rm",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--network",
          "none",
          "--memory",
          "64m",
          "--cpus",
          "0.25",
          "--pids-limit",
          "64",
          "--mount",
          `type=volume,source=${this.cacheVolume},destination=/cache`,
          "--user",
          "0:0",
          "--entrypoint",
          "sh",
          this.image,
          "-lc",
          "chmod 0777 /cache",
        ]);
      }
      const workspaceMount = `type=bind,src=${this.stage},dst=/workspace${this.readOnly ? ",readonly" : ""}`;
      const args = [
        "run",
        "-d",
        "--name",
        this.id,
        "--workdir",
        "/workspace",
        "--mount",
        workspaceMount,
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
        this.readOnly ? "none" : this.network,
      ];
      if (!this.readOnly) {
        args.push(
          "--mount",
          `type=volume,source=${this.cacheVolume},destination=/cache`,
        );
      }
      args.push(
        "--user",
        `${uid}:${gid}`,
        "--env",
        "HOME=/tmp",
        "--env",
        this.readOnly
          ? "XDG_CACHE_HOME=/tmp/cache"
          : "XDG_CACHE_HOME=/cache/xdg",
      );
      if (!this.readOnly) {
        args.push(
          "--env",
          "NPM_CONFIG_CACHE=/cache/npm",
          "--env",
          "PLAYWRIGHT_BROWSERS_PATH=/cache/playwright",
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
        );
      }
      args.push(
        "--tmpfs",
        "/tmp:rw,nosuid,nodev",
        "--entrypoint",
        "sh",
        this.image,
        "-c",
        "while :; do sleep 3600; done",
      );
      await this.docker([...args]);
      this.started = true;
    } catch (error) {
      await this.docker(["rm", "-f", this.id]).catch(() => {});
      throw error;
    }
  }

  async shell(command: string, signal?: AbortSignal): Promise<string> {
    if (!this.started || this.disposed)
      throw new Error("Sandbox is not running");
    if (signal?.aborted) throw new Error("Sandbox command cancelled");
    const outputPath = `/tmp/louibot-shell-${randomUUID()}.log`;
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(
        "docker",
        [
          "exec",
          this.id,
          "sh",
          "-lc",
          buildShellCaptureCommand(command, outputPath),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let tail = "";
      let truncated = false;
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
        const text = chunk.toString("utf8");
        if (!truncated && output.length + text.length <= MAX_SHELL_OUTPUT) {
          output += text;
          return;
        }
        const { head, tail: tailLength } = outputParts();
        if (!truncated) {
          const combined = output + text;
          output = combined.slice(0, head);
          tail = combined.slice(-tailLength);
          truncated = true;
        } else {
          tail = (tail + text).slice(-tailLength);
        }
      };
      const stopContainer = async () => {
        try {
          await this.docker(["kill", this.id]);
        } catch {
          // The container may already have stopped with the exec process.
        } finally {
          this.started = false;
        }
      };
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
        if (truncated) output += `${SHELL_OUTPUT_MARKER}${tail}`;
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
    if (!this.readOnly && this.stageReady)
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
        if (!this.finished && !this.readOnly && this.stageReady) {
          try {
            await syncWorkspaceFromStage(this.stage, this.worktree);
          } catch (error) {
            this.log(`Could not preserve sandbox changes: ${String(error)}`);
          }
        }
        await rm(this.stage, { recursive: true, force: true });
        await rm(`${this.stage}.complete`, { force: true });
        await rm(`${this.stage}.tmp`, { recursive: true, force: true });
        this.stage = undefined;
        this.stageReady = false;
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

export async function cleanup(root: string, worktree: string): Promise<void> {
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

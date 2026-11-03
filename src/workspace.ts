import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import {
  cp,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rename,
  writeFile,
  rmdir,
  readlink,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;
const MAX_GIT_PATHS = 64 * 1024 * 1024;
export const MAX_SHELL_OUTPUT = 12_000;
const HOST_COMMAND_TIMEOUT = 120_000;
const snapshotIgnoredDirs: Record<string, true> = {
  ".cache": true,
  ".docusaurus": true,
  ".git": true,
  ".louibot": true,
  ".next": true,
  ".parcel-cache": true,
  ".turbo": true,
  coverage: true,
  node_modules: true,
};
const SHELL_OUTPUT_MARKER =
  "\n\n[output truncated by Louibot; showing the beginning and end]\n\n";

function outputParts(): { head: number; tail: number } {
  const available = MAX_SHELL_OUTPUT - SHELL_OUTPUT_MARKER.length;
  return { head: Math.ceil(available / 2), tail: Math.floor(available / 2) };
}

function snapshotPathExcluded(path: string): boolean {
  const normalized = path.split(/[\\/]/).join("/");
  if (secretPath(path)) return true;
  return normalized.split("/").some((part) => snapshotIgnoredDirs[part]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function historyExcerpt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = `...[${value.length - maxChars} characters omitted]...`;
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${value.slice(0, head)}${marker}${tail ? value.slice(-tail) : ""}`;
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

const SANDBOX_MEMORY_MB = 2_048;
const SANDBOX_CPUS = 2;
const SANDBOX_PIDS_LIMIT = 256;

export type SandboxSpec = {
  image: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  commandTimeoutSeconds: number;
  network: SandboxNetwork;
};

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

const MAX_RECOVERY_DIFF = 24_000;

async function snapshotWorkspaceTree(
  worktree: string,
  repositoryGitDir?: string,
): Promise<string> {
  const gitDir =
    repositoryGitDir ??
    resolve(worktree, await git(worktree, ["rev-parse", "--git-dir"]));
  const indexPath = join(gitDir, `louibot-index-${randomUUID()}`);
  const pathspecPath = `${indexPath}.paths`;
  const environment = {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: worktree,
    GIT_INDEX_FILE: indexPath,
  };
  try {
    await git(worktree, ["read-tree", "HEAD"], environment);
    const listed = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: worktree,
        maxBuffer: MAX_GIT_PATHS,
        timeout: HOST_COMMAND_TIMEOUT,
        env: { ...process.env, ...environment },
      },
    );
    const paths = [
      ...new Set(listed.stdout.split("\0").filter(Boolean)),
    ].filter((path) => !snapshotPathExcluded(path));
    if (paths.length) {
      await writeFile(
        pathspecPath,
        paths.map((path) => `:(literal)${path}\0`).join(""),
        { mode: 0o600 },
      );
      await git(
        worktree,
        [
          "add",
          "-A",
          "--pathspec-from-file",
          pathspecPath,
          "--pathspec-file-nul",
        ],
        environment,
      );
    }
    return await git(worktree, ["write-tree"], environment);
  } finally {
    await Promise.all([
      rm(indexPath, { force: true }),
      rm(`${indexPath}.lock`, { force: true }),
      rm(pathspecPath, { force: true }),
    ]);
  }
}

export async function captureWorkspaceBaseline(
  worktree: string,
): Promise<string> {
  return snapshotWorkspaceTree(worktree);
}

export async function diffWorkspaceFromBaseline(
  worktree: string,
  baselineTree: string,
  repositoryGitDir?: string,
): Promise<string> {
  const currentTree = await snapshotWorkspaceTree(worktree, repositoryGitDir);
  const { stdout } = await execFileAsync(
    "git",
    [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--find-renames",
      "--unified=3",
      baselineTree,
      currentTree,
      "--",
    ],
    {
      cwd: worktree,
      maxBuffer: MAX_GIT_PATHS,
      timeout: HOST_COMMAND_TIMEOUT,
      env: {
        ...process.env,
        ...(repositoryGitDir ? { GIT_DIR: repositoryGitDir } : {}),
      },
    },
  );
  if (stdout.length <= MAX_RECOVERY_DIFF) return stdout.trim();
  const half = Math.floor((MAX_RECOVERY_DIFF - 100) / 2);
  return `${stdout.slice(0, half)}\n[baseline diff truncated by Louibot]\n${stdout.slice(-half)}`;
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

async function isIgnored(worktree: string, path: string): Promise<boolean> {
  try {
    await lstat(join(worktree, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", path], {
      cwd: worktree,
      timeout: HOST_COMMAND_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === "1") return false;
    // Standalone workspaces and test fixtures may not have Git metadata.
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function sameEntry(
  source: string,
  destination: string,
): Promise<boolean> {
  let sourceInfo;
  let destinationInfo;
  try {
    [sourceInfo, destinationInfo] = await Promise.all([
      lstat(source),
      lstat(destination),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (sourceInfo.isSymbolicLink() || destinationInfo.isSymbolicLink()) {
    if (!sourceInfo.isSymbolicLink() || !destinationInfo.isSymbolicLink())
      return false;
    return (await readlink(source)) === (await readlink(destination));
  }
  if (sourceInfo.isDirectory() || destinationInfo.isDirectory())
    return sourceInfo.isDirectory() && destinationInfo.isDirectory();
  if (!sourceInfo.isFile() || !destinationInfo.isFile()) return false;
  if (
    sourceInfo.size !== destinationInfo.size ||
    sourceInfo.mtimeMs !== destinationInfo.mtimeMs ||
    (sourceInfo.mode & 0o777) !== (destinationInfo.mode & 0o777)
  )
    return false;

  // A tool can preserve timestamps while changing content, so verify identical
  // metadata before deciding that a file is unchanged.
  const [sourceDigest, destinationDigest] = await Promise.all([
    fileDigest(source),
    fileDigest(destination),
  ]);
  return sourceDigest === destinationDigest;
}

async function removePath(
  path: string,
  worktree: string,
  rel: string,
  tracked: Set<string>,
): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (!tracked.has(rel) && (await isIgnored(worktree, rel))) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of await readdir(path)) {
      if (name === ".git" || name === ".louibot") continue;
      const child = `${rel}/${name}`;
      if (secretPath(child)) continue;
      await removePath(join(path, name), worktree, child, tracked);
    }
    await rmdir(path);
  } else await rm(path, { force: true });
}

async function trackedPaths(worktree: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "-z"],
      {
        cwd: worktree,
        maxBuffer: MAX_GIT_PATHS,
        timeout: HOST_COMMAND_TIMEOUT,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    const tracked = new Set<string>();
    for (const file of stdout.split("\0").filter(Boolean)) {
      tracked.add(file);
      let parent = dirname(file).split(sep).join("/");
      while (parent && parent !== ".") {
        tracked.add(parent);
        parent = dirname(parent).split(sep).join("/");
      }
    }
    return tracked;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 128 || code === "ENOENT") return new Set();
    throw error;
  }
}

async function syncChangedTree(
  stage: string,
  worktree: string,
  tracked: Set<string>,
  source: string,
  destination: string,
  prefix = "",
): Promise<void> {
  if (prefix && secretPath(prefix)) return;
  const stageInfo = await lstat(source).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  const worktreeInfo = await lstat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );

  if (!stageInfo) {
    if (
      !prefix ||
      !worktreeInfo ||
      (!tracked.has(prefix) && (await isIgnored(worktree, prefix)))
    )
      return;
    if (worktreeInfo.isDirectory() && !worktreeInfo.isSymbolicLink()) {
      for (const name of await readdir(destination)) {
        if (name === ".git" || name === ".louibot") continue;
        const rel = `${prefix}/${name}`;
        if (secretPath(rel)) continue;
        await syncChangedTree(
          stage,
          worktree,
          tracked,
          join(source, name),
          join(destination, name),
          rel,
        );
      }
      await rmdir(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOTEMPTY") throw error;
      });
    } else await removePath(destination, worktree, prefix, tracked);
    return;
  }
  if (
    stageInfo.isSymbolicLink() ||
    (!stageInfo.isDirectory() && !stageInfo.isFile())
  ) {
    if (prefix && !worktreeInfo && (await isIgnored(worktree, prefix))) return;
    if (prefix && !secretPath(prefix)) {
      const target = stageInfo.isSymbolicLink()
        ? await readlink(source)
        : undefined;
      if (target === undefined || safeLinkTarget(stage, prefix, target)) {
        if (!(await sameEntry(source, destination))) {
          if (!tracked.has(prefix) && (await isIgnored(worktree, prefix)))
            return;
          await removePath(destination, worktree, prefix, tracked);
          await mkdir(dirname(destination), { recursive: true });
          if (target === undefined) await cp(source, destination);
          else await symlink(target, destination);
        }
      } else if (worktreeInfo)
        await removePath(destination, worktree, prefix, tracked);
    }
    return;
  }

  if (stageInfo.isFile()) {
    if (
      prefix &&
      !secretPath(prefix) &&
      !(await sameEntry(source, destination))
    ) {
      if (!tracked.has(prefix) && (await isIgnored(worktree, prefix))) return;
      await removePath(destination, worktree, prefix, tracked);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { preserveTimestamps: true });
      const copiedInfo = await lstat(source);
      await chmod(destination, copiedInfo.mode & 0o777 & ~0o6000);
    }
    return;
  }

  if (prefix && !tracked.has(prefix) && (await isIgnored(worktree, prefix)))
    return;
  if (!worktreeInfo || !worktreeInfo.isDirectory()) {
    await removePath(destination, worktree, prefix, tracked);
    await mkdir(destination, { recursive: true, mode: stageInfo.mode & 0o777 });
  }

  const stageEntries = await readdir(source, { withFileTypes: true });
  const worktreeEntries = await readdir(destination, { withFileTypes: true });
  const names = new Set([
    ...stageEntries.map((entry) => entry.name),
    ...worktreeEntries.map((entry) => entry.name),
  ]);
  for (const name of names) {
    if (name === ".git" || name === ".louibot") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (secretPath(rel)) continue;
    await syncChangedTree(
      stage,
      worktree,
      tracked,
      join(source, name),
      join(destination, name),
      rel,
    );
  }
}

export async function syncWorkspaceFromStage(
  stage: string,
  worktree: string,
): Promise<void> {
  await syncChangedTree(
    stage,
    worktree,
    await trackedPaths(worktree),
    stage,
    worktree,
  );
}

export class Sandbox {
  private readonly id: string;
  private stage?: string;
  private stageReady = false;
  private started = false;
  private finished = false;
  private disposed = false;
  private readonly shellHistory: Array<{ command: string; output: string }> =
    [];

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

  spec(): SandboxSpec {
    return {
      image: this.image,
      cpus: SANDBOX_CPUS,
      memoryMb: SANDBOX_MEMORY_MB,
      pidsLimit: SANDBOX_PIDS_LIMIT,
      commandTimeoutSeconds: this.timeoutSeconds,
      network: this.network,
    };
  }

  async restart(): Promise<void> {
    if (this.started) {
      await this.docker(["rm", "-f", this.id]).catch(() => {});
      this.started = false;
    }
    await this.start();
  }

  recentShellHistory(limit = 8, excerptChars = 300): string {
    return this.shellHistory
      .slice(-limit)
      .map(
        ({ command, output }, index) =>
          `${index + 1}. command: ${historyExcerpt(command, excerptChars)}\n   output: ${historyExcerpt(output, excerptChars)}`,
      )
      .join("\n");
  }

  async fileExists(relativePath: string): Promise<boolean> {
    if (!this.stage || !this.stageReady)
      throw new Error("Sandbox stage is not ready for file inspection");
    const target = resolve(this.stage, relativePath);
    const fromStage = relative(this.stage, target);
    if (
      fromStage === ".." ||
      fromStage.startsWith(`..${sep}`) ||
      isAbsolute(fromStage)
    )
      throw new Error("Sandbox file inspection must stay inside the workspace");
    try {
      await lstat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async diffFromBaseline(baselineTree: string): Promise<string> {
    if (!this.stage || !this.stageReady)
      throw new Error("Sandbox stage is not ready for diffing");
    const gitDir = resolve(
      this.worktree,
      await git(this.worktree, ["rev-parse", "--git-dir"]),
    );
    return diffWorkspaceFromBaseline(this.stage, baselineTree, gitDir);
  }

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
        `${SANDBOX_MEMORY_MB}m`,
        "--cpus",
        `${SANDBOX_CPUS}`,
        "--pids-limit",
        `${SANDBOX_PIDS_LIMIT}`,
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
    return this.executeShell(this.id, command, signal);
  }

  private async executeShell(
    containerId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new Error("Sandbox command cancelled");
    const outputPath = `/tmp/louibot-shell-${randomUUID()}.log`;
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(
        "docker",
        [
          "exec",
          containerId,
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
          await this.docker(["kill", containerId]);
        } catch {
          // The container may already have stopped with the exec process.
        } finally {
          if (containerId === this.id) this.started = false;
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
        this.shellHistory.push({ command, output });
        if (this.shellHistory.length > 32) this.shellHistory.shift();
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

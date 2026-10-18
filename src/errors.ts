export interface ErrorDiagnostic {
  name: string;
  code?: string;
  message: string;
  nextStep: string;
  stack?: string;
}

export function redactErrorText(value: unknown): string {
  let message = String(value).replace(/https?:\/\/[^\s]+/g, "<url>");
  const secretValues = Object.entries(process.env)
    .filter(
      ([name, secret]) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) &&
        Boolean(secret) &&
        secret!.length > 3,
    )
    .map(([, secret]) => secret!);
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

function nextStepFor(name: string, code: string | undefined, message: string) {
  const text = `${name} ${code ?? ""} ${message}`.toLowerCase();
  if (text.includes("recursion") || name === "GraphRecursionError")
    return "Raise --max-steps for implementation or --reviewer-max-steps for review, within the model and spend limits; then retry with @louibot implement.";
  if (text.includes("malformed or truncated tool call"))
    return "Raise --max-output-tokens if the model supports it, then retry with @louibot implement.";
  if (text.includes("cost budget exceeded"))
    return "Raise --max-cost-usd or use a lower-cost model, then retry with @louibot implement.";
  if (text.includes("input token budget exceeded"))
    return "Reduce issue/context size or adjust --max-input-tokens and --context-window-tokens to the model's documented limits, then retry.";
  if (name === "ZodError")
    return "Correct the invalid setting reported above; run louibot start --help or louibot doctor to review supported values, then retry.";
  if (/\b[a-z_][a-z0-9_]* is not set\b/i.test(message))
    return "Export the named variable in the same shell that runs Louibot, then run louibot doctor to test it.";
  if (text.includes("spawn gh") || text.includes("gh auth"))
    return "Install GitHub CLI if missing, run gh auth login, and confirm repository access with gh auth status.";
  if (text.includes("timed out") || code === "ETIMEDOUT")
    return "Inspect the failed command in louibot logs <issue>; raise --command-timeout-seconds only if that command should take longer, then retry.";
  if (code === "ENOSPC" || text.includes("no space left on device"))
    return "Free disk space for the worktree, Docker image, and build cache, then retry.";
  if (code === "EFBIG" || text.includes("file too large"))
    return "Inspect the command and filesystem limits in louibot logs <issue>; remove the limit or reduce the generated file size, then retry.";
  if (text.includes("docker") && text.includes("permission denied"))
    return "Confirm `docker version` works for this user; fix Docker socket access, then run louibot doctor and retry.";
  if (/(?:http\s*)?401\b/.test(text) || /(?:http\s*)?403\b/.test(text))
    return text.includes("github")
      ? "Run gh auth status and confirm the authenticated account has the required repository permissions, then retry."
      : "Check the selected API-key environment variable and provider permissions with louibot doctor, then retry.";
  if (/(?:http\s*)?404\b/.test(text))
    return text.includes("github")
      ? "Confirm the configured owner/repository and that the authenticated GitHub account can access it, then run louibot doctor."
      : "Check --base-url: use the API root and omit /chat/completions, then run louibot doctor.";
  if (
    text.includes("unsupported parameter") ||
    text.includes("invalid request") ||
    text.includes("unsupported value")
  )
    return "Check the provider's Chat Completions settings and match --token-limit-parameter and --reasoning-effort to its documentation.";
  if (text.includes("docker"))
    return "Confirm Docker is installed and its daemon is running, then run louibot doctor and retry.";
  if (code === "ENOENT")
    return "Install the missing executable or correct its configured path, then run louibot doctor and retry.";
  if (
    ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"].includes(
      code ?? "",
    )
  )
    return "Check network connectivity and service availability, then retry with @louibot implement.";
  if (text.includes("sandbox command exited"))
    return "Inspect the complete command output in louibot logs <issue>, fix the implementation or validation failure, then retry with @louibot implement.";
  return "Inspect louibot logs <issue> for the failing step; correct the reported cause, then retry with @louibot implement.";
}

function errorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== "object" || error === null)
    return undefined;
  const record = error as { code?: unknown; cause?: unknown };
  if (typeof record.code === "string") return record.code;
  return errorCode(record.cause, depth + 1);
}

export function diagnoseError(error: unknown): ErrorDiagnostic {
  const record =
    typeof error === "object" && error !== null
      ? (error as {
          name?: unknown;
          code?: unknown;
          message?: unknown;
          stack?: unknown;
        })
      : undefined;
  const name = typeof record?.name === "string" ? record.name : "Error";
  const code = errorCode(error);
  const rawMessage =
    typeof record?.message === "string" ? record.message : String(error);
  const message = redactErrorText(rawMessage)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .slice(0, 2_000);
  const stack =
    typeof record?.stack === "string"
      ? redactErrorText(record.stack).slice(0, 8_000)
      : undefined;
  return {
    name,
    code,
    message,
    nextStep: nextStepFor(name, code, message),
    stack,
  };
}

export function formatDiagnostic(error: unknown): string {
  const diagnostic = diagnoseError(error);
  return `${diagnostic.name}${diagnostic.code ? ` (${diagnostic.code})` : ""}: ${diagnostic.message}\nNext step: ${diagnostic.nextStep}`;
}

const DEFAULT_SAFE_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
  "NODE_ENV",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "DISPLAY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const;

export interface BuildSafeChildEnvOptions {
  /** Overrides `HOME` (e.g. per-run temp directory). */
  homeDir?: string;
  /** Additional explicit key/value pairs for the child process. */
  extra?: Record<string, string | undefined>;
  /** Optional custom allowlist replacing `DEFAULT_SAFE_ENV_KEYS`. */
  allowlist?: readonly string[];
  /** Source environment object (defaults to `process.env`). */
  sourceEnv?: NodeJS.ProcessEnv;
}

/**
 * Builds a minimal, allowlisted environment for child processes (Playwright, k6)
 * so backend secrets such as `DATABASE_URL`, `SECRETS_ENCRYPTION_KEY`, `JWT_SECRET`,
 * and API keys are never inherited by user-controlled test scripts.
 */
export function buildSafeChildEnv(options: BuildSafeChildEnvOptions = {}): NodeJS.ProcessEnv {
  const source = options.sourceEnv ?? process.env;
  const keys = options.allowlist ?? DEFAULT_SAFE_ENV_KEYS;
  const env: NodeJS.ProcessEnv = {};

  for (const key of keys) {
    const val = source[key];
    if (typeof val === "string" && val.length > 0) {
      env[key] = val;
    }
  }

  if (options.homeDir) {
    env.HOME = options.homeDir;
  }

  if (options.extra) {
    for (const [key, val] of Object.entries(options.extra)) {
      if (typeof val === "string") {
        env[key] = val;
      }
    }
  }

  return env;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Masks common credential patterns (Bearer tokens, Authorization headers,
 * connection strings with passwords) and any explicitly known secrets from
 * child-process stdout/stderr before persisting or displaying them.
 */
export function redactSensitiveOutput(text: string, knownSecrets?: readonly string[]): string;
export function redactSensitiveOutput(text: string | null | undefined, knownSecrets?: readonly string[]): string | null;
export function redactSensitiveOutput(
  text: string | null | undefined,
  knownSecrets: readonly string[] = []
): string | null {
  if (!text) {
    return text ?? null;
  }

  let redacted = text
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*:\s*)(?:Basic|Bearer|Token|ApiKey)\s+\S+/gi, "$1[REDACTED]")
    .replace(/((?:postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^:\s/]+:)[^@\s/]+@/gi, "$1[REDACTED]@");

  for (const secret of knownSecrets) {
    if (typeof secret === "string" && secret.trim().length >= 4) {
      redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
    }
  }

  return redacted;
}

import { BadRequestException } from "@nestjs/common";
import { isIP } from "node:net";

const BLOCKED_SCRIPT_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(?:require\s*\(\s*['"`](?:node:)?child_process['"`]\s*\)|from\s+['"`](?:node:)?child_process['"`])/i,
    reason: "child_process is not permitted in automation scripts."
  },
  {
    pattern: /(?:require\s*\(\s*['"`](?:node:)?vm['"`]\s*\)|from\s+['"`](?:node:)?vm['"`])/i,
    reason: "vm module is not permitted in automation scripts."
  },
  {
    pattern: /(?:require\s*\(\s*['"`](?:node:)?(?:worker_threads|cluster)['"`]\s*\)|from\s+['"`](?:node:)?(?:worker_threads|cluster)['"`])/i,
    reason: "worker_threads and cluster modules are not permitted in automation scripts."
  },
  {
    pattern: /\bprocess\s*\.\s*(?:binding|dlopen|kill|exit)\b/,
    reason: "process control primitives (binding/dlopen/kill/exit) are not permitted in automation scripts."
  },
  {
    pattern: /\b(?:eval\s*\(|new\s+Function\s*\()/,
    reason: "Dynamic code evaluation (eval / new Function) is not permitted in automation scripts."
  },
  {
    pattern: /['"`](?:\/proc\/|\/etc\/(?:passwd|shadow)|[^'"`]*\/\.env\b|\.env)['"`]/i,
    reason: "Accessing sensitive system or environment files is not permitted in automation scripts."
  }
];

/**
 * Performs static safety validation on user-submitted Playwright scripts before
 * persisting or executing them, blocking common Node.js/OS escape primitives.
 */
export function assertSafePlaywrightScript(scriptContent: string): void {
  for (const rule of BLOCKED_SCRIPT_PATTERNS) {
    if (rule.pattern.test(scriptContent)) {
      throw new BadRequestException(`Blocked unsafe automation script: ${rule.reason}`);
    }
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const first = parseInt(host.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

export function isPrivateOrBlockedTargetHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  );
}

/**
 * Validates that an automation target URL uses http/https and is not pointing to
 * loopback, private network, or cloud metadata endpoints unless explicitly allowed.
 */
export function assertSafeTargetUrl(
  rawUrl: string,
  allowPrivateEnvKeys: readonly string[] = ["ALLOW_PRIVATE_AUTOMATION_TARGETS", "ALLOW_PRIVATE_PERFORMANCE_TARGETS"]
): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException("targetUrl must be a valid http or https URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestException("targetUrl must use http or https.");
  }

  const allowPrivate = allowPrivateEnvKeys.some((key) => process.env[key] === "true");
  if (!allowPrivate && isPrivateOrBlockedTargetHost(parsed.hostname)) {
    throw new BadRequestException(
      "Private or localhost target URLs are blocked. Set ALLOW_PRIVATE_AUTOMATION_TARGETS=true for local testing."
    );
  }

  return parsed.toString();
}

import { BadRequestException } from "@nestjs/common";
import * as net from "node:net";
import { MAX_DURATION_SEC, MAX_TARGET_RPS, MAX_VUS, PERFORMANCE_HTTP_METHODS } from "./performance-tests.constants";
import type {
  K6CustomMetricSummary,
  K6SummaryData,
  K6ThresholdResult,
  K6TimingBreakdown,
  PerformanceBuilderConfig,
  PerformanceCheckBreakdown,
  PerformanceEndpointBreakdown,
  PerformanceFlowConfig,
  PerformanceFlowStep,
  PerformanceHttpMethod,
  PerformanceLoadProfile,
  PerformanceRunBreakdown,
  PerformanceStage,
  PerformanceTimeseriesPoint,
  RecordedApiCall
} from "./performance-tests.types";

const PRIVATE_HOSTNAME_EXACT = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

function isPrivateOrLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((n) => Number(n));
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fe80:") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.") ||
      lower.startsWith("::ffff:169.254.")
    );
  }
  return false;
}

/**
 * Validates that a performance test target URL is well-formed HTTP/HTTPS and
 * blocks loopback/private network targets unless explicitly allowed.
 */
export function validateTargetUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new BadRequestException("Target URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException("Target URL must be a valid HTTP or HTTPS URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestException("Target URL must use http:// or https://.");
  }

  const allowPrivate = process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS === "true";
  if (!allowPrivate) {
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      PRIVATE_HOSTNAME_EXACT.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      isPrivateOrLoopbackIp(host)
    ) {
      throw new BadRequestException(
        "Private or localhost target URLs are blocked. Set ALLOW_PRIVATE_PERFORMANCE_TARGETS=true for local testing."
      );
    }
  }

  return parsed.toString();
}

function normalizeLoadOptions(raw: {
  loadProfile?: PerformanceLoadProfile;
  vus?: number;
  durationSec?: number;
  targetRps?: number | null;
  stages?: PerformanceStage[];
}): {
  loadProfile: PerformanceLoadProfile;
  vus: number;
  durationSec: number;
  targetRps: number | null;
  stages: PerformanceStage[] | undefined;
} {
  const stages = Array.isArray(raw.stages) && raw.stages.length > 0
    ? raw.stages.map((stage, idx) => {
        const stageDur = Number(stage.durationSec);
        const stageVus = Number(stage.targetVus);
        if (!Number.isInteger(stageDur) || stageDur < 1 || stageDur > MAX_DURATION_SEC) {
          throw new BadRequestException(`Stage ${idx + 1} duration must be between 1 and ${MAX_DURATION_SEC}s.`);
        }
        if (!Number.isInteger(stageVus) || stageVus < 0 || stageVus > MAX_VUS) {
          throw new BadRequestException(`Stage ${idx + 1} targetVus must be between 0 and ${MAX_VUS}.`);
        }
        return { durationSec: stageDur, targetVus: stageVus };
      })
    : undefined;

  if (stages && stages.length > 0) {
    const totalStageDur = stages.reduce((acc, s) => acc + s.durationSec, 0);
    if (totalStageDur > MAX_DURATION_SEC) {
      throw new BadRequestException(`Total stages duration cannot exceed ${MAX_DURATION_SEC} seconds.`);
    }
  }

  const loadProfile: PerformanceLoadProfile =
    raw.loadProfile ?? (stages && stages.length > 0 ? "ramping" : "fixed");
  if (!["fixed", "ramping", "constant-arrival-rate"].includes(loadProfile)) {
    throw new BadRequestException(`Unsupported loadProfile: ${loadProfile}`);
  }

  if (loadProfile === "ramping" && (!stages || stages.length === 0)) {
    throw new BadRequestException("At least one stage is required when loadProfile is 'ramping'.");
  }

  const vus = Number(raw.vus ?? 10);
  if (!Number.isInteger(vus) || vus < 1 || vus > MAX_VUS) {
    throw new BadRequestException(`VUs must be an integer between 1 and ${MAX_VUS}.`);
  }

  const durationSec = Number(raw.durationSec ?? 30);
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > MAX_DURATION_SEC) {
    throw new BadRequestException(`Duration must be an integer between 1 and ${MAX_DURATION_SEC} seconds.`);
  }

  let targetRps: number | null = null;
  if (loadProfile === "constant-arrival-rate") {
    targetRps = Number(raw.targetRps ?? 10);
    if (!Number.isInteger(targetRps) || targetRps < 1 || targetRps > MAX_TARGET_RPS) {
      throw new BadRequestException(`targetRps must be an integer between 1 and ${MAX_TARGET_RPS}.`);
    }
  }

  return { loadProfile, vus, durationSec, targetRps, stages };
}

function buildThresholdEntry(
  expr: string,
  abortOnFail?: boolean,
  delayAbortEval?: string | null
): string | { threshold: string; abortOnFail: boolean; delayAbortEval?: string } {
  if (!abortOnFail) return expr;
  return {
    threshold: expr,
    abortOnFail: true,
    ...(delayAbortEval?.trim() ? { delayAbortEval: delayAbortEval.trim() } : {})
  };
}

function buildK6Options(config: {
  loadProfile?: PerformanceLoadProfile;
  vus: number;
  durationSec: number;
  targetRps?: number | null;
  stages?: PerformanceStage[];
  p95ThresholdMs?: number | null;
  errorRateThresholdPct?: number | null;
  abortOnFail?: boolean;
  delayAbortEval?: string | null;
}): Record<string, unknown> {
  const thresholds: Record<string, Array<string | { threshold: string; abortOnFail: boolean; delayAbortEval?: string }>> = {};
  if (config.p95ThresholdMs !== null && config.p95ThresholdMs !== undefined) {
    thresholds.http_req_duration = [
      buildThresholdEntry(`p(95)<${config.p95ThresholdMs}`, config.abortOnFail, config.delayAbortEval)
    ];
  }
  if (config.errorRateThresholdPct !== null && config.errorRateThresholdPct !== undefined) {
    const rate = Number((config.errorRateThresholdPct / 100).toFixed(4));
    thresholds.http_req_failed = [
      buildThresholdEntry(`rate<=${rate}`, config.abortOnFail, config.delayAbortEval)
    ];
  }

  const profile =
    config.loadProfile ?? (config.stages && config.stages.length > 0 ? "ramping" : "fixed");

  let optionsObj: Record<string, unknown>;
  if (profile === "constant-arrival-rate") {
    optionsObj = {
      scenarios: {
        constant_rps: {
          executor: "constant-arrival-rate",
          rate: config.targetRps ?? 10,
          timeUnit: "1s",
          duration: `${config.durationSec}s`,
          preAllocatedVUs: config.vus,
          maxVUs: Math.min(MAX_VUS, Math.max(config.vus * 2, config.vus))
        }
      }
    };
  } else if (profile === "ramping" || (config.stages && config.stages.length > 0)) {
    optionsObj = {
      stages: (config.stages ?? []).map((s) => ({
        duration: `${s.durationSec}s`,
        target: s.targetVus
      }))
    };
  } else {
    optionsObj = {
      vus: config.vus,
      duration: `${config.durationSec}s`
    };
  }

  if (Object.keys(thresholds).length > 0) {
    optionsObj.thresholds = thresholds;
  }

  return optionsObj;
}

export function normalizeBuilderConfig(raw: PerformanceBuilderConfig): PerformanceBuilderConfig {
  if (!raw || typeof raw !== "object") {
    throw new BadRequestException("builderConfig is required for builder mode.");
  }

  const targetUrl = validateTargetUrl(raw.targetUrl ?? "");
  const method = (raw.method ?? "GET").toUpperCase() as PerformanceHttpMethod;
  if (!PERFORMANCE_HTTP_METHODS.includes(method)) {
    throw new BadRequestException(`Unsupported HTTP method: ${method}`);
  }

  const load = normalizeLoadOptions(raw);

  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === "object") {
    for (const [k, v] of Object.entries(raw.headers)) {
      const key = k.trim();
      if (key) headers[key] = String(v ?? "");
    }
  }

  const sleepSec = raw.sleepSec !== undefined ? Number(raw.sleepSec) : 1;
  if (!Number.isFinite(sleepSec) || sleepSec < 0 || sleepSec > 60) {
    throw new BadRequestException("sleepSec must be between 0 and 60.");
  }

  const p95ThresholdMs =
    raw.p95ThresholdMs !== undefined && raw.p95ThresholdMs !== null
      ? Number(raw.p95ThresholdMs)
      : null;
  if (p95ThresholdMs !== null && (!Number.isFinite(p95ThresholdMs) || p95ThresholdMs <= 0)) {
    throw new BadRequestException("p95ThresholdMs must be a positive number.");
  }

  const errorRateThresholdPct =
    raw.errorRateThresholdPct !== undefined && raw.errorRateThresholdPct !== null
      ? Number(raw.errorRateThresholdPct)
      : null;
  if (
    errorRateThresholdPct !== null &&
    (!Number.isFinite(errorRateThresholdPct) || errorRateThresholdPct < 0 || errorRateThresholdPct > 100)
  ) {
    throw new BadRequestException("errorRateThresholdPct must be between 0 and 100.");
  }

  const expectedStatus =
    raw.expectedStatus !== undefined && raw.expectedStatus !== null
      ? Number(raw.expectedStatus)
      : 200;
  if (expectedStatus !== null && (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599)) {
    throw new BadRequestException("expectedStatus must be a valid HTTP status code (100-599).");
  }

  return {
    targetUrl,
    method,
    headers,
    body: raw.body ?? null,
    loadProfile: load.loadProfile,
    vus: load.vus,
    durationSec: load.durationSec,
    targetRps: load.targetRps,
    stages: load.stages,
    sleepSec,
    p95ThresholdMs,
    errorRateThresholdPct,
    ...(raw.abortOnFail ? { abortOnFail: true } : {}),
    ...(raw.delayAbortEval?.trim() ? { delayAbortEval: raw.delayAbortEval.trim() } : {}),
    ...(raw.customMetrics ? { customMetrics: true } : {}),
    expectedStatus
  };
}

/**
 * Generates an executable Grafana k6 JavaScript test script from a validated builder config.
 */
export function generateK6Script(config: PerformanceBuilderConfig): string {
  const optionsObj = buildK6Options(config);

  const headersEntries = Object.entries(config.headers ?? {});
  const hasHeaders = headersEntries.length > 0;
  const hasBody = config.body !== null && config.body !== undefined && config.body !== "";
  const methodFn = config.method.toLowerCase();
  const expectedStatus = config.expectedStatus ?? 200;
  const sleepSec = config.sleepSec ?? 1;

  const lines: string[] = [
    `import http from "k6/http";`,
    `import { check, sleep } from "k6";`,
    ...(config.customMetrics ? [`import { Rate, Trend } from "k6/metrics";`] : []),
    ``,
    ...(config.customMetrics
      ? [
          `const apiSuccessRate = new Rate("api_success_rate");`,
          `const apiTtfbMs = new Trend("api_ttfb_ms", true);`,
          ``
        ]
      : []),
    `export const options = ${JSON.stringify(optionsObj, null, 2)};`,
    ``,
    `export default function () {`,
    `  const url = ${JSON.stringify(config.targetUrl)};`
  ];

  if (hasHeaders) {
    lines.push(`  const params = { headers: ${JSON.stringify(config.headers)} };`);
  }

  if (config.method === "GET" || config.method === "DELETE") {
    lines.push(
      hasHeaders
        ? `  const res = http.${methodFn}(url, params);`
        : `  const res = http.${methodFn}(url);`
    );
  } else {
    const bodyArg = hasBody ? JSON.stringify(config.body) : "null";
    lines.push(
      hasHeaders
        ? `  const res = http.${methodFn}(url, ${bodyArg}, params);`
        : `  const res = http.${methodFn}(url, ${bodyArg});`
    );
  }

  lines.push(
    `  const passed = check(res, {`,
    `    "status is ${expectedStatus}": (r) => r.status === ${expectedStatus}`,
    `  });`
  );
  if (config.customMetrics) {
    lines.push(`  apiSuccessRate.add(passed);`);
    lines.push(`  apiTtfbMs.add(res.timings.waiting);`);
  }

  if (sleepSec > 0) {
    lines.push(`  sleep(${sleepSec});`);
  }

  lines.push(`}`, ``);
  return lines.join("\n");
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extracts structured KPIs and threshold results from k6 `--summary-export` JSON output.
 */
export function parseK6SummaryJson(raw: Record<string, unknown>): K6SummaryData {
  const metrics = (raw.metrics ?? {}) as Record<string, Record<string, unknown>>;

  const httpReqs = (metrics.http_reqs?.values ?? metrics.http_reqs ?? {}) as Record<string, unknown>;
  const httpDuration = (metrics.http_req_duration?.values ?? metrics.http_req_duration ?? {}) as Record<
    string,
    unknown
  >;
  const httpFailed = (metrics.http_req_failed?.values ?? metrics.http_req_failed ?? {}) as Record<string, unknown>;
  const checks = (metrics.checks?.values ?? metrics.checks ?? {}) as Record<string, unknown>;

  const thresholds: K6ThresholdResult[] = [];
  for (const [metricName, metricObj] of Object.entries(metrics)) {
    const thMap = metricObj?.thresholds as Record<string, { ok?: boolean } | boolean> | undefined;
    if (!thMap || typeof thMap !== "object") continue;
    for (const [expr, result] of Object.entries(thMap)) {
      // In k6 --summary-export, a boolean value indicates whether the threshold failed/crossed (false = PASS, true = FAIL).
      const ok = typeof result === "boolean" ? !result : Boolean(result?.ok);
      thresholds.push({ metric: metricName, expression: expr, ok });
    }
  }

  const thresholdsPassed = thresholds.length > 0 ? thresholds.every((t) => t.ok) : null;

  const BUILTIN_K6_METRICS = new Set([
    "http_reqs",
    "http_req_duration",
    "http_req_failed",
    "http_req_blocked",
    "http_req_connecting",
    "http_req_tls_handshaking",
    "http_req_sending",
    "http_req_waiting",
    "http_req_receiving",
    "iteration_duration",
    "iterations",
    "vus",
    "vus_max",
    "data_sent",
    "data_received",
    "checks"
  ]);

  const readMetricValues = (name: string) =>
    ((metrics[name]?.values ?? metrics[name] ?? {}) as Record<string, unknown>);

  const blocked = readMetricValues("http_req_blocked");
  const connecting = readMetricValues("http_req_connecting");
  const tls = readMetricValues("http_req_tls_handshaking");
  const sending = readMetricValues("http_req_sending");
  const waiting = readMetricValues("http_req_waiting");
  const receiving = readMetricValues("http_req_receiving");

  const hasTiming =
    asNumber(waiting.avg) !== null ||
    asNumber(blocked.avg) !== null ||
    asNumber(connecting.avg) !== null;

  const timingBreakdown: K6TimingBreakdown | undefined = hasTiming
    ? {
        blockedAvgMs: asNumber(blocked.avg),
        connectingAvgMs: asNumber(connecting.avg),
        tlsHandshakingAvgMs: asNumber(tls.avg),
        sendingAvgMs: asNumber(sending.avg),
        waitingAvgMs: asNumber(waiting.avg),
        waitingP95Ms: asNumber(waiting["p(95)"]),
        receivingAvgMs: asNumber(receiving.avg)
      }
    : undefined;

  const customMetrics: K6CustomMetricSummary[] = [];
  for (const [metricName, metricObj] of Object.entries(metrics)) {
    if (BUILTIN_K6_METRICS.has(metricName) || metricName.includes("{")) continue;
    const rawVals = (metricObj?.values ?? metricObj ?? {}) as Record<string, unknown>;
    const numericValues: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawVals)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        numericValues[k] = v;
      }
    }
    if (Object.keys(numericValues).length > 0) {
      customMetrics.push({
        name: metricName,
        type: typeof metricObj?.type === "string" ? metricObj.type : null,
        values: numericValues
      });
    }
  }

  return {
    totalRequests: asNumber(httpReqs.count),
    rps: asNumber(httpReqs.rate),
    errorRate: asNumber(httpFailed.rate) ?? asNumber(httpFailed.value),
    avgMs: asNumber(httpDuration.avg),
    minMs: asNumber(httpDuration.min),
    medMs: asNumber(httpDuration.med),
    p90Ms: asNumber(httpDuration["p(90)"]),
    p95Ms: asNumber(httpDuration["p(95)"]),
    maxMs: asNumber(httpDuration.max),
    checksPassed: asNumber(checks.passes),
    checksFailed: asNumber(checks.fails),
    thresholdsPassed,
    thresholds,
    ...(timingBreakdown ? { timingBreakdown } : {}),
    ...(customMetrics.length > 0 ? { customMetrics } : {})
  };
}

const STATIC_EXT_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map|mp4|webm|mp3)(?:$|\?)/i;
const TELEMETRY_PATH_RE = /\/cdn-cgi\/(?:rum|trace|bm\/|challenge-platform)|\/gtag\/|\/analytics\.js|\/collect(?:$|\?)/i;
const TELEMETRY_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "facebook.net",
  "clarity.ms",
  "hotjar.com",
  "sentry.io",
  "mixpanel.com",
  "segment.io",
  "posthog.com"
];
const NOISE_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "upgrade-insecure-requests",
  "user-agent",
  "origin",
  "referer"
]);

export function filterRecordedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith(":") || NOISE_HEADERS.has(lower)) continue;
    out[k] = v;
  }
  return out;
}

export function isApiCandidateUrl(rawUrl: string, resourceType?: string, _method?: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (STATIC_EXT_RE.test(parsed.pathname)) return false;
    if (TELEMETRY_PATH_RE.test(parsed.pathname)) return false;
    const host = parsed.hostname.toLowerCase();
    if (TELEMETRY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  } catch {
    return false;
  }
  return !resourceType || resourceType === "xhr" || resourceType === "fetch" || resourceType === "document";
}

export function normalizeFlowConfig(raw: PerformanceFlowConfig): PerformanceFlowConfig {
  if (!raw || typeof raw !== "object") {
    throw new BadRequestException("flowConfig is required for flow mode.");
  }

  const load = normalizeLoadOptions(raw);

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new BadRequestException("At least one API step is required in flow mode.");
  }

  const steps: PerformanceFlowStep[] = raw.steps.map((step, idx) => {
    const method = (step.method ?? "GET").toUpperCase() as PerformanceHttpMethod;
    if (!PERFORMANCE_HTTP_METHODS.includes(method)) {
      throw new BadRequestException(`Step ${idx + 1} has unsupported HTTP method: ${method}`);
    }
    const url = validateTargetUrl(step.url ?? "");
    const headers: Record<string, string> = {};
    if (step.headers && typeof step.headers === "object") {
      for (const [k, v] of Object.entries(step.headers)) {
        const key = k.trim();
        if (key) headers[key] = String(v ?? "");
      }
    }
    const sleepAfterSec = step.sleepAfterSec !== undefined ? Number(step.sleepAfterSec) : 0.5;
    if (!Number.isFinite(sleepAfterSec) || sleepAfterSec < 0 || sleepAfterSec > 60) {
      throw new BadRequestException(`Step ${idx + 1} sleepAfterSec must be between 0 and 60.`);
    }
    const expectedStatus =
      step.expectedStatus !== undefined && step.expectedStatus !== null ? Number(step.expectedStatus) : 200;

    return {
      id: step.id || `step-${idx + 1}`,
      name: (step.name || `${method} ${new URL(url).pathname}`).trim(),
      method,
      url,
      headers,
      body: step.body ?? null,
      expectedStatus,
      sleepAfterSec,
      enabled: step.enabled !== false
    };
  });

  if (!steps.some((s) => s.enabled !== false)) {
    throw new BadRequestException("At least one API step must be enabled.");
  }

  const p95ThresholdMs =
    raw.p95ThresholdMs !== undefined && raw.p95ThresholdMs !== null ? Number(raw.p95ThresholdMs) : null;
  const errorRateThresholdPct =
    raw.errorRateThresholdPct !== undefined && raw.errorRateThresholdPct !== null
      ? Number(raw.errorRateThresholdPct)
      : null;

  return {
    loadProfile: load.loadProfile,
    vus: load.vus,
    durationSec: load.durationSec,
    targetRps: load.targetRps,
    stages: load.stages,
    p95ThresholdMs,
    errorRateThresholdPct,
    ...(raw.abortOnFail ? { abortOnFail: true } : {}),
    ...(raw.delayAbortEval?.trim() ? { delayAbortEval: raw.delayAbortEval.trim() } : {}),
    ...(raw.customMetrics ? { customMetrics: true } : {}),
    steps
  };
}

/**
 * Generates a multi-step business flow k6 script using `group()` per API call.
 */
export function generateK6FlowScript(config: PerformanceFlowConfig): string {
  const optionsObj = buildK6Options(config);

  const enabledSteps = config.steps.filter((s) => s.enabled !== false);
  const lines: string[] = [
    `import http from "k6/http";`,
    `import { check, group, sleep } from "k6";`,
    ...(config.customMetrics ? [`import { Rate, Trend } from "k6/metrics";`] : []),
    ``,
    ...(config.customMetrics
      ? [
          `const flowSuccessRate = new Rate("flow_step_success_rate");`,
          `const flowTtfbMs = new Trend("flow_ttfb_ms", true);`,
          ``
        ]
      : []),
    `export const options = ${JSON.stringify(optionsObj, null, 2)};`,
    ``,
    `export default function () {`
  ];

  enabledSteps.forEach((step, idx) => {
    const stepLabel = step.name || `Step ${idx + 1}`;
    const methodFn = step.method.toLowerCase();
    const hasHeaders = step.headers && Object.keys(step.headers).length > 0;
    const expectedStatus = step.expectedStatus ?? 200;

    lines.push(`  group(${JSON.stringify(stepLabel)}, function () {`);
    lines.push(`    const url = ${JSON.stringify(step.url)};`);
    if (hasHeaders) {
      lines.push(`    const params = { headers: ${JSON.stringify(step.headers)} };`);
    }

    if (step.method === "GET" || step.method === "DELETE") {
      lines.push(
        hasHeaders
          ? `    const res = http.${methodFn}(url, params);`
          : `    const res = http.${methodFn}(url);`
      );
    } else {
      const bodyArg = step.body ? JSON.stringify(step.body) : "null";
      lines.push(
        hasHeaders
          ? `    const res = http.${methodFn}(url, ${bodyArg}, params);`
          : `    const res = http.${methodFn}(url, ${bodyArg});`
      );
    }

    lines.push(
      `    const passed = check(res, {`,
      `      "status is ${expectedStatus}": (r) => r.status === ${expectedStatus}`,
      `    });`
    );
    if (config.customMetrics) {
      lines.push(`    flowSuccessRate.add(passed, { step: ${JSON.stringify(stepLabel)} });`);
      lines.push(`    flowTtfbMs.add(res.timings.waiting, { step: ${JSON.stringify(stepLabel)} });`);
    }

    if ((step.sleepAfterSec ?? 0) > 0) {
      lines.push(`    sleep(${step.sleepAfterSec});`);
    }
    lines.push(`  });`);
    if (idx < enabledSteps.length - 1) {
      lines.push(``);
    }
  });

  lines.push(`}`, ``);
  return lines.join("\n");
}

/**
 * Parses a standard HAR (HTTP Archive) JSON payload into filtered RecordedApiCall items.
 */
export function parseHarToRecordedCalls(harJson: unknown): RecordedApiCall[] {
  if (!harJson || typeof harJson !== "object") {
    throw new BadRequestException("Invalid HAR JSON payload.");
  }
  const log = (harJson as { log?: { entries?: unknown[] } }).log;
  if (!log || !Array.isArray(log.entries)) {
    throw new BadRequestException("HAR payload is missing log.entries.");
  }

  const calls: RecordedApiCall[] = [];
  for (let i = 0; i < log.entries.length; i++) {
    const entry = log.entries[i] as {
      startedDateTime?: string;
      _resourceType?: string;
      request?: {
        method?: string;
        url?: string;
        headers?: Array<{ name?: string; value?: string }>;
        postData?: { text?: string };
      };
      response?: { status?: number };
    };

    const req = entry?.request;
    if (!req?.url || !req?.method) continue;

    const method = req.method.toUpperCase() as PerformanceHttpMethod;
    if (!PERFORMANCE_HTTP_METHODS.includes(method)) continue;

    if (!isApiCandidateUrl(req.url, entry._resourceType, method)) continue;

    const rawHeaders: Record<string, string> = {};
    for (const h of req.headers ?? []) {
      if (h?.name) rawHeaders[h.name] = String(h.value ?? "");
    }

    calls.push({
      id: `har-${i + 1}`,
      method,
      url: req.url,
      headers: filterRecordedHeaders(rawHeaders),
      body: req.postData?.text ?? null,
      status: typeof entry.response?.status === "number" ? entry.response.status : null,
      resourceType: entry._resourceType ?? "xhr",
      timestamp: entry.startedDateTime ?? new Date().toISOString()
    });
  }

  return calls;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function avgOf(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((acc, v) => acc + v, 0) / nums.length;
}

/**
 * Aggregates k6 `--out json=<file>` NDJSON metric points into 1-second time-series buckets,
 * per-endpoint statistics, and HTTP status code distribution.
 */
export function analyzeK6JsonLines(ndjson: string): {
  timeseries: PerformanceTimeseriesPoint[];
  endpoints: PerformanceEndpointBreakdown[];
  statusCodes: Record<string, number>;
} {
  const buckets = new Map<
    number,
    {
      reqs: number;
      failed: number;
      durations: number[];
      waiting: number[];
      connecting: number[];
      tls: number[];
      vus: number;
    }
  >();

  const endpointMap = new Map<
    string,
    { method: string; url: string; count: number; failed: number; durations: number[] }
  >();

  const statusCodes: Record<string, number> = {};
  let firstTsMs: number | null = null;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: {
      type?: string;
      metric?: string;
      data?: { time?: string; value?: number; tags?: Record<string, string> };
    };
    try {
      parsed = JSON.parse(trimmed) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.type !== "Point" || !parsed.data?.time || typeof parsed.data.value !== "number") {
      continue;
    }
    const tsMs = Date.parse(parsed.data.time);
    if (!Number.isFinite(tsMs)) continue;
    if (firstTsMs === null || tsMs < firstTsMs) {
      firstTsMs = tsMs;
    }
    const sec = Math.max(0, Math.floor((tsMs - firstTsMs) / 1000));
    let bucket = buckets.get(sec);
    if (!bucket) {
      bucket = { reqs: 0, failed: 0, durations: [], waiting: [], connecting: [], tls: [], vus: 0 };
      buckets.set(sec, bucket);
    }

    const tags = parsed.data.tags ?? {};
    const metric = parsed.metric;

    if (metric === "http_reqs") {
      bucket.reqs += parsed.data.value;
      const status = tags.status ? String(tags.status) : "unknown";
      statusCodes[status] = (statusCodes[status] ?? 0) + parsed.data.value;

      const method = (tags.method ?? "GET").toUpperCase();
      const url = tags.name || tags.url || "unknown";
      const key = `${method} ${url}`;
      let ep = endpointMap.get(key);
      if (!ep) {
        ep = { method, url, count: 0, failed: 0, durations: [] };
        endpointMap.set(key, ep);
      }
      ep.count += parsed.data.value;
    } else if (metric === "http_req_failed") {
      bucket.failed += parsed.data.value;
      if (parsed.data.value > 0) {
        const method = (tags.method ?? "GET").toUpperCase();
        const url = tags.name || tags.url || "unknown";
        const key = `${method} ${url}`;
        const ep = endpointMap.get(key);
        if (ep) ep.failed += parsed.data.value;
      }
    } else if (metric === "http_req_duration") {
      bucket.durations.push(parsed.data.value);
      const method = (tags.method ?? "GET").toUpperCase();
      const url = tags.name || tags.url || "unknown";
      const key = `${method} ${url}`;
      const ep = endpointMap.get(key);
      if (ep) ep.durations.push(parsed.data.value);
    } else if (metric === "http_req_waiting") {
      bucket.waiting.push(parsed.data.value);
    } else if (metric === "http_req_connecting") {
      bucket.connecting.push(parsed.data.value);
    } else if (metric === "http_req_tls_handshaking") {
      bucket.tls.push(parsed.data.value);
    } else if (metric === "vus") {
      bucket.vus = Math.max(bucket.vus, parsed.data.value);
    }
  }

  const timeseries = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, b]) => {
      const sorted = [...b.durations].sort((x, y) => x - y);
      const errorRate = b.reqs > 0 ? b.failed / b.reqs : 0;
      return {
        t,
        rps: Number(b.reqs.toFixed(2)),
        failedRps: Number(b.failed.toFixed(2)),
        avgMs: Number(avgOf(sorted).toFixed(2)),
        medMs: Number(percentile(sorted, 0.5).toFixed(2)),
        p90Ms: Number(percentile(sorted, 0.9).toFixed(2)),
        p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
        p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
        errorRate: Number(errorRate.toFixed(4)),
        vus: b.vus,
        waitingMs: Number(avgOf(b.waiting).toFixed(2)),
        connectingMs: Number(avgOf(b.connecting).toFixed(2)),
        tlsMs: Number(avgOf(b.tls).toFixed(2))
      };
    });

  const endpoints: PerformanceEndpointBreakdown[] = Array.from(endpointMap.values()).map((ep) => {
    const sorted = [...ep.durations].sort((x, y) => x - y);
    return {
      method: ep.method,
      url: ep.url,
      count: ep.count,
      failed: ep.failed,
      errorRate: ep.count > 0 ? Number((ep.failed / ep.count).toFixed(4)) : 0,
      avgMs: Number(avgOf(sorted).toFixed(2)),
      medMs: Number(percentile(sorted, 0.5).toFixed(2)),
      p90Ms: Number(percentile(sorted, 0.9).toFixed(2)),
      p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
      maxMs: sorted.length > 0 ? Number(sorted[sorted.length - 1].toFixed(2)) : 0
    };
  });

  return { timeseries, endpoints, statusCodes };
}

export function aggregateK6JsonLinesToTimeseries(ndjson: string): PerformanceTimeseriesPoint[] {
  return analyzeK6JsonLines(ndjson).timeseries;
}

/**
 * Recursively extracts per-check pass/fail counts from k6 `summary.root_group`.
 */
export function extractK6ChecksBreakdown(
  summaryJson: Record<string, unknown> | null | undefined
): PerformanceCheckBreakdown[] {
  if (!summaryJson || typeof summaryJson !== "object") return [];
  const rootGroup = summaryJson.root_group as Record<string, unknown> | undefined;
  if (!rootGroup) return [];

  const out: PerformanceCheckBreakdown[] = [];

  const visit = (group: Record<string, unknown>, prefix: string) => {
    const rawName = typeof group.name === "string" && group.name.trim() ? group.name.trim() : "";
    const groupLabel = rawName ? (prefix ? `${prefix} › ${rawName}` : rawName) : prefix || "Root";

    const rawChecks = group.checks;
    const checkList = Array.isArray(rawChecks)
      ? rawChecks
      : rawChecks && typeof rawChecks === "object"
      ? Object.values(rawChecks)
      : [];

    for (const c of checkList) {
      if (!c || typeof c !== "object") continue;
      const item = c as { name?: string; passes?: number; fails?: number };
      out.push({
        group: groupLabel,
        name: item.name ?? "Check",
        passes: typeof item.passes === "number" ? item.passes : 0,
        fails: typeof item.fails === "number" ? item.fails : 0
      });
    }

    const rawGroups = group.groups;
    const subGroups = Array.isArray(rawGroups)
      ? rawGroups
      : rawGroups && typeof rawGroups === "object"
      ? Object.values(rawGroups)
      : [];

    for (const g of subGroups) {
      if (g && typeof g === "object") {
        visit(g as Record<string, unknown>, rawName ? groupLabel : "");
      }
    }
  };

  visit(rootGroup, "");
  return out;
}

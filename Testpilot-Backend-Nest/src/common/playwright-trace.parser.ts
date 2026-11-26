import * as zlib from "node:zlib";

export interface TraceStepSummary {
  callId: string;
  apiName: string;
  selector: string | null;
  line: number | null;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  status: "passed" | "failed";
  error: string | null;
  point: { x: number; y: number } | null;
  params: Record<string, unknown> | null;
  beforeFrameDataUrl: string | null;
  frameDataUrl: string | null;
}

export interface TraceFilmstripFrame {
  timestamp: number;
  offsetMs: number;
  frameDataUrl: string;
}

export interface TraceConsoleEntry {
  level: string;
  text: string;
  time: number | null;
}

export interface TraceNetworkEntry {
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
}

export interface TraceErrorEntry {
  message: string;
  stack: string | null;
}

export interface ParsedTraceSummary {
  metadata: {
    browserName: string | null;
    baseUrl: string | null;
    viewport: { width: number; height: number } | null;
    totalDurationMs: number | null;
  };
  filmstrip: TraceFilmstripFrame[];
  steps: TraceStepSummary[];
  console: TraceConsoleEntry[];
  network: TraceNetworkEntry[];
  errors: TraceErrorEntry[];
}

export function extractZipEntries(zipBuffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minOffset; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return files;

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  let offset = zipBuffer.readUInt32LE(eocdOffset + 16);

  for (let idx = 0; idx < totalEntries && offset + 46 <= zipBuffer.length; idx++) {
    if (zipBuffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const nameLen = zipBuffer.readUInt16LE(offset + 28);
    const extraLen = zipBuffer.readUInt16LE(offset + 30);
    const commentLen = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const fileName = zipBuffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;

    if (localHeaderOffset + 30 > zipBuffer.length || zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      continue;
    }
    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      files.set(fileName, compressed);
    } else if (compressionMethod === 8) {
      try {
        files.set(fileName, zlib.inflateRawSync(compressed));
      } catch {
        // Ignore corrupt zip entry
      }
    }
  }
  return files;
}

function findFrameBuffer(entries: Map<string, Buffer>, keyOrSha1: string): string | null {
  const candidates = [
    keyOrSha1,
    `resources/${keyOrSha1}`,
    `resources/${keyOrSha1}.jpeg`,
    `resources/${keyOrSha1}.png`
  ];
  for (const key of candidates) {
    const buf = entries.get(key);
    if (buf && buf.length > 0) {
      const isPng = buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50;
      const mime = isPng ? "image/png" : "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    }
  }
  return null;
}

const INTERNAL_API_PREFIXES = [
  "tracing.",
  "browsertype.",
  "browser.",
  "browsercontext.",
  "fixture:",
  "hook:",
  "before hooks",
  "after hooks",
  "worker cleanup",
  "attach ",
  "screenshot"
];

function isUserFacingTraceStep(evt: Record<string, any>, apiName: string): boolean {
  if (evt.group === "configuration" || evt.group === "internal") return false;
  const cls = String(evt.class || "").toLowerCase();
  if (["tracing", "browsertype", "browser", "browsercontext"].includes(cls)) return false;
  const lower = apiName.trim().toLowerCase();
  if (!lower) return false;
  if (INTERNAL_API_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  if (lower === "page.screenshot" || lower === "page.close" || lower === "page.pause") return false;
  return true;
}

export function parsePlaywrightTraceArchive(zipBuffer: Buffer): ParsedTraceSummary {
  const entries = extractZipEntries(zipBuffer);

  let browserName: string | null = null;
  let baseUrl: string | null = null;
  let viewport: { width: number; height: number } | null = null;

  const callsById = new Map<string, TraceStepSummary & { userFacing: boolean }>();
  const orderedCallIds: string[] = [];
  const frames: Array<{ timestamp: number; resourceKey: string }> = [];
  const consoleEntries: TraceConsoleEntry[] = [];
  const networkEntries: TraceNetworkEntry[] = [];
  const errors: TraceErrorEntry[] = [];

  for (const [name, buf] of entries.entries()) {
    if (name.endsWith(".trace")) {
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: Record<string, any>;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }

        if (evt.type === "context-options") {
          browserName = evt.browserName || browserName;
          baseUrl = evt.options?.baseURL || baseUrl;
          if (evt.options?.viewport?.width && evt.options?.viewport?.height) {
            viewport = {
              width: Number(evt.options.viewport.width),
              height: Number(evt.options.viewport.height)
            };
          }
        } else if (evt.type === "before" && evt.callId) {
          const apiName = String(evt.title || evt.apiName || (evt.class && evt.method ? `${evt.class}.${evt.method}` : "step"));
          const selector =
            typeof evt.params?.selector === "string"
              ? evt.params.selector
              : typeof evt.params?.url === "string"
                ? evt.params.url
                : null;
          const firstFrame = Array.isArray(evt.stack) ? evt.stack[0] : null;
          const lineNum = typeof firstFrame?.line === "number" ? firstFrame.line : null;
          const startTime = typeof evt.startTime === "number" ? evt.startTime : typeof evt.wallTime === "number" ? evt.wallTime : 0;

          const compactParams: Record<string, unknown> = {};
          if (evt.params && typeof evt.params === "object") {
            for (const k of ["url", "selector", "value", "expectedText", "timeout", "strict"]) {
              if (evt.params[k] !== undefined) compactParams[k] = evt.params[k];
            }
          }

          callsById.set(String(evt.callId), {
            callId: String(evt.callId),
            apiName,
            selector,
            line: lineNum,
            startTime,
            endTime: null,
            durationMs: null,
            status: "passed",
            error: null,
            point: null,
            params: Object.keys(compactParams).length > 0 ? compactParams : null,
            beforeFrameDataUrl: null,
            frameDataUrl: null,
            userFacing: isUserFacingTraceStep(evt, apiName)
          });
          orderedCallIds.push(String(evt.callId));
        } else if (evt.type === "input" && evt.callId) {
          const step = callsById.get(String(evt.callId));
          if (step && evt.point && typeof evt.point.x === "number" && typeof evt.point.y === "number") {
            step.point = { x: Math.round(evt.point.x), y: Math.round(evt.point.y) };
          }
        } else if (evt.type === "after" && evt.callId) {
          const step = callsById.get(String(evt.callId));
          if (!step) continue;
          const endTime = typeof evt.endTime === "number" ? evt.endTime : step.startTime;
          step.endTime = endTime;
          step.durationMs = Math.max(0, Math.round(endTime - step.startTime));
          if (evt.error) {
            step.status = "failed";
            const msg = typeof evt.error?.message === "string" ? evt.error.message : String(evt.error);
            step.error = msg;
            errors.push({
              message: msg,
              stack: typeof evt.error?.stack === "string" ? evt.error.stack : null
            });
          }
        } else if (evt.type === "screencast-frame" && (evt.file || evt.sha1) && typeof evt.timestamp === "number") {
          frames.push({ timestamp: evt.timestamp, resourceKey: String(evt.file || evt.sha1) });
        } else if (evt.type === "console" && consoleEntries.length < 200) {
          consoleEntries.push({
            level: String(evt.messageType || "log"),
            text: String(evt.text || ""),
            time: typeof evt.time === "number" ? evt.time : null
          });
        } else if (evt.type === "event" && evt.method === "pageError" && evt.params?.error) {
          errors.push({
            message: String(evt.params.error.message || "Page error"),
            stack: typeof evt.params.error.stack === "string" ? evt.params.error.stack : null
          });
        }
      }
    } else if (name.endsWith(".network")) {
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim() || networkEntries.length >= 200) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type !== "resource-snapshot" || !parsed.snapshot) continue;
          const snap = parsed.snapshot;
          networkEntries.push({
            method: String(snap.request?.method || "GET"),
            url: String(snap.request?.url || ""),
            status: typeof snap.response?.status === "number" ? snap.response.status : null,
            statusText: typeof snap.response?.statusText === "string" ? snap.response.statusText : null,
            durationMs: typeof snap.time === "number" ? Math.round(snap.time) : null
          });
        } catch {
          // Ignore malformed network entry
        }
      }
    }
  }

  frames.sort((a, b) => a.timestamp - b.timestamp);
  const frameCache = new Map<string, string | null>();
  const steps: TraceStepSummary[] = [];

  const findClosestFrame = (targetTs: number) => {
    let best = frames[0];
    let bestDiff = Math.abs(frames[0].timestamp - targetTs);
    for (const f of frames) {
      const diff = Math.abs(f.timestamp - targetTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = f;
      }
    }
    if (!frameCache.has(best.resourceKey)) {
      frameCache.set(best.resourceKey, frameCache.size < 80 ? findFrameBuffer(entries, best.resourceKey) : null);
    }
    return frameCache.get(best.resourceKey) ?? null;
  };

  for (const id of orderedCallIds) {
    const { userFacing, ...step } = callsById.get(id)!;
    if (!userFacing && step.status !== "failed") continue;

    if (frames.length > 0) {
      step.beforeFrameDataUrl = findClosestFrame(step.startTime);
      step.frameDataUrl = findClosestFrame(step.endTime ?? step.startTime);
    }
    steps.push(step);
  }

  const firstStart = steps.length > 0 ? steps[0].startTime : (frames[0]?.timestamp ?? null);
  const lastEnd = steps.length > 0 ? (steps[steps.length - 1].endTime ?? steps[steps.length - 1].startTime) : (frames[frames.length - 1]?.timestamp ?? null);
  const totalDurationMs =
    firstStart !== null && lastEnd !== null ? Math.max(0, Math.round(lastEnd - firstStart)) : null;

  const filmstrip: TraceFilmstripFrame[] = [];
  if (frames.length > 0) {
    const maxFilmstrip = 32;
    const stride = Math.max(1, Math.floor(frames.length / maxFilmstrip));
    const baseTs = firstStart ?? frames[0].timestamp;
    for (let i = 0; i < frames.length && filmstrip.length < maxFilmstrip; i += stride) {
      const f = frames[i];
      if (!frameCache.has(f.resourceKey)) {
        frameCache.set(f.resourceKey, frameCache.size < 80 ? findFrameBuffer(entries, f.resourceKey) : null);
      }
      const url = frameCache.get(f.resourceKey);
      if (url) {
        filmstrip.push({
          timestamp: f.timestamp,
          offsetMs: Math.max(0, Math.round(f.timestamp - baseTs)),
          frameDataUrl: url
        });
      }
    }
  }

  return {
    metadata: { browserName, baseUrl, viewport, totalDurationMs },
    filmstrip,
    steps,
    console: consoleEntries,
    network: networkEntries,
    errors
  };
}

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
  beforeSnapshotHtml: string | null;
  afterSnapshotHtml: string | null;
  networkErrors?: TraceNetworkEntry[];
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
  timestamp?: number | null;
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
    failedNetworkCount?: number;
    consoleErrorCount?: number;
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

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr"
]);

function escapeAttr(val: unknown): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlText(val: unknown): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getSnapshotNodes(snapshot: Record<string, any>): any[] {
  if (!snapshot._nodes) {
    const nodes: any[] = [];
    const visit = (n: any) => {
      if (typeof n === "string") {
        nodes.push(n);
      } else if (Array.isArray(n) && typeof n[0] === "string") {
        for (let i = 2; i < n.length; i++) visit(n[i]);
        nodes.push(n);
      }
    };
    visit(snapshot.html);
    snapshot._nodes = nodes;
  }
  return snapshot._nodes;
}

function renderSnapshotToHtml(
  snapshotIdx: number,
  snapshotsList: Array<Record<string, any>>,
  entries: Map<string, Buffer>
): string | null {
  const rootSnap = snapshotsList[snapshotIdx];
  if (!rootSnap?.html) return null;

  const resourceMap = new Map<string, string>();
  if (Array.isArray(rootSnap.resourceOverrides)) {
    for (const ov of rootSnap.resourceOverrides) {
      if (ov?.url && ov?.sha1) {
        const buf = entries.get(`resources/${ov.sha1}`) || entries.get(String(ov.sha1));
        if (buf && buf.length > 0 && buf.length <= 512 * 1024) {
          const ext = String(ov.sha1).split(".").pop()?.toLowerCase() || "";
          const mime = ext === "css" ? "text/css" : ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "application/octet-stream";
          resourceMap.set(String(ov.url), `data:${mime};base64,${buf.toString("base64")}`);
        }
      }
    }
  }

  const baseHref = typeof rootSnap.frameUrl === "string" ? rootSnap.frameUrl : "";

  const renderNode = (node: any, curSnapIdx: number, insideStyle = false): string => {
    if (node == null) return "";
    if (typeof node === "string") {
      return insideStyle ? node : escapeHtmlText(node);
    }
    if (Array.isArray(node) && Array.isArray(node[0])) {
      const refIdx = curSnapIdx - Number(node[0][0]);
      const nodeIdx = Number(node[0][1]);
      if (refIdx >= 0 && refIdx < snapshotsList.length) {
        const refNodes = getSnapshotNodes(snapshotsList[refIdx]);
        if (nodeIdx >= 0 && nodeIdx < refNodes.length) {
          return renderNode(refNodes[nodeIdx], refIdx, insideStyle);
        }
      }
      return "";
    }
    if (!Array.isArray(node) || typeof node[0] !== "string") return "";

    const tag = node[0].toLowerCase();
    if (tag === "script" || tag === "noscript") return "";

    const attrsObj = (node[1] && typeof node[1] === "object" ? node[1] : {}) as Record<string, any>;
    const attrParts: string[] = [];
    let pwValue: string | undefined;
    let isTarget = false;
    let existingStyle = "";

    for (const [k, v] of Object.entries(attrsObj)) {
      if (k === "__playwright_value__") {
        pwValue = String(v ?? "");
        continue;
      }
      if (k === "__playwright_checked__") {
        if (v) attrParts.push("checked");
        continue;
      }
      if (k === "__playwright_selected__") {
        if (v) attrParts.push("selected");
        continue;
      }
      if (k === "__playwright_target__") {
        isTarget = true;
        continue;
      }
      if (k.startsWith("__playwright_")) continue;
      if (k.toLowerCase().startsWith("on")) continue;

      let attrVal = String(v ?? "");
      if ((k === "href" || k === "src") && resourceMap.has(attrVal)) {
        attrVal = resourceMap.get(attrVal)!;
      }
      if (k === "style") {
        existingStyle = attrVal;
        continue;
      }
      attrParts.push(`${k}="${escapeAttr(attrVal)}"`);
    }

    if (tag === "input" && pwValue !== undefined) {
      attrParts.push(`value="${escapeAttr(pwValue)}"`);
    }
    if (isTarget) {
      existingStyle = `${existingStyle ? `${existingStyle};` : ""}outline:2px solid #ef4444;outline-offset:2px;`;
    }
    if (existingStyle) {
      attrParts.push(`style="${escapeAttr(existingStyle)}"`);
    }

    const attrStr = attrParts.length ? ` ${attrParts.join(" ")}` : "";
    if (VOID_TAGS.has(tag)) {
      return `<${tag}${attrStr} />`;
    }

    const isStyleTag = tag === "style";
    let childrenHtml = "";
    if (tag === "textarea" && pwValue !== undefined) {
      childrenHtml = escapeHtmlText(pwValue);
    } else {
      for (let i = 2; i < node.length; i++) {
        childrenHtml += renderNode(node[i], curSnapIdx, isStyleTag);
      }
    }

    if (tag === "head" && baseHref) {
      childrenHtml = `<base href="${escapeAttr(baseHref)}" />${childrenHtml}`;
    }

    return `<${tag}${attrStr}>${childrenHtml}</${tag}>`;
  };

  return renderNode(rootSnap.html, snapshotIdx);
}

export function parsePlaywrightTraceArchive(zipBuffer: Buffer): ParsedTraceSummary {
  const entries = extractZipEntries(zipBuffer);

  let browserName: string | null = null;
  let baseUrl: string | null = null;
  let viewport: { width: number; height: number } | null = null;

  const callsById = new Map<
    string,
    TraceStepSummary & { userFacing: boolean; beforeSnapName: string | null; afterSnapName: string | null }
  >();
  const orderedCallIds: string[] = [];
  const frames: Array<{ timestamp: number; resourceKey: string }> = [];
  const snapshotsList: Array<Record<string, any>> = [];
  const snapshotIndexByName = new Map<string, number>();
  const consoleEntries: TraceConsoleEntry[] = [];
  const networkEntries: TraceNetworkEntry[] = [];
  const errors: TraceErrorEntry[] = [];

  const hasBrowserTraceFile = Array.from(entries.keys()).some(
    (name) => name.endsWith(".trace") && !name.endsWith("test.trace")
  );

  for (const [name, buf] of entries.entries()) {
    if (name.endsWith(".trace")) {
      const isTestRunnerTrace = name === "test.trace" || name.endsWith("/test.trace");
      const skipCallsFromThisFile = isTestRunnerTrace && hasBrowserTraceFile;
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
        } else if (evt.type === "before" && evt.callId && !skipCallsFromThisFile) {
          const callId = String(evt.callId);
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

          if (!callsById.has(callId)) {
            orderedCallIds.push(callId);
          }
          callsById.set(callId, {
            callId,
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
            beforeSnapshotHtml: null,
            afterSnapshotHtml: null,
            beforeSnapName: typeof evt.beforeSnapshot === "string" ? evt.beforeSnapshot : `before@${callId}`,
            afterSnapName: `after@${callId}`,
            userFacing: isUserFacingTraceStep(evt, apiName)
          });
        } else if (evt.type === "input" && evt.callId && !skipCallsFromThisFile) {
          const step = callsById.get(String(evt.callId));
          if (step && evt.point && typeof evt.point.x === "number" && typeof evt.point.y === "number") {
            step.point = { x: Math.round(evt.point.x), y: Math.round(evt.point.y) };
          }
        } else if (evt.type === "after" && evt.callId && !skipCallsFromThisFile) {
          const step = callsById.get(String(evt.callId));
          if (!step) continue;
          if (typeof evt.afterSnapshot === "string") {
            step.afterSnapName = evt.afterSnapshot;
          }
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
        } else if (evt.type === "frame-snapshot" && evt.snapshot) {
          const snap = evt.snapshot as Record<string, any>;
          const sIdx = snapshotsList.length;
          snapshotsList.push(snap);
          if (typeof snap.snapshotName === "string") {
            snapshotIndexByName.set(snap.snapshotName, sIdx);
          }
        } else if (evt.type === "screencast-frame" && (evt.file || evt.sha1) && typeof evt.timestamp === "number") {
          frames.push({ timestamp: evt.timestamp, resourceKey: String(evt.file || evt.sha1) });
          if (!viewport && typeof evt.width === "number" && typeof evt.height === "number" && evt.width > 0 && evt.height > 0) {
            viewport = { width: Number(evt.width), height: Number(evt.height) };
          }
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
            durationMs: typeof snap.time === "number" ? Math.round(snap.time) : null,
            timestamp: typeof snap._monotonicTime === "number" ? snap._monotonicTime : null
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

  const loadFrameUrl = (resourceKey: string): string | null => {
    if (!frameCache.has(resourceKey)) {
      frameCache.set(resourceKey, frameCache.size < 250 ? findFrameBuffer(entries, resourceKey) : null);
    }
    return frameCache.get(resourceKey) ?? null;
  };

  const findFrameAtOrBefore = (targetTs: number): string | null => {
    let chosen = frames[0];
    for (const f of frames) {
      if (f.timestamp <= targetTs) {
        chosen = f;
      } else {
        break;
      }
    }
    return loadFrameUrl(chosen.resourceKey);
  };

  const findAfterFrame = (startTs: number, endTs: number): string | null => {
    // 1. Prefer the latest frame painted during [startTs, endTs + 120ms].
    let inWindow: { timestamp: number; resourceKey: string } | null = null;
    for (const f of frames) {
      if (f.timestamp >= startTs && f.timestamp <= endTs + 120) {
        inWindow = f;
      }
    }
    if (inWindow) return loadFrameUrl(inWindow.resourceKey);

    // 2. Fast actions (e.g. Frame.fill in 2ms) often paint on the next compositor tick after endTs.
    const nextPainted = frames.find((f) => f.timestamp > startTs && f.timestamp <= endTs + 500);
    if (nextPainted) return loadFrameUrl(nextPainted.resourceKey);

    return findFrameAtOrBefore(endTs);
  };

  const filteredRawSteps = orderedCallIds
    .map((id) => callsById.get(id)!)
    .filter((s) => s.userFacing || s.status === "failed");

  const renderedSnapCache = new Map<number, string | null>();
  const getRenderedSnapshot = (snapName: string | null): string | null => {
    if (!snapName) return null;
    const sIdx = snapshotIndexByName.get(snapName);
    if (sIdx === undefined) return null;
    if (!renderedSnapCache.has(sIdx)) {
      renderedSnapCache.set(sIdx, renderedSnapCache.size < 120 ? renderSnapshotToHtml(sIdx, snapshotsList, entries) : null);
    }
    return renderedSnapCache.get(sIdx) ?? null;
  };

  const failedNetworkEntries = networkEntries.filter((n) => n.status !== null && n.status >= 400);

  for (let i = 0; i < filteredRawSteps.length; i++) {
    const { userFacing: _uf, beforeSnapName, afterSnapName, ...step } = filteredRawSteps[i];
    if (snapshotsList.length > 0) {
      step.beforeSnapshotHtml = getRenderedSnapshot(beforeSnapName);
      step.afterSnapshotHtml = getRenderedSnapshot(afterSnapName);
    }
    if (frames.length > 0) {
      const nextStepStart = filteredRawSteps[i + 1]?.startTime ?? Number.POSITIVE_INFINITY;
      const endTs = step.endTime ?? step.startTime;
      const afterCeiling = Math.min(endTs + 80, nextStepStart > endTs ? nextStepStart - 1 : endTs + 80);
      step.beforeFrameDataUrl = findFrameAtOrBefore(step.startTime);
      step.frameDataUrl = findFrameAtOrBefore(afterCeiling);
    }
    if (failedNetworkEntries.length > 0) {
      const endTs = step.endTime ?? step.startTime;
      const windowMatches = failedNetworkEntries.filter(
        (n) => typeof n.timestamp === "number" && n.timestamp >= step.startTime - 500 && n.timestamp <= endTs + 1000
      );
      if (windowMatches.length > 0) {
        step.networkErrors = windowMatches.slice(0, 10);
      } else if (step.status === "failed") {
        step.networkErrors = failedNetworkEntries.slice(0, 5);
      }
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

  const consoleErrorCount = consoleEntries.filter((c) => c.level === "error").length;

  return {
    metadata: {
      browserName,
      baseUrl,
      viewport,
      totalDurationMs,
      failedNetworkCount: failedNetworkEntries.length,
      consoleErrorCount
    },
    filmstrip,
    steps,
    console: consoleEntries,
    network: networkEntries,
    errors
  };
}

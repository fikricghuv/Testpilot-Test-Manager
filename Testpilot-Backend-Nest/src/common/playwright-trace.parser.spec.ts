import archiver from "archiver";
import { parsePlaywrightTraceArchive } from "./playwright-trace.parser";

describe("parsePlaywrightTraceArchive", () => {
  it("parses steps, frames, console, network, and errors from a Playwright trace.zip", async () => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on("data", (c) => chunks.push(Buffer.from(c)));
    const done = new Promise<Buffer>((resolve, reject) => {
      archive.on("end", () => resolve(Buffer.concat(chunks)));
      archive.on("error", reject);
    });

    const traceLines = [
      JSON.stringify({
        type: "context-options",
        browserName: "chromium",
        options: { baseURL: "https://example.com", viewport: { width: 1280, height: 720 } }
      }),
      JSON.stringify({
        type: "before",
        callId: "call@hook",
        class: "BrowserContext",
        method: "newPage",
        apiName: "browserContext.newPage",
        startTime: 900
      }),
      JSON.stringify({ type: "after", callId: "call@hook", endTime: 950 }),
      JSON.stringify({
        type: "before",
        callId: "call@1",
        apiName: "page.goto",
        params: { url: "https://example.com/login" },
        startTime: 1000,
        stack: [{ line: 4 }]
      }),
      JSON.stringify({ type: "after", callId: "call@1", endTime: 1250 }),
      JSON.stringify({
        type: "before",
        callId: "call@2",
        apiName: "expect.toContainText",
        params: { selector: "getByText('Invalid')" },
        startTime: 1300,
        stack: [{ line: 8 }]
      }),
      JSON.stringify({
        type: "after",
        callId: "call@2",
        endTime: 1800,
        error: { message: "Strict mode violation", stack: "at test.spec.ts:8:5" }
      }),
      JSON.stringify({ type: "screencast-frame", file: "screencast/page1-1255.jpeg", timestamp: 1255 }),
      JSON.stringify({
        type: "frame-snapshot",
        snapshot: {
          snapshotName: "after@call@1",
          frameUrl: "https://example.com/login",
          html: ["html", {}, ["head", {}], ["body", {}, ["input", { type: "text", __playwright_value__: "student" }]]]
        }
      }),
      JSON.stringify({ type: "console", messageType: "error", text: "Failed to load resource", time: 1400 })
    ].join("\n");

    const networkLine = JSON.stringify({
      type: "resource-snapshot",
      snapshot: {
        request: { method: "POST", url: "https://example.com/api/login" },
        response: { status: 401, statusText: "Unauthorized" },
        time: 42
      }
    });

    const testRunnerTrace = [
      JSON.stringify({
        type: "before",
        callId: "runner@1",
        apiName: "Navigate to https://example.com/login",
        startTime: 1000,
        stack: [{ line: 4 }]
      }),
      JSON.stringify({ type: "after", callId: "runner@1", endTime: 1250 })
    ].join("\n");

    archive.append(testRunnerTrace, { name: "test.trace" });
    archive.append(traceLines, { name: "0-trace.trace" });
    archive.append(networkLine, { name: "0-trace.network" });
    archive.append(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), { name: "screencast/page1-1255.jpeg" });
    await archive.finalize();

    const parsed = parsePlaywrightTraceArchive(await done);
    expect(parsed.metadata).toEqual({
      browserName: "chromium",
      baseUrl: "https://example.com",
      viewport: { width: 1280, height: 720 },
      totalDurationMs: 800,
      failedNetworkCount: 1,
      consoleErrorCount: 1
    });
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]).toMatchObject({
      apiName: "page.goto",
      line: 4,
      durationMs: 250,
      status: "passed"
    });
    expect(parsed.steps[0].frameDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(parsed.steps[0].afterSnapshotHtml).toContain('value="student"');
    expect(parsed.steps[1]).toMatchObject({
      apiName: "expect.toContainText",
      line: 8,
      status: "failed",
      error: "Strict mode violation"
    });
    expect(parsed.steps[1].networkErrors).toHaveLength(1);
    expect(parsed.console).toHaveLength(1);
    expect(parsed.network).toHaveLength(1);
    expect(parsed.errors).toHaveLength(1);
  });
});

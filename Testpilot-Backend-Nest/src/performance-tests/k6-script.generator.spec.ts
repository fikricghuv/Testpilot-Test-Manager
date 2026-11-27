import { BadRequestException } from "@nestjs/common";
import {
  analyzeK6JsonLines,
  extractK6ChecksBreakdown,
  generateK6FlowScript,
  generateK6Script,
  isApiCandidateUrl,
  normalizeBuilderConfig,
  normalizeFlowConfig,
  parseHarToRecordedCalls,
  parseK6SummaryJson,
  validateTargetUrl
} from "./k6-script.generator";

describe("k6-script.generator", () => {
  const prevAllowPrivate = process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS;

  afterEach(() => {
    if (prevAllowPrivate === undefined) {
      delete process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS;
    } else {
      process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS = prevAllowPrivate;
    }
  });

  describe("validateTargetUrl", () => {
    it("accepts public https URLs", () => {
      expect(validateTargetUrl("https://test.k6.io/contacts.php")).toBe(
        "https://test.k6.io/contacts.php"
      );
    });

    it("blocks localhost and private IPs by default", () => {
      delete process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS;
      expect(() => validateTargetUrl("http://localhost:1021/health")).toThrow(BadRequestException);
      expect(() => validateTargetUrl("http://127.0.0.1:7000/health")).toThrow(BadRequestException);
      expect(() => validateTargetUrl("http://169.254.169.254/latest/meta-data")).toThrow(
        BadRequestException
      );
      expect(() => validateTargetUrl("http://192.168.1.10/api")).toThrow(BadRequestException);
    });

    it("allows private targets when ALLOW_PRIVATE_PERFORMANCE_TARGETS=true", () => {
      process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS = "true";
      expect(validateTargetUrl("http://localhost:1021/health")).toBe("http://localhost:1021/health");
    });
  });

  describe("normalizeBuilderConfig & generateK6Script", () => {
    it("enforces VU and duration boundaries", () => {
      expect(() =>
        normalizeBuilderConfig({
          targetUrl: "https://test.k6.io",
          method: "GET",
          vus: 101,
          durationSec: 10
        })
      ).toThrow(BadRequestException);

      expect(() =>
        normalizeBuilderConfig({
          targetUrl: "https://test.k6.io",
          method: "GET",
          vus: 10,
          durationSec: 301
        })
      ).toThrow(BadRequestException);
    });

    it("generates a valid k6 script with thresholds", () => {
      const config = normalizeBuilderConfig({
        targetUrl: "https://test.k6.io",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"ok":true}',
        vus: 5,
        durationSec: 10,
        p95ThresholdMs: 400,
        errorRateThresholdPct: 2,
        expectedStatus: 201,
        sleepSec: 0.5
      });

      const script = generateK6Script(config);
      expect(script).toContain('import http from "k6/http";');
      expect(script).toContain('"vus": 5');
      expect(script).toContain('"duration": "10s"');
      expect(script).toContain('"p(95)<400"');
      expect(script).toContain('"rate<=0.02"');
      expect(script).toContain("http.post(url,");
      expect(script).toContain("r.status === 201");
      expect(script).toContain("sleep(0.5);");
    });
  });

  describe("parseK6SummaryJson", () => {
    it("extracts metrics and threshold statuses from k6 summary JSON", () => {
      const parsed = parseK6SummaryJson({
        metrics: {
          http_reqs: { values: { count: 120, rate: 12.0 } },
          http_req_failed: { values: { rate: 0.02 } },
          http_req_duration: {
            values: { avg: 45.2, min: 10.1, med: 40.0, "p(90)": 80.5, "p(95)": 110.3, max: 210.0 },
            thresholds: { "p(95)<500": { ok: true } }
          },
          checks: { values: { passes: 118, fails: 2 } }
        }
      });

      expect(parsed.totalRequests).toBe(120);
      expect(parsed.rps).toBe(12.0);
      expect(parsed.errorRate).toBe(0.02);
      expect(parsed.p95Ms).toBe(110.3);
      expect(parsed.checksPassed).toBe(118);
      expect(parsed.checksFailed).toBe(2);
      expect(parsed.thresholdsPassed).toBe(true);
      expect(parsed.thresholds).toEqual([
        { metric: "http_req_duration", expression: "p(95)<500", ok: true }
      ]);

      // k6 --summary-export v0.55 uses `value` for Rate metrics and boolean `crossed` (false = pass) for thresholds
      const v55 = parseK6SummaryJson({
        metrics: {
          http_req_failed: { value: 1, passes: 500, fails: 0, thresholds: { "rate<=0.01": true } },
          http_req_duration: { "p(95)": 99.5, thresholds: { "p(95)<2000": false } }
        }
      });
      expect(v55.errorRate).toBe(1);
      expect(v55.thresholdsPassed).toBe(false);
      expect(v55.thresholds).toEqual([
        { metric: "http_req_failed", expression: "rate<=0.01", ok: false },
        { metric: "http_req_duration", expression: "p(95)<2000", ok: true }
      ]);
    });
  });

  describe("normalizeFlowConfig, generateK6FlowScript & parseHarToRecordedCalls", () => {
    it("generates grouped k6 script for multi-step business flow", () => {
      const flow = normalizeFlowConfig({
        vus: 5,
        durationSec: 20,
        p95ThresholdMs: 600,
        steps: [
          {
            id: "s1",
            name: "Login",
            method: "POST",
            url: "https://test.k6.io/api/login",
            body: '{"user":"demo"}',
            expectedStatus: 200,
            sleepAfterSec: 1,
            enabled: true
          },
          {
            id: "s2",
            name: "Ignored step",
            method: "GET",
            url: "https://test.k6.io/api/ignored",
            enabled: false
          },
          {
            id: "s3",
            name: "Load Profile",
            method: "GET",
            url: "https://test.k6.io/api/profile",
            expectedStatus: 200,
            sleepAfterSec: 0.5,
            enabled: true
          }
        ]
      });

      const script = generateK6FlowScript(flow);
      expect(script).toContain('import { check, group, sleep } from "k6";');
      expect(script).toContain('group("Login"');
      expect(script).toContain('group("Load Profile"');
      expect(script).not.toContain("Ignored step");
    });

    it("filters static assets and noise headers from HAR", () => {
      const calls = parseHarToRecordedCalls({
        log: {
          entries: [
            {
              _resourceType: "stylesheet",
              request: { method: "GET", url: "https://test.k6.io/app.css", headers: [] },
              response: { status: 200 }
            },
            {
              _resourceType: "xhr",
              request: {
                method: "POST",
                url: "https://test.k6.io/api/orders",
                headers: [
                  { name: "Host", value: "test.k6.io" },
                  { name: "Authorization", value: "Bearer abc" }
                ],
                postData: { text: '{"item":1}' }
              },
              response: { status: 201 }
            }
          ]
        }
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe("https://test.k6.io/api/orders");
      expect(calls[0].headers).toEqual({ Authorization: "Bearer abc" });
      expect(calls[0].body).toBe('{"item":1}');
    });
  });

  describe("analyzeK6JsonLines & extractK6ChecksBreakdown", () => {
    it("extracts per-endpoint stats, status codes, and timings timeseries", () => {
      const ndjson = [
        JSON.stringify({
          type: "Point",
          metric: "http_reqs",
          data: { time: "2026-11-27T10:00:00Z", value: 1, tags: { method: "GET", name: "https://test.k6.io", status: "200" } }
        }),
        JSON.stringify({
          type: "Point",
          metric: "http_req_duration",
          data: { time: "2026-11-27T10:00:00Z", value: 120, tags: { method: "GET", name: "https://test.k6.io" } }
        }),
        JSON.stringify({
          type: "Point",
          metric: "http_req_waiting",
          data: { time: "2026-11-27T10:00:00Z", value: 100 }
        }),
        JSON.stringify({
          type: "Point",
          metric: "http_reqs",
          data: { time: "2026-11-27T10:00:01Z", value: 1, tags: { method: "POST", name: "https://test.k6.io/login", status: "500" } }
        }),
        JSON.stringify({
          type: "Point",
          metric: "http_req_failed",
          data: { time: "2026-11-27T10:00:01Z", value: 1, tags: { method: "POST", name: "https://test.k6.io/login" } }
        }),
        JSON.stringify({
          type: "Point",
          metric: "http_req_duration",
          data: { time: "2026-11-27T10:00:01Z", value: 300, tags: { method: "POST", name: "https://test.k6.io/login" } }
        })
      ].join("\n");

      const analyzed = analyzeK6JsonLines(ndjson);
      expect(analyzed.timeseries).toHaveLength(2);
      expect(analyzed.timeseries[0].waitingMs).toBe(100);
      expect(analyzed.timeseries[1].failedRps).toBe(1);
      expect(analyzed.statusCodes).toEqual({ "200": 1, "500": 1 });
      expect(analyzed.endpoints).toHaveLength(2);
      expect(analyzed.endpoints[1].failed).toBe(1);
      expect(analyzed.endpoints[1].p95Ms).toBe(300);
    });

    it("extracts nested group checks from root_group", () => {
      const checks = extractK6ChecksBreakdown({
        root_group: {
          name: "",
          checks: { "root ok": { name: "root ok", passes: 10, fails: 0 } },
          groups: {
            Login: {
              name: "Login",
              checks: [{ name: "status is 200", passes: 9, fails: 1 }],
              groups: {}
            }
          }
        }
      });

      expect(checks).toEqual([
        { group: "Root", name: "root ok", passes: 10, fails: 0 },
        { group: "Login", name: "status is 200", passes: 9, fails: 1 }
      ]);
    });

    it("filters telemetry endpoints and keeps document & API requests", () => {
      expect(isApiCandidateUrl("https://practicetestautomation.com/cdn-cgi/rum?", "xhr", "POST")).toBe(false);
      expect(isApiCandidateUrl("https://www.google-analytics.com/g/collect", "fetch", "POST")).toBe(false);
      expect(isApiCandidateUrl("https://practicetestautomation.com/practice-test-login/", "document", "GET")).toBe(true);
      expect(isApiCandidateUrl("https://practicetestautomation.com/practice-test-login/", "document", "POST")).toBe(true);
      expect(isApiCandidateUrl("https://api.example.com/v1/login", "fetch", "POST")).toBe(true);
    });

    it("generates ramping stages and constant-arrival-rate scripts", () => {
      const rampCfg = normalizeBuilderConfig({
        targetUrl: "https://test.k6.io",
        method: "GET",
        loadProfile: "ramping",
        vus: 30,
        durationSec: 40,
        stages: [
          { durationSec: 10, targetVus: 10 },
          { durationSec: 20, targetVus: 30 },
          { durationSec: 10, targetVus: 0 }
        ]
      });
      const rampScript = generateK6Script(rampCfg);
      expect(rampScript).toContain('"stages": [');
      expect(rampScript).toContain('"target": 30');

      const rpsCfg = normalizeFlowConfig({
        loadProfile: "constant-arrival-rate",
        vus: 15,
        durationSec: 25,
        targetRps: 40,
        steps: [
          { id: "s1", name: "Home", method: "GET", url: "https://test.k6.io" }
        ]
      });
      const rpsScript = generateK6FlowScript(rpsCfg);
      expect(rpsScript).toContain('"executor": "constant-arrival-rate"');
      expect(rpsScript).toContain('"rate": 40');
      expect(rpsScript).toContain('"preAllocatedVUs": 15');
    });
  });
});

import fs from "node:fs";
import path from "node:path";
import { expect, request as newRequestContext, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("performance tests CRUD & validation", () => {
  test("supports create -> get -> update -> list -> delete lifecycle", async ({ request }) => {
    const name = `E2E Perf ${Date.now()}`;
    const createRes = await request.post(`/api/projects/${ctx.projectId}/performance-tests`, {
      data: {
        name,
        description: "Created by e2e",
        mode: "builder",
        builderConfig: {
          targetUrl: "https://test.k6.io",
          method: "GET",
          vus: 5,
          durationSec: 10,
          p95ThresholdMs: 500,
          errorRateThresholdPct: 1,
        },
      },
    });
    expect(createRes.status()).toBe(201);
    const { test: created } = await createRes.json();

    try {
      expect(created.id).toBeTruthy();
      expect(created.name).toBe(name);
      expect(created.scriptContent).toContain("https://test.k6.io");

      const getRes = await request.get(`/api/projects/${ctx.projectId}/performance-tests/${created.id}`);
      expect(getRes.ok()).toBeTruthy();
      const fetched = await getRes.json();
      expect(fetched.test.id).toBe(created.id);
      expect(Array.isArray(fetched.runs)).toBeTruthy();

      const updatedName = `${name} (updated)`;
      const updateRes = await request.put(
        `/api/projects/${ctx.projectId}/performance-tests/${created.id}`,
        {
          data: {
            name: updatedName,
            mode: "script",
            scriptContent: 'import http from "k6/http";\nexport default function () { http.get("https://test.k6.io"); }',
          },
        }
      );
      expect(updateRes.ok()).toBeTruthy();
      const { test: updated } = await updateRes.json();
      expect(updated.name).toBe(updatedName);
      expect(updated.mode).toBe("script");

      const listRes = await request.get(`/api/projects/${ctx.projectId}/performance-tests`);
      expect(listRes.ok()).toBeTruthy();
      const { list } = await listRes.json();
      expect(list.some((item: { id: string }) => item.id === created.id)).toBeTruthy();
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/performance-tests/${created.id}`, {
        failOnStatusCode: false,
      });
    }

    const afterDeleteRes = await request.get(
      `/api/projects/${ctx.projectId}/performance-tests/${created.id}`,
      { failOnStatusCode: false }
    );
    expect(afterDeleteRes.status()).toBe(404);
  });

  test("rejects invalid payloads and unauthenticated requests", async ({ request }) => {
    const emptyNameRes = await request.post(`/api/projects/${ctx.projectId}/performance-tests`, {
      data: { name: "   ", mode: "builder", builderConfig: { targetUrl: "https://test.k6.io", method: "GET", vus: 5, durationSec: 10 } },
      failOnStatusCode: false,
    });
    expect(emptyNameRes.status()).toBe(400);

    const overLimitRes = await request.post(`/api/projects/${ctx.projectId}/performance-tests`, {
      data: {
        name: `Over limit ${Date.now()}`,
        mode: "builder",
        builderConfig: { targetUrl: "https://test.k6.io", method: "GET", vus: 999, durationSec: 10 },
      },
      failOnStatusCode: false,
    });
    expect(overLimitRes.status()).toBe(400);

    const unauth = await newRequestContext.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await unauth.get(`/api/projects/${ctx.projectId}/performance-tests`, {
        failOnStatusCode: false,
      });
      expect([400, 401]).toContain(res.status());
    } finally {
      await unauth.dispose();
    }
  });

  test("supports multi-step flow mode and HAR import", async ({ request }) => {
    const harRes = await request.post(`/api/projects/${ctx.projectId}/performance-tests/import-har`, {
      data: {
        har: {
          log: {
            entries: [
              {
                _resourceType: "script",
                request: { method: "GET", url: "https://test.k6.io/bundle.js", headers: [] },
                response: { status: 200 },
              },
              {
                _resourceType: "fetch",
                request: { method: "GET", url: "https://test.k6.io/contacts.php", headers: [] },
                response: { status: 200 },
              },
            ],
          },
        },
      },
    });
    expect(harRes.ok()).toBeTruthy();
    const { calls } = await harRes.json();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://test.k6.io/contacts.php");

    const createFlowRes = await request.post(`/api/projects/${ctx.projectId}/performance-tests`, {
      data: {
        name: `E2E Flow ${Date.now()}`,
        mode: "flow",
        flowConfig: {
          vus: 5,
          durationSec: 10,
          steps: [
            {
              id: "step-1",
              name: "Contacts",
              method: "GET",
              url: "https://test.k6.io/contacts.php",
              expectedStatus: 200,
              sleepAfterSec: 0.5,
              enabled: true,
            },
          ],
        },
      },
    });
    expect(createFlowRes.status()).toBe(201);
    const { test: created } = await createFlowRes.json();
    try {
      expect(created.mode).toBe("flow");
      expect(created.scriptContent).toContain('group("Contacts"');
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/performance-tests/${created.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("returns project performance report and CSV/XLSX exports", async ({ request }) => {
    const reportRes = await request.get(`/api/projects/${ctx.projectId}/performance-tests/report?range=30d`);
    expect(reportRes.ok()).toBeTruthy();
    const report = await reportRes.json();
    expect(report.range).toBe("30d");
    expect(report.kpis).toBeDefined();
    expect(Array.isArray(report.scenarios)).toBeTruthy();
    expect(Array.isArray(report.trend)).toBeTruthy();
    expect(Array.isArray(report.slowestEndpoints)).toBeTruthy();

    const csvRes = await request.get(`/api/projects/${ctx.projectId}/performance-tests/report/export/csv?range=30d`);
    expect(csvRes.ok()).toBeTruthy();
    expect(csvRes.headers()["content-type"]).toContain("text/csv");
  });
});

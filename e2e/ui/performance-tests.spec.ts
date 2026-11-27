import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("performance tests UI", () => {
  test("creates and views a performance scenario from the Performance page", async ({ page, request }) => {
    const scenarioName = `E2E UI Perf ${Date.now()}`;
    let createdId: string | null = null;

    try {
      await page.goto(`/projects/${ctx.projectId}/performance`);
      await expect(page.getByRole("heading", { name: "Performance Tests" })).toBeVisible();

      await page.getByTestId("new-performance-test-btn").click();
      await page.getByPlaceholder("e.g. Checkout API Smoke Load").fill(scenarioName);
      await page.locator("form").getByRole("button", { name: "Create Scenario" }).click();

      await page.waitForURL(new RegExp(`/projects/${ctx.projectId}/performance/[0-9a-f-]+`));
      const urlParts = page.url().split("/");
      createdId = urlParts[urlParts.length - 1] ?? null;

      await expect(page.getByRole("heading", { name: scenarioName })).toBeVisible();

      // Verify persistence via API
      const listRes = await request.get(`${env.apiBaseUrl}/api/projects/${ctx.projectId}/performance-tests`);
      expect(listRes.ok()).toBeTruthy();
      const { list } = await listRes.json();
      expect(list.some((item: { id: string; name: string }) => item.id === createdId && item.name === scenarioName)).toBeTruthy();
    } finally {
      if (createdId) {
        await request.delete(`${env.apiBaseUrl}/api/projects/${ctx.projectId}/performance-tests/${createdId}`, {
          failOnStatusCode: false,
        });
      }
    }
  });
});

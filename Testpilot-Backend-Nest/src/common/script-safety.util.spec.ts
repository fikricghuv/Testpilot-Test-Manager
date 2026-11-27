import { BadRequestException } from "@nestjs/common";
import { assertSafePlaywrightScript, assertSafeTargetUrl } from "./script-safety.util";

describe("script-safety.util", () => {
  describe("assertSafePlaywrightScript", () => {
    it("allows normal Playwright test scripts", () => {
      const safe = `
        import { test, expect } from "@playwright/test";
        test("login", async ({ page }) => {
          await page.goto("https://example.com/login");
          await page.getByLabel("Email").fill("qa@example.com");
          await expect(page).toHaveURL(/dashboard/);
        });
      `;
      expect(() => assertSafePlaywrightScript(safe)).not.toThrow();
    });

    it("blocks child_process, vm, eval, process.kill, and sensitive file paths", () => {
      expect(() => assertSafePlaywrightScript(`import { exec } from "node:child_process";`)).toThrow(
        BadRequestException
      );
      expect(() => assertSafePlaywrightScript(`const cp = require("child_process");`)).toThrow(BadRequestException);
      expect(() => assertSafePlaywrightScript(`const vm = require("vm");`)).toThrow(BadRequestException);
      expect(() => assertSafePlaywrightScript(`eval("process.exit(1)");`)).toThrow(BadRequestException);
      expect(() => assertSafePlaywrightScript(`process.kill(1, "SIGKILL");`)).toThrow(BadRequestException);
      expect(() => assertSafePlaywrightScript(`fs.readFileSync("/etc/passwd", "utf8");`)).toThrow(BadRequestException);
      expect(() => assertSafePlaywrightScript(`fs.readFileSync(".env", "utf8");`)).toThrow(BadRequestException);
    });
  });

  describe("assertSafeTargetUrl", () => {
    const prevAuto = process.env.ALLOW_PRIVATE_AUTOMATION_TARGETS;
    const prevPerf = process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS;

    afterEach(() => {
      if (prevAuto === undefined) delete process.env.ALLOW_PRIVATE_AUTOMATION_TARGETS;
      else process.env.ALLOW_PRIVATE_AUTOMATION_TARGETS = prevAuto;
      if (prevPerf === undefined) delete process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS;
      else process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS = prevPerf;
    });

    it("allows public HTTPS URLs and blocks private/metadata targets by default", () => {
      delete process.env.ALLOW_PRIVATE_AUTOMATION_TARGETS;
      delete process.env.ALLOW_PRIVATE_PERFORMANCE_TARGETS;

      expect(assertSafeTargetUrl("https://example.com/login")).toBe("https://example.com/login");
      expect(() => assertSafeTargetUrl("ftp://invalid.local")).toThrow(BadRequestException);
      expect(() => assertSafeTargetUrl("http://127.0.0.1:1011/api")).toThrow(BadRequestException);
      expect(() => assertSafeTargetUrl("http://169.254.169.254/latest/meta-data/")).toThrow(BadRequestException);
      expect(() => assertSafeTargetUrl("http://localhost:1010")).toThrow(BadRequestException);
    });

    it("allows private targets when ALLOW_PRIVATE_AUTOMATION_TARGETS=true", () => {
      process.env.ALLOW_PRIVATE_AUTOMATION_TARGETS = "true";
      expect(assertSafeTargetUrl("http://localhost:1010/")).toBe("http://localhost:1010/");
    });
  });
});

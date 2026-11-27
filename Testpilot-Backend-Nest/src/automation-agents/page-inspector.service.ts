import { Injectable, Logger } from "@nestjs/common";
import { chromium } from "playwright";
import { INSPECT_TIMEOUT_MS } from "./automation-agents.constants";
import type { DecryptedAutomationAuth, InteractiveElement, PageSnapshot } from "./automation-agents.types";

@Injectable()
export class PageInspectorService {
  private readonly logger = new Logger(PageInspectorService.name);

  /**
   * Opens targetUrl in a real headless Chromium browser (with optional project auth/storageState)
   * and extracts both Playwright's official ARIA snapshot and verified interactive element locators.
   */
  async inspectPage(targetUrl: string, auth?: DecryptedAutomationAuth | null): Promise<PageSnapshot> {
    const browser = await chromium.launch({ headless: true });
    try {
      let storageState: Record<string, unknown> | undefined;
      if (auth?.storageStateJson) {
        try {
          storageState = JSON.parse(auth.storageStateJson) as Record<string, unknown>;
        } catch {
          this.logger.warn("Invalid storageState JSON in project_automation_auth; ignoring.");
        }
      }

      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        ...(storageState ? { storageState: storageState as never } : {})
      });
      const page = await context.newPage();
      page.setDefaultTimeout(INSPECT_TIMEOUT_MS);

      // Optional credential-based pre-login when no storageState is provided.
      if (!storageState && auth?.loginUrl && auth.username && auth.password) {
        try {
          await page.goto(auth.loginUrl, { waitUntil: "domcontentloaded", timeout: INSPECT_TIMEOUT_MS });
          const userInput = page.locator("input[type='email'], input[name*='user' i], input[name*='email' i], input[type='text']").first();
          const passInput = page.locator("input[type='password']").first();
          if ((await userInput.count()) > 0 && (await passInput.count()) > 0) {
            await userInput.fill(auth.username);
            await passInput.fill(auth.password);
            const submitBtn = page.locator("button[type='submit'], input[type='submit'], button:has-text('Sign in'), button:has-text('Log in'), button:has-text('Login')").first();
            if ((await submitBtn.count()) > 0) {
              await Promise.allSettled([page.waitForLoadState("networkidle", { timeout: 8000 }), submitBtn.click()]);
            }
          }
        } catch (err) {
          this.logger.warn(`Pre-login attempt failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: INSPECT_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

      const title = await page.title().catch(() => "");
      const url = page.url();
      const ariaSnapshot = await page
        .locator("body")
        .ariaSnapshot()
        .catch(() => "");

      const interactiveElements = await page.evaluate((): InteractiveElement[] => {
        const clean = (s: unknown) => String(s || "").replace(/\s+/g, " ").trim();
        const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

        const candidates = Array.from(
          document.querySelectorAll(
            "a[href], button, input, textarea, select, [role='button'], [role='link'], [role='textbox'], [role='checkbox'], [role='combobox'], [data-testid], [data-test-id]"
          )
        );

        const out: InteractiveElement[] = [];
        for (const el of candidates) {
          if (out.length >= 120) break;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || (rect.width === 0 && rect.height === 0)) {
            continue;
          }

          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute("type");
          const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-pw");
          const placeholder = clean(el.getAttribute("placeholder")) || null;
          const id = el.id && /^[a-zA-Z][\w-]*$/.test(el.id) ? el.id : null;
          const text = clean((el as HTMLElement).innerText || el.textContent).slice(0, 80) || null;

          let label: string | null = clean(el.getAttribute("aria-label")) || null;
          if (!label && el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) label = clean(lbl.textContent) || null;
          }
          if (!label) {
            const parentLbl = el.closest("label");
            if (parentLbl) label = clean(parentLbl.textContent) || null;
          }

          let role = clean(el.getAttribute("role")).toLowerCase() || null;
          if (!role) {
            if (tag === "button") role = "button";
            else if (tag === "a" && el.hasAttribute("href")) role = "link";
            else if (tag === "select") role = "combobox";
            else if (tag === "textarea") role = "textbox";
            else if (tag === "input") {
              const t = (type || "text").toLowerCase();
              if (["button", "submit", "reset"].includes(t)) role = "button";
              else if (t === "checkbox") role = "checkbox";
              else if (t === "radio") role = "radio";
              else role = "textbox";
            }
          }

          let playwrightLocator = "";
          if (testId) {
            playwrightLocator = `page.getByTestId('${esc(testId)}')`;
          } else if (role && (label || text)) {
            const acc = (label || text || "").slice(0, 60);
            playwrightLocator = `page.getByRole('${role}', { name: '${esc(acc)}' })`;
          } else if (label && ["input", "textarea", "select"].includes(tag)) {
            playwrightLocator = `page.getByLabel('${esc(label.slice(0, 60))}')`;
          } else if (placeholder) {
            playwrightLocator = `page.getByPlaceholder('${esc(placeholder.slice(0, 60))}')`;
          } else if (id) {
            playwrightLocator = `page.locator('#${esc(id)}')`;
          } else if (text) {
            playwrightLocator = `page.getByText('${esc(text.slice(0, 50))}')`;
          } else {
            const nameAttr = el.getAttribute("name");
            playwrightLocator = nameAttr
              ? `page.locator('${tag}[name="${esc(nameAttr)}"]')`
              : `page.locator('${tag}')`;
          }

          out.push({
            tag,
            type,
            role,
            label,
            placeholder,
            text,
            testId,
            id,
            playwrightLocator
          });
        }
        return out;
      });

      return {
        url,
        title,
        ariaSnapshot: ariaSnapshot.slice(0, 12_000),
        interactiveElements
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

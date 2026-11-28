import { Injectable, Logger } from "@nestjs/common";
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import { INSPECT_TIMEOUT_MS } from "./automation-agents.constants";
import type {
  DecryptedAutomationAuth,
  InteractiveElement,
  MultiPageExplorationResult,
  PageConsoleIssue,
  PageFailedRequest,
  PageSnapshot
} from "./automation-agents.types";

const DESTRUCTIVE_ACTION_RE = /\b(delete|remove|destroy|logout|log out|sign out|revoke|reset|cancel subscription|terminate)\b/i;

function escapeSingleQuote(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

@Injectable()
export class PageInspectorService {
  private readonly logger = new Logger(PageInspectorService.name);

  private async openAuthenticatedPage(
    targetUrl: string,
    auth?: DecryptedAutomationAuth | null
  ): Promise<{
    browser: Awaited<ReturnType<typeof chromium.launch>>;
    context: BrowserContext;
    page: Page;
    consoleErrors: PageConsoleIssue[];
    pageErrors: string[];
    failedRequests: PageFailedRequest[];
  }> {
    const browser = await chromium.launch({ headless: true });
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

    const consoleErrors: PageConsoleIssue[] = [];
    const pageErrors: string[] = [];
    const failedRequests: PageFailedRequest[] = [];

    page.on("console", (msg) => {
      if ((msg.type() === "error" || msg.type() === "warning") && consoleErrors.length < 30) {
        consoleErrors.push({ level: msg.type(), text: msg.text().slice(0, 300) });
      }
    });
    page.on("pageerror", (err) => {
      if (pageErrors.length < 20) {
        pageErrors.push((err instanceof Error ? err.message : String(err)).slice(0, 300));
      }
    });
    page.on("response", (res) => {
      if (res.status() >= 400 && failedRequests.length < 30) {
        failedRequests.push({ method: res.request().method(), url: res.url().slice(0, 300), status: res.status() });
      }
    });

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

    return { browser, context, page, consoleErrors, pageErrors, failedRequests };
  }

  private buildPlaywrightLocatorFromMeta(frame: Frame, el: InteractiveElement): Locator | null {
    try {
      if (el.testId) return frame.getByTestId(el.testId);
      if (el.role && (el.label || el.text)) {
        return frame.getByRole(el.role as never, { name: (el.label || el.text || "").slice(0, 60) });
      }
      if (el.label && ["input", "textarea", "select"].includes(el.tag)) {
        return frame.getByLabel(el.label.slice(0, 60));
      }
      if (el.placeholder) return frame.getByPlaceholder(el.placeholder.slice(0, 60));
      if (el.id) return frame.locator(`#${el.id}`);
      if (el.text) return frame.getByText(el.text.slice(0, 50));
    } catch {
      return null;
    }
    return null;
  }

  private async collectFrameElements(
    frame: Frame,
    framePrefix: string | null,
    frameUrl: string | null
  ): Promise<InteractiveElement[]> {
    const rawElements = await frame.evaluate((): InteractiveElement[] => {
      const clean = (s: unknown) => String(s || "").replace(/\s+/g, " ").trim();
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

      const candidates = Array.from(
        document.querySelectorAll(
          "a[href], button, input, textarea, select, [role='button'], [role='link'], [role='textbox'], [role='checkbox'], [role='combobox'], [role='tab'], [data-testid], [data-test-id]"
        )
      );

      const out: InteractiveElement[] = [];
      for (const el of candidates) {
        if (out.length >= 100) break;
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
    }).catch(() => []);

    // Validate strict-mode uniqueness (count === 1) for up to 50 elements to keep inspection fast
    const validated: InteractiveElement[] = [];
    for (let i = 0; i < rawElements.length; i++) {
      const el = rawElements[i];
      let locatorStr = framePrefix ? el.playwrightLocator.replace(/^page\./, `${framePrefix}.`) : el.playwrightLocator;
      let matchCount: number | undefined;

      if (i < 50) {
        const pwLocator = this.buildPlaywrightLocatorFromMeta(frame, el);
        if (pwLocator) {
          matchCount = await pwLocator.count().catch(() => undefined);
          if (typeof matchCount === "number" && matchCount > 1) {
            if (el.id) {
              const idCount = await frame.locator(`#${el.id}`).count().catch(() => 0);
              if (idCount === 1) {
                locatorStr = `${framePrefix ?? "page"}.locator('#${escapeSingleQuote(el.id)}')`;
                matchCount = 1;
              }
            } else if (el.text && !locatorStr.includes("hasText")) {
              const filteredCount = await pwLocator.filter({ hasText: el.text.slice(0, 40) }).count().catch(() => 0);
              if (filteredCount === 1) {
                locatorStr = `${locatorStr}.filter({ hasText: '${escapeSingleQuote(el.text.slice(0, 40))}' })`;
                matchCount = 1;
              } else {
                locatorStr = `${locatorStr}.first()`;
              }
            } else {
              locatorStr = `${locatorStr}.first()`;
            }
          }
        }
      }

      validated.push({
        ...el,
        playwrightLocator: locatorStr,
        ...(frameUrl ? { frameUrl } : {}),
        ...(typeof matchCount === "number" ? { strictMatchCount: matchCount } : {})
      });
    }

    return validated;
  }

  private async captureSnapshot(
    page: Page,
    consoleErrors: PageConsoleIssue[],
    pageErrors: string[],
    failedRequests: PageFailedRequest[]
  ): Promise<PageSnapshot> {
    const title = await page.title().catch(() => "");
    const url = page.url();
    const ariaSnapshot = await page.locator("body").ariaSnapshot().catch(() => "");

    const mainElements = await this.collectFrameElements(page.mainFrame(), null, null);
    const childElements: InteractiveElement[] = [];

    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      const fUrl = frame.url();
      if (!fUrl || fUrl === "about:blank") continue;
      const frameSelector = frame.name()
        ? `iframe[name="${escapeSingleQuote(frame.name())}"]`
        : `iframe[src*="${escapeSingleQuote(fUrl.slice(0, 60))}"]`;
      const prefix = `page.frameLocator('${frameSelector}')`;
      const elems = await this.collectFrameElements(frame, prefix, fUrl);
      childElements.push(...elems.slice(0, 25));
      if (childElements.length >= 40) break;
    }

    return {
      url,
      title,
      ariaSnapshot: ariaSnapshot.slice(0, 12_000),
      interactiveElements: [...mainElements, ...childElements].slice(0, 120),
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      failedRequests: [...failedRequests]
    };
  }

  /**
   * Opens targetUrl in a real headless Chromium browser (with optional project auth/storageState)
   * and extracts Playwright's ARIA snapshot, strict-mode validated interactive elements (including iframes),
   * and runtime console/network diagnostics.
   */
  async inspectPage(targetUrl: string, auth?: DecryptedAutomationAuth | null): Promise<PageSnapshot> {
    const { browser, page, consoleErrors, pageErrors, failedRequests } = await this.openAuthenticatedPage(targetUrl, auth);
    try {
      return await this.captureSnapshot(page, consoleErrors, pageErrors, failedRequests);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * Safely explores up to `maxSteps` non-destructive links/tabs/triggers on the same origin
   * to discover multi-page routes, modals, and state transitions for the Explorer Agent.
   */
  async exploreInteractiveFlows(
    targetUrl: string,
    auth?: DecryptedAutomationAuth | null,
    maxSteps = 4
  ): Promise<MultiPageExplorationResult> {
    const { browser, page, consoleErrors, pageErrors, failedRequests } = await this.openAuthenticatedPage(targetUrl, auth);
    try {
      const origin = new URL(targetUrl).origin;
      const visitedPages: PageSnapshot[] = [];
      const visitedUrls = new Set<string>();

      const initial = await this.captureSnapshot(page, consoleErrors, pageErrors, failedRequests);
      visitedPages.push(initial);
      visitedUrls.add(initial.url);

      const candidateTriggers = initial.interactiveElements.filter((el) => {
        if (el.strictMatchCount === 0) return false;
        const label = `${el.label || ""} ${el.text || ""}`.trim();
        if (!label || DESTRUCTIVE_ACTION_RE.test(label)) return false;
        return el.tag === "a" || el.role === "tab" || el.role === "link" || el.tag === "button";
      });

      let stepsDone = 0;
      for (const trigger of candidateTriggers) {
        if (stepsDone >= maxSteps) break;
        const pwLoc = this.buildPlaywrightLocatorFromMeta(page.mainFrame(), trigger);
        if (!pwLoc) continue;

        try {
          const count = await pwLoc.count().catch(() => 0);
          if (count !== 1) continue;
          const isVisible = await pwLoc.isVisible().catch(() => false);
          if (!isVisible) continue;

          await pwLoc.click({ timeout: 3000 });
          await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);

          const currentUrl = page.url();
          if (new URL(currentUrl).origin !== origin) {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: INSPECT_TIMEOUT_MS }).catch(() => undefined);
            continue;
          }

          if (!visitedUrls.has(currentUrl) || trigger.tag === "button" || trigger.role === "tab") {
            const snap = await this.captureSnapshot(page, consoleErrors, pageErrors, failedRequests);
            visitedPages.push(snap);
            visitedUrls.add(currentUrl);
            stepsDone++;
          }

          if (currentUrl !== initial.url) {
            await page.goto(initial.url, { waitUntil: "domcontentloaded", timeout: INSPECT_TIMEOUT_MS }).catch(() => undefined);
            await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
          }
        } catch {
          // Ignore non-navigable or transient UI triggers during safe exploration
        }
      }

      return {
        entryUrl: targetUrl,
        visitedPages,
        discoveredRoutes: Array.from(visitedUrls)
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

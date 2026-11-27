const STORAGE_KEY = "testpilotRecorderSessions";

async function getSessions() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function setSessions(sessions) {
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
}

async function broadcastToTab(tabId, session) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SESSION_UPDATED", session });
  } catch {
    // Tab might still be loading or not have content script yet
  }
}

function compilePlaywrightScript(session) {
  const title = session.testcaseExternalId
    ? `[${session.testcaseExternalId}] ${session.testcaseTitle || "Recorded test"}`
    : session.testcaseTitle || "Recorded test";
  const lines = (session.steps || []).map((s) => `  ${s.code}`);
  return [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test(${JSON.stringify(title)}, async ({ page }) => {`,
    ...(lines.length ? lines : [`  await page.goto(${JSON.stringify(session.targetUrl || "https://example.com")});`]),
    `});`,
    ``
  ].join("\n");
}

function collectVerifiedLocators(session) {
  const map = {};
  (session.steps || []).forEach((s, idx) => {
    if (s.locator) {
      map[`step_${idx + 1}:${s.kind}`] = s.locator;
    }
  });
  return map;
}

function unescapeQuotes(str) {
  return String(str || "").replace(/\\(['"`])/g, "$1");
}

function parsePlaywrightSpecToDebugSteps(scriptContent, fallbackUrl) {
  const rawLines = String(scriptContent || "").split(/\r?\n/);

  // Group multi-line `await ...;` statements while preserving their starting line number.
  const statements = [];
  let buffer = "";
  let bufferStartLine = 1;
  for (let i = 0; i < rawLines.length; i++) {
    const lineNum = i + 1;
    const trimmed = rawLines[i].trim();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("import ") ||
      trimmed.startsWith("test(") ||
      trimmed.startsWith("await test.step(") ||
      trimmed.startsWith("test.step(") ||
      trimmed === "});" ||
      trimmed === "}"
    ) {
      continue;
    }
    if (!buffer) bufferStartLine = lineNum;
    buffer = buffer ? `${buffer} ${trimmed}` : trimmed;
    if (trimmed.endsWith(";") || (!trimmed.endsWith(".") && !trimmed.endsWith("(") && !trimmed.endsWith(","))) {
      statements.push({ line: bufferStartLine, text: buffer.replace(/;\s*$/, "") });
      buffer = "";
    }
  }
  if (buffer) {
    statements.push({ line: bufferStartLine, text: buffer.replace(/;\s*$/, "") });
  }

  // Track simple `const foo = page.locator(...)` aliases so `await foo.click()` resolves accurately.
  const aliases = new Map();
  const resolveAliases = (expr) => {
    const m = expr.match(/^([a-zA-Z_$][\w$]*)\.(.*)$/);
    if (m && aliases.has(m[1])) {
      return `${aliases.get(m[1])}.${m[2]}`;
    }
    return aliases.get(expr) || expr;
  };

  const steps = [];

  for (const { line: lineNum, text: line } of statements) {
    const aliasMatch = line.match(/^(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*(page\..+)$/);
    if (aliasMatch) {
      aliases.set(aliasMatch[1], aliasMatch[2]);
      continue;
    }

    const gotoMatch = line.match(/^await\s+page\.goto\(\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    if (gotoMatch) {
      let url = unescapeQuotes(gotoMatch[2]);
      if (url.startsWith("/") && fallbackUrl) {
        try {
          url = new URL(url, fallbackUrl).toString();
        } catch {}
      }
      steps.push({ kind: "GOTO", url, label: url, line: lineNum, status: "pending", code: line });
      continue;
    }

    const body = line.replace(/^await\s+/, "");

    const clickMatch = body.match(/^(.+?)\.click\([^)]*\)$/);
    if (clickMatch) {
      const loc = resolveAliases(clickMatch[1].trim());
      if (loc.startsWith("page.")) {
        steps.push({ kind: "CLICK", locatorExpr: loc, label: loc.replace(/^page\./, ""), line: lineNum, status: "pending", code: line });
        continue;
      }
    }

    const fillMatch = body.match(/^(.+?)\.(?:fill|type|pressSequentially)\(\s*(?:(['"`])((?:\\.|(?!\2).)*)\2|.+?\?\?\s*(['"`])((?:\\.|(?!\4).)*)\4)\s*(?:,[^)]*)?\)$/);
    if (fillMatch) {
      const loc = resolveAliases(fillMatch[1].trim());
      const val = unescapeQuotes(fillMatch[3] ?? fillMatch[5] ?? "");
      if (loc.startsWith("page.")) {
        steps.push({ kind: "FILL", locatorExpr: loc, value: val, label: `${loc.replace(/^page\./, "")} = "${val}"`, line: lineNum, status: "pending", code: line });
        continue;
      }
    }

    const selectMatch = body.match(/^(.+?)\.selectOption\(\s*(['"`])((?:\\.|(?!\2).)*)\2\s*\)$/);
    if (selectMatch) {
      const loc = resolveAliases(selectMatch[1].trim());
      const val = unescapeQuotes(selectMatch[3]);
      if (loc.startsWith("page.")) {
        steps.push({ kind: "SELECT", locatorExpr: loc, value: val, label: loc.replace(/^page\./, ""), line: lineNum, status: "pending", code: line });
        continue;
      }
    }

    const checkMatch = body.match(/^(.+?)\.(check|uncheck)\([^)]*\)$/);
    if (checkMatch) {
      const loc = resolveAliases(checkMatch[1].trim());
      if (loc.startsWith("page.")) {
        steps.push({ kind: "CHECK", locatorExpr: loc, checked: checkMatch[2] === "check", label: loc.replace(/^page\./, ""), line: lineNum, status: "pending", code: line });
        continue;
      }
    }

    const pressMatch = body.match(/^(.+?)\.press\(\s*(['"`])((?:\\.|(?!\2).)*)\2\s*\)$/);
    if (pressMatch) {
      const loc = resolveAliases(pressMatch[1].trim());
      const key = unescapeQuotes(pressMatch[3]);
      if (loc.startsWith("page.")) {
        steps.push({ kind: "PRESS", locatorExpr: loc, key, label: `${loc.replace(/^page\./, "")} [${key}]`, line: lineNum, status: "pending", code: line });
        continue;
      }
    }

    const expectPageMatch = body.match(/^expect\(\s*page\s*\)\.(toHaveURL|toHaveTitle)\(\s*(?:(['"`])((?:\\.|(?!\2).)*)\2|\/([^/]+)\/[gimsuy]*)\s*\)$/);
    if (expectPageMatch) {
      const expected = unescapeQuotes(expectPageMatch[3] ?? expectPageMatch[4] ?? "");
      steps.push({
        kind: "PAGE_ASSERT",
        assertType: expectPageMatch[1],
        expected,
        label: `page.${expectPageMatch[1]}("${expected}")`,
        line: lineNum,
        status: "pending",
        code: line
      });
      continue;
    }

    const assertTextMatch = body.match(/^expect\(\s*(.+?)\s*\)\.(toContainText|toHaveText|toHaveValue)\(\s*(?:(['"`])((?:\\.|(?!\3).)*)\3|\/([^/]+)\/[gimsuy]*)\s*(?:,[^)]*)?\)$/);
    if (assertTextMatch) {
      const loc = resolveAliases(assertTextMatch[1].trim());
      const expected = unescapeQuotes(assertTextMatch[4] ?? assertTextMatch[5] ?? "");
      if (loc.startsWith("page.")) {
        steps.push({
          kind: "ASSERT",
          locatorExpr: loc,
          assertType: assertTextMatch[2],
          expected,
          label: `${loc.replace(/^page\./, "")} (${assertTextMatch[2]})`,
          line: lineNum,
          status: "pending",
          code: line
        });
        continue;
      }
    }

    const assertVisibleMatch = body.match(/^expect\(\s*(.+?)\s*\)\.(toBeVisible|toBeEnabled|toBeChecked)\([^)]*\)$/);
    if (assertVisibleMatch) {
      const loc = resolveAliases(assertVisibleMatch[1].trim());
      if (loc.startsWith("page.")) {
        steps.push({
          kind: "ASSERT",
          locatorExpr: loc,
          assertType: assertVisibleMatch[2],
          expected: null,
          label: `${loc.replace(/^page\./, "")} (${assertVisibleMatch[2]})`,
          line: lineNum,
          status: "pending",
          code: line
        });
        continue;
      }
    }

    if (line.startsWith("await ")) {
      steps.push({
        kind: "WAIT",
        label: body.slice(0, 60),
        line: lineNum,
        status: "pending",
        code: line
      });
    }
  }

  return steps;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const senderTabId = sender.tab?.id;

  if (msg?.type === "START_DEBUG") {
    const p = msg.payload || {};
    const debugSteps = parsePlaywrightSpecToDebugSteps(p.scriptContent, p.targetUrl);
    const firstGoto = debugSteps.find((s) => s.kind === "GOTO")?.url;
    const openUrl = p.targetUrl || firstGoto;
    if (!openUrl) {
      sendResponse({ ok: false, error: "Provide a Target URL or page.goto(...) in your spec before debugging." });
      return true;
    }
    if (debugSteps.length === 0) {
      sendResponse({ ok: false, error: "No supported Playwright steps found to debug in this spec." });
      return true;
    }

    (async () => {
      const targetTab = await chrome.tabs.create({ url: openUrl, active: true });
      const tabId = targetTab.id;
      const sessions = await getSessions();
      sessions[tabId] = {
        mode: "debug",
        apiBaseUrl: p.apiBaseUrl ? String(p.apiBaseUrl).replace(/\/+$/, "") : null,
        token: p.token || null,
        projectId: p.projectId || null,
        sourceTabId: senderTabId || null,
        testcaseId: p.testcaseId || null,
        testcaseTitle: p.testcaseTitle || "Debug Spec",
        testcaseExternalId: p.testcaseExternalId || null,
        targetUrl: openUrl,
        scriptContent: String(p.scriptContent || ""),
        breakpoints: [],
        debugSteps,
        currentStepIndex: 0,
        autoRun: Boolean(p.autoRun),
        startedAt: Date.now(),
        reported: false,
        lastDebugError: null
      };
      await setSessions(sessions);
      await broadcastToTab(tabId, sessions[tabId]);
      sendResponse({ ok: true, tabId });
    })().catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === "START_RECORDING") {
    const p = msg.payload || {};
    if (!p.apiBaseUrl || !p.token || !p.projectId || !p.testcaseId || !p.targetUrl) {
      sendResponse({ ok: false, error: "Missing required recording session fields." });
      return true;
    }

    (async () => {
      let targetTab;
      if (msg.useCurrentTab) {
        if (senderTabId) {
          targetTab = await chrome.tabs.get(senderTabId);
        } else {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTab = activeTab;
        }
      } else {
        targetTab = await chrome.tabs.create({ url: p.targetUrl, active: true });
      }
      if (!targetTab?.id) {
        sendResponse({ ok: false, error: "Could not resolve target browser tab." });
        return;
      }

      const tabId = targetTab.id;
      const sessions = await getSessions();
      sessions[tabId] = {
        apiBaseUrl: String(p.apiBaseUrl).replace(/\/+$/, ""),
        token: p.token,
        projectId: p.projectId,
        testcaseId: p.testcaseId,
        testcaseTitle: p.testcaseTitle || "Recorded test",
        testcaseExternalId: p.testcaseExternalId || null,
        targetUrl: p.targetUrl,
        sourceTabId: senderTabId || null,
        paused: false,
        assertMode: false,
        maskPasswords: false,
        steps: [
          {
            kind: "GOTO",
            locator: null,
            label: p.targetUrl,
            code: `await page.goto(${JSON.stringify(p.targetUrl)});`
          }
        ]
      };
      await setSessions(sessions);
      await broadcastToTab(tabId, sessions[tabId]);
      sendResponse({ ok: true, tabId });
    })().catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (!senderTabId) {
    sendResponse({ ok: false });
    return true;
  }

  (async () => {
    const sessions = await getSessions();
    const session = sessions[senderTabId];

    if (msg?.type === "GET_SESSION") {
      sendResponse({ session: session || null });
      return;
    }

    if (!session) {
      sendResponse({ ok: false, error: "No active recording session." });
      return;
    }

    if (msg?.type === "RECORD_STEP" && msg.step) {
      const last = session.steps[session.steps.length - 1];
      if (
        last &&
        last.kind === "FILL" &&
        msg.step.kind === "FILL" &&
        last.locator === msg.step.locator &&
        (last.frameSelector || null) === (msg.step.frameSelector || null)
      ) {
        session.steps[session.steps.length - 1] = msg.step;
      } else {
        session.steps.push(msg.step);
      }
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "REMOVE_STEP") {
      session.steps.splice(msg.index, 1);
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "CLEAR_STEPS") {
      session.steps = [];
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "TOGGLE_PAUSE") {
      session.paused = !session.paused;
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "TOGGLE_ASSERT") {
      session.assertMode = !session.assertMode;
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "DEBUG_SET_STATE" && session.mode === "debug") {
      if (Array.isArray(msg.debugSteps)) session.debugSteps = msg.debugSteps;
      if (typeof msg.currentStepIndex === "number") session.currentStepIndex = msg.currentStepIndex;
      if (typeof msg.autoRun === "boolean") session.autoRun = msg.autoRun;
      if (Array.isArray(msg.breakpoints)) session.breakpoints = msg.breakpoints;
      session.lastDebugError = msg.lastDebugError ?? null;
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "DEBUG_TOGGLE_BREAKPOINT" && session.mode === "debug") {
      const line = Number(msg.line);
      const bps = Array.isArray(session.breakpoints) ? [...session.breakpoints] : [];
      const idx = bps.indexOf(line);
      if (idx >= 0) bps.splice(idx, 1);
      else if (Number.isInteger(line) && line > 0) bps.push(line);
      session.breakpoints = bps;
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "DEBUG_RESET" && session.mode === "debug") {
      session.debugSteps = (session.debugSteps || []).map((s) => ({ ...s, status: "pending" }));
      session.currentStepIndex = 0;
      session.autoRun = false;
      session.startedAt = Date.now();
      session.reported = false;
      session.lastDebugError = null;
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "REPORT_HEADED_RUN" && session.mode === "debug") {
      if (!session.apiBaseUrl || !session.token || !session.projectId || !session.testcaseId || session.reported) {
        sendResponse({ ok: false, skipped: true });
        return;
      }
      session.reported = true;
      await setSessions(sessions);

      let screenshotDataUrl = null;
      try {
        screenshotDataUrl = await chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "png" });
      } catch {
        // Tab may not be active/focused; report without screenshot
      }

      const stepsSummary = (session.debugSteps || [])
        .map((s, i) => `${i + 1}. [${(s.status || "pending").toUpperCase()}] ${s.label || s.code || s.kind}`)
        .join("\n");
      const durationMs = Math.max(0, Date.now() - (session.startedAt || Date.now()));
      const status = msg.status === "passed" ? "passed" : "failed";

      const reportRes = await fetch(
        `${session.apiBaseUrl}/api/projects/${session.projectId}/testcases/${session.testcaseId}/script/headed-run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.token}`
          },
          body: JSON.stringify({
            status,
            targetUrl: session.targetUrl,
            durationMs,
            stdout: stepsSummary || null,
            errorMessage: msg.errorMessage || session.lastDebugError || null,
            screenshotDataUrl
          })
        }
      );

      if (!reportRes.ok) {
        const errBody = await reportRes.text().catch(() => "");
        session.reported = false;
        await setSessions(sessions);
        await broadcastToTab(senderTabId, session);
        sendResponse({ ok: false, error: `Report failed (${reportRes.status}): ${errBody.slice(0, 120)}` });
        return;
      }

      const reportData = await reportRes.json().catch(() => ({}));
      await broadcastToTab(senderTabId, session);

      if (session.sourceTabId) {
        try {
          await chrome.tabs.sendMessage(session.sourceTabId, {
            type: "HEADED_RUN_REPORTED",
            projectId: session.projectId,
            testcaseId: session.testcaseId,
            cycleId: reportData?.cycleId || null,
            status
          });
        } catch {
          // Source TestPilot tab may have been closed
        }
      }

      sendResponse({ ok: true, cycleId: reportData?.cycleId || null, executionId: reportData?.executionId || null });
      return;
    }

    if (msg?.type === "TOGGLE_MASK_PASSWORDS") {
      session.maskPasswords = !session.maskPasswords;
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "STOP_SESSION") {
      delete sessions[senderTabId];
      await setSessions(sessions);
      await broadcastToTab(senderTabId, null);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "SAVE_AND_RUN") {
      const scriptContent = compilePlaywrightScript(session);
      const verifiedLocators = collectVerifiedLocators(session);
      const base = `${session.apiBaseUrl}/api/projects/${session.projectId}/testcases/${session.testcaseId}/script`;

      const saveRes = await fetch(base, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({
          scriptContent,
          framework: "playwright-ts",
          targetUrl: session.targetUrl,
          status: "draft",
          source: "recorder",
          notes: `Recorded ${session.steps.length} step(s) via TestPilot Chrome Recorder`,
          verifiedLocators
        })
      });

      if (!saveRes.ok) {
        const errBody = await saveRes.text().catch(() => "");
        sendResponse({ ok: false, error: `Save failed (${saveRes.status}): ${errBody.slice(0, 120)}` });
        return;
      }

      const runRes = await fetch(`${base}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({ targetUrl: session.targetUrl })
      });

      if (!runRes.ok) {
        const errBody = await runRes.text().catch(() => "");
        sendResponse({ ok: false, error: `Saved, but run failed (${runRes.status}): ${errBody.slice(0, 120)}` });
        return;
      }

      if (session.sourceTabId) {
        try {
          await chrome.tabs.sendMessage(session.sourceTabId, {
            type: "RECORDER_SAVED",
            projectId: session.projectId,
            testcaseId: session.testcaseId
          });
        } catch {
          // Source TestPilot tab may have been closed
        }
      }

      sendResponse({ ok: true });
    }
  })().catch((err) => sendResponse({ ok: false, error: err.message }));

  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const sessions = await getSessions();
  if (sessions[tabId]) {
    delete sessions[tabId];
    await setSessions(sessions);
  }
});

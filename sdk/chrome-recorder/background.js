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
  const lines = String(scriptContent || "").split(/\r?\n/);
  const steps = [];

  lines.forEach((raw, idx) => {
    const lineNum = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("import ") || line.startsWith("test(")) return;

    const gotoMatch = line.match(/^await\s+page\.goto\(\s*(['"`])((?:\\.|(?!\1).)*)\1/);
    if (gotoMatch) {
      let url = unescapeQuotes(gotoMatch[2]);
      if (url.startsWith("/") && fallbackUrl) {
        try {
          url = new URL(url, fallbackUrl).toString();
        } catch {}
      }
      steps.push({ kind: "GOTO", url, label: url, line: lineNum, status: "pending", code: line });
      return;
    }

    const clickMatch = line.match(/^await\s+(page\..+)\.click\(\s*\)/);
    if (clickMatch) {
      steps.push({ kind: "CLICK", locatorExpr: clickMatch[1], label: clickMatch[1].replace(/^page\./, ""), line: lineNum, status: "pending", code: line });
      return;
    }

    const fillMatch = line.match(/^await\s+(page\..+)\.fill\(\s*(['"`])((?:\\.|(?!\2).)*)\2\s*\)/);
    if (fillMatch) {
      steps.push({ kind: "FILL", locatorExpr: fillMatch[1], value: unescapeQuotes(fillMatch[3]), label: `${fillMatch[1].replace(/^page\./, "")} = "${unescapeQuotes(fillMatch[3])}"`, line: lineNum, status: "pending", code: line });
      return;
    }

    const selectMatch = line.match(/^await\s+(page\..+)\.selectOption\(\s*(['"`])((?:\\.|(?!\2).)*)\2\s*\)/);
    if (selectMatch) {
      steps.push({ kind: "SELECT", locatorExpr: selectMatch[1], value: unescapeQuotes(selectMatch[3]), label: selectMatch[1].replace(/^page\./, ""), line: lineNum, status: "pending", code: line });
      return;
    }

    const checkMatch = line.match(/^await\s+(page\..+)\.(check|uncheck)\(\s*\)/);
    if (checkMatch) {
      steps.push({ kind: "CHECK", locatorExpr: checkMatch[1], checked: checkMatch[2] === "check", label: checkMatch[1].replace(/^page\./, ""), line: lineNum, status: "pending", code: line });
      return;
    }

    const pressMatch = line.match(/^await\s+(page\..+)\.press\(\s*(['"`])((?:\\.|(?!\2).)*)\2\s*\)/);
    if (pressMatch) {
      steps.push({ kind: "PRESS", locatorExpr: pressMatch[1], key: unescapeQuotes(pressMatch[3]), label: `${pressMatch[1].replace(/^page\./, "")} [${unescapeQuotes(pressMatch[3])}]`, line: lineNum, status: "pending", code: line });
      return;
    }

    const assertTextMatch = line.match(/^await\s+expect\(\s*(page\..+?)\s*\)\.(toContainText|toHaveText)\(\s*(['"`])((?:\\.|(?!\3).)*)\3\s*\)/);
    if (assertTextMatch) {
      steps.push({ kind: "ASSERT", locatorExpr: assertTextMatch[1], expected: unescapeQuotes(assertTextMatch[4]), label: `${assertTextMatch[1].replace(/^page\./, "")} (${assertTextMatch[2]})`, line: lineNum, status: "pending", code: line });
      return;
    }

    const assertVisibleMatch = line.match(/^await\s+expect\(\s*(page\..+?)\s*\)\.toBeVisible\(\s*\)/);
    if (assertVisibleMatch) {
      steps.push({ kind: "ASSERT", locatorExpr: assertVisibleMatch[1], expected: null, label: `${assertVisibleMatch[1].replace(/^page\./, "")} (visible)`, line: lineNum, status: "pending", code: line });
    }
  });

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
        testcaseId: p.testcaseId || null,
        testcaseTitle: p.testcaseTitle || "Debug Spec",
        testcaseExternalId: p.testcaseExternalId || null,
        targetUrl: openUrl,
        debugSteps,
        currentStepIndex: 0,
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
      session.lastDebugError = msg.lastDebugError ?? null;
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "DEBUG_RESET" && session.mode === "debug") {
      session.debugSteps = (session.debugSteps || []).map((s) => ({ ...s, status: "pending" }));
      session.currentStepIndex = 0;
      session.lastDebugError = null;
      await setSessions(sessions);
      await broadcastToTab(senderTabId, session);
      sendResponse({ ok: true });
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

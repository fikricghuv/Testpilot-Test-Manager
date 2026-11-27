(() => {
  if (window !== window.top) return;
  if (window.__testpilotModalLoaded) return;
  window.__testpilotModalLoaded = true;

  let host = null;
  let shadow = null;
  let currentSession = null;
  let activeTab = "steps";
  let debugTab = "code";
  let pickMode = false;
  let pickedLocator = "";
  let statusMessage = "";
  let autoRunActive = false;

  function ensureModal() {
    if (host) return;
    host = document.createElement("div");
    host.id = "testpilot-recorder-root";
    Object.assign(host.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483647",
      width: "380px",
      fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    });
    shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);
  }

  function destroyModal() {
    if (host) {
      host.remove();
      host = null;
      shadow = null;
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildPlaywrightCode(session) {
    const title = session.testcaseExternalId
      ? `[${session.testcaseExternalId}] ${session.testcaseTitle || "Recorded test"}`
      : session.testcaseTitle || "Recorded test";
    const lines = (session.steps || []).map((s) => `  ${s.code}`);
    return [
      `import { test, expect } from "@playwright/test";`,
      ``,
      `test(${JSON.stringify(title)}, async ({ page }) => {`,
      ...(lines.length ? lines : [`  // Interact with the page to record steps`]),
      `});`,
      ``
    ].join("\n");
  }

  function makeDraggable(handleEl) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handleEl.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.left = `${startLeft}px`;
      host.style.top = `${startTop}px`;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging || !host) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      host.style.left = `${Math.max(8, startLeft + dx)}px`;
      host.style.top = `${Math.max(8, startTop + dy)}px`;
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function renderDebugMode() {
    ensureModal();
    host.style.width = "480px";
    const dbg = window.__testpilotDebugger;
    const steps = currentSession.debugSteps || [];
    const idx = Math.min(currentSession.currentStepIndex || 0, steps.length);
    const currentStep = idx < steps.length ? steps[idx] : null;
    const breakpoints = new Set(currentSession.breakpoints || []);
    const tcBadge = currentSession.testcaseExternalId || currentSession.testcaseId?.slice(0, 8) || "DBG";

    let matchInfo = "";
    if (!pickMode) {
      if (dbg && currentStep) {
        const res = dbg.highlightStepTarget(currentStep);
        if (currentStep.locatorExpr) {
          matchInfo = res.count === 1 ? "1 match" : res.count === 0 ? "0 matches" : `${res.count} matches (strict!)`;
        }
      } else if (dbg) {
        dbg.hideDebugHighlight();
      }
    }

    const stepByLine = new Map();
    for (const s of steps) {
      if (s.line && !stepByLine.has(s.line)) stepByLine.set(s.line, s);
    }
    const codeLines = String(currentSession.scriptContent || "").split(/\r?\n/);

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .card { background:#111827; color:#f9fafb; border:1px solid #f59e0b; border-radius:12px; box-shadow:0 20px 40px rgba(0,0,0,0.45); overflow:hidden; font-size:12px; }
        .header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; background:#1f2937; border-bottom:1px solid #374151; cursor:grab; user-select:none; }
        .title-row { display:flex; align-items:center; gap:6px; font-weight:600; }
        .dot { width:9px; height:9px; border-radius:999px; background:#f59e0b; }
        .badge { background:#111827; border:1px solid #374151; color:#d1d5db; padding:1px 6px; border-radius:4px; font-family:ui-monospace,monospace; font-size:11px; }
        .tabs { display:flex; align-items:center; justify-content:space-between; padding:0 12px; border-bottom:1px solid #374151; background:#111827; }
        .tab-group { display:flex; gap:12px; }
        .tab { background:transparent; border:none; border-bottom:2px solid transparent; border-radius:0; padding:7px 0; color:#9ca3af; font-size:11px; font-weight:500; cursor:pointer; }
        .tab.active { color:#f9fafb; border-bottom-color:#f59e0b; }
        button { cursor:pointer; border:1px solid #4b5563; background:#111827; color:#f9fafb; border-radius:6px; padding:4px 8px; font-size:11px; font-weight:500; }
        button:hover { background:#374151; }
        button:disabled { opacity:0.45; cursor:not-allowed; }
        .btn-primary { background:#f59e0b; border-color:#f59e0b; color:#111827; font-weight:600; }
        .btn-primary:hover { background:#d97706; }
        .btn-pick-on { border-color:#38bdf8; color:#38bdf8; background:rgba(56,189,248,0.12); }
        .body { max-height:270px; overflow:auto; padding:8px 0; }
        .code-wrap { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; line-height:1.55; }
        .code-line { display:flex; align-items:flex-start; padding:1px 10px 1px 6px; border-left:2px solid transparent; }
        .code-line.active { background:rgba(245,158,11,0.18); border-left-color:#f59e0b; }
        .code-line.passed { background:rgba(16,185,129,0.06); }
        .code-line.failed { background:rgba(239,68,68,0.16); border-left-color:#ef4444; }
        .ln { width:36px; shrink:0; display:flex; align-items:center; justify-content:flex-end; gap:4px; padding-right:8px; color:#6b7280; cursor:pointer; user-select:none; }
        .ln:hover { color:#f9fafb; }
        .bp { width:7px; height:7px; border-radius:999px; background:#ef4444; display:inline-block; }
        .code-txt { white-space:pre; color:#e5e7eb; }
        .step { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; margin:0 10px 6px; background:#1f2937; border:1px solid #374151; border-radius:6px; }
        .step.current { border-color:#f59e0b; background:rgba(245,158,11,0.12); }
        .step.passed { border-color:#10b981; }
        .step.failed { border-color:#ef4444; background:rgba(239,68,68,0.12); }
        .step-left { display:flex; align-items:center; gap:6px; min-width:0; }
        .kind { font-family:ui-monospace,monospace; font-size:10px; padding:1px 5px; border-radius:4px; background:rgba(245,158,11,0.2); color:#fcd34d; flex-shrink:0; }
        .target { font-family:ui-monospace,monospace; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .picked { margin:0 12px 8px; padding:6px 8px; border-radius:6px; background:rgba(56,189,248,0.12); border:1px solid #38bdf8; color:#bae6fd; font-family:ui-monospace,monospace; font-size:11px; display:flex; justify-content:space-between; align-items:center; gap:6px; }
        .err { margin:0 12px 8px; padding:6px 8px; border-radius:6px; background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#fecaca; font-size:11px; }
        .footer { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; background:#1f2937; border-top:1px solid #374151; }
      </style>
      <div class="card">
        <div class="header" id="drag-handle">
          <div class="title-row">
            <span class="dot"></span>
            <span>Playwright Inspector</span>
            <span class="badge">${escapeHtml(tcBadge)}</span>
            ${matchInfo ? `<span class="badge">${escapeHtml(matchInfo)}</span>` : ""}
          </div>
          <div style="display:flex;gap:4px;">
            <button id="btn-pick" class="${pickMode ? "btn-pick-on" : ""}" title="Click an element on the page to inspect its locator">Pick Locator</button>
            <button id="btn-reset">Reset</button>
            <button id="btn-close">✕</button>
          </div>
        </div>
        <div class="tabs">
          <div class="tab-group">
            <button class="tab ${debugTab === "code" ? "active" : ""}" id="dtab-code">Code (${codeLines.length}L)</button>
            <button class="tab ${debugTab === "steps" ? "active" : ""}" id="dtab-steps">Steps (${steps.length})</button>
          </div>
          <span style="color:#9ca3af;font-size:11px;">Click line # for breakpoint</span>
        </div>
        <div class="body">
          ${
            debugTab === "code" && codeLines.length > 0
              ? `<div class="code-wrap">
                  ${codeLines
                    .map((lineText, idx0) => {
                      const lineNum = idx0 + 1;
                      const isActive = currentStep?.line === lineNum;
                      const matchedStep = stepByLine.get(lineNum);
                      const lineCls = isActive
                        ? "active"
                        : matchedStep?.status === "failed"
                          ? "failed"
                          : matchedStep?.status === "passed"
                            ? "passed"
                            : "";
                      const hasBp = breakpoints.has(lineNum);
                      return `<div class="code-line ${lineCls}" ${isActive ? 'id="active-code-line"' : ""}>
                        <span class="ln" data-bp="${lineNum}" title="Toggle breakpoint on line ${lineNum}">
                          ${hasBp ? '<span class="bp"></span>' : isActive ? '<span style="color:#f59e0b;">▶</span>' : ""}
                          <span>${lineNum}</span>
                        </span>
                        <span class="code-txt">${escapeHtml(lineText || " ")}</span>
                      </div>`;
                    })
                    .join("")}
                </div>`
              : steps
                  .map(
                    (s, i) => `
                  <div class="step ${i === idx ? "current" : s.status === "passed" ? "passed" : s.status === "failed" ? "failed" : ""}">
                    <div class="step-left">
                      <span style="color:#9ca3af;font-family:monospace;">L${s.line}</span>
                      <span class="kind">${escapeHtml(s.kind)}</span>
                      <span class="target" title="${escapeHtml(s.code)}">${escapeHtml(s.label)}</span>
                    </div>
                    <span style="font-size:11px;">${s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : i === idx ? "▶" : ""}</span>
                  </div>`
                  )
                  .join("")
          }
        </div>
        ${
          pickedLocator
            ? `<div class="picked"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(pickedLocator)}</span><button id="btn-copy-loc">Copy</button></div>`
            : ""
        }
        ${currentSession.lastDebugError ? `<div class="err">${escapeHtml(currentSession.lastDebugError)}</div>` : ""}
        ${currentSession.reported ? `<div style="padding:6px 12px;background:#064e3b;color:#a7f3d0;font-size:11px;border-top:1px solid #065f46;">✓ Report saved to TestPilot</div>` : ""}
        <div class="footer">
          <span style="color:#9ca3af;font-size:11px;">Step ${Math.min(idx + 1, steps.length)} / ${steps.length}</span>
          <div style="display:flex;gap:6px;">
            <button id="btn-run-all" ${!currentStep ? "disabled" : ""}>Resume</button>
            <button class="btn-primary" id="btn-step" ${!currentStep ? "disabled" : ""}>Step Over</button>
          </div>
        </div>
      </div>
    `;

    const activeLineEl = shadow.getElementById("active-code-line");
    if (activeLineEl) {
      activeLineEl.scrollIntoView({ block: "nearest" });
    }

    makeDraggable(shadow.getElementById("drag-handle"));

    shadow.getElementById("dtab-code").onclick = () => {
      debugTab = "code";
      render();
    };
    shadow.getElementById("dtab-steps").onclick = () => {
      debugTab = "steps";
      render();
    };
    shadow.querySelectorAll("[data-bp]").forEach((el) => {
      el.onclick = () => {
        const line = Number(el.getAttribute("data-bp"));
        chrome.runtime.sendMessage({ type: "DEBUG_TOGGLE_BREAKPOINT", line });
      };
    });
    shadow.getElementById("btn-pick").onclick = () => {
      if (!dbg) return;
      pickMode = !pickMode;
      if (pickMode) {
        dbg.startPickLocator((expr) => {
          pickMode = false;
          pickedLocator = expr;
          render();
        });
      } else {
        dbg.stopPickLocator();
      }
      render();
    };
    const copyBtn = shadow.getElementById("btn-copy-loc");
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard?.writeText(pickedLocator).catch(() => undefined);
        copyBtn.textContent = "Copied!";
      };
    }

    shadow.getElementById("btn-close").onclick = () => {
      if (dbg) {
        dbg.stopPickLocator();
        dbg.hideDebugHighlight();
      }
      chrome.runtime.sendMessage({ type: "STOP_SESSION" });
    };
    shadow.getElementById("btn-reset").onclick = () => {
      chrome.runtime.sendMessage({ type: "DEBUG_RESET" });
    };

    const runSingleStep = async () => {
      if (!dbg || !currentStep) return { ok: false, done: true };
      const nextSteps = steps.map((s) => ({ ...s }));
      const result = await dbg.executeStep(currentStep);
      if (!result.ok) {
        nextSteps[idx].status = "failed";
        chrome.runtime.sendMessage({
          type: "DEBUG_SET_STATE",
          debugSteps: nextSteps,
          currentStepIndex: idx,
          lastDebugError: result.error
        });
        return { ok: false };
      }
      nextSteps[idx].status = "passed";
      const nextIdx = idx + 1;
      chrome.runtime.sendMessage({
        type: "DEBUG_SET_STATE",
        debugSteps: nextSteps,
        currentStepIndex: nextIdx,
        lastDebugError: null
      });
      return { ok: true, navigated: currentStep.kind === "GOTO" };
    };

    const runAllRemaining = async () => {
      if (autoRunActive) return;
      autoRunActive = true;
      let firstIteration = true;
      let completedRunStatus = null;
      let completedError = null;
      try {
        while (currentSession && currentSession.mode === "debug") {
          const curIdx = currentSession.currentStepIndex || 0;
          const allSteps = currentSession.debugSteps || [];
          if (curIdx >= allSteps.length) {
            completedRunStatus = "passed";
            break;
          }
          const cur = allSteps[curIdx];
          if (!cur || !dbg) break;

          const activeBps = new Set(currentSession.breakpoints || []);
          if (!firstIteration && cur.line && activeBps.has(cur.line)) {
            await new Promise((resolve) =>
              chrome.runtime.sendMessage({ type: "DEBUG_SET_STATE", autoRun: false }, resolve)
            );
            break;
          }
          firstIteration = false;

          const res = await dbg.executeStep(cur);
          const updated = allSteps.map((s) => ({ ...s }));
          if (!res.ok) {
            updated[curIdx].status = "failed";
            completedRunStatus = "failed";
            completedError = res.error || "Step execution failed";
            await new Promise((resolve) =>
              chrome.runtime.sendMessage(
                {
                  type: "DEBUG_SET_STATE",
                  debugSteps: updated,
                  currentStepIndex: curIdx,
                  autoRun: false,
                  lastDebugError: res.error
                },
                resolve
              )
            );
            break;
          }

          updated[curIdx].status = "passed";
          const nextIdx = curIdx + 1;
          await new Promise((resolve) =>
            chrome.runtime.sendMessage(
              {
                type: "DEBUG_SET_STATE",
                debugSteps: updated,
                currentStepIndex: nextIdx,
                autoRun: nextIdx < updated.length,
                lastDebugError: null
              },
              resolve
            )
          );

          if (nextIdx >= updated.length) {
            completedRunStatus = "passed";
            break;
          }
          if (res.navigated) break;
          await new Promise((r) => setTimeout(r, 450));
        }

        if (
          completedRunStatus &&
          currentSession?.apiBaseUrl &&
          currentSession?.token &&
          !currentSession?.reported
        ) {
          await new Promise((resolve) =>
            chrome.runtime.sendMessage(
              {
                type: "REPORT_HEADED_RUN",
                status: completedRunStatus,
                errorMessage: completedError
              },
              resolve
            )
          );
        }
      } finally {
        autoRunActive = false;
      }
    };

    shadow.getElementById("btn-step").onclick = () => {
      void runSingleStep();
    };

    shadow.getElementById("btn-run-all").onclick = () => {
      void runAllRemaining();
    };

    if (currentSession.autoRun && idx < steps.length && !currentSession.lastDebugError && !autoRunActive) {
      setTimeout(() => {
        if (currentSession?.autoRun && !autoRunActive) {
          void runAllRemaining();
        }
      }, 500);
    }
  }

  function render() {
    if (!currentSession) {
      destroyModal();
      return;
    }
    if (currentSession.mode === "debug") {
      renderDebugMode();
      return;
    }
    ensureModal();
    const steps = currentSession.steps || [];
    const code = buildPlaywrightCode(currentSession);
    const tcBadge = currentSession.testcaseExternalId || currentSession.testcaseId?.slice(0, 8) || "REC";

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .card {
          background: #111827;
          color: #f9fafb;
          border: 1px solid #374151;
          border-radius: 12px;
          box-shadow: 0 20px 40px rgba(0,0,0,0.45);
          overflow: hidden;
          font-size: 12px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          background: #1f2937;
          border-bottom: 1px solid #374151;
          cursor: grab;
          user-select: none;
        }
        .title-row { display: flex; align-items: center; gap: 6px; font-weight: 600; }
        .dot {
          width: 9px; height: 9px; border-radius: 999px;
          background: ${currentSession.paused ? "#9ca3af" : "#ef4444"};
        }
        .badge {
          background: #111827;
          border: 1px solid #374151;
          color: #d1d5db;
          padding: 1px 6px;
          border-radius: 4px;
          font-family: ui-monospace, monospace;
          font-size: 11px;
        }
        .controls { display: flex; align-items: center; gap: 4px; }
        button {
          cursor: pointer;
          border: 1px solid #4b5563;
          background: #111827;
          color: #f9fafb;
          border-radius: 6px;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 500;
        }
        button:hover { background: #374151; }
        .btn-assert-on {
          border-color: #10b981;
          color: #34d399;
          background: rgba(16, 185, 129, 0.12);
        }
        .btn-primary {
          background: #6366f1;
          border-color: #6366f1;
          color: #ffffff;
        }
        .btn-primary:hover { background: #4f46e5; }
        .tabs {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 12px;
          border-bottom: 1px solid #374151;
          background: #111827;
        }
        .tab-group { display: flex; gap: 12px; }
        .tab {
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          border-radius: 0;
          padding: 8px 0;
          color: #9ca3af;
        }
        .tab.active {
          color: #f9fafb;
          border-bottom-color: #6366f1;
        }
        .body {
          max-height: 240px;
          overflow-y: auto;
          padding: 10px 12px;
        }
        .step {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 6px 8px;
          margin-bottom: 6px;
          background: #1f2937;
          border: 1px solid #374151;
          border-radius: 6px;
        }
        .step-left {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        .kind {
          font-family: ui-monospace, monospace;
          font-size: 10px;
          padding: 1px 5px;
          border-radius: 4px;
          background: rgba(99, 102, 241, 0.2);
          color: #a5b4fc;
          flex-shrink: 0;
        }
        .kind-ASSERT { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; }
        .kind-GOTO { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
        .target {
          font-family: ui-monospace, monospace;
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .del {
          border: none;
          background: transparent;
          color: #9ca3af;
          padding: 2px 4px;
        }
        .del:hover { color: #f87171; background: transparent; }
        pre {
          margin: 0;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          line-height: 1.5;
          color: #e5e7eb;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          background: #1f2937;
          border-top: 1px solid #374151;
        }
        .status { color: #9ca3af; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      </style>
      <div class="card">
        <div class="header" id="drag-handle">
          <div class="title-row">
            <span class="dot"></span>
            <span>${currentSession.paused ? "Paused" : "Recording"}</span>
            <span class="badge">${escapeHtml(tcBadge)}</span>
          </div>
          <div class="controls">
            <button id="btn-pause">${currentSession.paused ? "Resume" : "Pause"}</button>
            <button id="btn-assert" class="${currentSession.assertMode ? "btn-assert-on" : ""}">
              Assert: ${currentSession.assertMode ? "ON" : "OFF"}
            </button>
            <button id="btn-close" title="Close recorder">✕</button>
          </div>
        </div>
        <div class="tabs">
          <div class="tab-group">
            <button class="tab ${activeTab === "steps" ? "active" : ""}" id="tab-steps">Steps (${steps.length})</button>
            <button class="tab ${activeTab === "code" ? "active" : ""}" id="tab-code">Playwright TS</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button id="btn-mask" title="Mask password values with TEST_PASSWORD env" style="border:none;background:transparent;color:${currentSession.maskPasswords ? "#34d399" : "#9ca3af"};">
              Mask: ${currentSession.maskPasswords ? "ON" : "OFF"}
            </button>
            <button id="btn-clear" style="border:none;background:transparent;color:#9ca3af;">Clear</button>
          </div>
        </div>
        <div class="body">
          ${
            activeTab === "steps"
              ? steps.length
                ? steps
                    .map(
                      (s, i) => `
                  <div class="step">
                    <div class="step-left">
                      <span style="color:#9ca3af;font-family:monospace;">${i + 1}.</span>
                      <span class="kind kind-${escapeHtml(s.kind)}">${escapeHtml(s.kind)}</span>
                      <span class="target" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
                    </div>
                    <button class="del" data-del="${i}">✕</button>
                  </div>`
                    )
                    .join("")
                : `<div style="text-align:center;padding:24px 8px;color:#9ca3af;">Klik atau ketik di halaman untuk merekam step.</div>`
              : `<pre>${escapeHtml(code)}</pre>`
          }
        </div>
        <div class="footer">
          <span class="status">${escapeHtml(statusMessage || "Ready to sync")}</span>
          <button class="btn-primary" id="btn-save-run">Save &amp; Run</button>
        </div>
      </div>
    `;

    makeDraggable(shadow.getElementById("drag-handle"));

    shadow.getElementById("btn-pause").onclick = () => {
      chrome.runtime.sendMessage({ type: "TOGGLE_PAUSE" });
    };
    shadow.getElementById("btn-assert").onclick = () => {
      chrome.runtime.sendMessage({ type: "TOGGLE_ASSERT" });
    };
    shadow.getElementById("btn-close").onclick = () => {
      chrome.runtime.sendMessage({ type: "STOP_SESSION" });
    };
    shadow.getElementById("tab-steps").onclick = () => {
      activeTab = "steps";
      render();
    };
    shadow.getElementById("tab-code").onclick = () => {
      activeTab = "code";
      render();
    };
    shadow.getElementById("btn-mask").onclick = () => {
      chrome.runtime.sendMessage({ type: "TOGGLE_MASK_PASSWORDS" });
    };
    shadow.getElementById("btn-clear").onclick = () => {
      chrome.runtime.sendMessage({ type: "CLEAR_STEPS" });
    };
    shadow.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute("data-del"));
        chrome.runtime.sendMessage({ type: "REMOVE_STEP", index: idx });
      };
    });
    shadow.getElementById("btn-save-run").onclick = () => {
      statusMessage = "Saving & queuing Playwright run...";
      render();
      chrome.runtime.sendMessage({ type: "SAVE_AND_RUN" }, (res) => {
        if (chrome.runtime.lastError) {
          statusMessage = chrome.runtime.lastError.message || "Failed to save";
        } else if (res?.ok) {
          statusMessage = "Saved & queued in TestPilot!";
        } else {
          statusMessage = res?.error || "Save failed";
        }
        render();
      });
    };
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SESSION_UPDATED") {
      currentSession = msg.session || null;
      render();
    }
  });

  chrome.runtime.sendMessage({ type: "GET_SESSION" }, (res) => {
    if (!chrome.runtime.lastError && res?.session) {
      currentSession = res.session;
      render();
    }
  });
})();

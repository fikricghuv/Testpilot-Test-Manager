(() => {
  if (window !== window.top) return;
  if (window.__testpilotModalLoaded) return;
  window.__testpilotModalLoaded = true;

  let host = null;
  let shadow = null;
  let currentSession = null;
  let activeTab = "steps";
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
    const dbg = window.__testpilotDebugger;
    const steps = currentSession.debugSteps || [];
    const idx = Math.min(currentSession.currentStepIndex || 0, steps.length);
    const currentStep = idx < steps.length ? steps[idx] : null;
    const tcBadge = currentSession.testcaseExternalId || currentSession.testcaseId?.slice(0, 8) || "DBG";

    let matchInfo = "";
    if (dbg && currentStep) {
      const res = dbg.highlightStepTarget(currentStep);
      if (currentStep.locatorExpr) {
        matchInfo = res.count === 1 ? "1 match" : res.count === 0 ? "0 matches" : `${res.count} matches (strict!)`;
      }
    } else if (dbg) {
      dbg.hideDebugHighlight();
    }

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .card { background:#111827; color:#f9fafb; border:1px solid #f59e0b; border-radius:12px; box-shadow:0 20px 40px rgba(0,0,0,0.45); overflow:hidden; font-size:12px; }
        .header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; background:#1f2937; border-bottom:1px solid #374151; cursor:grab; user-select:none; }
        .title-row { display:flex; align-items:center; gap:6px; font-weight:600; }
        .dot { width:9px; height:9px; border-radius:999px; background:#f59e0b; }
        .badge { background:#111827; border:1px solid #374151; color:#d1d5db; padding:1px 6px; border-radius:4px; font-family:ui-monospace,monospace; font-size:11px; }
        button { cursor:pointer; border:1px solid #4b5563; background:#111827; color:#f9fafb; border-radius:6px; padding:4px 8px; font-size:11px; font-weight:500; }
        button:hover { background:#374151; }
        button:disabled { opacity:0.45; cursor:not-allowed; }
        .btn-primary { background:#f59e0b; border-color:#f59e0b; color:#111827; font-weight:600; }
        .btn-primary:hover { background:#d97706; }
        .body { max-height:240px; overflow-y:auto; padding:10px 12px; }
        .step { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; margin-bottom:6px; background:#1f2937; border:1px solid #374151; border-radius:6px; }
        .step.current { border-color:#f59e0b; background:rgba(245,158,11,0.12); }
        .step.passed { border-color:#10b981; }
        .step.failed { border-color:#ef4444; background:rgba(239,68,68,0.12); }
        .step-left { display:flex; align-items:center; gap:6px; min-width:0; }
        .kind { font-family:ui-monospace,monospace; font-size:10px; padding:1px 5px; border-radius:4px; background:rgba(245,158,11,0.2); color:#fcd34d; flex-shrink:0; }
        .target { font-family:ui-monospace,monospace; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .err { margin:0 12px 8px; padding:6px 8px; border-radius:6px; background:rgba(239,68,68,0.15); border:1px solid #ef4444; color:#fecaca; font-size:11px; }
        .footer { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; background:#1f2937; border-top:1px solid #374151; }
      </style>
      <div class="card">
        <div class="header" id="drag-handle">
          <div class="title-row">
            <span class="dot"></span>
            <span>Debugger</span>
            <span class="badge">${escapeHtml(tcBadge)}</span>
            ${matchInfo ? `<span class="badge">${escapeHtml(matchInfo)}</span>` : ""}
          </div>
          <div style="display:flex;gap:4px;">
            <button id="btn-reset">Reset</button>
            <button id="btn-close">✕</button>
          </div>
        </div>
        <div class="body">
          ${steps
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
            .join("")}
        </div>
        ${currentSession.lastDebugError ? `<div class="err">${escapeHtml(currentSession.lastDebugError)}</div>` : ""}
        <div class="footer">
          <span style="color:#9ca3af;font-size:11px;">Step ${Math.min(idx + 1, steps.length)} / ${steps.length}</span>
          <div style="display:flex;gap:6px;">
            <button id="btn-run-all" ${!currentStep ? "disabled" : ""}>Run Remaining</button>
            <button class="btn-primary" id="btn-step" ${!currentStep ? "disabled" : ""}>Step Over</button>
          </div>
        </div>
      </div>
    `;

    makeDraggable(shadow.getElementById("drag-handle"));

    shadow.getElementById("btn-close").onclick = () => {
      if (dbg) dbg.hideDebugHighlight();
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
      try {
        while (currentSession && currentSession.mode === "debug") {
          const curIdx = currentSession.currentStepIndex || 0;
          const allSteps = currentSession.debugSteps || [];
          if (curIdx >= allSteps.length) break;
          const cur = allSteps[curIdx];
          if (!cur || !dbg) break;

          const res = await dbg.executeStep(cur);
          const updated = allSteps.map((s) => ({ ...s }));
          if (!res.ok) {
            updated[curIdx].status = "failed";
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

          if (res.navigated) break;
          await new Promise((r) => setTimeout(r, 450));
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

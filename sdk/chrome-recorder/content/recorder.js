(() => {
  if (window.__testpilotRecorderLoaded) return;
  window.__testpilotRecorderLoaded = true;

  const { generatePlaywrightLocator, getFramePrefix, escapeSingleQuotes, cleanText } = window.__testpilotLocator || {};
  if (!generatePlaywrightLocator) return;

  let active = false;
  let paused = false;
  let assertMode = false;
  let maskPasswords = false;
  let highlightBox = null;
  let highlightLabel = null;
  const inputTimers = new WeakMap();

  function isOwnUi(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("#testpilot-recorder-root") || target.closest("[data-testpilot-ui='1']"));
  }

  function ensureHighlightElements() {
    if (highlightBox) return;
    highlightBox = document.createElement("div");
    highlightBox.setAttribute("data-testpilot-ui", "1");
    Object.assign(highlightBox.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483645",
      border: "2px dashed #6366f1",
      background: "rgba(99, 102, 241, 0.08)",
      borderRadius: "4px",
      display: "none",
      transition: "all 60ms ease"
    });

    highlightLabel = document.createElement("div");
    highlightLabel.setAttribute("data-testpilot-ui", "1");
    Object.assign(highlightLabel.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483646",
      background: "#111827",
      color: "#f9fafb",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "11px",
      padding: "2px 6px",
      borderRadius: "4px",
      display: "none",
      maxWidth: "320px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      boxShadow: "0 2px 8px rgba(0,0,0,0.25)"
    });

    document.documentElement.appendChild(highlightBox);
    document.documentElement.appendChild(highlightLabel);
  }

  function hideHighlight() {
    if (highlightBox) highlightBox.style.display = "none";
    if (highlightLabel) highlightLabel.style.display = "none";
  }

  function buildLocatorPrefix() {
    const frameSelector = getFramePrefix();
    if (!frameSelector) return { chain: "page", frameSelector: null };
    return {
      chain: `page.frameLocator('${escapeSingleQuotes(frameSelector)}')`,
      frameSelector
    };
  }

  function sendStep(step) {
    chrome.runtime.sendMessage({ type: "RECORD_STEP", step });
  }

  function syncSessionState() {
    chrome.runtime.sendMessage({ type: "GET_SESSION" }, (res) => {
      if (chrome.runtime.lastError || !res?.session || res.session.mode === "debug") {
        active = false;
        paused = false;
        assertMode = false;
        maskPasswords = false;
        hideHighlight();
        return;
      }
      active = true;
      paused = Boolean(res.session.paused);
      assertMode = Boolean(res.session.assertMode);
      maskPasswords = Boolean(res.session.maskPasswords);
      if (paused) hideHighlight();
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SESSION_UPDATED") {
      if (!msg.session || msg.session.mode === "debug") {
        active = false;
        paused = false;
        assertMode = false;
        maskPasswords = false;
        hideHighlight();
      } else {
        active = true;
        paused = Boolean(msg.session.paused);
        assertMode = Boolean(msg.session.assertMode);
        maskPasswords = Boolean(msg.session.maskPasswords);
        if (paused) hideHighlight();
      }
    }
  });

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!active || paused) return;
      const target = e.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE || isOwnUi(target)) {
        hideHighlight();
        return;
      }
      ensureHighlightElements();
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hideHighlight();
        return;
      }
      const loc = generatePlaywrightLocator(target);
      Object.assign(highlightBox.style, {
        display: "block",
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        borderColor: assertMode ? "#10b981" : "#6366f1",
        background: assertMode ? "rgba(16, 185, 129, 0.10)" : "rgba(99, 102, 241, 0.08)"
      });
      highlightLabel.textContent = `${assertMode ? "ASSERT " : ""}${loc.label}`;
      Object.assign(highlightLabel.style, {
        display: "block",
        top: `${Math.max(4, rect.top - 22)}px`,
        left: `${Math.max(4, rect.left)}px`
      });
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!active || paused) return;
      const target = e.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE || isOwnUi(target)) return;

      const { chain, frameSelector } = buildLocatorPrefix();
      const loc = generatePlaywrightLocator(target);
      const fullLocator = `${chain}.${loc.expression}`;

      if (assertMode) {
        e.preventDefault();
        e.stopPropagation();
        const text = cleanText(target.innerText || target.textContent);
        const code =
          text && text.length > 0 && text.length <= 60 && !["input", "textarea", "select"].includes(target.tagName.toLowerCase())
            ? `await expect(${fullLocator}).toContainText('${escapeSingleQuotes(text)}');`
            : `await expect(${fullLocator}).toBeVisible();`;
        sendStep({
          kind: "ASSERT",
          locator: fullLocator,
          label: loc.label,
          frameSelector,
          code
        });
        return;
      }

      const tag = target.tagName.toLowerCase();
      const type = (target.getAttribute("type") || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) && !["button", "submit", "reset", "checkbox", "radio"].includes(type)) {
        return;
      }

      sendStep({
        kind: "CLICK",
        locator: fullLocator,
        label: loc.label,
        frameSelector,
        code: `await ${fullLocator}.click();`
      });
    },
    true
  );

  function recordInputValue(target) {
    if (!active || paused || assertMode) return;
    if (!target || target.nodeType !== Node.ELEMENT_NODE || isOwnUi(target)) return;

    const tag = target.tagName.toLowerCase();
    if (!["input", "textarea", "select"].includes(tag)) return;

    const type = (target.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset", "file"].includes(type)) return;

    const { chain, frameSelector } = buildLocatorPrefix();
    const loc = generatePlaywrightLocator(target);
    const fullLocator = `${chain}.${loc.expression}`;

    if (tag === "select") {
      const val = target.value;
      sendStep({
        kind: "SELECT",
        locator: fullLocator,
        label: loc.label,
        frameSelector,
        code: `await ${fullLocator}.selectOption('${escapeSingleQuotes(val)}');`
      });
      return;
    }

    if (type === "checkbox" || type === "radio") {
      const code = target.checked
        ? `await ${fullLocator}.check();`
        : `await ${fullLocator}.uncheck();`;
      sendStep({
        kind: "CHECK",
        locator: fullLocator,
        label: loc.label,
        frameSelector,
        code
      });
      return;
    }

    const isSensitive =
      type === "password" ||
      (target.getAttribute("autocomplete") || "").toLowerCase().includes("password");
    const valueExpr = isSensitive && maskPasswords
      ? `process.env.TEST_PASSWORD ?? "***"`
      : `'${escapeSingleQuotes(target.value || "")}'`;

    sendStep({
      kind: "FILL",
      locator: fullLocator,
      label: isSensitive ? `${loc.label} (password)` : loc.label,
      frameSelector,
      code: `await ${fullLocator}.fill(${valueExpr});`
    });
  }

  document.addEventListener(
    "input",
    (e) => {
      if (!active || paused || assertMode) return;
      const target = e.target;
      if (!target || isOwnUi(target)) return;
      const tag = target.tagName?.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return;
      const type = (target.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio", "button", "submit", "reset"].includes(type)) return;

      const prev = inputTimers.get(target);
      if (prev) clearTimeout(prev);
      inputTimers.set(
        target,
        setTimeout(() => recordInputValue(target), 450)
      );
    },
    true
  );

  document.addEventListener(
    "change",
    (e) => {
      const target = e.target;
      if (!target || isOwnUi(target)) return;
      const tag = target.tagName?.toLowerCase();
      const type = (target.getAttribute("type") || "").toLowerCase();
      if (tag === "select" || type === "checkbox" || type === "radio") {
        recordInputValue(target);
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (!active || paused || assertMode) return;
      if (e.key !== "Enter") return;
      const target = e.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE || isOwnUi(target)) return;
      const tag = target.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return;

      const prev = inputTimers.get(target);
      if (prev) {
        clearTimeout(prev);
        inputTimers.delete(target);
        recordInputValue(target);
      }

      const { chain, frameSelector } = buildLocatorPrefix();
      const loc = generatePlaywrightLocator(target);
      const fullLocator = `${chain}.${loc.expression}`;
      sendStep({
        kind: "PRESS",
        locator: fullLocator,
        label: `${loc.label} [Enter]`,
        frameSelector,
        code: `await ${fullLocator}.press('Enter');`
      });
    },
    true
  );

  syncSessionState();
})();

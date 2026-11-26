(() => {
  if (window.__testpilotDebuggerLoaded) return;
  window.__testpilotDebuggerLoaded = true;

  let debugHighlightBox = null;
  let debugHighlightLabel = null;

  function ensureDebugHighlight() {
    if (debugHighlightBox) return;
    debugHighlightBox = document.createElement("div");
    debugHighlightBox.setAttribute("data-testpilot-ui", "1");
    Object.assign(debugHighlightBox.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483645",
      border: "2px solid #f59e0b",
      background: "rgba(245, 158, 11, 0.14)",
      borderRadius: "4px",
      display: "none"
    });
    debugHighlightLabel = document.createElement("div");
    debugHighlightLabel.setAttribute("data-testpilot-ui", "1");
    Object.assign(debugHighlightLabel.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: "2147483646",
      background: "#92400e",
      color: "#fef3c7",
      fontFamily: "ui-monospace, monospace",
      fontSize: "11px",
      padding: "2px 6px",
      borderRadius: "4px",
      display: "none",
      maxWidth: "340px",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    });
    document.documentElement.appendChild(debugHighlightBox);
    document.documentElement.appendChild(debugHighlightLabel);
  }

  function hideDebugHighlight() {
    if (debugHighlightBox) debugHighlightBox.style.display = "none";
    if (debugHighlightLabel) debugHighlightLabel.style.display = "none";
  }

  function cleanText(v) {
    return String(v || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function getAccName(el) {
    const aria = cleanText(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return cleanText(lbl.textContent);
    }
    const parentLabel = el.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll("input,select,textarea").forEach((n) => n.remove());
      const t = cleanText(clone.textContent);
      if (t) return t;
    }
    return cleanText(el.innerText || el.textContent || el.getAttribute("title") || el.getAttribute("value"));
  }

  function inferRole(el) {
    const explicit = cleanText(el.getAttribute("role")).toLowerCase();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (["text", "email", "password", "search", "tel", "url", "number"].includes(t)) return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return null;
  }

  function resolveLocatorMatches(locatorExpr) {
    if (!locatorExpr) return [];
    let expr = locatorExpr.trim();
    let rootDoc = document;

    // Optional frameLocator('...') prefix for same-origin iframes
    const frameMatch = expr.match(/^(?:page\.)?frameLocator\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)\.(.*)$/);
    if (frameMatch) {
      const frameSel = frameMatch[2];
      expr = frameMatch[3];
      const iframe = rootDoc.querySelector(frameSel);
      if (!iframe || !iframe.contentDocument) return [];
      rootDoc = iframe.contentDocument;
    } else {
      expr = expr.replace(/^page\./, "");
    }

    const useFirst = /\.first\(\)\s*$/.test(expr);
    expr = expr.replace(/\.first\(\)\s*$/, "");

    let matches = [];
    const testIdMatch = expr.match(/^getByTestId\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)$/);
    const roleMatch = expr.match(/^getByRole\(\s*(['"`])([^'"`]+)\1(?:\s*,\s*\{\s*name\s*:\s*(['"`])((?:\\.|(?!\3).)*)\3\s*\})?\s*\)$/);
    const labelMatch = expr.match(/^getByLabel\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)$/);
    const placeholderMatch = expr.match(/^getByPlaceholder\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)$/);
    const textMatch = expr.match(/^getByText\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)$/);
    const cssMatch = expr.match(/^locator\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)$/);

    const allEls = Array.from(rootDoc.querySelectorAll("body *")).filter(
      (n) => !n.closest("[data-testpilot-ui='1'], #testpilot-recorder-root")
    );

    if (testIdMatch) {
      const id = testIdMatch[2].replace(/\\'/g, "'");
      matches = allEls.filter(
        (el) =>
          el.getAttribute("data-testid") === id ||
          el.getAttribute("data-test-id") === id ||
          el.getAttribute("data-pw") === id
      );
    } else if (roleMatch) {
      const role = roleMatch[2].toLowerCase();
      const name = roleMatch[4] ? roleMatch[4].replace(/\\'/g, "'") : null;
      matches = allEls.filter((el) => {
        if (inferRole(el) !== role) return false;
        if (!name) return true;
        return getAccName(el).includes(name);
      });
    } else if (labelMatch) {
      const lbl = labelMatch[2].replace(/\\'/g, "'");
      matches = allEls.filter((el) => ["input", "textarea", "select"].includes(el.tagName.toLowerCase()) && getAccName(el).includes(lbl));
    } else if (placeholderMatch) {
      const ph = placeholderMatch[2].replace(/\\'/g, "'");
      matches = allEls.filter((el) => (el.getAttribute("placeholder") || "").includes(ph));
    } else if (textMatch) {
      const txt = textMatch[2].replace(/\\'/g, "'");
      matches = allEls.filter((el) => cleanText(el.textContent).includes(txt));
    } else if (cssMatch) {
      const sel = cssMatch[2].replace(/\\'/g, "'");
      try {
        matches = Array.from(rootDoc.querySelectorAll(sel));
      } catch {
        matches = [];
      }
    }

    if (useFirst && matches.length > 0) {
      return [matches[0]];
    }
    return matches;
  }

  function highlightStepTarget(step) {
    if (!step || !step.locatorExpr) {
      hideDebugHighlight();
      return { count: 0 };
    }
    const matches = resolveLocatorMatches(step.locatorExpr);
    if (matches.length === 0) {
      hideDebugHighlight();
      return { count: 0 };
    }
    const target = matches[0];
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    const rect = target.getBoundingClientRect();
    ensureDebugHighlight();
    Object.assign(debugHighlightBox.style, {
      display: "block",
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      borderColor: matches.length === 1 ? "#f59e0b" : "#ef4444",
      background: matches.length === 1 ? "rgba(245, 158, 11, 0.14)" : "rgba(239, 68, 68, 0.14)"
    });
    debugHighlightLabel.textContent =
      matches.length === 1
        ? `Line ${step.line}: 1 match`
        : `Line ${step.line}: ${matches.length} matches (strict violation!)`;
    Object.assign(debugHighlightLabel.style, {
      display: "block",
      top: `${Math.max(4, rect.top - 22)}px`,
      left: `${Math.max(4, rect.left)}px`
    });
    return { count: matches.length };
  }

  function setInputValue(el, value) {
    const proto =
      el.tagName.toLowerCase() === "textarea"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      return `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    } catch {
      return String(url || "").replace(/\/+$/, "");
    }
  }

  async function executeStep(step, timeoutMs = 6000) {
    if (!step) return { ok: false, error: "No step to execute." };
    if (step.kind === "WAIT") {
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true };
    }

    const deadline = Date.now() + timeoutMs;

    if (step.kind === "PAGE_ASSERT") {
      while (Date.now() < deadline) {
        if (step.assertType === "toHaveURL" && window.location.href.includes(step.expected || "")) {
          return { ok: true };
        }
        if (step.assertType === "toHaveTitle" && document.title.includes(step.expected || "")) {
          return { ok: true };
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      if (step.assertType === "toHaveURL") {
        return { ok: false, error: `Expected URL to contain "${step.expected}", got "${window.location.href}"` };
      }
      return { ok: false, error: `Expected title to contain "${step.expected}", got "${document.title}"` };
    }

    if (step.kind === "GOTO") {
      if (normalizeUrl(window.location.href) !== normalizeUrl(step.url)) {
        window.location.href = step.url;
        return { ok: true, navigated: true };
      }
      return { ok: true, navigated: false };
    }

    // Smart auto-wait: poll until target element is present, unique, visible (and matches assertion if ASSERT).
    let lastError = `Locator not found: ${step.locatorExpr}`;
    while (Date.now() < deadline) {
      const matches = resolveLocatorMatches(step.locatorExpr);
      if (matches.length > 1) {
        return {
          ok: false,
          error: `Strict mode violation: ${step.locatorExpr} resolved to ${matches.length} elements.`
        };
      }
      if (matches.length === 1) {
        const el = matches[0];
        if (!isVisible(el)) {
          lastError = `Element found but not visible: ${step.locatorExpr}`;
        } else if (step.kind === "ASSERT") {
          if (step.expected == null) {
            return { ok: true };
          }
          const actual =
            step.assertType === "toHaveValue"
              ? String(el.value ?? "")
              : cleanText(el.innerText || el.textContent);
          const matched =
            step.assertType === "toHaveValue" || step.assertType === "toHaveText"
              ? actual === step.expected || actual.includes(step.expected)
              : actual.includes(step.expected);
          if (matched) return { ok: true };
          lastError = `Expected "${step.expected}", got "${actual.slice(0, 80)}"`;
        } else {
          el.scrollIntoView({ block: "center" });
          if (step.kind === "CLICK") {
            el.click();
            return { ok: true };
          }
          if (step.kind === "FILL") {
            el.focus();
            setInputValue(el, step.value ?? "");
            return { ok: true };
          }
          if (step.kind === "SELECT") {
            el.value = step.value ?? "";
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          }
          if (step.kind === "CHECK") {
            el.checked = Boolean(step.checked);
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          }
          if (step.kind === "PRESS") {
            el.dispatchEvent(new KeyboardEvent("keydown", { key: step.key || "Enter", bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { key: step.key || "Enter", bubbles: true }));
            if ((step.key || "Enter") === "Enter" && el.form) {
              el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
            }
            return { ok: true };
          }
          return { ok: false, error: `Unsupported debug step kind: ${step.kind}` };
        }
      } else {
        lastError = `Locator not found: ${step.locatorExpr}`;
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    return { ok: false, error: lastError };
  }

  window.__testpilotDebugger = {
    highlightStepTarget,
    hideDebugHighlight,
    executeStep,
    resolveLocatorMatches
  };
})();

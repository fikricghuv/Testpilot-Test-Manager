(() => {
  if (window.__testpilotLocatorLoaded) return;
  window.__testpilotLocatorLoaded = true;

  function escapeSingleQuotes(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function countElementsMatchingText(text) {
    const needle = cleanText(text);
    if (!needle) return 0;
    let count = 0;
    const all = document.querySelectorAll("body *");
    for (const node of all) {
      if (node.closest && node.closest("[data-testpilot-ui='1'], #testpilot-recorder-root")) continue;
      const nodeText = cleanText(node.textContent);
      if (nodeText && nodeText.includes(needle)) {
        count += 1;
        if (count > 1) return count;
      }
    }
    return count;
  }

  function getAccessibleName(el) {
    const ariaLabel = cleanText(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => cleanText(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const labelText = cleanText(label?.textContent);
      if (labelText) return labelText;
    }

    const parentLabel = el.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
      const text = cleanText(clone.textContent);
      if (text) return text;
    }

    const title = cleanText(el.getAttribute("title"));
    if (title) return title;

    return cleanText(el.innerText || el.textContent);
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
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["text", "email", "password", "search", "tel", "url", "number"].includes(type)) return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return null;
  }

  function buildCssFallback(el) {
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && isUnique(`#${CSS.escape(el.id)}`)) {
      return `#${el.id}`;
    }
    const nameAttr = el.getAttribute("name");
    if (nameAttr) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(nameAttr)}"]`;
      if (isUnique(sel)) return sel;
    }

    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.id && /^[a-zA-Z][\w-]*$/.test(current.id)) {
        part = `#${current.id}`;
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }

  function generatePlaywrightLocator(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      return { expression: "locator('body')", label: "body", strategy: "fallback" };
    }

    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-pw");
    if (testId) {
      const expr = `getByTestId('${escapeSingleQuotes(testId)}')`;
      return { expression: expr, label: expr, strategy: "testid" };
    }

    const role = inferRole(el);
    const accName = getAccessibleName(el);
    if (role && accName && accName.length <= 60) {
      const expr = `getByRole('${role}', { name: '${escapeSingleQuotes(accName)}' })`;
      return { expression: expr, label: expr, strategy: "role" };
    }

    if (["input", "textarea", "select"].includes(el.tagName.toLowerCase())) {
      if (accName && accName.length <= 60) {
        const expr = `getByLabel('${escapeSingleQuotes(accName)}')`;
        return { expression: expr, label: expr, strategy: "label" };
      }
      const placeholder = cleanText(el.getAttribute("placeholder"));
      if (placeholder) {
        const expr = `getByPlaceholder('${escapeSingleQuotes(placeholder)}')`;
        return { expression: expr, label: expr, strategy: "placeholder" };
      }
    }

    const text = cleanText(el.innerText || el.textContent);
    if (text && text.length > 0 && text.length <= 48 && el.children.length === 0) {
      const matchCount = countElementsMatchingText(text);
      if (matchCount <= 1) {
        const expr = `getByText('${escapeSingleQuotes(text)}')`;
        return { expression: expr, label: expr, strategy: "text" };
      }
      // Multiple elements contain this text (e.g. parent <div> and child <b>): prefer unique CSS/ID to avoid strict mode violation.
      const css = buildCssFallback(el);
      if (css && isUnique(css)) {
        const expr = `locator('${escapeSingleQuotes(css)}')`;
        return { expression: expr, label: expr, strategy: "css" };
      }
      const expr = `getByText('${escapeSingleQuotes(text)}').first()`;
      return { expression: expr, label: expr, strategy: "text" };
    }

    const css = buildCssFallback(el);
    const expr = `locator('${escapeSingleQuotes(css)}')`;
    return { expression: expr, label: expr, strategy: "css" };
  }

  function getFramePrefix() {
    if (window === window.top) return null;
    try {
      const frameEl = window.frameElement;
      if (frameEl) {
        const testId = frameEl.getAttribute("data-testid");
        if (testId) return `iframe[data-testid="${testId}"]`;
        const name = frameEl.getAttribute("name");
        if (name) return `iframe[name="${name}"]`;
        const title = frameEl.getAttribute("title");
        if (title) return `iframe[title="${title}"]`;
        const id = frameEl.getAttribute("id");
        if (id) return `#${id}`;
      }
    } catch {
      // Cross-origin iframe: cannot read frameElement
    }
    return "iframe";
  }

  window.__testpilotLocator = {
    generatePlaywrightLocator,
    getFramePrefix,
    escapeSingleQuotes,
    cleanText
  };
})();

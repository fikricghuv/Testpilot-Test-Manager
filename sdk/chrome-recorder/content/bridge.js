(() => {
  if (window.__testpilotBridgeLoaded) return;
  window.__testpilotBridgeLoaded = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || typeof event.data !== "object") return;
    const { type, payload } = event.data;

    if (type === "TESTPILOT_RECORDER_PING") {
      window.postMessage({ type: "TESTPILOT_RECORDER_PONG", version: "1.0.0" }, "*");
      return;
    }

    if (type === "TESTPILOT_START_RECORDING" && payload) {
      chrome.runtime.sendMessage({ type: "START_RECORDING", payload }, (response) => {
        window.postMessage(
          {
            type: "TESTPILOT_START_RECORDING_ACK",
            ok: Boolean(response?.ok),
            error: response?.error || chrome.runtime.lastError?.message || null
          },
          "*"
        );
      });
      return;
    }

    if (type === "TESTPILOT_START_DEBUG" && payload) {
      chrome.runtime.sendMessage({ type: "START_DEBUG", payload }, (response) => {
        window.postMessage(
          {
            type: "TESTPILOT_START_DEBUG_ACK",
            ok: Boolean(response?.ok),
            error: response?.error || chrome.runtime.lastError?.message || null
          },
          "*"
        );
      });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "RECORDER_SAVED") {
      window.postMessage(
        {
          type: "TESTPILOT_RECORDER_SAVED",
          projectId: msg.projectId,
          testcaseId: msg.testcaseId
        },
        "*"
      );
    }
  });
})();

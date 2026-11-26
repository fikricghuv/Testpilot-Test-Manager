const CONFIG_KEY = "testpilotRecorderPopupConfig";

async function init() {
  const saved = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {};
  document.getElementById("apiBaseUrl").value = saved.apiBaseUrl || "http://localhost:3001";
  document.getElementById("projectId").value = saved.projectId || "";
  document.getElementById("testcaseId").value = saved.testcaseId || "";
  document.getElementById("token").value = saved.token || "";
}

document.getElementById("startBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  const apiBaseUrl = document.getElementById("apiBaseUrl").value.trim();
  const projectId = document.getElementById("projectId").value.trim();
  const testcaseId = document.getElementById("testcaseId").value.trim();
  const token = document.getElementById("token").value.trim();

  if (!apiBaseUrl || !projectId || !testcaseId || !token) {
    statusEl.textContent = "Lengkapi semua field terlebih dahulu.";
    return;
  }

  await chrome.storage.local.set({
    [CONFIG_KEY]: { apiBaseUrl, projectId, testcaseId, token }
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetUrl = tab?.url || "https://example.com";

  chrome.runtime.sendMessage(
    {
      type: "START_RECORDING",
      useCurrentTab: true,
      payload: { apiBaseUrl, projectId, testcaseId, token, targetUrl }
    },
    (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        statusEl.textContent = res?.error || chrome.runtime.lastError?.message || "Gagal memulai recording.";
      } else {
        window.close();
      }
    }
  );
});

init();

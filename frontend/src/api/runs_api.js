// Client HTTP des runs. Une fonction par endpoint, aucune logique d'affichage.

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `${response.status} sur ${url}`);
  }
  return response.json();
}

export function fetchRuns() {
  return request("/api/runs");
}

export function fetchRun(runId) {
  return request(`/api/runs/${runId}`);
}

export function fetchRunStatus(runId) {
  return request(`/api/runs/${runId}/status`);
}

export function cancelRun(runId) {
  return request(`/api/runs/${runId}/cancel`, { method: "POST" });
}

export function sendChatEdit(runId, message) {
  return request(`/api/runs/${runId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export function createRun({ pdf, page, effort, hasCoverPage, extraConfigFile, extraConfigText }) {
  const form = new FormData();
  form.append("pdf", pdf);
  form.append("page", page);
  form.append("effort", effort);
  form.append("has_cover_page", hasCoverPage ? "true" : "false");
  if (extraConfigFile) form.append("extra_config", extraConfigFile);
  if (extraConfigText) form.append("extra_config_text", extraConfigText);
  return request("/api/runs", { method: "POST", body: form });
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `${response.status} sur ${url}`);
  }
  return response.json();
}

export function createJinjaRun(cv, effort = "high") {
  const form = new FormData();
  form.append("cv", cv);
  form.append("effort", effort);
  return request("/api/jinja-runs", { method: "POST", body: form });
}

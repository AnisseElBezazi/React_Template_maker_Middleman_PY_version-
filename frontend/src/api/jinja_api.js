async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `${response.status} sur ${url}`);
  }
  return response.json();
}

export function createJinjaRun(cv) {
  const form = new FormData();
  form.append("cv", cv);
  return request("/api/jinja-runs", { method: "POST", body: form });
}

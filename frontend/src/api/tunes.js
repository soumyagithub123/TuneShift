const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

async function request(path, options) {
  const res = await fetch(`${API_URL}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json();
}

const postJson = (path, body) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const fetchInstruments = () => request('/instruments');

export function startGeneration({ file, region, instrument, settings }) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('start', String(region.start));
  formData.append('length', String(region.end - region.start));
  formData.append('instrument', instrument);
  formData.append('note_smoothing', String(settings.note_smoothing));
  formData.append('pitch_bend', String(settings.pitch_bend));
  formData.append('tempo', String(settings.tempo));
  formData.append('compose', String(settings.compose));
  return request('/generate', { method: 'POST', body: formData });
}

export const fetchStatus = (jobId) => request(`/status/${jobId}`);
export const fetchProject = (jobId) => request(`/projects/${jobId}`);
export const editProject = (jobId, ops) => postJson(`/projects/${jobId}/edit`, ops);
export const aiEditProject = (jobId, instruction) => postJson(`/projects/${jobId}/ai-edit`, { instruction });

export const downloadUrl = (jobId, version) => `${API_URL}/download/${jobId}?v=${version}`;

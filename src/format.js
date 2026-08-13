export const money = (v) => {
  const n = Math.round(v);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
};

export const num = (v, d = 1) =>
  Number.isFinite(v) ? v.toFixed(d) : '—';

export function duration(hours) {
  if (!Number.isFinite(hours)) return '∞';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export const pct = (v, d = 0) => `${(v ?? 0).toFixed(d)}%`;

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

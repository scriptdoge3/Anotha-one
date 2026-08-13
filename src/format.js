/** The career opens on the first of April, 1963. */
export const EPOCH = { y: 1963, m: 3, d: 1 };

export const money = (v) => {
  const n = Math.round(v);
  return `${n < 0 ? '-' : ''}£${Math.abs(n).toLocaleString('en-GB')}`;
};

export const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export function duration(hours) {
  if (!Number.isFinite(hours)) return '∞';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export const pct = (v, d = 0) => `${(v ?? 0).toFixed(d)}%`;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function gameDate(day) {
  const d = new Date(EPOCH.y, EPOCH.m, EPOCH.d);
  d.setDate(d.getDate() + Math.max(0, (day ?? 1) - 1));
  return d;
}

/** Compact stamp for the log roll: "12 APR". */
export function dayStamp(day) {
  const d = gameDate(day);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}`;
}

/** Full stamp for the header: "12 APR 63". */
export function dateStamp(day) {
  const d = gameDate(day);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

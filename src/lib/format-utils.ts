/** Formatting helpers shared by the UI and the library. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDelta(before: number, after: number): string {
  const delta = after - before;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const size = Math.abs(delta);
  if (size < 1024) return `${sign}${size} B`;
  if (size < 1024 * 1024) return `${sign}${(size / 1024).toFixed(1)} KB`;
  return `${sign}${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatPercent(before: number, after: number): string {
  if (before === 0) return '±0%';
  const pct = ((after - before) / before) * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Coordinates formatted for display and for a map link. */
export function formatCoord(value: number): string {
  return value.toFixed(6);
}

export function osmLink(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=15/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

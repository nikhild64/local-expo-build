/**
 * Parses RAM string formats (e.g., '2g', '4096m', '4g', '8', '16g') into MB.
 * Returns null if unparseable or 'default'.
 */
export function parseRamMb(maxRam?: string): number | null {
  if (!maxRam || maxRam === 'default') return null;
  const match = maxRam.toLowerCase().match(/^(\d+)(g|m)?$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2] || 'g';
  return unit === 'm' ? num : num * 1024;
}

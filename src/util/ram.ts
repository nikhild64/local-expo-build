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

/**
 * GRADLE_OPTS value that appends the heap flags to any existing user value
 * instead of replacing it (preserves custom Gradle args, CI overrides, etc.).
 */
export function gradleOptsWithRam(ramMb: number, existing?: string): string {
  const metaspace = ramMb >= 8192 ? '1536m' : '1024m';
  return [existing, `-Xmx${ramMb}m -XX:MaxMetaspaceSize=${metaspace} -XX:+UseParallelGC`]
    .filter(Boolean)
    .join(' ');
}

/** NODE_OPTIONS value that appends the heap cap to any existing user value. */
export function nodeOptionsWithRam(ramMb: number, existing?: string): string {
  return [existing, `--max-old-space-size=${ramMb}`].filter(Boolean).join(' ');
}

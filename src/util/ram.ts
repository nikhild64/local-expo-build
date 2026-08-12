export const MAX_RAM_MB = 64 * 1024; // 64g cap

/**
 * Parses RAM string formats (e.g., '2g', '4096m', '4g', '8', '16g') into MB.
 * Returns null if unparseable or 'default'.
 *
 * Throws on values that would be silently dangerous if passed through:
 * `0`/`0g`/`0m` (no heap at all) and anything above {@link MAX_RAM_MB}
 * (a typo like `999999g` would otherwise flow straight into -Xmx…m).
 */
export function parseRamMb(maxRam?: string): number | null {
  if (!maxRam || maxRam === 'default') return null;
  const match = maxRam.toLowerCase().match(/^(\d+)(g|m)?$/);
  if (!match) {
    // Never silently ignore a user-supplied value: a typo like `--max-ram 2x`
    // should fail loudly instead of quietly running with the default heap.
    throw new Error(
      `Invalid --max-ram "${maxRam}": expected a size like 2g, 4096m, 8g, or 16g (a plain number means gigabytes).`
    );
  }
  const num = parseInt(match[1], 10);
  const unit = match[2] || 'g';
  const mb = unit === 'm' ? num : num * 1024;
  if (mb <= 0) {
    throw new Error(`Invalid --max-ram "${maxRam}": must be a positive amount of memory.`);
  }
  if (mb > MAX_RAM_MB) {
    throw new Error(
      `Invalid --max-ram "${maxRam}": max supported is 64g (${MAX_RAM_MB}m). ` +
        `Use a value like 2g, 4096m, or 16g.`
    );
  }
  return mb;
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

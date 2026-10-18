/**
 * Converts a byte count into a human-readable size string with appropriate binary unit (B, KB, MB, GB).
 * Used for asset file sizes and upload progress displays.
 *
 * @param bytes Non-negative integer representing the size in bytes.
 * @returns Formatted size string (e.g. `512 B`, `12.4 KB`, `45.2 MB`, `1.25 GB`).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Formats a video duration in seconds into `MM:SS` format with zero-padded seconds.
 * Truncates fractional seconds and formats durations without displaying leading hours.
 *
 * @param seconds Non-negative number of seconds.
 * @returns String representation formatted as `MM:SS` (e.g. `3:05`, `0:42`).
 */
export function formatDuration(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * Abbreviates a record UUID for a dense surface such as a table cell or card
 * footer. The tail is the distinguishing part for every id shape in use: random
 * v4, time-ordered v7 (whose leading characters are a timestamp), and the local
 * fixtures, whose prefixes are constant across seeded rows. Prefixes therefore
 * render the same characters for different records, which is why this takes the
 * end. Callers keep the full id reachable through the element's `title`.
 *
 * @param id - Record UUID.
 * @returns The last six characters, or the id when already that short.
 */
export function abbreviateRecordId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

/**
 * Formats only the real provider username for display, adding @ when absent.
 * Null, missing, or whitespace-only usernames return null; IDs and display names
 * must never be passed as username fallbacks. The raw copy value stays unchanged.
 */
export function formatUsername(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

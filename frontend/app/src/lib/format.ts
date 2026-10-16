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

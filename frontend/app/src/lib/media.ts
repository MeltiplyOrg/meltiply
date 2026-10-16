/**
 * Determines whether a given file path or URL represents a supported video media file.
 *
 * Evaluates case-insensitive file extensions against the standard video formats supported
 * by the composer and media library (`.mp4`, `.mov`, `.webm`, `.m4v`).
 * Returns `false` immediately if `path` is empty or undefined.
 *
 * @param path - File path, filename, or URL string to inspect.
 * @returns `true` if the path ends with a recognized video extension; otherwise `false`.
 *
 * @example
 * isVideoPath('upload/reel.MP4'); // -> true
 * isVideoPath('image.png');        // -> false
 * isVideoPath('');                 // -> false
 */
export function isVideoPath(path: string): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".mp4") ||
    lower.endsWith(".mov") ||
    lower.endsWith(".webm") ||
    lower.endsWith(".m4v")
  );
}

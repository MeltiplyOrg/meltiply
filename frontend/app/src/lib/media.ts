const videoExtensionPattern = /\.(?:mp4|mov|webm|m4v)$/i;

export function isVideoPath(path: string): boolean {
  return videoExtensionPattern.test(path);
}

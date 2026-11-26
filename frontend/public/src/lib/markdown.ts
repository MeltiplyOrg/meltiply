const trailingSlashesPattern = /\/+$/;

export function getMarkdownPath(pathname: string): string {
  const path = pathname.replace(trailingSlashesPattern, "");
  return `${path === "/docs" ? "/docs/index" : path}.md`;
}

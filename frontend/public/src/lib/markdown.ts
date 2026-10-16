/**
 * Maps a public guide pathname to its generated Markdown route. Input is a
 * guide path under /docs without query/hash; trailing slashes do not change
 * the result. `/docs/` → `/docs/index.md`,
 * `/docs/channels/` → `/docs/channels.md`.
 */
export function getMarkdownPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, "");
  return `${path === "/docs" ? "/docs/index" : path}.md`;
}

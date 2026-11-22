import type { WorkspaceRole } from "@/types";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function abbreviateRecordId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

export function formatUsername(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export function workspaceRoleLabel(t: (message: string) => string, role: WorkspaceRole): string {
  return role === "admin" ? t("Admin") : role === "editor" ? t("Editor") : t("Viewer");
}

export interface PostDateFormatters {
  day: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
}

const postDateFormatterCache = new Map<string, PostDateFormatters>();
const maximumCachedPostTimeZones = 4;

export function postDateFormatters(timeZone: string): PostDateFormatters {
  const cached = postDateFormatterCache.get(timeZone);
  if (cached) return cached;
  const created: PostDateFormatters = {
    day: new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", timeZone }),
    time: new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: true,
      minute: "2-digit",
      timeZone,
    }),
  };
  if (postDateFormatterCache.size >= maximumCachedPostTimeZones) {
    const oldest = postDateFormatterCache.keys().next().value;
    if (oldest !== undefined) postDateFormatterCache.delete(oldest);
  }
  postDateFormatterCache.set(timeZone, created);
  return created;
}

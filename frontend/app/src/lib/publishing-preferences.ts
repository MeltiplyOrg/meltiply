import { parseDateTime, toZoned } from "@internationalized/date";

import { platformDisplayName } from "@/lib/platforms";
import type { Platform, SignatureTemplate } from "@/types";

export interface SignatureValues {
  brandProfileName: string;
  channelName: string;
  platform: Platform | string;
}

export function resolveSignature(body: string, values: SignatureValues): string {
  const replacements: Readonly<Record<string, string>> = {
    brand_profile: values.brandProfileName,
    channel: values.channelName,
    platform: platformDisplayName(values.platform),
  };
  return body.replace(/\{(brand_profile|platform|channel)\}/g, (_match, key: string) =>
    (replacements[key] ?? "").trim(),
  );
}

export function captionWithSignature(
  content: string,
  signature: string | null | undefined,
): string {
  return [content.trim(), signature?.trim()].filter(Boolean).join("\n\n");
}

export function defaultSignatureTemplate(
  templates: readonly SignatureTemplate[],
): SignatureTemplate | null {
  return templates.find((template) => template.is_default) ?? null;
}

export function wallClockToInstant(value: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  try {
    return toZoned(parseDateTime(value), timeZone, "compatible").toDate().toISOString();
  } catch {
    return null;
  }
}

export function instantToWallClock(
  instant: string | Date,
  timeZone: string,
  defaultMidnightToDaytime = true,
): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  let hour = value("hour");
  if (hour === "24") hour = "00";
  if (defaultMidnightToDaytime && hour === "00" && value("minute") === "00") hour = "10";
  return `${value("year")}-${value("month")}-${value("day")}T${hour}:${value("minute")}`;
}

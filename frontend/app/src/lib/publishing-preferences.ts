import { parseDateTime, toZoned } from "@internationalized/date";

import { platformDisplayName } from "@/lib/platforms";
import type { Platform, SignatureTemplate } from "@/types";

/** Values a saved signature resolves against one actual publication target. */
export interface SignatureValues {
  brandProfileName: string;
  channelName: string;
  platform: Platform | string;
}

/**
 * Resolves the supported placeholders in one signature body.
 *
 * Only `{brand_profile}`, `{platform}`, and `{channel}` are substituted; the
 * server rejects any other placeholder when the template is saved, so a body
 * that reaches the composer always resolves completely. Unknown values fall
 * back to a neutral label rather than leaking an internal identifier.
 *
 * @param body - Template body.
 * @param values - Brand Profile, Platform, and Channel display names.
 * @returns The resolved signature text.
 */
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

/**
 * Selects the default template from a saved list.
 *
 * @param templates - Persisted signature templates.
 * @returns The template marked default, or null when none is configured.
 */
export function defaultSignatureTemplate(
  templates: readonly SignatureTemplate[],
): SignatureTemplate | null {
  return templates.find((template) => template.is_default) ?? null;
}

/**
 * Converts a wall-clock value ('YYYY-MM-DDTHH:mm') in the selected publishing
 * timezone into the exact instant the Scheduler stores.
 *
 * `compatible` disambiguation is the documented behavior: a nonexistent
 * spring-forward time moves forward by the DST gap, and an ambiguous
 * fall-back time selects the earlier occurrence. The returned instant is
 * independent of the browser's own timezone, so changing the preference later
 * never reinterprets an existing Schedule.
 *
 * @param value - Minute-precision wall-clock value.
 * @param timeZone - Supported IANA timezone identifier.
 * @returns ISO instant, or null when the value is incomplete or invalid.
 */
export function wallClockToInstant(value: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  try {
    return toZoned(parseDateTime(value), timeZone, "compatible").toDate().toISOString();
  } catch {
    return null;
  }
}

/**
 * Formats an instant's wall-clock parts in a publishing timezone for the
 * composer's minute-precision input. The result always describes the selected
 * zone, not the browser's zone.
 *
 * @param instant - ISO instant, Date, or existing minute-precision value.
 * @param timeZone - Supported IANA timezone identifier.
 * @param defaultMidnightToDaytime - Apply the calendar-click 10:00 suggestion.
 * @returns Wall-clock value, or an empty string when unparseable.
 */
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

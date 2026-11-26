export async function clonedJsonRecord(
  message: Request | Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await message.clone().json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function clonedStringField(
  request: Request,
  field: string,
): Promise<string | undefined> {
  const value = (await clonedJsonRecord(request))?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

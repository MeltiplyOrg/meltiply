import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

/**
 * Optional browser-local recovery for the first-run form.
 *
 * Only the non-secret fields are ever written: the deployment setup secret and
 * the account password stay in component memory and are cleared on submit, on
 * a recoverable failure, and on success. The record rides the existing
 * functional-consent store (`meltiply.*` prefix), so a withdrawal removes it and
 * a visitor who never granted functional consent simply keeps the values for the
 * current page only.
 */
const draftKey = "meltiply.onboarding.setup";

/** Non-secret first-run values that may survive a reload or a recoverable failure. */
export interface SetupDraft {
  email: string;
  name: string;
  workspaceName: string;
}

/** Field bound mirroring the API contract, so a tampered record cannot become input truth. */
const fieldLimit = 200;

/**
 * Reads the remembered non-secret first-run values.
 *
 * Each field is narrowed to a bounded string because the record is browser
 * data, not trusted input: an unreadable, oversized, or wrong-typed entry is
 * dropped rather than becoming form state.
 *
 * @returns The stored draft, or `null` when absent, unreadable, or denied by
 *   functional consent.
 */
export function readSetupDraft(): SetupDraft | null {
  const raw = readFunctionalStorage(draftKey);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const field = (value: unknown) => (typeof value === "string" ? value.slice(0, fieldLimit) : "");
    return {
      email: field(record.email),
      name: field(record.name),
      workspaceName: field(record.workspaceName),
    };
  } catch {
    return null;
  }
}

/**
 * Remembers the non-secret first-run values.
 *
 * An empty draft is deleted rather than stored, and a value is only written
 * when functional consent allows optional storage.
 *
 * @param draft Current non-secret form values.
 */
export function writeSetupDraft(draft: SetupDraft): void {
  if (!draft.email && !draft.name && !draft.workspaceName) {
    writeFunctionalStorage(draftKey, null);
    return;
  }
  writeFunctionalStorage(draftKey, JSON.stringify(draft));
}

/** Drops the remembered values once the account exists or the journey ends. */
export function clearSetupDraft(): void {
  writeFunctionalStorage(draftKey, null);
}

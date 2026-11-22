import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

const draftKey = "meltiply.onboarding.setup";

export interface SetupDraft {
  email: string;
  name: string;
  workspaceName: string;
}

const fieldLimit = 200;

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

export function writeSetupDraft(draft: SetupDraft): void {
  if (!draft.email && !draft.name && !draft.workspaceName) {
    writeFunctionalStorage(draftKey, null);
    return;
  }
  writeFunctionalStorage(draftKey, JSON.stringify(draft));
}

export function clearSetupDraft(): void {
  writeFunctionalStorage(draftKey, null);
}

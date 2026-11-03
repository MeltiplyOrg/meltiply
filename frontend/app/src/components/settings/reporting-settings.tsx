import { useState } from "react";
import { Alert } from "@meltiply/ui/alert";
import { Button } from "@meltiply/ui/button";
import { Switch } from "@meltiply/ui/switch";
import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useI18n } from "@/lib/i18n";
import { useReportingPolicy, useUpdateReportingPreferences } from "@/lib/queries";

import { ReportingDisclosure } from "./reporting-disclosure";

/**
 * Installation improvement-reporting controls inside Settings.
 *
 * Every active member can read the disclosure and the effective state; only the
 * current Installation Owner can save a change, so authority follows ownership
 * transfer rather than the account that completed setup. A member sees the same
 * requested-versus-effective explanation with the switches disabled and the
 * Owner-only boundary stated, instead of a control that silently fails.
 *
 * Saving replaces both choices together, which is the contract's operation; an
 * unchanged decision never becomes a new consent interval.
 *
 * @returns React element rendering the reporting section.
 */
export function ReportingSettings(): React.ReactElement {
  const { t } = useI18n();
  const { isInstallationOwner } = useWorkspace();
  const scope = useSessionScope();
  const policy = useReportingPolicy(scope);
  const save = useUpdateReportingPreferences(scope);
  // The controls render the persisted choice until the Owner edits one. An
  // explicit local override keeps the first paint honest and means a policy read
  // can never be rendered as a choice that has not been saved.
  const [choiceOverride, setChoiceOverride] = useState<{
    diagnostics: boolean;
    usage: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = policy.data;
  const usage = choiceOverride?.usage ?? stored?.categories.usage.requested ?? false;
  const diagnostics =
    choiceOverride?.diagnostics ?? stored?.categories.diagnostics.requested ?? false;
  const setUsage = (value: boolean) => setChoiceOverride({ diagnostics, usage: value });
  const setDiagnostics = (value: boolean) =>
    setChoiceOverride({ diagnostics: value, usage });
  const canChange = isInstallationOwner && stored?.owner_can_change === true;
  const dirty =
    stored !== undefined &&
    (stored.categories.usage.requested !== usage ||
      stored.categories.diagnostics.requested !== diagnostics);

  const run = async () => {
    setError(null);
    try {
      await save.mutateAsync({ diagnostics, usage });
      // Hand the controls back to the persisted policy once the write lands.
      setChoiceOverride(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("Your choices could not be saved. Try again."),
      );
    }
  };

  return (
    <section aria-label={t("Privacy and improvement reporting")} className="space-y-5">
      {error && <Alert variant="destructive">{error}</Alert>}
      {policy.error && (
        <Alert variant="destructive">
          {t("The reporting policy could not be read, so nothing is sent.")}
        </Alert>
      )}
      <div className="space-y-1">
        <h2 className="text-(length:--font-size-ui) font-semibold">{t("Improvement reporting")}</h2>
        <p className="text-xs leading-relaxed text-ink-2">
          {isInstallationOwner
            ? t(
                "You are the Installation Owner, so you decide what this installation shares. Both reports start off.",
              )
            : t(
                "The Installation Owner decides what this installation shares. You can review the choice and its current effect here.",
              )}
        </p>
      </div>
      <div className="space-y-3">
        {(
          [
            {
              checked: usage,
              description: t("Daily totals of connected Channels and successful publishing."),
              id: "reporting-usage",
              label: t("Usage statistics"),
              onChange: setUsage,
            },
            {
              checked: diagnostics,
              description: t(
                "Unexpected application failures with the operation category and sanitized release locations, plus expected Provider conditions such as expired authorization and rate limits reported separately with their class. No message text, content, name, or identifier is included.",
              ),
              id: "reporting-diagnostics",
              label: t("Diagnostic reports"),
              onChange: setDiagnostics,
            },
          ] as const
        ).map((category) => (
          <div
            key={category.label}
            className="flex items-start gap-3 rounded-control border border-line p-3"
          >
            <Switch
              id={category.id}
              checked={category.checked}
              onCheckedChange={category.onChange}
              disabled={!canChange || save.isPending}
              aria-describedby={`${category.id}-help`}
            />
            <div className="min-w-0 space-y-1">
              <label
                htmlFor={category.id}
                className="text-(length:--font-size-control) font-medium text-ink"
              >
                {category.label}
              </label>
              <p id={`${category.id}-help`} className="text-xs leading-relaxed text-ink-2">
                {category.description}
              </p>
            </div>
          </div>
        ))}
      </div>
      <ReportingDisclosure policy={stored ?? null} />
      {canChange && (
        <Button type="button" disabled={!dirty || save.isPending} onClick={() => void run()}>
          {save.isPending ? t("Saving…") : t("Save reporting choices")}
        </Button>
      )}
    </section>
  );
}

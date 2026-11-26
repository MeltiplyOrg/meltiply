import { errorMessage } from "@meltiply/domain";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Check, Share2, UserRoundPlus } from "lucide-react";
import { Alert } from "@meltiply/ui/alert";
import { Button } from "@meltiply/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { Switch } from "@meltiply/ui/switch";
import { StatusPill } from "@meltiply/ui/status-pill";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useI18n } from "@/lib/i18n";
import {
  useCompleteOnboarding,
  useReportingFeedback,
  useReportingPolicy,
  useSaveOnboarding,
  useSubmitReportingFeedback,
  useUpdateReportingPreferences,
} from "@/lib/queries";
import {
  DISCOVERY_SOURCES,
  discoverySourceLabel,
  ReportingDisclosure,
} from "@/components/settings/reporting-disclosure";
import type { DiscoverySource, OnboardingProgress, ReportingFeedback } from "@/types";

type WizardStep = "improvement" | "ready";

function feedbackStatus(t: (message: string) => string, feedback: ReportingFeedback): string {
  if (feedback.delivery_status === "delivered") return t("PostHog accepted your answer.");
  if (feedback.delivery_status === "pending")
    return t("Queued to send. Receipt is not confirmed yet.");
  if (feedback.discovery_source === "prefer_not_to_say")
    return t("Saved on this installation. Nothing was sent.");
  return t("Saved on this installation, but no report was queued.");
}

function ReadyScreen({
  onDone,
  pending,
}: {
  onDone: (destination: string) => void;
  pending: boolean;
}): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <Button
        type="button"
        size="lg"
        className="h-auto w-full justify-between gap-4 px-4 py-3"
        disabled={pending}
        onClick={() => onDone("/channels")}
      >
        <span className="flex items-center gap-1">
          <Share2 className="size-3.5" aria-hidden="true" />
          {pending ? t("Finishing setup…") : t("Connect a Channel")}
        </span>
        <ArrowRight className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="h-auto w-full justify-between gap-4 px-4 py-3"
        disabled={pending}
        onClick={() => onDone("/settings?section=administration")}
      >
        <span className="flex items-center gap-1">
          <UserRoundPlus className="size-3.5" aria-hidden="true" />
          {t("Invite a teammate")}
        </span>
        <ArrowRight className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className="w-full"
        disabled={pending}
        onClick={() => onDone("/posts")}
      >
        {pending ? t("Finishing setup…") : t("Enter the Workspace")}
      </Button>
    </div>
  );
}

function ImprovementScreen({
  advancing,
  onContinue,
}: {
  advancing: boolean;
  onContinue: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  const scope = useSessionScope();
  const policy = useReportingPolicy(scope);
  const feedbackQuery = useReportingFeedback(scope);
  const savePreferences = useUpdateReportingPreferences(scope);
  const submitFeedback = useSubmitReportingFeedback(scope);
  const [choiceOverride, setChoiceOverride] = useState<{
    diagnostics: boolean;
    usage: boolean;
  } | null>(null);
  const [source, setSource] = useState<DiscoverySource | "">("");
  const [error, setError] = useState<string | null>(null);

  const stored = policy.data;
  const usage = choiceOverride?.usage ?? stored?.categories.usage.requested ?? false;
  const diagnostics =
    choiceOverride?.diagnostics ?? stored?.categories.diagnostics.requested ?? false;
  const setUsage = (value: boolean) => setChoiceOverride({ diagnostics, usage: value });
  const setDiagnostics = (value: boolean) => setChoiceOverride({ diagnostics: value, usage });
  const answered = feedbackQuery.data;
  const feedback =
    answered && (answered.submitted_at !== null || answered.discovery_source !== null)
      ? answered
      : null;
  const pending = savePreferences.isPending || advancing;

  const finish = async (save: boolean) => {
    setError(null);
    const changed =
      stored !== undefined &&
      (stored.categories.usage.requested !== usage ||
        stored.categories.diagnostics.requested !== diagnostics);
    if (!save || !changed) {
      onContinue();
      return;
    }
    try {
      await savePreferences.mutateAsync({ diagnostics, usage });
      setChoiceOverride(null);
      onContinue();
    } catch (cause) {
      setError(errorMessage(cause, t("Your choices could not be saved. Try again.")));
    }
  };

  const share = async () => {
    if (!source) return;
    setError(null);
    try {
      await submitFeedback.mutateAsync({ discoverySource: source });
    } catch (cause) {
      setError(errorMessage(cause, t("Your answer could not be shared. Try again.")));
    }
  };

  return (
    <div className="space-y-5">
      {error && (
        <Alert variant="destructive" id="wizard-error">
          {error}
        </Alert>
      )}
      <fieldset className="space-y-3">
        <legend className="text-(length:--font-size-control) font-medium text-ink">
          {t("Usage statistics and diagnostic reports")}
        </legend>
        {(
          [
            {
              checked: usage,
              description: t("Daily totals of connected Channels and successful publishing."),
              id: "wizard-usage",
              label: t("Usage statistics"),
              onChange: setUsage,
              status: stored?.categories.usage ?? null,
            },
            {
              checked: diagnostics,
              description: t(
                "Unexpected application failures with the operation category and sanitized release locations, plus expected Provider conditions such as expired authorization and rate limits reported separately with their class. No message text, content, name, or identifier is included.",
              ),
              id: "wizard-diagnostics",
              label: t("Diagnostic reports"),
              onChange: setDiagnostics,
              status: stored?.categories.diagnostics ?? null,
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
              disabled={pending}
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
              {category.status?.requested && !category.status.effective && (
                <StatusPill tone="orange">{t("Not sending")}</StatusPill>
              )}
            </div>
          </div>
        ))}
      </fieldset>
      <ReportingDisclosure policy={stored ?? null} />

      <section
        aria-labelledby="wizard-feedback-heading"
        className="space-y-3 border-t border-line pt-5"
      >
        <div className="space-y-1">
          <h2
            id="wizard-feedback-heading"
            className="text-(length:--font-size-control) font-medium text-ink"
          >
            {t("How did you hear about Meltiply?")}
          </h2>
          <p className="text-xs leading-relaxed text-ink-2">
            {t(
              "Optional. Choosing an answer does nothing on its own; Share feedback sends only your selected answer to PostHog Cloud and does not turn on either report.",
            )}
          </p>
        </div>
        {feedback ? (
          <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            <StatusPill
              tone={feedback.delivery_status === "delivered" ? "green" : "neutral"}
              dot={false}
            >
              {feedback.delivery_status === "delivered"
                ? t("Confirmed")
                : feedback.shared
                  ? t("Shared")
                  : t("Not sent")}
            </StatusPill>
            {feedbackStatus(t, feedback)}
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={source}
              onValueChange={(value) => setSource(value as DiscoverySource)}
              disabled={submitFeedback.isPending}
            >
              <SelectTrigger className="w-full sm:max-w-xs" aria-label={t("Discovery source")}>
                <SelectValue placeholder={t("Select an answer")} />
              </SelectTrigger>
              <SelectContent>
                {DISCOVERY_SOURCES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {discoverySourceLabel(t, option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={!source || submitFeedback.isPending}
              onClick={() => void share()}
            >
              {submitFeedback.isPending ? t("Sharing…") : t("Share feedback")}
            </Button>
          </div>
        )}
      </section>

      <div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" disabled={pending} onClick={() => void finish(false)}>
          {t("Skip")}
        </Button>
        <Button type="button" disabled={pending} onClick={() => void finish(true)}>
          {pending ? t("Please wait…") : t("Continue")}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function OnboardingWizard({
  progress,
}: {
  progress: OnboardingProgress;
}): React.ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const scope = useSessionScope();
  const complete = useCompleteOnboarding(scope);
  const saveProgress = useSaveOnboarding(scope);
  const [step, setStep] = useState<WizardStep>(progress.step);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const advance = async () => {
    setError(null);
    try {
      await saveProgress.mutateAsync({ step: "ready" });
      setStep("ready");
    } catch (cause) {
      setError(errorMessage(cause, t("Your progress could not be saved. Try again.")));
    }
  };

  const finish = async (destination: string) => {
    setError(null);
    try {
      await complete.mutateAsync({});
      void navigate(destination, { replace: true });
    } catch (cause) {
      setError(errorMessage(cause, t("Setup could not be finished. Try again.")));
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8 sm:px-8 sm:py-12">
      <section className="w-full max-w-2xl space-y-6 rounded-window border border-line bg-surface p-6 sm:p-8">
        <ol className="flex items-center gap-2 text-xs text-ink-3" aria-label={t("Setup progress")}>
          <li className="flex items-center gap-1">
            <Check className="size-3.5 text-green" aria-hidden="true" />
            {t("Account")}
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current={step === "improvement" ? "step" : undefined}>
            {t("Improvement choices")}
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current={step === "ready" ? "step" : undefined}>{t("Finish")}</li>
        </ol>
        <div className="space-y-2">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-(length:--text-title) leading-8 font-semibold tracking-page-title text-ink"
          >
            {step === "improvement" ? t("Help improve Meltiply") : t("You're ready")}
          </h1>
          <p className="text-sm leading-relaxed text-ink-2">
            {step === "improvement"
              ? t(
                  "Both reports are off unless you turn one on. Nothing is sent until you save an enabled choice, and you can change it in Settings.",
                )
              : t(
                  "Connect a Channel, invite a teammate, or enter the Workspace now. Neither setup step is required.",
                )}
          </p>
        </div>
        {error && <Alert variant="destructive">{error}</Alert>}
        {step === "improvement" ? (
          <ImprovementScreen advancing={saveProgress.isPending} onContinue={() => void advance()} />
        ) : (
          <ReadyScreen
            onDone={(destination) => void finish(destination)}
            pending={complete.isPending}
          />
        )}
      </section>
    </main>
  );
}

import { Alert } from "@meltiply/ui/alert";
import { StatusPill } from "@meltiply/ui/status-pill";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import type { DiscoverySource, ReportingCategoryStatus, ReportingPolicy } from "@/types";

/**
 * Atomic discovery-source choices in their documented order. The source of
 * truth is the generated contract enum; this list only fixes presentation order.
 */
export const DISCOVERY_SOURCES: readonly DiscoverySource[] = [
  "github",
  "search_engine",
  "social_media",
  "video",
  "article_newsletter",
  "friend_word_of_mouth",
  "ai_assistant",
  "other",
  "prefer_not_to_say",
];

/**
 * Resolves the localized label for one fixed discovery-source value.
 *
 * @param t Active translation function.
 * @param source Contract enum value.
 * @returns The translated label; an unknown runtime value falls back to `Other`
 *   rather than inventing free text.
 */
export function discoverySourceLabel(t: (message: string) => string, source: DiscoverySource) {
  const labels: Record<DiscoverySource, string> = {
    article_newsletter: t("Article or newsletter"),
    ai_assistant: t("ChatGPT or another AI assistant"),
    friend_word_of_mouth: t("Friend or word of mouth"),
    github: t("GitHub"),
    other: t("Other"),
    prefer_not_to_say: t("Prefer not to say"),
    search_engine: t("Search engine"),
    social_media: t("Social media"),
    video: t("Video"),
  };
  return labels[source] ?? t("Other");
}

/**
 * Explains one category's requested-versus-effective state.
 *
 * The reason describes why a category is or is not sending, so a disabled
 * destination, an unreadable preference record, or an operator override never
 * reads as working consent.
 *
 * @param t Active translation function.
 * @param status One category's status from the policy document.
 * @returns The reason sentence.
 */
function categoryReason(t: (message: string) => string, status: ReportingCategoryStatus) {
  switch (status.reason) {
    case "enabled":
      return t("Sending while enabled.");
    case "operator_disabled":
      return t("The deployment operator has turned reporting off.");
    case "destination_unavailable":
      return t("This deployment has no reporting destination configured.");
    case "preference_unavailable":
      return t("The saved choice could not be read, so nothing is sent.");
    default:
      return t("Not enabled.");
  }
}

/**
 * Renders the improvement-reporting disclosure shared by the first-run wizard
 * and Settings: what each category sends, who receives it, the persistent
 * installation identifier, and the operator override.
 *
 * The disclosure is copy plus state, never an implicit choice: reading it does
 * not enable a category, and every mutation stays in the calling surface.
 *
 * @param props.policy Current installation policy, or `null` while unreadable.
 * @param props.className Optional layout classes.
 * @returns React element rendering the disclosure block.
 */
export function ReportingDisclosure({
  policy,
  className,
}: {
  policy: ReportingPolicy | null;
  className?: string;
}): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className={cn("space-y-3", className)}>
      <dl className="space-y-3">
        {(
          [
            {
              description: t(
                "Daily totals only: connected Channels by platform, successful Posts and Distributions, and the latest stored views, reactions, comments, and shares.",
              ),
              label: t("Usage statistics"),
              status: policy?.categories.usage ?? null,
            },
            {
              description: t(
                "Unexpected application failures with the operation category, app version, and sanitized release locations. Expected Provider conditions — expired authorization, rate limits, quotas, timeouts, and unconfirmed outcomes — are reported separately with their class, so they never mix with application defects. No message text, content, name, or identifier is included.",
              ),
              label: t("Diagnostic reports"),
              status: policy?.categories.diagnostics ?? null,
            },
          ] as const
        ).map((category) => (
          <div key={category.label} className="space-y-1">
            <dt className="text-(length:--font-size-control) font-medium text-ink">
              {category.label}
            </dt>
            <dd className="text-xs leading-relaxed text-ink-2">{category.description}</dd>
            {category.status && (
              <dd className="flex flex-wrap items-center gap-2 pt-1 text-xs text-ink-2">
                <StatusPill tone={category.status.effective ? "green" : "neutral"}>
                  {category.status.requested ? t("Requested") : t("Not requested")}
                </StatusPill>
                <StatusPill tone={category.status.effective ? "green" : "neutral"} dot={false}>
                  {category.status.effective ? t("Sending") : t("Not sending")}
                </StatusPill>
                <span>{categoryReason(t, category.status)}</span>
              </dd>
            )}
          </div>
        ))}
      </dl>
      <p className="text-xs leading-relaxed text-ink-2">
        {t(
          "Reports go to PostHog Cloud, operated by the Meltiply maintainer. Participating installations share one random installation identifier, so reports can be linked over time: they are pseudonymous, not completely anonymous.",
        )}
      </p>
      <p className="text-xs leading-relaxed text-ink-2">
        {t(
          "Names, email addresses, Workspace names, Channel usernames, content, and credentials are never included. Neither category is required, and each can be changed later in Settings.",
        )}
      </p>
      {policy?.installation_reporting_id && (
        <p className="wrap-anywhere text-xs leading-relaxed text-ink-3">
          {t("Installation reporting identifier: {id}", {
            id: policy.installation_reporting_id,
          })}
        </p>
      )}
      {policy?.operator_forced_off && (
        <Alert variant="info">
          {t(
            "The deployment operator has turned reporting off, so neither category can send from this installation.",
          )}
        </Alert>
      )}
      {policy && !policy.destination_configured && (
        <Alert variant="info">
          {t(
            "This deployment has no reporting destination configured, so nothing can be sent yet. Your choices are saved and take effect if a destination is configured.",
          )}
        </Alert>
      )}
    </div>
  );
}

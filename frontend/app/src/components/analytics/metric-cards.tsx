import { Info } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { formatAnalyticsInteger } from "./analytics-helpers";
import type { AnalyticsSummary } from "@/types";

const COMPACT_FORMATS: Record<Language, Intl.NumberFormat> = {
  en: new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" }),
  es: new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1, notation: "compact" }),
  "pt-BR": new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, notation: "compact" }),
  fr: new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, notation: "compact" }),
  de: new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1, notation: "compact" }),
  it: new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1, notation: "compact" }),
  zh: new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, notation: "compact" }),
  vi: new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1, notation: "compact" }),
};

const CARDS = [
  { key: "views", label: "Views", definition: "Views reported for posts published in this range." },
  { key: "likes", label: "Likes", definition: "Likes reported for those posts." },
  { key: "comments", label: "Comments", definition: "Comments reported for those posts." },
  {
    key: "shares",
    label: "Shares",
    definition: "Shares, reposts, and quotes reported for those posts.",
  },
  {
    key: "post_count",
    label: "Published destinations",
    definition:
      "One Post can publish to multiple Channels; each published Distribution counts once.",
  },
] as const;

/**
 * Five exact totals for the published cohort. Values never come from an
 * inferred rate: the four stored counters and the published destination count
 * are the whole vocabulary. Each definition is reachable by hover or keyboard.
 */
export function MetricCards({
  totals,
}: {
  totals: AnalyticsSummary["totals"];
}): React.ReactElement {
  const { t, language } = useI18n();
  return (
    <TooltipProvider>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {CARDS.map((card) => {
          const value = totals[card.key];
          const exact = formatAnalyticsInteger(value, language);
          // Only totals wider than seven digits compact, and only on narrow
          // screens. Desktop always carries the exact grouped integer.
          const compactOnPhone = value >= 10_000_000;
          const compact = COMPACT_FORMATS[language].format(value);
          return (
            <div
              key={card.key}
              className={cn(
                "min-w-0 rounded-control border border-line bg-surface px-3 py-2.5",
                card.key === "post_count" && "col-span-2 sm:col-span-1",
              )}
            >
              <dt className="flex items-center gap-1 text-(length:--font-size-micro) font-medium uppercase tracking-wide text-ink-3">
                <span className="min-w-0 truncate">{t(card.label)}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-4 min-w-0 text-ink-3 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                      aria-label={t("About {metric}", { metric: t(card.label) })}
                    >
                      <Info className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t(card.definition)}</TooltipContent>
                </Tooltip>
              </dt>
              <dd
                className="mt-1 truncate font-mono text-xl font-semibold leading-none tabular-nums text-ink"
                title={exact}
                aria-label={`${t(card.label)}: ${exact}`}
              >
                <span className={compactOnPhone ? "hidden sm:inline" : undefined}>{exact}</span>
                {compactOnPhone && <span className="sm:hidden">{compact}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </TooltipProvider>
  );
}

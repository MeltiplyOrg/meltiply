import { ArrowRight, Pencil, Users } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@meltiply/ui/card";
import { Empty, EmptyDescription } from "@meltiply/ui/empty";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { brandProfileColorClass, type BrandProfile } from "@/types";

/**
 * Gr8r Teams' grid adapted to actual Brand Profiles. Counts come from loaded
 * workspace accounts, never the filtered directory; viewing a card delegates
 * scope selection to the workspace owner. Editing is absent for non-admins.
 */
export function BrandProfileDirectory({
  profiles,
  channelCounts,
  onViewChannels,
  onEdit,
}: {
  profiles: readonly BrandProfile[];
  channelCounts: ReadonlyMap<string, number>;
  onViewChannels: (id: string) => void;
  onEdit?: (profile: BrandProfile) => void;
}) {
  const { t } = useI18n();
  if (profiles.length === 0)
    return (
      <Empty className="border-0">
        <EmptyDescription>
          {t(
            "No Brand Profiles yet. Ask a workspace admin to create one, or use Create Brand Profile if you are an admin.",
          )}
        </EmptyDescription>
      </Empty>
    );
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {profiles.map((profile) => (
        <Card key={profile.id}>
          <CardHeader className="gap-3 p-4">
            <div className="flex items-center justify-between">
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-card",
                  brandProfileColorClass(profile.color),
                )}
              >
                <Users className="size-4 text-white" />
              </span>
              {onEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("Edit {name}", { name: profile.name })}
                  onClick={() => onEdit(profile)}
                >
                  <Pencil className="size-3.5" />
                </Button>
              )}
            </div>
            <div>
              <CardTitle className="text-ui font-semibold">{profile.name}</CardTitle>
              <CardDescription className="mt-1 line-clamp-2 text-control">
                {profile.description || t("Publishing identity and connected accounts.")}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4 text-xs text-ink-3">
            {t("{count} connected accounts", { count: channelCounts.get(profile.id) ?? 0 })}
          </CardContent>
          <CardFooter className="justify-between border-t border-line-soft px-4 py-2">
            <span className="font-mono text-micro text-ink-3">{profile.id.slice(0, 8)}</span>
            <Button variant="ghost" size="sm" onClick={() => onViewChannels(profile.id)}>
              {t("View channels")}
              <ArrowRight className="size-3" />
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}

import { Edit3, Trash2 } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { useI18n } from "@/lib/i18n";

export interface PostActionsProps {
  postId: string;
  canMutate: boolean;
  canDelete: boolean;
  onEdit: (postId: string) => void;
  onDelete: (postId: string) => void;
}

const QUICK_ACTION_CLASS =
  "h-6 w-5.5 sm:opacity-0 group-hover/row:opacity-100 group-hover/card:opacity-100 group-focus-within/actions:opacity-100";

/**
 * Gr8r-style row/card quick actions. Inspection is the card's own stretched hit
 * area, so only the real composer and confirmed-deletion flows stay here: a
 * redundant overflow menu would duplicate them without adding a capability.
 * Publication status is never manually editable. Keyboard focus reveals the
 * same actions, and delete carries the destructive colour.
 */
export function PostActions({ postId, canMutate, canDelete, onEdit, onDelete }: PostActionsProps) {
  const { t } = useI18n();
  if (!canMutate && !canDelete) return null;
  return (
    <div
      className="group/actions flex items-center justify-end"
      onClick={(event) => event.stopPropagation()}
    >
      {canMutate && (
        <Button
          variant="ghost"
          size="icon"
          className={QUICK_ACTION_CLASS}
          title={t("Edit post")}
          aria-label={t("Edit post")}
          onClick={() => onEdit(postId)}
        >
          <Edit3 className="size-3.5" />
        </Button>
      )}
      {canDelete && (
        <Button
          variant="ghost"
          size="icon"
          className={`${QUICK_ACTION_CLASS} text-red hover:text-red`}
          title={t("Delete post")}
          aria-label={t("Delete post")}
          onClick={() => onDelete(postId)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

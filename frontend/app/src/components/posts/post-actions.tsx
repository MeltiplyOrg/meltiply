import { Edit3, Ellipsis, Info, Trash2 } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@meltiply/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n";

export interface PostActionsProps {
  postId: string;
  canMutate: boolean;
  onViewDetails: (postId: string) => void;
  onEdit: (postId: string) => void;
  onDelete: (postId: string) => void;
}

const QUICK_ACTION_CLASS =
  "h-6 w-5.5 sm:opacity-0 group-hover/row:opacity-100 group-hover/card:opacity-100 group-focus-within/actions:opacity-100";

/**
 * Gr8r-style row/card hover actions and persistent overflow menu. Publication
 * status is never manually editable: the menu offers real inspection, composer,
 * and confirmed deletion flows. Keyboard focus reveals the same quick actions.
 */
export function PostActions({
  postId,
  canMutate,
  onViewDetails,
  onEdit,
  onDelete,
}: PostActionsProps) {
  const { t } = useI18n();
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
      <Button
        variant="ghost"
        size="icon"
        className={QUICK_ACTION_CLASS}
        title={t("Delete post")}
        aria-label={t("Delete post")}
        onClick={() => onDelete(postId)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6.5"
            aria-label={t("Post actions")}
            title={t("Post actions")}
          >
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onViewDetails(postId)}>
            <Info className="size-3.5" />
            {t("View details")}
          </DropdownMenuItem>
          {canMutate && (
            <DropdownMenuItem onClick={() => onEdit(postId)}>
              <Edit3 className="size-3.5" />
              {t("Edit post")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-red focus:text-red" onClick={() => onDelete(postId)}>
            <Trash2 className="size-3.5" />
            {t("Delete post")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

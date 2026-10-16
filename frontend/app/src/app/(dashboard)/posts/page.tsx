import { useMemo } from "react";
import { useNavigate } from "react-router";

import type { WorkspaceView } from "@/components/layout/navigation-shell";
import { workspaceViewPath } from "@/components/primitives/sidebar-nav";
import { PostsView } from "@/components/posts/posts-view";
import type { PostStatusFilter, PostViewMode } from "@/components/posts/types";
import { useSearchParams } from "@/lib/navigation";

/**
 * Resolves the posts hub's initial view mode from the `?view=` deep-link param.
 *
 * @param viewParam - Parsed `?view=` query value, if present.
 * @returns The initial `PostViewMode` for `PostsView` (`list` when absent/unknown).
 */
function resolveViewMode(viewParam: string | null): PostViewMode {
  return viewParam === "calendar" || viewParam === "composer" || viewParam === "grid"
    ? viewParam
    : "list";
}

/**
 * Resolves the posts hub's initial status filter from the `?status=` deep-link param.
 *
 * @param statusParam - Parsed `?status=` query value, if present.
 * @returns The initial `PostStatusFilter` for `PostsView` (`all` when absent/unknown).
 */
function resolveStatusFilter(statusParam: string | null): PostStatusFilter {
  return statusParam === "scheduled" ||
    statusParam === "draft" ||
    statusParam === "published" ||
    statusParam === "failed"
    ? statusParam
    : "all";
}

/**
 * Canonical RFC 4122 UUID form. A deep link that is not one can never identify an
 * existing Post, so it is ignored instead of driving a doomed composer load.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Unified posts hub route hosting the `PostsView` at the canonical `/posts` path.
 *
 * Derives the initial view mode and status filter from `?view=`/`?status=` deep
 * links, and opens the composer on an existing Post through `?editPostId=<uuid>`
 * — the stable Post identity rather than a composite key derived from an asset
 * and a timestamp. Forwards in-view navigation (e.g. "open composer") back into
 * React Router through the canonical workspace route map.
 *
 * @returns React element rendering the posts workspace view.
 */
export default function PostsPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const navigate = useNavigate();

  const initialViewMode = useMemo(() => resolveViewMode(searchParams.get("view")), [searchParams]);
  const initialStatusFilter = useMemo(
    () => resolveStatusFilter(searchParams.get("status")),
    [searchParams],
  );
  const editPostIdParam = searchParams.get("editPostId");
  const initialPostId =
    editPostIdParam && UUID_PATTERN.test(editPostIdParam) ? editPostIdParam : undefined;

  const handleNavigate = (view: WorkspaceView, options?: { search?: string }) => {
    const query = options?.search
      ? options.search.startsWith("?")
        ? options.search
        : `?${options.search}`
      : "";
    navigate(`${workspaceViewPath(view)}${query}`);
  };

  return (
    <PostsView
      initialPostId={initialPostId}
      initialViewMode={initialViewMode}
      initialStatusFilter={initialStatusFilter}
      onNavigate={handleNavigate}
    />
  );
}

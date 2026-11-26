import { useMemo } from "react";

import { useSearchParams, useWorkspaceNavigate } from "@/lib/navigation";
import { PostsView } from "@/components/posts/posts-view";
import type { PostStatusFilter, PostViewMode } from "@/components/posts/types";

function resolveViewMode(viewParam: string | null): PostViewMode {
  return viewParam === "table" || viewParam === "calendar" || viewParam === "grid"
    ? viewParam
    : "table";
}

function resolveStatusFilter(statusParam: string | null): PostStatusFilter {
  return statusParam === "scheduled" ||
    statusParam === "draft" ||
    statusParam === "published" ||
    statusParam === "failed"
    ? statusParam
    : "all";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PostsPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const handleNavigate = useWorkspaceNavigate();

  const initialViewMode = useMemo(() => resolveViewMode(searchParams.get("view")), [searchParams]);
  const initialStatusFilter = useMemo(
    () => resolveStatusFilter(searchParams.get("status")),
    [searchParams],
  );
  const editPostIdParam = searchParams.get("editPostId");
  const initialPostId =
    editPostIdParam && UUID_PATTERN.test(editPostIdParam) ? editPostIdParam : undefined;

  return (
    <PostsView
      initialPostId={initialPostId}
      initialViewMode={initialViewMode}
      initialStatusFilter={initialStatusFilter}
      initialComposerOpen={searchParams.get("view") === "composer"}
      onNavigate={handleNavigate}
    />
  );
}

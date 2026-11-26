import React from "react";

import { useSessionScope } from "@/hooks/use-session-scope";
import { useAsset, useAssetPreviewUrl } from "@/lib/queries";
import { isVideoPath } from "@/lib/media";
import { cn } from "@meltiply/ui/utils";

interface MediaPreviewSource {
  assetId: string;
  assetType?: string;
  hintPath?: string;
  fallbackSrc?: string;
  enabled?: boolean;
}

function useMediaPreview(source: MediaPreviewSource): { src: string; isVideo: boolean } {
  const scope = useSessionScope();
  const assetQuery = useAsset(scope, source.assetId, source.assetType === undefined);
  const previewQuery = useAssetPreviewUrl(scope, source.assetId, source.enabled ?? true);
  const assetType = source.assetType ?? assetQuery.data?.asset_type;
  const src = previewQuery.data?.url ?? source.fallbackSrc ?? "";
  const isVideo =
    assetType === "video" || (assetType === undefined && isVideoPath(source.hintPath ?? ""));
  return { src, isVideo };
}

export interface MediaPreviewProps extends MediaPreviewSource {
  className?: string;
  videoClassName?: string;
  alt: string;
  empty: React.ReactNode;
}

export function MediaPreview({
  className,
  videoClassName,
  alt,
  empty,
  ...source
}: MediaPreviewProps): React.ReactElement {
  const { src, isVideo } = useMediaPreview(source);
  if (isVideo) {
    return (
      <video src={src || undefined} className={cn(className, videoClassName)} preload="metadata" />
    );
  }
  if (src) {
    return <img src={src} alt={alt} className={className} loading="lazy" />;
  }
  return <>{empty}</>;
}

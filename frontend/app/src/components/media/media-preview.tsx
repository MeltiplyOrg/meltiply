import React from "react";

import { useSessionScope } from "@/hooks/use-session-scope";
import { useAsset, useAssetPreviewUrl } from "@/lib/queries";
import { isVideoPath } from "@/lib/media";
import { cn } from "@meltiply/ui/utils";

/**
 * Input contract for media preview resolution.
 *
 * `assetId` drives the signed preview URL request; `assetType` supplies the
 * contract `asset_type` when the caller already holds the Asset record (the Post
 * composer embeds it per attachment, so no extra Asset request is needed), and
 * `hintPath`/`fallbackSrc` cover attachments still uploading or processing:
 * `hintPath` seeds video detection from the declared MIME type or filename and
 * `fallbackSrc` renders a local blob URL until the signed URL resolves.
 */
interface MediaPreviewSource {
  /** Contract asset id whose signed preview URL should be resolved. */
  assetId: string;
  /** Contract `asset_type` when known; video detection falls back to `hintPath` extension. */
  assetType?: string;
  /** Stored path or filename used for extension-based video detection when `assetType` is absent. */
  hintPath?: string;
  /** Stored URL rendered while the signed preview URL resolves or when it is unavailable. */
  fallbackSrc?: string;
  /** When false, the signed preview request stays inert (e.g. non-ready assets). */
  enabled?: boolean;
}

/**
 * Resolves the signed preview when enabled, falling back to a local upload URL.
 * Known Asset types avoid a metadata fetch; otherwise resolve the type from
 * the Asset or filename because signed URLs need not contain an extension.
 */
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

/**
 * Props for the shared {@link MediaPreview} thumbnail primitive.
 */
export interface MediaPreviewProps extends MediaPreviewSource {
  /** Classes applied to both the `<img>` and `<video>` element (sizing, object-fit). */
  className?: string;
  /** Extra classes applied only to the `<video>` element (e.g. `pointer-events-none`). */
  videoClassName?: string;
  /** Accessible alt text for the image variant. */
  alt: string;
  /** Placeholder rendered when no preview URL is available. */
  empty: React.ReactNode;
}

/**
 * Renders composer attachment previews with a caller-supplied empty placeholder.
 * Images lazy-load; videos preload metadata without playback controls.
 */
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

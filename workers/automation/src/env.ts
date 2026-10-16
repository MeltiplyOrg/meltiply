import type { MediaProcessorRpcOutcome, NativeProcessorJob } from "./native-processor";
import type { ReplyWorkflowPayload } from "./messages";

/**
 * RPC contract of the MediaProcessorContainer Durable Object, which owns the
 * single native FFmpeg/libvips processor instance this Worker may use. Jobs
 * reach the engine only through this private binding, never a public route.
 */
export interface MediaProcessorStub extends Rpc.DurableObjectBranded {
  process(job: NativeProcessorJob): Promise<MediaProcessorRpcOutcome>;
}

export interface AutomationEnv {
  ANALYTICS_QUEUE?: Queue<unknown>;
  ASSETS?: R2Bucket;
  ASSET_PROCESSING_QUEUE?: Queue<unknown>;
  CHANNEL_REVOCATION_QUEUE?: Queue<unknown>;
  COMMENTS_QUEUE?: Queue<unknown>;
  DB_SYSTEM?: Hyperdrive;
  ENVIRONMENT: string;
  LOG_SAMPLE_RATE?: string;
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  FACEBOOK_LIVE_ACCEPTED?: string;
  FACEBOOK_PUBLISH_QUEUE?: Queue<unknown>;
  INSTAGRAM_CLIENT_ID?: string;
  INSTAGRAM_CLIENT_SECRET?: string;
  INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED?: string;
  INSTAGRAM_LIVE_ACCEPTED?: string;
  INSTAGRAM_PUBLISH_QUEUE?: Queue<unknown>;
  /**
   * Private processor lookup and RPC surface; excludes stub lifecycle methods
   * whose class-specific types make full DurableObjectNamespace types invariant.
   * The engine remains reachable only through this binding.
   */
  MEDIA_PROCESSOR?: {
    /** Maps the asset-scoped processor name to its stable Durable Object ID. */
    idFromName(name: string): DurableObjectId;
    /** Resolves the ID to the typed process RPC without exposing container internals. */
    get(id: DurableObjectId): Pick<DurableObjectStub<MediaProcessorStub>, "process">;
  };
  /** Verified public API origin; remote-ingest media URLs are signed under its `/api/v1/provider-media/` route. */
  PUBLIC_API_URL?: string;
  REPLIES_QUEUE?: Queue<unknown>;
  REPLY_WORKFLOW?: Workflow<ReplyWorkflowPayload>;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  /** Optional trusted S3 origin for local runs (plain HTTP only when ENVIRONMENT is local/test). */
  R2_ENDPOINT?: string;
  /** Optional path prefix the local runtime serves the bucket under (e.g. /cdn-cgi/local/r2/s3). */
  R2_ENDPOINT_PATH_PREFIX?: string;
  R2_SECRET_ACCESS_KEY?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  TIKTOK_LIVE_ACCEPTED?: string;
  /** Verified-domain HTTPS directory prefix TikTok validates remote-ingest URLs against; must cover the API provider-media route. */
  TIKTOK_MEDIA_URL_PREFIX?: string;
  TIKTOK_PUBLISH_QUEUE?: Queue<unknown>;
  /** Shared secret; also the HMAC-SHA256 material signing verified-domain provider-media URLs. */
  TOKEN_ENCRYPTION_KEY?: string;
  TOKEN_REFRESH_QUEUE?: Queue<unknown>;
  THREADS_CLIENT_ID?: string;
  THREADS_CLIENT_SECRET?: string;
  THREADS_ENGAGEMENT_LIVE_ACCEPTED?: string;
  THREADS_LIVE_ACCEPTED?: string;
  THREADS_PUBLISH_QUEUE?: Queue<unknown>;
  VERSION: string;
  YOUTUBE_LIVE_ACCEPTED?: string;
  YOUTUBE_PUBLISH_QUEUE?: Queue<unknown>;
  YOUTUBE_SHORTS_CLIENT_ID?: string;
  YOUTUBE_SHORTS_CLIENT_SECRET?: string;
}

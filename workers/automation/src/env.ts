import type { ProviderOriginSetting } from "@meltiply/providers";
import type { MediaProcessorRpcOutcome, NativeProcessorJob } from "./native-processor";
import type { ReplyWorkflowPayload } from "./messages";

export interface MediaProcessorStub extends Rpc.DurableObjectBranded {
  process(job: NativeProcessorJob): Promise<MediaProcessorRpcOutcome>;
}

export interface AutomationEnv extends Partial<Record<ProviderOriginSetting, string>> {
  ANALYTICS_QUEUE?: Queue<unknown>;
  ASSETS?: R2Bucket;
  ASSET_PROCESSING_QUEUE?: Queue<unknown>;
  CHANNEL_REVOCATION_QUEUE?: Queue<unknown>;
  COMMENTS_QUEUE?: Queue<unknown>;
  RECURRING_COMMENTS_ENABLED?: string;
  PUBLISH_BATCH_CONCURRENCY?: string;
  REPORTING_FORCED_OFF?: string;
  REPORTING_POSTHOG_HOST?: string;
  REPORTING_POSTHOG_PROJECT_TOKEN?: string;
  DATABASE_POOL_MODE?: "request";
  DEPLOYMENT_CATEGORY?: string;
  DB_SYSTEM?: Hyperdrive;
  ENVIRONMENT: string;
  LOG_SAMPLE_RATE?: string;
  MAIL?: SendEmail;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  NOTIFICATIONS_QUEUE?: Queue<unknown>;
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  FACEBOOK_LIVE_ACCEPTED?: string;
  FACEBOOK_PUBLISH_QUEUE?: Queue<unknown>;
  INSTAGRAM_CLIENT_ID?: string;
  INSTAGRAM_CLIENT_SECRET?: string;
  INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED?: string;
  INSTAGRAM_LIVE_ACCEPTED?: string;
  INSTAGRAM_PUBLISH_QUEUE?: Queue<unknown>;
  MEDIA_PROCESSOR?: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): Pick<MediaProcessorStub, "process">;
  };
  APP_URL?: string;
  REPLIES_QUEUE?: Queue<unknown>;
  REPLY_WORKFLOW?: Workflow<ReplyWorkflowPayload>;
  OBJECT_STORAGE_PROVIDER?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ENDPOINT?: string;
  R2_ENDPOINT_PATH_PREFIX?: string;
  R2_SECRET_ACCESS_KEY?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_FORCE_PATH_STYLE?: string;
  S3_REGION?: string;
  S3_SECRET_ACCESS_KEY?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  TIKTOK_LIVE_ACCEPTED?: string;
  TIKTOK_MEDIA_URL_PREFIX?: string;
  TIKTOK_PUBLISH_QUEUE?: Queue<unknown>;
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

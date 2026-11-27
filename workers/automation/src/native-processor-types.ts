export interface NativeProcessorProfile {
  allowed_content_types: string[];
  effort: number | null;
  kind: "image" | "video";
  max_duration_seconds: number | null;
  max_height: number | null;
  max_width: number | null;
  name: string;
  quality: number | null;
}

export interface NativeProcessorJob {
  asset_id: string;
  declared_content_type: string;
  deadline_seconds?: number | null;
  expected_checksum?: string | null;
  expected_size: number;
  input_url: string;
  job_id: string;
  maximum_output_bytes: number;
  output_url: string;
  profile: NativeProcessorProfile;
}

interface NativeProcessorInput {
  bytes: number;
  sha256: string;
}

interface NativeProcessorOutput {
  bytes: number;
  content_type: string;
  etag: string | null;
  sha256: string;
}

interface NativeProcessorMedia {
  animated: boolean;
  content_type: string;
  duration_seconds: number | null;
  frame_count: number | null;
  has_audio: boolean;
  height: number | null;
  width: number | null;
}

interface NativeProcessorEngineInfo {
  duration_ms: number;
  ffmpeg: string;
  vips: string;
}

export interface NativeProcessorSuccess {
  engine: NativeProcessorEngineInfo;
  input: NativeProcessorInput;
  job_id: string;
  media: NativeProcessorMedia;
  output: NativeProcessorOutput | null;
  replayed?: boolean;
  result: "optimized" | "original_compatible";
  status: "succeeded";
}

export interface NativeProcessorFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export type MediaProcessorRpcOutcome =
  | { error: NativeProcessorFailure; ok: false }
  | { ok: true; result: NativeProcessorSuccess };

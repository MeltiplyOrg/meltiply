import { EffectObjectStore } from "../src/object-store";
import type { MultipartUpload, ObjectMetadata } from "../src";

export const METADATA: ObjectMetadata = {
  contentType: "image/png",
  etag: "etag-one",
  key: "org/asset/photo.png",
  size: 3,
  uploadedAt: new Date("2026-01-01T00:00:00Z"),
};

export class FakeObjectStore extends EffectObjectStore {
  readonly calls: unknown[][] = [];
  object: ObjectMetadata | null = METADATA;
  failure: unknown;

  private record(...call: unknown[]) {
    if (this.failure !== undefined) throw this.failure;
    this.calls.push(call);
  }

  async head(key: string) {
    this.record("head", key);
    return this.object;
  }

  async delete(key: string) {
    this.record("delete", key);
  }

  async copyObject(sourceKey: string, destinationKey: string) {
    this.record("copyObject", sourceKey, destinationKey);
    return this.object;
  }

  async read(key: string) {
    this.record("read", key);
    return null;
  }

  async readRange(key: string, offset: number, maximumBytes: number) {
    this.record("readRange", key, offset, maximumBytes);
    return new Uint8Array([1, 2]);
  }

  async createMultipartUpload(key: string, contentType: string) {
    this.record("createMultipartUpload", key, contentType);
    return this.upload("upload-new");
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    this.record("resumeMultipartUpload", key, uploadId);
    return this.upload(uploadId);
  }

  private upload(uploadId: string): MultipartUpload {
    return {
      abort: async () => this.record("abort", uploadId),
      complete: async (parts) => {
        this.record("complete", uploadId, parts);
        return METADATA;
      },
      uploadId,
      uploadPart: async (partNumber) => {
        this.record("uploadPart", uploadId, partNumber);
        return { etag: "part-etag", partNumber };
      },
    };
  }
}

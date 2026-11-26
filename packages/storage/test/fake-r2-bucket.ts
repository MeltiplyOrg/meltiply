import type { R2BucketLike } from "../src";

type R2Object = NonNullable<Awaited<ReturnType<R2BucketLike["head"]>>>;
type R2Body = NonNullable<Awaited<ReturnType<R2BucketLike["get"]>>>;
type R2Upload = ReturnType<R2BucketLike["resumeMultipartUpload"]>;

export const UPLOADED = new Date("2026-01-01T00:00:00Z");

export function r2Body(fields: Partial<R2Body> = {}): R2Body {
  return {
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    etag: "etag-one",
    key: "org/asset/clip.mp4",
    size: 3,
    uploaded: UPLOADED,
    ...fields,
  };
}

export class FakeR2Bucket implements R2BucketLike {
  readonly calls: unknown[][] = [];
  object: R2Body | null = null;
  written: R2Object | null = r2Body({ etag: "etag-written" });

  async head(key: string) {
    this.calls.push(["head", key]);
    return this.object;
  }

  async get(key: string, options?: Parameters<R2BucketLike["get"]>[1]) {
    this.calls.push(options === undefined ? ["get", key] : ["get", key, options]);
    return this.object;
  }

  async put(...[key, value, options]: Parameters<R2BucketLike["put"]>) {
    this.calls.push(["put", key, value, options]);
    return this.written;
  }

  async delete(key: string) {
    this.calls.push(["delete", key]);
  }

  async createMultipartUpload(key: string, options: { httpMetadata: { contentType: string } }) {
    this.calls.push(["createMultipartUpload", key, options]);
    return this.upload("upload-new");
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    this.calls.push(["resumeMultipartUpload", key, uploadId]);
    return this.upload(uploadId);
  }

  private upload(uploadId: string): R2Upload {
    return {
      abort: async () => {
        this.calls.push(["abort", uploadId]);
      },
      complete: async (parts) => {
        this.calls.push(["complete", uploadId, parts]);
        return r2Body({ etag: "etag-complete" });
      },
      uploadId,
      uploadPart: async (partNumber, value) => {
        this.calls.push(["uploadPart", uploadId, partNumber, value]);
        return { etag: `part-${partNumber}`, partNumber };
      },
    };
  }
}

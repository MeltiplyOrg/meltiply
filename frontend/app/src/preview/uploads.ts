import { Schema } from "effect";
import { http, HttpResponse } from "msw";
import type { components } from "@meltiply/contracts/schema";
import type { Asset } from "@/types";
import { asset, timestamp } from "./data";

type Upload = {
  asset: Asset;
  upload_session: components["schemas"]["UploadSession"];
  uploaded_parts: [];
};

/** Owns tab-local sample Assets and single-part uploads. Uploaded bytes remain local Blobs; nothing is sent to R2 or a Provider. */
export function createPreviewUploads() {
  const assets = new Map([[asset.id, structuredClone(asset)]]);
  const sessions = new Map<string, Upload>();
  const handlers = [
    http.post("/api/v1/asset-upload-sessions", async ({ request }) => {
      const input = Schema.decodeUnknownSync(
        Schema.Struct({
          asset_type: Schema.Literals(["image", "video"]),
          brand_profile_id: Schema.String,
          filename: Schema.String,
          content_type: Schema.String,
          file_size: Schema.Number,
          title: Schema.String,
        }),
      )(await request.json());
      const id = crypto.randomUUID();
      const item: Asset = {
        ...asset,
        id: crypto.randomUUID(),
        brand_profile_id: input.brand_profile_id,
        asset_type: input.asset_type,
        title: input.title,
        mime_type: input.content_type,
        file_size: input.file_size,
        status: "pending_upload",
        thumbnail_url: null,
        download_url: null,
      };
      const expires = new Date(Date.now() + 3600000).toISOString();
      const upload: Upload = {
        asset: item,
        upload_session: {
          id,
          asset_id: item.id,
          strategy: "single",
          status: "created",
          expires_at: expires,
          content_type: input.content_type,
          file_size: input.file_size,
          single_upload: {
            url: new URL(`/__preview-upload/${id}`, request.url).href,
            method: "PUT",
            headers: { "Content-Type": input.content_type },
            expires_at: expires,
          },
          multipart: null,
        },
        uploaded_parts: [],
      };
      assets.set(item.id, item);
      sessions.set(id, upload);
      return HttpResponse.json(upload, { status: 201 });
    }),
    http.put("/__preview-upload/:id", async ({ params, request }) => {
      const upload = sessions.get(String(params.id));
      if (!upload) return new HttpResponse(null, { status: 404 });
      const url = URL.createObjectURL(await request.blob());
      upload.asset.download_url = url;
      upload.asset.thumbnail_url = upload.asset.asset_type === "image" ? url : null;
      upload.upload_session.status = "uploading";
      return new HttpResponse(null, { headers: { ETag: "preview-local-blob" } });
    }),
    http.get("/api/v1/asset-upload-sessions/:id", ({ params }) => {
      const upload = sessions.get(String(params.id));
      return upload ? HttpResponse.json(upload) : new HttpResponse(null, { status: 404 });
    }),
    http.post("/api/v1/asset-upload-sessions/:id/complete", ({ params }) => {
      const upload = sessions.get(String(params.id));
      if (!upload?.asset.download_url) return new HttpResponse(null, { status: 409 });
      upload.asset.status = "ready";
      upload.asset.updated_at = timestamp;
      upload.upload_session.status = "completed";
      return HttpResponse.json(upload);
    }),
    http.delete("/api/v1/asset-upload-sessions/:id", ({ params }) => {
      const upload = sessions.get(String(params.id));
      if (upload) {
        if (upload.asset.download_url?.startsWith("blob:"))
          URL.revokeObjectURL(upload.asset.download_url);
        assets.delete(upload.asset.id);
        sessions.delete(String(params.id));
      }
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("/api/v1/assets/:id", ({ params }) => {
      const item = assets.get(String(params.id));
      return item ? HttpResponse.json(item) : new HttpResponse(null, { status: 404 });
    }),
    http.get(/\/api\/v1\/assets\/([^/]+)\/(?:preview|download)-url$/, ({ params, request }) => {
      const item = assets.get(String(params[0]));
      if (!item?.download_url) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json({
        url: new URL(item.download_url, request.url).href,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }),
  ];
  return { assets, handlers };
}

import { http, HttpResponse } from "msw";
import type {
  PreviewObject,
  PreviewOperation,
  PreviewResponse,
  PreviewValue,
} from "./contract-types";

type Upload = { asset: PreviewObject; upload_session: PreviewObject };
type Parameters = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Supplies browser-only file effects behind generated operations. Response templates come from the contract; bytes remain local Blobs and are never sent to R2. */
export function createPreviewUploads(assetTemplate: PreviewObject, sessionTemplate: PreviewObject) {
  const assets = new Map<string, PreviewObject>();
  if (typeof assetTemplate.id === "string") assets.set(assetTemplate.id, assetTemplate);
  const sessions = new Map<string, Upload>();
  const blobHandler = http.put("/__preview-upload/:id", async ({ params, request }) => {
    const upload = sessions.get(String(params.id));
    if (!upload) return new HttpResponse(null, { status: 404 });
    if (
      typeof upload.asset.download_url === "string" &&
      upload.asset.download_url.startsWith("blob:")
    )
      URL.revokeObjectURL(upload.asset.download_url);
    const url = URL.createObjectURL(await request.blob());
    upload.asset.download_url = url;
    upload.asset.thumbnail_url = upload.asset.asset_type === "image" ? url : null;
    upload.upload_session.status = "uploading";
    return new HttpResponse(null, { headers: { ETag: "preview-local-blob" } });
  });

  /** Applies only byte/session effects that static HTTP examples cannot supply. All route registration and selected errors remain owned by the generated handler. */
  function handle(
    operation: PreviewOperation,
    request: Request,
    params: Parameters,
    input: PreviewObject,
  ): PreviewResponse | undefined {
    const id = String(params.session_id ?? params.asset_id ?? "");
    if (operation.operationId === "createUploadSession") {
      const sessionId = crypto.randomUUID();
      const assetId = crypto.randomUUID();
      const asset: PreviewObject = {
        ...assetTemplate,
        id: assetId,
        status: "pending_upload",
        thumbnail_url: null,
        download_url: null,
      };
      for (const key of ["asset_type", "brand_profile_id", "title", "file_size"])
        if (input[key] !== undefined) asset[key] = input[key];
      if (typeof input.content_type === "string") asset.mime_type = input.content_type;
      const expires = new Date(Date.now() + 3600000).toISOString();
      const upload: Upload = {
        asset,
        upload_session: {
          ...sessionTemplate,
          id: sessionId,
          asset_id: assetId,
          strategy: "single",
          status: "created",
          expires_at: expires,
          content_type: input.content_type ?? sessionTemplate.content_type ?? null,
          file_size: input.file_size ?? sessionTemplate.file_size ?? null,
          multipart: null,
          single_upload: {
            url: new URL(`/__preview-upload/${sessionId}`, request.url).href,
            method: "PUT",
            headers: {
              "Content-Type":
                typeof input.content_type === "string"
                  ? input.content_type
                  : "application/octet-stream",
            },
            expires_at: expires,
          },
        },
      };
      assets.set(assetId, asset);
      sessions.set(sessionId, upload);
      return { status: operation.success.status, body: upload };
    }
    if (
      ["getUploadSession", "completeUploadSession", "abortUploadSession"].includes(
        operation.operationId,
      )
    ) {
      const upload = sessions.get(id);
      if (!upload) return { status: 404 };
      if (operation.operationId === "completeUploadSession") {
        if (!upload.asset.download_url) return { status: 409 };
        upload.asset.status = "ready";
        upload.upload_session.status = "completed";
      }
      if (operation.operationId === "abortUploadSession") {
        if (
          typeof upload.asset.download_url === "string" &&
          upload.asset.download_url.startsWith("blob:")
        )
          URL.revokeObjectURL(upload.asset.download_url);
        sessions.delete(id);
        assets.delete(String(upload.asset.id));
        return { status: operation.success.status };
      }
      return {
        status: operation.success.status,
        body:
          operation.operationId === "getUploadSession" ? { ...upload, uploaded_parts: [] } : upload,
      };
    }
    if (["getAsset", "getAssetPreviewUrl", "getAssetDownloadUrl"].includes(operation.operationId)) {
      const asset = assets.get(id);
      if (!asset) return { status: 404 };
      const body: PreviewValue =
        operation.operationId === "getAsset"
          ? asset
          : {
              url: asset.download_url ?? asset.thumbnail_url ?? null,
              expires_at: new Date(Date.now() + 3600000).toISOString(),
            };
      return { status: operation.success.status, body };
    }
    return undefined;
  }
  return { assets, blobHandler, handle };
}

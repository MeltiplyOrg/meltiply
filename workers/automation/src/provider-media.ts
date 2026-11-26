import {
  createObjectStoreFromEnv,
  createObjectUrlSignerFromEnv,
  signProviderMediaUrl,
  type ConfiguredObjectStore,
  type ObjectUrlSigner,
} from "@meltiply/storage";

import type { DistributionProviderDependencies } from "./distribution-provider";
import type { AutomationEnv } from "./env";

const contentTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const unsafeObjectKeyPattern = /[\u0000-\u001f\u007f\\]/;

export const providerMediaRetrievalLeaseSeconds = 24 * 60 * 60;

function normalizedContentType(value: string | undefined): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && contentTypePattern.test(normalized) ? normalized : null;
}

function verifiedRemoteIngestUrl(env: AutomationEnv, key: string): Promise<string | undefined> {
  return signProviderMediaUrl({
    appUrl: env.APP_URL,
    expiresAtSeconds: Math.floor(Date.now() / 1000) + providerMediaRetrievalLeaseSeconds,
    key,
    secret: env.TOKEN_ENCRYPTION_KEY,
  });
}

function validateObjectKey(assetId: string, key: string): void {
  const segments = key.split("/");
  if (
    segments.length < 3 ||
    segments[1] !== assetId ||
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || unsafeObjectKeyPattern.test(segment),
    )
  ) {
    throw new TypeError("provider media object key is invalid");
  }
}

function validateMetadata(
  request: {
    contentType: string;
    fileSize: number;
  },
  object: { contentType: string | null; size: number },
): void {
  if (
    !Number.isSafeInteger(request.fileSize) ||
    request.fileSize < 1 ||
    object.size !== request.fileSize ||
    normalizedContentType(object.contentType ?? undefined) !==
      normalizedContentType(request.contentType)
  ) {
    throw new TypeError("provider media metadata does not match the object store");
  }
}
export function createProviderMediaResolver(
  env: AutomationEnv,
  signer: ObjectUrlSigner | undefined = undefined,
): NonNullable<DistributionProviderDependencies["mediaFor"]> {
  let resolvedSigner = signer;
  let resolvedStore: ConfiguredObjectStore | undefined;
  return async (request) => {
    if (!resolvedStore) {
      try {
        resolvedStore = createObjectStoreFromEnv(env);
      } catch {
        throw new TypeError("provider media object storage is unavailable");
      }
    }
    const store = resolvedStore;
    validateObjectKey(request.assetId, request.objectKey);
    const contentType = normalizedContentType(request.contentType);
    if (!contentType) {
      throw new TypeError("provider media content type is invalid");
    }

    if (request.transferMode === "remote_ingest") {
      const object = await store.head(request.objectKey);
      if (!object) throw new TypeError("provider media object is unavailable");
      validateMetadata(request, object);
      const verifiedUrl = await verifiedRemoteIngestUrl(env, request.objectKey);
      if (verifiedUrl) {
        return {
          contentType,
          fileSize: request.fileSize,
          mode: "remote_ingest",
          url: verifiedUrl,
        };
      }
      resolvedSigner ??= createObjectUrlSignerFromEnv(env);
      return {
        contentType,
        fileSize: request.fileSize,
        mode: "remote_ingest",
        url: await resolvedSigner.signDownload({
          expiresInSeconds: providerMediaRetrievalLeaseSeconds,
          key: request.objectKey,
        }),
      };
    }

    const object = await store.read(request.objectKey);
    if (!object) throw new TypeError("provider media object is unavailable");
    validateMetadata(request, object);
    return {
      body: object.body,
      contentType,
      fileSize: request.fileSize,
      mode: request.transferMode,
    };
  };
}

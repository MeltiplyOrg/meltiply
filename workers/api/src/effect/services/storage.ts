import type { Layer } from "effect";
import { StorageUnavailableError } from "@meltiply/domain";
import { createR2SignerFromEnv, createStorageServiceLive, StorageService } from "@meltiply/storage";

import type { ApiWorkerEnv } from "../../env";

/** Identifies missing API storage bindings without conflating remote R2 failures. */
export class StorageConfigurationError extends StorageUnavailableError {}

/**
 * Creates a live production Layer for StorageService backed by Cloudflare R2 bucket and credentials.
 *
 * Bucket operations and URL signing are configured independently. Missing ASSETS
 * fails object operations lazily with StorageConfigurationError, while valid signing
 * credentials still issue URLs. Layer construction does not preempt route validation.
 *
 * Signing is delegated to the shared `createR2SignerFromEnv` factory rather than
 * re-assembled here, so the API worker signs uploads, previews, and downloads against
 * exactly the same origin and path prefix as the automation worker. That is what makes
 * a local run consistent: the browser and the processor container fetch byte-identical
 * signed URLs, and the development-only permission to sign a plain-HTTP origin stays
 * derived from `ENVIRONMENT` alone. Incomplete credentials yield no signer (signing
 * then fails closed with a storage error) rather than throwing during layer construction.
 *
 * @param env - Worker environment bindings containing R2 bucket, SigV4 credentials, and optional endpoint override.
 * @returns Layer providing production storage or operations failing with StorageConfigurationError.
 */
export function createStorageServiceLiveFromEnv(
  env: ApiWorkerEnv,
): Layer.Layer<StorageService, never, never> {
  let signer;
  if (env.R2_ACCESS_KEY_ID && env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME && env.R2_SECRET_ACCESS_KEY) {
    try {
      signer = createR2SignerFromEnv(env);
    } catch {
      // Rejected endpoint or credentials: leave the signer unset so signing
      // fails closed instead of issuing URLs that cannot be honored.
      signer = undefined;
    }
  }

  return createStorageServiceLive({
    bucket: env.ASSETS,
    signer,
    storageUnavailableError: new StorageConfigurationError({
      message: "Asset storage is unavailable.",
    }),
  });
}

export { StorageService };

import type { Layer } from "effect";
import { StorageUnavailableError } from "@meltiply/domain";
import {
  createObjectStoreFromEnv,
  createObjectUrlSignerFromEnv,
  createStorageServiceLive,
  type ConfiguredObjectStore,
  type ObjectUrlSigner,
  StorageService,
} from "@meltiply/storage";

import type { ApiWorkerEnv } from "../../env";

/** Identifies missing API storage bindings without conflating remote storage failures. */
export class StorageConfigurationError extends StorageUnavailableError {}

/**
 * Creates a live production Layer for StorageService over the configured object storage provider.
 *
 * Both the store and the signer come from the shared provider factory, so this
 * Worker never decides for itself which backend it is on: it can only report what
 * its configuration selected. R2 stays the default, and an S3 deployment signs
 * uploads, previews, and downloads against exactly the same origin the
 * automation Worker uses, which is what keeps the browser and the processor
 * container fetching byte-identical URLs.
 *
 * Store and signer availability are configured independently. A missing store
 * fails object operations lazily with StorageConfigurationError, while valid
 * signing credentials still issue URLs. Neither construction throws: an
 * incomplete or untrusted configuration leaves the corresponding capability
 * unset so it fails closed instead of issuing URLs that cannot be honored.
 *
 * @param env - Worker environment bindings selecting the provider and supplying its settings.
 * @returns Layer providing production storage or operations failing with StorageConfigurationError.
 */
export function createStorageServiceLiveFromEnv(
  env: ApiWorkerEnv,
): Layer.Layer<StorageService, never, never> {
  let store: ConfiguredObjectStore | undefined;
  try {
    store = createObjectStoreFromEnv(env);
  } catch {
    // Unselected or unusable provider: leave object access unset so it fails
    // closed with StorageConfigurationError rather than guessing a backend.
    store = undefined;
  }

  let signer: ObjectUrlSigner | undefined;
  try {
    signer = createObjectUrlSignerFromEnv(env);
  } catch {
    // Rejected endpoint or credentials: signing fails closed instead of
    // issuing URLs that cannot be honored.
    signer = undefined;
  }

  return createStorageServiceLive({
    ...(store ? { store } : {}),
    ...(signer ? { signer } : {}),
    storageUnavailableError: new StorageConfigurationError({
      message: "Asset storage is unavailable.",
    }),
  });
}

export { StorageService };

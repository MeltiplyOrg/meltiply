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

export class StorageConfigurationError extends StorageUnavailableError {}

export function createStorageServiceLiveFromEnv(
  env: ApiWorkerEnv,
): Layer.Layer<StorageService, never, never> {
  let store: ConfiguredObjectStore | undefined;
  try {
    store = createObjectStoreFromEnv(env);
  } catch {
    store = undefined;
  }

  let signer: ObjectUrlSigner | undefined;
  try {
    signer = createObjectUrlSignerFromEnv(env);
  } catch {
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

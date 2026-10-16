import { Context, Effect, Layer } from "effect";
import { InvalidRequestError, StorageUnavailableError } from "@meltiply/domain";

const legacyPrefix = "meltiply:v1:";
const currentPrefix = "meltiply:v2:";
const nonceLength = 12;
type Bytes = Uint8Array<ArrayBuffer>;

export interface TokenKey {
  id: string;
  material: string;
}

export interface TokenCipherOptions {
  currentKeyId: string;
  keys: readonly TokenKey[];
  randomBytes?: (length: number) => Bytes;
}

/**
 * Decodes a base64 or base64url string into a Uint8Array byte buffer.
 * Normalizes URL-safe characters (- and _) and adds padding before base64 decoding.
 *
 * @param value - Base64 or base64url encoded string.
 * @returns Decoded byte array, or undefined if decoding fails.
 */
function decodeBase64(value: string): Bytes | undefined {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Decodes 32-byte encryption key material from a base64, base64url, or raw text string.
 * Enforces strict 256-bit (32-byte) key sizing for AES-GCM encryption.
 *
 * @param value - Raw key material string.
 * @returns Exactly 32 bytes of decoded key material.
 * @throws {TypeError} When key material does not decode to exactly 32 bytes.
 */
function decodeKey(value: string): Bytes {
  const trimmed = value.trim();
  const encoded = decodeBase64(trimmed);
  if (encoded?.byteLength === 32) return encoded;
  const raw = new TextEncoder().encode(trimmed);
  if (raw.byteLength === 32) return raw;
  throw new TypeError("token key material must decode to 32 bytes");
}

/**
 * Encodes a byte array into an unpadded URL-safe base64url string.
 *
 * @param value - Binary bytes to encode.
 * @returns URL-safe base64 string without trailing '=' padding characters.
 */
function encodeBase64Url(value: Bytes): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generates cryptographically secure random bytes using WebCrypto getRandomValues.
 * Used to construct unique nonces for AES-GCM encryption operations.
 *
 * @param length - Number of random bytes requested.
 * @returns Uint8Array containing cryptographically random bytes.
 */
function defaultRandomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Imports raw 256-bit key bytes into an unextractable WebCrypto AES-GCM CryptoKey.
 *
 * @param value - 32-byte raw encryption key.
 * @returns Promise resolving to an AES-GCM CryptoKey configured for encrypt/decrypt.
 */
async function importKey(value: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", value, "AES-GCM", false, ["decrypt", "encrypt"]);
}

/**
 * Decrypts an encoded AES-GCM ciphertext payload (nonce prepended) using the provided CryptoKey.
 * Extracts the 12-byte initialization vector (nonce) and decodes the UTF-8 plaintext.
 *
 * @param key - Promise resolving to the CryptoKey corresponding to the key ID.
 * @param encoded - Base64-encoded binary payload containing [12-byte IV][ciphertext].
 * @returns Decrypted UTF-8 string plaintext.
 * @throws {TypeError} If payload is invalid, too short, or authentication tag fails.
 */
async function decryptPayload(key: Promise<CryptoKey>, encoded: string): Promise<string> {
  const payload = decodeBase64(encoded);
  if (!payload || payload.byteLength <= nonceLength) {
    throw new TypeError("token ciphertext is invalid");
  }
  const plaintext = await crypto.subtle.decrypt(
    { iv: payload.slice(0, nonceLength), name: "AES-GCM" },
    await key,
    payload.slice(nonceLength),
  );
  return new TextDecoder().decode(plaintext);
}

export class TokenCipher {
  readonly #currentKeyId: string;
  readonly #importedKeys = new Map<string, Promise<CryptoKey>>();
  readonly #keys: ReadonlyMap<string, Bytes>;
  readonly #randomBytes: (length: number) => Bytes;

  /**
   * Initializes a TokenCipher with a ring of encryption keys and a designated current key ID.
   * Key material is decoded and validated up front; WebCrypto CryptoKey instances are imported lazily.
   *
   * @param options - Cipher configuration containing key ring and currentKeyId.
   * @throws {TypeError} If currentKeyId does not match any configured key in the ring.
   */
  constructor(options: TokenCipherOptions) {
    const keys = new Map(
      options.keys.map((key) => [key.id.trim(), decodeKey(key.material)] as const),
    );
    const currentKeyId = options.currentKeyId.trim();
    if (!currentKeyId || !keys.has(currentKeyId)) {
      throw new TypeError("current token key ID must reference a configured key");
    }
    this.#currentKeyId = currentKeyId;
    this.#keys = keys;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
  }

  /**
   * Lazily imports and caches the WebCrypto CryptoKey for a given key ID.
   *
   * @param keyId - ID of the configured key.
   * @returns Promise resolving to the imported CryptoKey.
   */
  #key(keyId: string): Promise<CryptoKey> {
    let key = this.#importedKeys.get(keyId);
    if (!key) {
      key = importKey(this.#keys.get(keyId)!);
      this.#importedKeys.set(keyId, key);
    }
    return key;
  }

  /**
   * Encrypts plaintext using AES-256-GCM under the current active key ID.
   * Generates a unique 12-byte nonce, computes ciphertext with authentication tag,
   * and prefixes the payload with version and key identity: `meltiply:v2:<keyId>:<base64urlPayload>`.
   *
   * @param plaintext - UTF-8 string to encrypt (e.g., OAuth access or refresh token).
   * @returns Prefixed, versioned ciphertext string safe for database storage.
   * @throws {TypeError} If nonce generator produces an invalid length.
   */
  async encrypt(plaintext: string): Promise<string> {
    const nonce = this.#randomBytes(nonceLength);
    if (nonce.byteLength !== nonceLength) {
      throw new TypeError("token nonce source returned an invalid length");
    }
    const ciphertext = await crypto.subtle.encrypt(
      { iv: nonce, name: "AES-GCM" },
      await this.#key(this.#currentKeyId),
      new TextEncoder().encode(plaintext),
    );
    const payload = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
    payload.set(nonce);
    payload.set(new Uint8Array(ciphertext), nonce.byteLength);
    return `${currentPrefix}${this.#currentKeyId}:${encodeBase64Url(payload)}`;
  }

  /**
   * Decrypts a token ciphertext produced by any key in the configured key ring.
   * Directly routes version 2 tokens (`meltiply:v2:<keyId>:...`) to the matching key ID,
   * and scans configured keys for legacy version 1 tokens (`meltiply:v1:...`).
   * Pass-through handles unencrypted values without error.
   *
   * @param value - Encrypted token string or unencrypted legacy value.
   * @returns Decrypted plaintext string.
   * @throws {TypeError} If ciphertext references an unknown key ID or cannot be decrypted.
   */
  async decrypt(value: string): Promise<string> {
    if (value.startsWith(currentPrefix)) {
      const [keyId, encoded, ...extra] = value.slice(currentPrefix.length).split(":");
      if (!keyId || !this.#keys.has(keyId) || !encoded || extra.length > 0) {
        throw new TypeError("token ciphertext references an unknown key");
      }
      return decryptPayload(this.#key(keyId), encoded);
    }
    if (value.startsWith(legacyPrefix)) {
      const encoded = value.slice(legacyPrefix.length);
      for (const keyId of this.#keys.keys()) {
        try {
          return await decryptPayload(this.#key(keyId), encoded);
        } catch {
          // Version 1 did not persist a key ID, so rotation requires a bounded key scan.
        }
      }
      throw new TypeError("legacy token ciphertext cannot be decrypted");
    }
    return value;
  }

  /**
   * Encrypts plaintext using AES-256-GCM as a typed Effect.
   * Wraps low-level WebCrypto cryptographic operations and maps errors to typed domain errors.
   *
   * @param plaintext - UTF-8 string to encrypt (e.g., OAuth access or refresh token).
   * @returns Effect resolving to versioned, prefixed ciphertext string safe for database storage.
   */
  encryptEffect(
    plaintext: string,
  ): Effect.Effect<string, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) =>
        new StorageUnavailableError({
          message: cause instanceof Error ? cause.message : "Failed to encrypt token",
        }),
      try: () => this.encrypt(plaintext),
    });
  }

  /**
   * Decrypts ciphertext using the configured key ring as a typed Effect.
   * Distinguishes invalid ciphertext format (InvalidRequestError) from service unavailability.
   *
   * @param value - Encrypted token string or unencrypted legacy plaintext.
   * @returns Effect resolving to decrypted UTF-8 plaintext string.
   */
  decryptEffect(
    value: string,
  ): Effect.Effect<string, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => {
        const message =
          cause instanceof Error ? cause.message : "Failed to decrypt token ciphertext";
        if (
          message.includes("invalid") ||
          message.includes("unknown key") ||
          message.includes("cannot be decrypted")
        ) {
          return new InvalidRequestError({ message });
        }
        return new StorageUnavailableError({ message });
      },
      try: () => this.decrypt(value),
    });
  }
}

/**
 * Service shape describing effectful token and secret encryption/decryption boundaries.
 */
export interface SecretServiceShape {
  readonly decrypt: (
    ciphertext: string,
  ) => Effect.Effect<string, StorageUnavailableError | InvalidRequestError>;
  readonly encrypt: (
    plaintext: string,
  ) => Effect.Effect<string, StorageUnavailableError | InvalidRequestError>;
}

/**
 * Effect service tag for cryptographic secret management and OAuth token protection.
 */
export class SecretService extends Context.Service<SecretService, SecretServiceShape>()(
  "SecretService",
) {}

/**
 * Creates a live production Layer for SecretService backed by TokenCipher.
 * Enforces fail-closed semantics: invalid key material or configuration results in failing operations.
 *
 * @param cipherOrOptions - Configured TokenCipher instance or options to construct one.
 * @returns Layer providing the production SecretService.
 */
export function createSecretServiceLive(
  cipherOrOptions: TokenCipher | TokenCipherOptions,
): Layer.Layer<SecretService, never, never> {
  let cipher: TokenCipher | undefined;
  let initError: Error | undefined;

  if (cipherOrOptions instanceof TokenCipher) {
    cipher = cipherOrOptions;
  } else {
    try {
      cipher = new TokenCipher(cipherOrOptions);
    } catch (error) {
      initError = error instanceof Error ? error : new Error("Failed to initialize TokenCipher");
    }
  }

  const service: SecretServiceShape = {
    decrypt: (ciphertext) => {
      if (initError || !cipher) {
        return Effect.fail(
          new StorageUnavailableError({
            message: initError?.message ?? "Token encryption is unavailable.",
          }),
        );
      }
      return cipher.decryptEffect(ciphertext);
    },
    encrypt: (plaintext) => {
      if (initError || !cipher) {
        return Effect.fail(
          new StorageUnavailableError({
            message: initError?.message ?? "Token encryption is unavailable.",
          }),
        );
      }
      return cipher.encryptEffect(plaintext);
    },
  };

  return Layer.succeed(SecretService, service);
}

/**
 * Creates a test Layer providing a stubbed or fake SecretService implementation.
 * Replaces live cryptography with deterministic mock transformations for unit tests.
 *
 * @param impl - Optional partial method implementations for SecretServiceShape.
 * @returns Layer providing the configured test SecretService.
 */
export function createSecretServiceTest(
  impl?: Partial<SecretServiceShape>,
): Layer.Layer<SecretService, never, never> {
  const service: SecretServiceShape = {
    decrypt:
      impl?.decrypt ?? ((ciphertext) => Effect.succeed(ciphertext.replace(/^mock_encrypted:/, ""))),
    encrypt: impl?.encrypt ?? ((plaintext) => Effect.succeed(`mock_encrypted:${plaintext}`)),
  };

  return Layer.succeed(SecretService, service);
}

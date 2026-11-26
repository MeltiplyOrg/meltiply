import { errorMessage } from "@meltiply/domain";

const base64PaddingPattern = /=+$/;

const legacyPrefix = "meltiply:v1:";
const currentPrefix = "meltiply:v2:";
const nonceLength = 12;
type Bytes = Uint8Array<ArrayBuffer>;

/** A stored token ciphertext is malformed, names an unknown key, or fails AES-GCM authentication. */
export class TokenCiphertextError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "TokenCiphertextError";
  }
}

/** `TOKEN_ENCRYPTION_KEY` is missing or does not decode to a 256-bit key. */
export class TokenCipherUnavailableError extends Error {
  constructor(message = "Token encryption is unavailable.") {
    super(message);
    this.name = "TokenCipherUnavailableError";
  }
}

interface TokenKey {
  id: string;
  material: string;
}

export interface TokenCipherOptions {
  currentKeyId: string;
  keys: readonly TokenKey[];
  randomBytes?: (length: number) => Bytes;
}

function decodeBase64(value: string): Bytes | undefined {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function decodeKey(value: string): Bytes {
  const trimmed = value.trim();
  const encoded = decodeBase64(trimmed);
  if (encoded?.byteLength === 32) return encoded;
  const raw = new TextEncoder().encode(trimmed);
  if (raw.byteLength === 32) return raw;
  throw new TypeError("token key material must decode to 32 bytes");
}

function encodeBase64Url(value: Bytes): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(base64PaddingPattern, "");
}

function defaultRandomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function decryptPayload(key: Promise<CryptoKey>, encoded: string): Promise<string> {
  const payload = decodeBase64(encoded);
  if (!payload || payload.byteLength <= nonceLength) {
    throw new TokenCiphertextError("token ciphertext is invalid");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { iv: payload.slice(0, nonceLength), name: "AES-GCM" },
      await key,
      payload.slice(nonceLength),
    );
    return new TextDecoder().decode(plaintext);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "OperationError") {
      throw new TokenCiphertextError("token ciphertext is invalid");
    }
    throw cause;
  }
}

/**
 * AES-256-GCM token cipher over a key ring. Writes `meltiply:v2:<keyId>:<base64url(nonce ‖ ciphertext)>`;
 * reads v2, key-less v1 (by scanning the ring), and unprefixed plaintext rows unchanged.
 */
export class TokenCipher {
  readonly #currentKeyId: string;
  readonly #importedKeys = new Map<string, Promise<CryptoKey>>();
  readonly #keys: ReadonlyMap<string, Bytes>;
  readonly #randomBytes: (length: number) => Bytes;

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

  #key(keyId: string): Promise<CryptoKey> {
    let key = this.#importedKeys.get(keyId);
    if (!key) {
      const material = this.#keys.get(keyId);
      if (!material) throw new TokenCiphertextError("token ciphertext references an unknown key");
      key = crypto.subtle.importKey("raw", material, "AES-GCM", false, ["decrypt", "encrypt"]);
      this.#importedKeys.set(keyId, key);
    }
    return key;
  }

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

  /** Throws `TokenCiphertextError` for an undecryptable v1 or v2 value. */
  async decrypt(value: string): Promise<string> {
    if (value.startsWith(currentPrefix)) {
      const [keyId, encoded, ...extra] = value.slice(currentPrefix.length).split(":");
      if (!keyId || !this.#keys.has(keyId) || !encoded || extra.length > 0) {
        throw new TokenCiphertextError("token ciphertext references an unknown key");
      }
      return decryptPayload(this.#key(keyId), encoded);
    }
    if (value.startsWith(legacyPrefix)) {
      const encoded = value.slice(legacyPrefix.length);
      for (const keyId of this.#keys.keys()) {
        try {
          return await decryptPayload(this.#key(keyId), encoded);
        } catch (cause) {
          if (!(cause instanceof TokenCiphertextError)) throw cause;
        }
      }
      throw new TokenCiphertextError("legacy token ciphertext cannot be decrypted");
    }
    return value;
  }
}

/**
 * Isolate-scoped resolver that caches one single-key cipher per `TOKEN_ENCRYPTION_KEY` value and
 * throws `TokenCipherUnavailableError` when the binding is absent or malformed.
 */
export function createIsolateTokenCipherCache(): (env: {
  readonly TOKEN_ENCRYPTION_KEY?: string;
}) => TokenCipher {
  let cachedCipher: TokenCipher | undefined;
  let cachedKey: string | undefined;

  return (env) => {
    const key = env.TOKEN_ENCRYPTION_KEY;
    if (!key) {
      throw new TokenCipherUnavailableError();
    }
    if (!cachedCipher || cachedKey !== key) {
      try {
        cachedCipher = new TokenCipher({
          currentKeyId: "primary",
          keys: [{ id: "primary", material: key }],
        });
      } catch (cause) {
        throw new TokenCipherUnavailableError(
          errorMessage(cause, "Token encryption is unavailable."),
        );
      }
      cachedKey = key;
    }
    return cachedCipher;
  };
}

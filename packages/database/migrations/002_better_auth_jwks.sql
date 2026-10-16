-- meltiply-release-phase: expand
-- Better Auth JWT plugin key storage: one row per managed signing key pair.
--
-- The 001 baseline is immutable once applied, so the JWT plugin's table lands
-- as a forward-only migration. The plugin mints keys lazily on first
-- /api/auth/token or /api/auth/jwks use; privateKey holds the symmetrically
-- encrypted JWK, alg/crv record the key type, and expiresAt is set only when
-- rotationInterval is configured.

CREATE TABLE IF NOT EXISTS "jwks" (
    id          TEXT PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "expiresAt" TIMESTAMPTZ,
    alg         TEXT,
    crv         TEXT
);

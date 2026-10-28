# CLI device authorization

`melti-cli` signs in without receiving a password or a copied browser JWT. The
member starts the flow from the terminal, reviews the request in their own
Meltiply installation, and explicitly approves or denies it. Approval mints a
separate Better Auth session for the CLI. That session obtains short-lived API
JWTs for the existing `/api/v1` surface.

This is a first-party session grant, not a general OAuth provider. The only
supported client identifier is `melti-cli`. The CLI receives the approving
member's current Workspace permissions; request-supplied scopes never add
capabilities. The authoritative implementation is the installed Better Auth
`device-authorization`, `bearer`, `jwt`, and `two-factor` plugins with the
Meltiply origin, policy, and rate-limit guards. This document describes their
observable HTTP contract so separately released CLI and backend versions can
interoperate.

## Installation origin and secrets

- Every endpoint is relative to the installation application origin configured
  as `APP_URL`. That origin serves the dashboard and `/api/*`; there is no
  separate auth origin.
- `verification_uri`, `verification_uri_complete`, and the browser return path
  are absolute on `APP_URL`. The server never derives them from a forwarded
  request host.
- HTTPS is required outside loopback local development. Browser sign-in and
  consent stay same-origin.
- `device_code` is a secret. Never include it in a verification link, browser
  storage, support report, log, trace, or diagnostic. `user_code` is the
  user-facing matching code and is not a credential.
- Credential responses are non-cacheable (`Cache-Control: no-store`,
  `Pragma: no-cache`).

## Flow

1. `POST /api/auth/device/code` returns a device code, a six-character user
   code, and verification links. Pending requests expire after ten minutes.
2. The CLI displays `user_code` and opens `verification_uri_complete`, or the
   member opens `verification_uri` and types the code. A signed-out browser
   returns through the existing sign-in and two-factor flow to the same
   `/device?user_code=…` path.
3. `GET /api/auth/device?user_code=…` uses the browser session to claim an
   unclaimed pending request and returns its reviewable client context. A link
   visit claims review only; it never approves.
4. The member compares the code, client, approving account, Workspace role, and
   effective permissions, then explicitly calls
   `POST /api/auth/device/approve` or `/deny`. Approval is bound to the browser
   session that verified the code; a different session of the same member
   cannot consent. Deleting that claiming session makes pending and approved
   requests terminal, so a replacement session cannot reclaim them.
5. While approval is pending, the CLI calls `POST /api/auth/device/token` at
   least five seconds apart. `authorization_pending` means wait; `slow_down`
   means back off further.
6. A successful exchange returns the raw CLI session credential. Redeeming the
   device code is atomic and single-use.
7. The CLI sends that credential as `Authorization: Bearer …` to
   `GET /api/auth/get-session`. The live session and user are returned and the
   short-lived API JWT is exposed in `set-auth-jwt`.
8. The CLI calls `/api/v1` with the JWT, not the session credential.
9. `POST /api/auth/sign-out` with the same bearer credential revokes only the
   CLI session. The approving browser session stays usable.

## Code issuance

### `POST /api/auth/device/code`

Request body:

```json
{ "client_id": "melti-cli" }
```

The body must be JSON. Send `Origin` equal to the installation origin. Do not
send `user_id`; pre-binding a request to a member is rejected. A `scope` value,
if sent, is discarded and never becomes an authority grant.

Success: `200`

```json
{
  "device_code": "unpredictable-secret",
  "user_code": "ABC234",
  "verification_uri": "https://app.example/device",
  "verification_uri_complete": "https://app.example/device?user_code=ABC234",
  "expires_in": 600,
  "interval": 5
}
```

`expires_in` and `interval` are seconds. User codes use an unambiguous alphabet
and are compared case-insensitively with separators ignored. Verification links
never contain `device_code`.

Failures:

| Status | `error`                                                     | Meaning                                                       |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------- |
| 400    | `invalid_request`                                           | Missing body/fields, non-JSON body, or unsupported `user_id`. |
| 400    | `invalid_client`                                            | `client_id` is not exactly `melti-cli`.                       |
| 403    | Worker error envelope `INVALID_ORIGIN` / `untrusted_origin` | Request `Origin` is not a trusted installation origin.        |
| 429    | Worker error envelope `rate_limited` with `Retry-After`     | Distributed issuance budget exhausted.                        |
| 500    | `server_error`                                              | Code generation or persistence failed.                        |

## Browser review and consent

### `GET /api/auth/device?user_code=…`

Send the browser's Better Auth session cookie. An authenticated member claims
an unclaimed pending request. The response is `200`:

```json
{
  "user_code": "ABC234",
  "status": "pending",
  "client_id": "melti-cli",
  "scope": null
}
```

`client_id` and `scope` are returned only to the member who owns the claim. A
pending response without `client_id` belongs to another account (or an anonymous
visitor) and must not enable consent. Another session of the same member may see
the request context, but only the original claiming session can decide it. `scope`
is informational; it is not an authority grant. `status` is `pending`, `approved`,
or `denied`. Loading this endpoint never approves a request.

Errors: `400 invalid_request` for a malformed or unknown code, and
`400 expired_token` for an expired request. The Worker applies a distributed
verification budget; exceeding it returns the Worker error envelope with
`rate_limited` and `Retry-After`.

### `POST /api/auth/device/approve` and `/deny`

Request body:

```json
{ "userCode": "ABC234" }
```

Send the same browser session cookie and `Origin` equal to the installation
origin. Success is `200` with `{ "success": true }`.

- `401 unauthorized`: no authenticated browser session.
- `400 invalid_request`: missing/unknown code or a request that is no longer
  pending (already approved or denied). Treat this as terminal; verify again
  only to display the authoritative status.
- `400 expired_token`: the pending request expired.
- `403 access_denied`: the request belongs to another member or is bound to a
  different browser session of the same member. Return to the original browser
  session; if it is unavailable, run `melti-cli auth login` again for a new code.
  A fresh browser session cannot take over the existing request.
- Rate limiting returns `429 rate_limited` with `Retry-After`.

Preserve the plugin's CSRF/origin checks; do not repeat either decision
automatically.

## Token polling and exchange

### `POST /api/auth/device/token`

Request body:

```json
{
  "client_id": "melti-cli",
  "device_code": "unpredictable-secret",
  "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
}
```

Poll no faster than the advertised `interval` (five seconds). A successful
exchange returns `200`:

```json
{
  "access_token": "raw-better-auth-session-credential",
  "token_type": "Bearer",
  "expires_in": 604800,
  "scope": ""
}
```

`expires_in` reflects the Better Auth session lifetime (seven days by default),
not the fifteen-minute JWT lifetime. `access_token` is a session credential, not
a JWT. `scope` may be empty and is not a capability grant.

RFC-style failures are `400` with `error` and `error_description`:

| `error`                 | Meaning                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `authorization_pending` | Approval has not happened yet. Keep polling at the interval.                                      |
| `slow_down`             | Polled faster than the interval or a rate budget allows. Honor `Retry-After`.                     |
| `access_denied`         | The member denied the request or its claiming browser session is no longer active. Restart login. |
| `expired_token`         | The pending request expired. Start a new CLI login.                                               |
| `invalid_grant`         | Unknown, mismatched-client, replayed, or already-consumed device code.                            |
| `invalid_request`       | Malformed request.                                                                                |
| `server_error`          | Session creation or policy evaluation failed.                                                     |

Token polling is limited per device code and per caller across Worker
instances. The caller IP budget is checked and counted first; the per-device
bucket is touched only for admitted callers, and device-throttled polls still
consume the caller budget. A denial is deleted after reporting `access_denied`;
later attempts report `invalid_grant`. Only one concurrent redemption can
succeed. Before releasing the credential, the server checks suspension, required
mailbox verification, membership, account activity, and whether the exact
claiming browser session still exists. A browser-session deletion that completed
before that check revokes the minted credential; a later sign-out is independent
of the CLI session.

## Native session transport

### `GET /api/auth/get-session`

Send the CLI credential as a bearer token:

```http
Authorization: Bearer <access_token>
```

The bearer plugin accepts the raw session credential and, when it renews a
session, may return a signed replacement in `set-auth-token`. Persist a
replacement when present. A live session returns `200` with the Better Auth
session and user and exposes the short-lived API JWT in `set-auth-jwt`; both
headers are listed in `Access-Control-Expose-Headers`. A missing, expired, or
revoked session returns `200` with `null`; it is not a usable grant.

JWTs are signed for issuer and audience `APP_URL`, carry the member subject and
live session id (`sid`), and expire after fifteen minutes by default. Session
renewal extends the seven-day session when it crosses the update window; it does
not rotate the member. Request a fresh JWT through `get-session` rather than
reusing an expired one.

### Protected API

`/api/v1/*` accepts only `Authorization: Bearer <JWT>`. A raw CLI session
credential, browser cookie, or cookie-derived JWT from another environment is
rejected with `401 authentication_required`. The API verifies the signature,
issuer, audience, live session, active account, verified email when required,
Workspace membership, and role on every request. Existing role rules apply:
Viewers remain read-only, Editors retain content write access, and no CLI-specific
role exists. Current-user lookup, Post listing, and idempotent draft creation use
the existing routes and contracts.

`POST /api/auth/sign-out` with the CLI bearer credential and
`Origin: <installation origin>` revokes that session and returns `200`. The
approving browser session is unaffected. After sign-out, `get-session` returns
`null` and previously minted JWTs fail with `401`. Existing security policy also
applies: suspension, password change or reset, email verification changes, and
two-factor activation or deactivation revoke affected sessions, including CLI
sessions. Deleting the browser session that claimed a device code also denies
any pending or approved unredeemed grant in the same database transaction; a
new browser session cannot reclaim it. Redemption rechecks the claiming session
after consuming the grant: deletion completed before that check revokes the
minted credential, while a later browser sign-out leaves the independent CLI
session usable. The CLI must treat `null` from `get-session`, a `401` from
`/api/v1`, or a revoked session as reauthentication required.

## Browser policy

Sign-in, email verification when required, and any enrolled second factor happen
in the browser before consent. Device authorization never bypasses them and
never receives the password. Suspended members cannot obtain a usable CLI
session. The consent page shows the matching code, `melti-cli`, the approving
account, the Workspace role, effective permissions, and a warning to approve only
a terminal the member controls. Deny is equally explicit. A prefilled URL, a
second tab, or a browser back/forward navigation must not approve automatically.

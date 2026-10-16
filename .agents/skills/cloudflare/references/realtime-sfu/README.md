# Cloudflare Realtime SFU

Use Realtime SFU for real-time audio/video/data over WebRTC on Cloudflare's anycast network: one session per client (a PeerConnection to the edge), tracks you publish and others subscribe to. **There are no rooms** — build presence and signaling yourself by exchanging session and track IDs through your backend (see [patterns.md](./patterns.md)). Fetch the [Realtime SFU documentation index](https://developers.cloudflare.com/realtime/llms.txt) for current API shapes and limits.

## Choose an approach

| Approach                                | When to use                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PartyTracks (`partytracks` npm package) | Production browser apps: observable-based client that handles device switching and reconnections; examples in [patterns.md](./patterns.md)                                    |
| Raw REST/WebRTC API                     | Custom signaling, non-browser clients, or full control of the PeerConnection lifecycle; see the [Connection API](https://developers.cloudflare.com/realtime/sfu/api/index.md) |
| [RealtimeKit](../realtimekit/)          | End-to-end SDK with prebuilt UI components instead of hand-built signaling and UI                                                                                             |

Default to PartyTracks for most production applications; drop to the raw API only when its lifecycle control is the requirement.

## Setup

Create an app in the [Calls dashboard](https://dash.cloudflare.com/?to=/:account/calls) to get `CALLS_APP_ID` and `CALLS_APP_SECRET` (a secret — set via `wrangler secret put`). Credentials and Wrangler configuration are in [configuration.md](./configuration.md).

## Read for the task

| Task                                                            | Reference                              |
| --------------------------------------------------------------- | -------------------------------------- |
| Credentials, Wrangler config, dependencies, TURN                | [configuration.md](./configuration.md) |
| Sessions, tracks, endpoints, request/response shapes            | [api.md](./api.md)                     |
| PartyTracks, presence via Durable Objects, cascading, simulcast | [patterns.md](./patterns.md)           |
| Connection failures, media issues, limits, security             | [gotchas.md](./gotchas.md)             |

## See also

- [Orange Meets demo](https://demo.orange.cloudflare.dev/) and [source](https://github.com/cloudflare/orange) — a full SFU application.
- [calls-examples](https://github.com/cloudflare/calls-examples) — official sample code.
- [RealtimeKit docs](https://developers.cloudflare.com/realtime/realtimekit/index.md) — the managed SDK layer on top of the SFU.

# Cloudflare RealtimeKit

Use RealtimeKit for in-app audio and video without building WebRTC plumbing: SDKs, prebuilt UI components, and managed meeting state on top of [Realtime SFU](../realtime-sfu/). Fetch the [RealtimeKit docs](https://developers.cloudflare.com/realtime/realtimekit/index.md) before integrating; SDK APIs and REST shapes change between versions.

## Mental model

- **App** → **Meeting** → **Session**: an App groups meetings, presets, and recordings; a Meeting is a reusable room; each join creates a Session that ends when the last participant leaves.
- **Participant** is created via the REST API and returns an `authToken` for the client SDK — **never reuse tokens**. `participant.userId` persists across sessions; `peer.id` changes every join.
- **Preset** is a reusable permission/UI template applied when the participant is created.
- Backend flow: create App → create Meeting → add participant → hand `authToken` to the client. Endpoint shapes live in [api.md](./api.md) and [configuration.md](./configuration.md).

## Choose a package

| Need                          | Package                                             |
| ----------------------------- | --------------------------------------------------- |
| Full meeting UI, React        | `@cloudflare/realtimekit-react-ui` (`<RtkMeeting>`) |
| Full meeting UI, Angular      | `@cloudflare/realtimekit-angular-ui`                |
| Full meeting UI, HTML/vanilla | `@cloudflare/realtimekit-ui`                        |
| Custom UI, managed state      | `@cloudflare/realtimekit` (Core SDK)                |
| Custom WebRTC, full control   | [Realtime SFU](../realtime-sfu/) instead            |

## Read for the task

| Task                                                 | Reference                              |
| ---------------------------------------------------- | -------------------------------------- |
| Install SDKs, backend credentials, presets, Wrangler | [configuration.md](./configuration.md) |
| Meeting object, REST endpoints, SDK methods          | [api.md](./api.md)                     |
| UI-kit composition, event handling, waitlists        | [patterns.md](./patterns.md)           |
| Join failures, token errors, media issues            | [gotchas.md](./gotchas.md)             |

## See also

- [RealtimeKit web examples](https://github.com/cloudflare/realtimekit-web-examples)
- [Dashboard](https://dash.cloudflare.com/?to=/:account/realtime/kit) — App and credential management
- [R2](../r2/) for recording storage; [D1](../d1/) for meeting metadata

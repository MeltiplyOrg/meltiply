# Email Routing

Use routing rules for address-based forwarding; use an [Email Worker](../email-workers/README.md) when incoming mail needs custom processing. Fetch the linked docs before implementing APIs, DNS, configuration, or limits.

Forwarding requires verified destinations. Replying within an incoming email event and sending a new outbound message have different requirements; check the relevant API docs rather than inferring one from the other.

## Choose a task

| Task                                                        | Start here                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Forward incoming mail to an existing mailbox                | [Route emails](https://developers.cloudflare.com/email-service/get-started/route-emails/index.md)                                    |
| Manage addresses, verification, catch-all, or subaddressing | [Routing rules and addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/index.md)        |
| Filter, parse, reply to, or store incoming mail             | [Email Workers](../email-workers/README.md)                                                                                          |
| Send a new outbound message                                 | [Send emails](https://developers.cloudflare.com/email-service/get-started/send-emails/index.md) — Workers binding, REST API, or SMTP |
| Configure domains, rules, deployment, or local testing      | [Configuration](configuration.md)                                                                                                    |
| Manage routing programmatically                             | [API](api.md)                                                                                                                        |
| Design filtering, parsing, storage, or notifications        | [Patterns](patterns.md)                                                                                                              |
| Diagnose authentication, delivery, or limit issues          | [Gotchas](gotchas.md)                                                                                                                |

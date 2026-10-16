# Cloudflare DDoS Protection

Use DDoS Protection for autonomous, always-on mitigation of HTTP (L7) and network-layer (L3/4) attacks. Protection is on by default; configuration means adjusting sensitivity, actions, and overrides rather than enabling the service.

L7 rules live in the `ddos_l7` phase at zone or account level; L3/4 rules are account-level only. Adaptive DDoS profiles learn a 7-day traffic baseline — allow baseline time before judging detection behavior. Zone-level overrides take precedence over account-level ones. Advanced options (custom expressions, the `log` action, expanded override counts) require Enterprise Advanced — check plan availability before designing around them.

## Choose a task

| Task                                                 | Start here                        |
| ---------------------------------------------------- | --------------------------------- |
| Configure sensitivity, actions, or adaptive profiles | [Configuration](configuration.md) |
| Automate via API or discover ruleset IDs             | [API](api.md)                     |
| Layer defenses or build a dynamic response           | [Patterns](patterns.md)           |
| Resolve false positives or tune an existing setup    | [Gotchas](gotchas.md)             |

## See also

- [DDoS Protection docs](https://developers.cloudflare.com/ddos-protection/index.md)
- [WAF](../waf/README.md) — application-layer security rules
- [Bot Management](../bot-management/README.md) — automated-traffic detection

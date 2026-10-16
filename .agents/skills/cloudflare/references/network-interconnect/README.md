# Cloudflare Network Interconnect (CNI)

Use CNI for private, dedicated connectivity between a customer network and Cloudflare — typically feeding Magic Transit, Magic WAN, or peering. **Enterprise-only, no SLA**: every design needs a backup Internet path and link diversity (see [patterns.md](./patterns.md)). Provisioning takes 2–4 weeks and runs through the Cloudflare account team.

Fetch the [product documentation](https://developers.cloudflare.com/network-interconnect/index.md) for current availability, locations, and specs; optical, MTU, and throughput details are maintained there and in [gotchas.md](./gotchas.md), not here.

## Choose a connection type

| Type    | Mechanism                                                              | Notes                                               |
| ------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| Direct  | Physical fiber cross-connect in a shared facility                      | You order the cross-connect; 10/100 Gbps            |
| Partner | Virtual circuit via a partner SDN (Console Connect, Equinix, Megaport) | Ordered in the partner portal; no colocation needed |
| Cloud   | AWS Direct Connect or GCP Cloud Interconnect                           | Magic WAN only; beta                                |

## Choose a dataplane version

| Need                                                    | Version      |
| ------------------------------------------------------- | ------------ |
| GRE tunnels, VLAN tagging, BFD, LACP, or public peering | v1 (classic) |
| 1500 MTU both directions, ECMP, simplest config         | v2 (beta)    |

v1 uses asymmetric MTU (1500 down / 1476 up); v2 has no GRE, VLAN, BFD, or LACP yet. The full comparison matrix lives in [patterns.md](./patterns.md).

## Automation boundary

The API automates listing/creating/deleting interconnects, querying slots and status, downloading the LOA, and managing CNI objects (BGP config) — see [api.md](./api.md). It cannot automate:

- Physical cross-connect installation and partner-portal circuit ordering.
- AWS/GCP portal operations and final cloud activation.
- Initial request approval, v1 VLAN assignment, and v1 config-document generation — these go through the account team.

## Read for the task

| Task                                                    | Reference                              |
| ------------------------------------------------------- | -------------------------------------- |
| BGP, routing, cloud interconnect setup, monitoring      | [configuration.md](./configuration.md) |
| REST endpoints, SDK namespaces, request shapes          | [api.md](./api.md)                     |
| HA design, failover, hybrid cloud, decision matrix      | [patterns.md](./patterns.md)           |
| Status diagnosis, MTU/throughput limits, partner issues | [gotchas.md](./gotchas.md)             |

## See also

- [tunnel](../tunnel/) — software-defined alternative for private connectivity.
- [spectrum](../spectrum/) — L4 proxy for TCP/UDP traffic.

# Move outbound rules

In 0.12, class fields and methods such as `outboundByHost`, `allowedHosts`, and `setOutboundByHost()` decided where a sandbox's requests went, and the class installed intercepts for you. Now your Durable Object installs the intercepts once per start, and one entrypoint in your Worker reads the sandbox's rules on every request. [Control outbound requests](../control-outbound-requests.md) builds it step by step. The [outbound workspace example](../../examples/outbound-workspace) is the complete Worker.

## 1. Replace handlers with an entrypoint

Move each outbound handler into one `WorkerEntrypoint`, and choose between them by name, as in [step 2](../control-outbound-requests.md#2-send-every-request-to-one-entrypoint) of the how-to. Install it after each `start()`, as in [step 3](../control-outbound-requests.md#3-intercept-all-traffic-once-per-start). Stop exporting `ContainerProxy` from your Worker. Export your entrypoint instead.

Done when a request from the Container reaches your entrypoint.

| 0.12                                             | Now                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `static outbound = handler`                      | A handler named for the pattern `"*"` in `handlers`                      |
| `static outboundByHost = { host: handler }`      | A handler for `host` in `handlers`                                       |
| `static outboundHandlers = { name: handler }`    | Handlers the entrypoint chooses by name                                  |
| `handler(request, env, { containerId, params })` | `fetch(request)` on the entrypoint, with `this.env` and `this.ctx.props` |

`outboundProxy` and `outboundProxies` were other names for `outbound` and `outboundHandlers`. 0.12 checked per-host handlers, then the catch-all handler, then allowed hosts. The example checks `handlers` the same way, with an exact hostname before patterns and `"*"` matching every host. To pass parameters to a handler, as `setOutboundHandler(name, params)` did, store them in the rules next to the handler's name.

## 2. Move allow and deny lists into stored rules

Store the lists in Durable Object storage, as in [step 1](../control-outbound-requests.md#1-keep-the-rules-in-the-durable-object). Patterns use `*` as in 0.12.

Done when each host that 0.12 blocked returns `403`, and each host it allowed still works.

| 0.12 configuration                          | Rules                               |
| ------------------------------------------- | ----------------------------------- |
| `enableInternet: false` with `allowedHosts` | `allow`: the allowed hosts          |
| `enableInternet: true`                      | `allow: ["*"]`                      |
| `deniedHosts`                               | `deny`: the denied hosts            |
| `enableInternet: false` with nothing else   | Empty rules, which block every host |

Keep `enableInternet: false` on `start()` in every case. The rules replace it. HTTP on port 80 and HTTPS on port 443 reach the Internet through the Worker. Connections to other ports time out. With `enableInternet: true`, they would go out directly and skip the rules, so a sandbox could reach a denied host on another port. If code in the Container needs another port or protocol, such as a database, reach it through a Worker instead.

In 0.12, when `allowedHosts` was set, a host with a handler also had to be allowed. In the example, a host in `handlers` runs its handler whether or not it is in `allow`. Add the host to `deny` to block it.

## 3. Replace runtime changes

Replace each method that changed the rules with a change to the stored rules, as in [step 6](../control-outbound-requests.md#6-change-the-rules). The next request follows the new rules. 0.12 installed the intercepts again after each change. Now they never change.

Done when removing a host's handler makes its next request follow `allow` and `deny` again.

| 0.12                                                | Change to the rules                  |
| --------------------------------------------------- | ------------------------------------ |
| `setOutboundHandler(name)`                          | Set `handlers["*"]` to `name`        |
| `setOutboundByHost(host, name)`                     | Set `handlers[host]` to `name`       |
| `setOutboundByHosts(map)`                           | Replace `handlers` with `map`        |
| `removeOutboundByHost(host)`                        | Delete `handlers[host]`              |
| `setAllowedHosts(hosts)`, `setDeniedHosts(hosts)`   | Replace `allow` or `deny`            |
| `allowHost(host)`, `denyHost(host)`                 | Add `host` to `allow` or `deny`      |
| `removeAllowedHost(host)`, `removeDeniedHost(host)` | Remove `host` from `allow` or `deny` |

Read, change, and write the rules in one Durable Object method, so two changes cannot overwrite each other. Rules stay in storage when the Container stops, as 0.12's runtime rules did.

## 4. Update HTTPS and blocked responses

The example intercepts HTTPS for every host. If you left `interceptHttps` off in 0.12, HTTPS requests now follow your rules too. Pass the certificate variables from [step 4](../control-outbound-requests.md#4-trust-the-interception-certificate) on each `exec()` that makes HTTPS requests.

Done when HTTPS requests to allowed hosts succeed without certificate errors.

0.12 answered a blocked request with status `520` and `Origin is disallowed`. The example answers `403` with the reason. Return `520` from your entrypoint if code in the Container checks for it.

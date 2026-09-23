import { z } from "zod";

// Lowercase hostnames. "*" matches any run of characters, so "*.example.com" matches
// "api.example.com" but not "example.com".
const HostPattern = z
  .string()
  .max(253)
  .regex(/^[a-z0-9*.-]+$/, "use lowercase hostnames, with * as a wildcard");

export const HandlerName = z.enum(["bearer-token", "audit"]);
export type HandlerName = z.infer<typeof HandlerName>;

export const OutboundRules = z.object({
  // Checked first. A matching host is blocked, even if it has a handler or is allowed.
  deny: z.array(HostPattern).max(100).default([]),
  // Checked next. A matching host goes to the named handler.
  handlers: z.record(HostPattern, HandlerName).default({}),
  // Checked last. A matching host is fetched unchanged. ["*"] allows every host.
  allow: z.array(HostPattern).max(100).default([]),
});
export type OutboundRules = z.infer<typeof OutboundRules>;

export type Decision =
  | { action: "deny"; reason: string }
  | { action: "handle"; handler: HandlerName }
  | { action: "fetch" };

export function decide(rules: OutboundRules, hostname: string): Decision {
  const host = hostname.replace(/\.+$/, "");
  const denied = rules.deny.find((pattern) => matches(pattern, host));
  if (denied !== undefined)
    return { action: "deny", reason: `${host} matches deny rule ${denied}` };
  // An exact hostname wins over a wildcard pattern.
  const handler =
    rules.handlers[host] ??
    Object.entries(rules.handlers).find(([pattern]) => matches(pattern, host))?.[1];
  if (handler !== undefined) return { action: "handle", handler };
  if (rules.allow.some((pattern) => matches(pattern, host))) return { action: "fetch" };
  return { action: "deny", reason: `${host} is not allowed` };
}

function matches(pattern: string, host: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replaceAll(".", "\\."))
    .join(".*");
  return new RegExp(`^${source}$`).test(host);
}

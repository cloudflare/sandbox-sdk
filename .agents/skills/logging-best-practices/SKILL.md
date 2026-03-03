---
name: logging-best-practices
description: Logging best practices focused on wide events (canonical log lines) for powerful debugging and analytics
license: MIT
metadata:
  author: boristane
  version: '1.0.0'
---

# Logging Best Practices Skill

Version: 1.0.0

## Purpose

This skill provides guidelines for implementing effective logging in applications. It focuses on **wide events** (also called canonical log lines) - a pattern where you emit a single, context-rich event per request per service, enabling powerful debugging and analytics.

## When to Apply

Apply these guidelines when:

- Writing or reviewing logging code
- Adding console.log, logger.info, or similar
- Designing logging strategy for new services
- Setting up logging infrastructure

## Core Principles

### 1. Wide Events (CRITICAL)

Emit **one context-rich event per request per service**. Instead of scattering log lines throughout your handler, consolidate everything into a single structured event emitted at request completion.

```typescript
const wideEvent: Record<string, unknown> = {
  method: 'POST',
  path: '/checkout',
  requestId: c.get('requestId'),
  timestamp: new Date().toISOString()
};

try {
  const user = await getUser(c.get('userId'));
  wideEvent.user = { id: user.id, subscription: user.subscription };

  const cart = await getCart(user.id);
  wideEvent.cart = { total_cents: cart.total, item_count: cart.items.length };

  wideEvent.status_code = 200;
  wideEvent.outcome = 'success';
  return c.json({ success: true });
} catch (error) {
  wideEvent.status_code = 500;
  wideEvent.outcome = 'error';
  wideEvent.error = { message: error.message, type: error.name };
  throw error;
} finally {
  wideEvent.duration_ms = Date.now() - startTime;
  logger.info(wideEvent);
}
```

### 2. High Cardinality & Dimensionality (CRITICAL)

Include fields with high cardinality (user IDs, request IDs - millions of unique values) and high dimensionality (many fields per event). This enables querying by specific users and answering questions you haven't anticipated yet.

### 3. Business Context (CRITICAL)

Always include business context: user subscription tier, cart value, feature flags, account age. The goal is to know "a premium customer couldn't complete a $2,499 purchase" not just "checkout failed."

### 4. Environment Characteristics (CRITICAL)

Include environment and deployment info in every event: commit hash, service version, region, instance ID. This enables correlating issues with deployments and identifying region-specific problems.

### 5. Single Logger (HIGH)

Use one logger instance configured at startup and import it everywhere. This ensures consistent formatting and automatic environment context.

### 6. Middleware Pattern (HIGH)

Use middleware to handle wide event infrastructure (timing, status, environment, emission). Handlers should only add business context.

### 7. Structure & Consistency (HIGH)

- Use JSON format consistently
- Maintain consistent field names across services
- Simplify to two log levels: `info` and `error`
- Never log unstructured strings

## Anti-Patterns to Avoid

1. **Scattered logs**: Multiple console.log() calls per request
2. **Multiple loggers**: Different logger instances in different files
3. **Missing environment context**: No commit hash or deployment info
4. **Missing business context**: Logging technical details without user/business data
5. **Unstructured strings**: `console.log('something happened')` instead of structured data
6. **Inconsistent schemas**: Different field names across services

## Guidelines

### Wide Events (`rules/wide-events.md`)

- Emit one wide event per service hop
- Include all relevant context
- Connect events with request ID
- Emit at request completion in finally block

### Context (`rules/context.md`)

- Support high cardinality fields (user_id, request_id)
- Include high dimensionality (many fields)
- Always include business context
- Always include environment characteristics (commit_hash, version, region)

### Structure (`rules/structure.md`)

- Use a single logger throughout the codebase
- Use middleware for consistent wide events
- Use JSON format
- Maintain consistent schema
- Simplify to info and error levels
- Never log unstructured strings

### Common Pitfalls (`rules/pitfalls.md`)

- Avoid multiple log lines per request
- Design for unknown unknowns
- Always propagate request IDs across services

References:

- [Logging Sucks](https://loggingsucks.com)
- [Observability Wide Events 101](https://boristane.com/blog/observability-wide-events-101/)
- [Stripe - Canonical Log Lines](https://stripe.com/blog/canonical-log-lines)

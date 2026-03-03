---
title: Structure and Format
impact: HIGH
tags: logging, json, structured-logging, schema, middleware
---

## Structure and Format

**Impact: HIGH**

Structured logging with consistent formats enables efficient querying and analysis. The right structure transforms logs from text files into queryable data.

### Use a Single Logger Throughout the Codebase

Use one logger instance configured at application startup and import it everywhere. This ensures consistent formatting, log levels, and output destinations across all modules.

```typescript
// lib/logger.ts - Single logger configuration
import pino from 'pino';

// Configure once at startup
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    // Environment context added to ALL logs automatically
    service: process.env.SERVICE_NAME,
    version: process.env.SERVICE_VERSION,
    commit_hash: process.env.COMMIT_SHA,
    region: process.env.AWS_REGION,
    environment: process.env.NODE_ENV
  }
});

// Usage everywhere else - just import
// services/checkout.ts
import { logger } from '../lib/logger';

logger.info({ event: 'checkout_completed', orderId });
```

**Benefits:**

- Consistent log format across all modules
- Environment context automatically included
- Single place to change log level or destination
- No risk of misconfigured loggers in different files

**Avoid:**

```typescript
// DON'T create new loggers in each file
const logger = new Logger(); // Each file creates its own
console.log('some event'); // Bypasses the logger entirely
```

### Use Middleware for Consistent Wide Events

Implement wide event collection as middleware that wraps all request handlers. The middleware initializes the event, captures timing, handles emission in the finally block, and makes the event accessible to handlers for enrichment.

```typescript
// middleware/wideEvent.ts
import { logger } from '../lib/logger';

// Capture environment once at startup
const envContext = {
  service: process.env.SERVICE_NAME,
  version: process.env.SERVICE_VERSION,
  commit_hash: process.env.COMMIT_SHA,
  region: process.env.AWS_REGION,
  environment: process.env.NODE_ENV,
  instance_id: process.env.HOSTNAME
};

export function wideEventMiddleware() {
  return async (c: Context, next: Next) => {
    const startTime = Date.now();

    // Initialize event with standard fields + environment
    const wideEvent: Record<string, unknown> = {
      request_id: c.get('requestId') || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      method: c.req.method,
      path: c.req.path,
      user_agent: c.req.header('user-agent'),
      ...envContext // Environment automatically included
    };

    // Make event accessible to handlers for enrichment
    c.set('wideEvent', wideEvent);

    try {
      await next();
      wideEvent.status_code = c.res.status;
      wideEvent.outcome = c.res.status < 400 ? 'success' : 'error';
    } catch (error) {
      wideEvent.status_code = 500;
      wideEvent.outcome = 'error';
      wideEvent.error = {
        type: error.name,
        message: error.message
      };
      throw error;
    } finally {
      wideEvent.duration_ms = Date.now() - startTime;
      logger.info(wideEvent); // Uses the single logger
    }
  };
}

// Apply middleware globally
app.use('*', wideEventMiddleware());
```

**Handlers just enrich with business context:**

```typescript
app.post('/checkout', async (c) => {
  const wideEvent = c.get('wideEvent');
  const user = c.get('user');

  // Add business context - environment already included by middleware
  wideEvent.user = { id: user.id, subscription: user.subscription };

  const cart = await getCart(user.id);
  wideEvent.cart = { id: cart.id, total: cart.total };

  const order = await createOrder(cart);
  wideEvent.order = { id: order.id };

  return c.json(order, 201);
});
// Middleware handles: timing, status, environment, emission
// Handler handles: business context only
```

### Use JSON Format

Use JSON as your logging format. JSON is universally supported, enables nested objects for complex context, works across all programming languages, and is easily parsed.

```typescript
const wideEvent = {
  timestamp: '2024-09-08T06:14:05.680Z',
  service: 'articles',
  requestId: 'req_abc123',
  message: 'Article created',
  user: { id: 'user_123', subscription: 'premium' },
  article: { id: 'article_456', title: 'My Post' },
  duration_ms: 268,
  status_code: 201
};

// Emit as single-line JSON
logger.info(wideEvent);
```

### Maintain Consistent Schema

Use consistent field names across all services. If one service uses `user_id` and another uses `userId`, querying becomes painful.

```typescript
// All services use the same schema
{
  request_id: 'req_abc',
  user: { id: 'user_123' },
  duration_ms: 268,
  status_code: 200,
}
```

Define your schema once and share it across services via a common library or documented standard.

### Simplify Log Levels

Limit yourself to two log levels: `info` and `error`. The distinction between debug, trace, warn, info, notice, and critical creates confusion without adding value.

- **INFO**: Normal operations, all wide events
- **ERROR**: Unexpected failures that need attention

If you find yourself wanting debug logs, add that context to your wide event instead.

### Never Log Unstructured Strings

Every log must be structured with queryable fields. `console.log('User logged in')` is useless for debugging at scale.

```typescript
// Add the data to your wide event instead
wideEvent.order = { id: orderId, status: 'created' };
wideEvent.payment = { error: { message: error.message } };
// Now it's queryable: WHERE order.status = 'created'
```

If you're tempted to write `console.log('something happened')`, ask: "What fields would make this queryable?" Then add those fields to your wide event instead.

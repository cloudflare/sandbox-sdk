---
title: Wide Events / Canonical Log Lines
impact: CRITICAL
tags: logging, wide-events, canonical-log-lines
---

## Wide Events / Canonical Log Lines

**Impact: CRITICAL**

Wide events (also called canonical log lines) are the foundation of effective logging. For each request, emit **a single context-rich event per service**. Instead of scattering 10-20 log lines throughout your request handler, consolidate everything into one comprehensive event emitted at the end of the request.

### The Pattern

Build the event throughout the request lifecycle, then emit once at completion in a `finally` block. This ensures the event is always emitted with complete context, even during failures.

**Incorrect:**

```typescript
app.post('/articles', async (c) => {
  console.log('Received POST /articles request');

  const body = await c.req.json();
  console.log('Request body parsed', { title: body.title });

  const user = await getUser(c.get('userId'));
  console.log('User fetched', { userId: user.id });

  const article = await database.saveArticle({ ...body, ownerId: user.id });
  console.log('Article saved', { articleId: article.id });

  await cache.set(article.id, article);
  console.log('Cache updated');

  console.log('Request completed successfully');
  return c.json({ article }, 201);
});
// 6 disconnected log lines with scattered context
// Cannot query: "show me all article creates by free trial users"
```

**Correct:**

```typescript
app.post('/articles', async (c) => {
  const startTime = Date.now();
  const wideEvent: Record<string, unknown> = {
    method: 'POST',
    path: '/articles',
    service: 'articles',
    requestId: c.get('requestId')
  };

  try {
    const body = await c.req.json();
    const user = await getUser(c.get('userId'));
    wideEvent.user = {
      id: user.id,
      subscription: user.subscription,
      trial: user.trial
    };

    const article = await database.saveArticle({ ...body, ownerId: user.id });
    wideEvent.article = {
      id: article.id,
      title: article.title,
      published: article.published
    };

    await cache.set(article.id, article);
    wideEvent.cache = { operation: 'write', key: article.id };

    wideEvent.status_code = 201;
    wideEvent.outcome = 'success';
    return c.json({ article }, 201);
  } catch (error) {
    wideEvent.status_code = 500;
    wideEvent.outcome = 'error';
    wideEvent.error = { message: error.message, type: error.name };
    throw error;
  } finally {
    wideEvent.duration_ms = Date.now() - startTime;
    wideEvent.timestamp = new Date().toISOString();
    logger.info(JSON.stringify(wideEvent));
  }
});
// Single event with all context - queryable by any field
```

### Connect Events with Request ID

Every wide event must include a unique request ID that is propagated across all service hops. This is the only way to reconstruct the full journey of a request through a distributed system.

```typescript
// Service A - generate and propagate
const requestId = c.get('requestId') || crypto.randomUUID();
wideEvent.requestId = requestId;

await fetch('http://downstream-service/endpoint', {
  headers: { 'x-request-id': requestId },
  body: JSON.stringify(data)
});

// Service B - extract and use
const requestId = c.req.header('x-request-id');
wideEvent.requestId = requestId; // Same ID links events together
```

### Emit in Finally Block

Always emit wide events in a `finally` block or equivalent. This ensures the event is emitted with complete context regardless of success or failure.

Reference: [Stripe Blog - Canonical Log Lines](https://stripe.com/blog/canonical-log-lines)

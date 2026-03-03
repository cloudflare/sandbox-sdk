---
title: Common Pitfalls
impact: MEDIUM
tags: logging, anti-patterns, pitfalls
---

## Common Pitfalls

**Impact: MEDIUM**

Avoid these anti-patterns that undermine your logging effectiveness.

### Pitfall 1: Too Many Log Lines Per Request

Emitting multiple log lines per request creates noise without value. These scattered logs cannot be efficiently queried.

**Incorrect:**

```typescript
app.post('/checkout', async (c) => {
  console.log('Received checkout request'); // Line 1
  console.log(`User ID: ${c.get('userId')}`); // Line 2
  const user = await getUser(c.get('userId'));
  console.log(`User fetched: ${user.email}`); // Line 3
  const cart = await getCart(user.id);
  console.log(`Cart fetched: ${cart.items.length} items`); // Line 4
  const payment = await processPayment(cart);
  console.log(`Payment processed: ${payment.status}`); // Line 5
  console.log('Checkout completed successfully'); // Line 6
  return c.json({ orderId: payment.orderId });
});
// 6 log lines per request = noise
```

**Correct:**

```typescript
// Single wide event with everything
const wideEvent = {
  method: 'POST',
  path: '/checkout',
  user: { id: user.id, email: user.email },
  cart: { item_count: cart.items.length, total: cart.total },
  payment: { status: payment.status, order_id: payment.orderId },
  status_code: 200,
  duration_ms: 1247
};
```

### Pitfall 2: Not Designing for Unknown Unknowns

Traditional logging captures "known unknowns" - issues you anticipated. But production bugs are often "unknown unknowns" - issues you never predicted. Wide events with rich context enable investigating issues you didn't anticipate.

**Incorrect:**

```typescript
// Logging only for anticipated issues
app.post('/articles', async (c) => {
  const article = await createArticle(c.req.body, user);
  if (!article.published) {
    console.log('Article created but not published'); // Anticipated issue
  }
  return c.json({ article });
});

// Bug: "Users on free trial can't see their articles"
// Your logs say: "Article created successfully" ✓
// But you have NO visibility into:
// - Which users are affected (free trial? all?)
// - What subscription plans see this issue
// - When it started
```

**Correct:**

```typescript
// Wide event captures everything
wideEvent.user = {
  id: user.id,
  subscription: user.subscription,
  trial: user.trial,
  trial_expiration: user.trialExpiration
};

wideEvent.article = {
  id: article.id,
  published: article.published // Captured even though we didn't anticipate the bug
};

// Now you can query: WHERE article.published = false GROUP BY user.trial
// Result: 95% of unpublished articles are from trial users!
```

### Pitfall 3: Missing Request Correlation

Without request IDs propagated across services, you cannot trace a request's journey.

**Incorrect:**

```typescript
// Service A logs
{ message: 'Order created', order_id: 'ord_123' }

// Service B logs
{ message: 'Inventory reserved', items: 3 }

// No way to connect these two events!
```

**Correct:**

```typescript
// Both services include the same request_id
{ request_id: 'req_abc', message: 'Order created', order_id: 'ord_123' }
{ request_id: 'req_abc', message: 'Inventory reserved', items: 3 }

// Query: WHERE request_id = 'req_abc' shows the full flow
```

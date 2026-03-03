---
title: Context, Cardinality, and Dimensionality
impact: CRITICAL
tags: logging, context, cardinality, dimensionality
---

## Context, Cardinality, and Dimensionality

**Impact: CRITICAL**

Wide events must be context-rich with high cardinality and high dimensionality. This enables you to answer questions you haven't anticipated yet - the "unknown unknowns" that traditional logging misses.

### High Cardinality

High cardinality means a field can have millions or billions of unique values. User IDs, request IDs, and transaction IDs are high cardinality fields. Your logging must support querying against any specific value of these fields. Without high cardinality support, you cannot debug issues for specific users.

### High Dimensionality

High dimensionality means your events have many fields (20-100+). More dimensions mean more questions you can answer without redeploying code.

```typescript
const wideEvent = {
  // Timing
  timestamp: '2024-09-08T06:14:05.680Z',
  duration_ms: 268,

  // Request context
  method: 'POST',
  path: '/checkout',
  requestId: 'req_abc123',

  // Infrastructure
  service: 'checkout-service',
  version: '2.4.1',
  region: 'us-east-1',
  commit_hash: '690de31f',

  // User context (HIGH CARDINALITY - millions of unique values)
  user: {
    id: 'user_456',
    subscription: 'premium',
    account_age_days: 847,
    lifetime_value_cents: 284700
  },

  // Business context
  cart: {
    id: 'cart_xyz',
    item_count: 3,
    total_cents: 15999,
    coupon_applied: 'SAVE20'
  },

  // Payment details
  payment: {
    method: 'card',
    provider: 'stripe',
    latency_ms: 189
  },

  // Feature flags - crucial for debugging rollouts
  feature_flags: {
    new_checkout_flow: true
  },

  // Outcome
  status_code: 200,
  outcome: 'success'
};
```

### Always Include Business Context

Include business-specific context, not just technical details. User subscription tier, cart value, feature flags, account age - this context helps prioritize issues and understand business impact.

```typescript
const wideEvent = {
  requestId: 'req_123',
  method: 'POST',
  path: '/checkout',
  status_code: 500,

  // Business context that changes response priority
  user: {
    id: 'user_456',
    subscription: 'enterprise', // High-value customer
    account_age_days: 1247, // Long-term customer
    lifetime_value_cents: 4850000 // $48,500 LTV
  },

  cart: {
    total_cents: 249900, // $2,499 order
    contains_annual_plan: true // Recurring revenue at stake
  },

  feature_flags: {
    new_payment_flow: true // Was new code involved?
  },

  error: {
    type: 'PaymentError',
    code: 'card_declined'
  }
};
// Now you KNOW this is critical: Enterprise customer, $48.5k LTV,
// trying to make a $2.5k purchase, and new_payment_flow is enabled
```

Business context transforms debugging from "something broke" to "this $48,500 customer can't complete a $2,499 order."

### Always Include Environment Characteristics

Include environment and deployment information in every wide event. This context is essential for correlating issues with deployments, identifying region-specific problems, and understanding the runtime environment.

**Environment fields to include:**

```typescript
const wideEvent = {
  // ... request and business context

  // Environment characteristics
  env: {
    // Deployment info
    commit_hash: process.env.COMMIT_SHA || process.env.GIT_COMMIT,
    version: process.env.SERVICE_VERSION || process.env.npm_package_version,
    deployment_id: process.env.DEPLOYMENT_ID,
    deploy_time: process.env.DEPLOY_TIMESTAMP,

    // Infrastructure
    service: process.env.SERVICE_NAME,
    region: process.env.AWS_REGION || process.env.REGION,
    availability_zone: process.env.AWS_AVAILABILITY_ZONE,
    instance_id: process.env.INSTANCE_ID || process.env.HOSTNAME,
    container_id: process.env.CONTAINER_ID,

    // Runtime
    node_version: process.version,
    runtime: process.env.AWS_EXECUTION_ENV || 'node',
    memory_limit_mb: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,

    // Environment type
    environment: process.env.NODE_ENV || process.env.ENVIRONMENT,
    stage: process.env.STAGE
  }
};
```

**Why environment context matters:**

- **commit_hash**: Instantly identify which code version caused an issue
- **deployment_id**: Correlate errors with specific deployments
- **region/availability_zone**: Identify region-specific failures
- **instance_id**: Debug issues affecting specific instances
- **version**: Track issues across service versions
- **environment**: Distinguish production from staging issues

This environment context should be added once at service startup and automatically included in every wide event via middleware.

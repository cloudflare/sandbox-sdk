# Logging Best Practices Skill

A skill for AI coding assistants to apply logging best practices when writing or reviewing code.

## Overview

This skill teaches the **wide events** pattern (also known as canonical log lines) - emit a single, context-rich event per request per service instead of scattered log statements.

## Key Concepts

- **Wide Events**: One comprehensive event per request, emitted at completion
- **High Cardinality**: Support fields with millions of unique values (user_id, request_id)
- **High Dimensionality**: Include many fields (20+) per event
- **Business Context**: Always include user subscription, cart value, feature flags
- **Environment Context**: Always include commit hash, version, region, instance ID
- **Single Logger**: One logger instance configured at startup, used everywhere
- **Middleware Pattern**: Handle logging infrastructure in middleware, business context in handlers

## Structure

```
logging-best-practices/
├── SKILL.md              # Agent instructions
├── README.md             # This file
├── metadata.json         # Version and references
└── rules/
    ├── wide-events.md    # Core pattern (CRITICAL)
    ├── context.md        # Cardinality, business & environment context (CRITICAL)
    ├── structure.md      # Single logger, middleware, JSON format (HIGH)
    └── pitfalls.md       # Common mistakes (MEDIUM)
```

## Rules

1. **Wide Events** (CRITICAL) - One event per request, emit in finally block, request ID correlation
2. **Context** (CRITICAL) - High cardinality, dimensionality, business context, environment characteristics
3. **Structure** (HIGH) - Single logger, middleware pattern, JSON format, consistent schema
4. **Pitfalls** (MEDIUM) - Scattered logs, unknown unknowns, missing request correlation

## Reference

- [Boris Tane's Blog - Logging Sucks](https://loggingsucks.com)
- [Boris Tane's Blog - Observability wide events 101](https://boristane.com/blog/observability-wide-events-101/)
- [Stripe Blog - Canonical Log Lines](https://stripe.com/blog/canonical-log-lines)

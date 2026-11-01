---
kind: upgrade-guide
description: Custom Agent implementations must provide response interruption, and request recovery listeners receive response-or-turn cancellation.
---

# Response interruption for Agent implementations and recovery listeners

English | [中文](guide.zh.md)

## Change

`Agent` requires `interruptResponse(): boolean`. The default AgentLoop requests cancellation of its active model response or recovery wait, records that response, and continues through the next pre-step in the same turn. Callers enqueue steering separately. The method does not cancel tools, preparation, maintenance, or the whole turn.

`agent/request-error.payload.signal` is cancelled by either whole-turn cancellation or response interruption. Previously it represented only turn cancellation. Recovery listeners cannot infer that the turn ended from this signal alone. Existing `cancel()`, `steer()`, and `followup()` keep their semantics.

## Migration

1. Update custom `Agent` implementations and typed fixtures to provide `interruptResponse()`. Return `true` only when requesting an eligible response's interruption; return `false` when no eligible response remains or interruption was already requested. A request acknowledgement does not prove settlement.
2. In `agent/request-error` listeners, pass `payload.signal` to cancellable recovery work and stop retrying after it aborts. Use Agent lifecycle or durable turn events when the caller needs the whole-turn outcome; do not cast every signal reason to a turn-cancellation cause.
3. For immediate corrections, enqueue the identified message through `steer()` before requesting interruption. Preserve normal pre-step admission and leave whole-turn cancellation authoritative.
4. Verify a waiting response and a recovery wait can stop while the same turn continues with the correction. Verify active tools and ordinary steering remain unaffected. The [Agent API](../../../../packages/core/agent/README.md#drive-an-agents-conversation) defines return values and settlement observations.

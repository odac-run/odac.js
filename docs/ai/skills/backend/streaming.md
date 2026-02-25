---
name: backend-streaming-sse-skill
description: Server-Sent Events streaming patterns in ODAC for realtime one-way updates with safe connection lifecycle management.
metadata:
  tags: backend, streaming, sse, realtime, event-stream, connection-lifecycle
---

# Backend Streaming API Skill

Real-time data streaming using Server-Sent Events (SSE).

## Core Rules
1.  **Usage**: Use `Odac.stream(callback)` to keep the connection open.
2.  **Safety**: Always use `Odac.setInterval` and `Odac.setTimeout` inside streams; they are automatically cleaned up on disconnect.
3.  **Return**: You must `return Odac.stream(...)` from the controller.

## Reference Patterns
### 1. Simple Stream
```javascript
module.exports = async (Odac) => {
  return Odac.stream((send) => {
    send({ status: 'connected' });
    
    Odac.setInterval(() => {
      send({ time: Date.now() });
    }, 1000);
  });
};
```

### 2. Async Generator Stream
```javascript
module.exports = async (Odac) => {
  return Odac.stream(async function* () {
    const logs = await getLogStream();
    for await (const log of logs) {
      yield log;
    }
  });
};
```

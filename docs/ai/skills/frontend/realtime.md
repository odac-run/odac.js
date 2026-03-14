---
name: frontend-realtime-websocket-skill
description: Realtime frontend communication patterns in odac.js using shared WebSockets, SSE, and resilient reconnect behavior.
metadata:
  tags: frontend, realtime, websocket, sse, sharedworker, auto-reconnect
---

# Frontend Realtime & WebSocket Skill

Real-time bidirectional communication and server-sent events with high efficiency.

## Architectural Approach
ODAC prioritizes connection efficiency. `Odac.ws()` provides shared WebSocket connections across multiple browser tabs using `SharedWorker`, significantly reducing server load.

## Core Rules
1.  **Shared Connections**: Always prefer `Odac.ws(url, { shared: true })` for scalable real-time apps.
2.  **Auto-Reconnect**: Enabled by default; the client handles network drops automatically.
3.  **SSE (Streaming)**: Use `new EventSource(url)` for one-way streams (e.g., live logs, notifications).
4.  **JSON Native**: Messages sent and received via `Odac.ws` are automatically parsed/stringified.

## Reference Patterns

### 1. Shared WebSocket (Cross-Tab)
```javascript
// One connection shared across all open tabs
const ws = Odac.ws('/chat', { shared: true });

ws.on('message', (data) => {
  console.log('Update received in all tabs:', data);
});

// Sends message from current tab; others will receive the response
ws.send({ type: 'chat', text: 'Hello World' });
```

### 2. Standard WebSocket (Per-Tab)
```javascript
const ws = Odac.ws('/game', { shared: false });
ws.on('open', () => console.log('Game connected'));
```

### 3. Server-Sent Events (SSE)
```javascript
const source = new EventSource('/api/events');
source.onmessage = (event) => {
  const data = JSON.parse(event.data);
  updateUI(data);
};
```

## Best Practices
-   **Resource Management**: Shared WebSocket automatically closes when the last tab using it is closed.
-   **Security**: Always use `Odac.ws(url, { token: true })` for authenticated paths; the client will automatically attach the latest CSRF/Session token.
-   **Distributed State**: Use `Odac.Ipc` in backend WS handlers to broadcast messages across multiple server workers.

### 4. Rooms & Broadcasting (Backend Example)
```javascript
// controller/ws/Game.js
module.exports = async function(Odac) {
  const ws = Odac.ws;
  const roomId = await Odac.request('roomId');

  ws.join(roomId);

  ws.on('message', (data) => {
    // Broadcast only to this room
    ws.to(roomId).send({ user: ws.id, move: data.move });
  });
};
```

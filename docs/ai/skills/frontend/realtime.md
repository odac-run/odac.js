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
-   **Fallback**: If `SharedWorker` is not supported (e.g., Safari), `Odac.ws` automatically falls back to a standard WebSocket.
-   **Server-Side Hubs**: Ensure the backend uses `Odac.Hub` to send messages to the correct rooms or users.

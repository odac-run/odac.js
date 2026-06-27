# WebSocket Overview

Odac provides built-in WebSocket support with automatic reconnection and cross-tab sharing capabilities.

## Quick Start

**Backend (route/main.js):**
```javascript
Odac.Route.ws('/chat', (ws, Odac) => {
  ws.on('message', data => {
    ws.broadcast(data)
  })
})
```

**Frontend:**
```javascript
const ws = Odac.ws('/chat')
ws.on('message', data => console.log(data))
ws.send({message: 'Hello!'})
```

## Key Features

### 🔄 Automatic Reconnection
Automatically reconnects on connection loss with configurable retry logic.

### 🔗 Cross-Tab Sharing
Share a single WebSocket connection across multiple browser tabs using SharedWorker.

### 🏠 Room Support
Group clients into rooms for targeted broadcasting.

### 🔐 Authentication
Full access to Odac context for authentication and authorization.

### 📦 JSON Auto-Parsing
Automatically parses JSON messages on both client and server.

### 🎯 URL Parameters
Support for dynamic route parameters like `/room/{id}`.

## Architecture

```
Browser Tab 1 ─┐
Browser Tab 2 ─┼─> SharedWorker ─> WebSocket ─> Odac Server ─> Your Handler
Browser Tab 3 ─┘
```

With `shared: true`, all tabs share one connection through a SharedWorker.

## Use Cases

- **Real-time chat applications**
- **Live notifications**
- **Collaborative editing**
- **Live dashboards**
- **Multiplayer games**
- **Stock/crypto price updates**
- **IoT device monitoring**

## Browser Support

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| WebSocket | ✅ | ✅ | ✅ | ✅ |
| Shared WebSocket | ✅ | ✅ | ❌ | ✅ |

*Shared WebSocket automatically falls back to regular WebSocket in unsupported browsers.*

## Next Steps

- [WebSocket Client](01-websocket-client.md) - Basic client usage
- [Shared WebSocket](02-shared-websocket.md) - Cross-tab communication
- [Backend WebSocket](../../backend/04-routing/09-websocket.md) - Server-side implementation

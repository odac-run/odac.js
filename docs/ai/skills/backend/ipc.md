# Backend IPC (Inter-Process Communication) Skill

ODAC provides a built-in IPC system to share data and sync states across application workers or multiple servers.

## Architectural Approach
IPC abstracts the underlying driver, allowing seamless transition between `memory` (Node.js cluster) and `redis` (multi-server scaling).

## Core Rules
1.  **Drivers**:
    -   `memory`: Shared across local workers via Main process (Default).
    -   `redis`: Shared across multiple servers/clusters.
2.  **State Sharing**: Use `Odac.Ipc` for global key-value storage.
3.  **Messaging**: Use Pub/Sub for worker-to-worker communication.

## Reference Patterns

### 1. Key-Value Storage
```javascript
// Set value with optional TTL (seconds)
await Odac.Ipc.set('maintenance_mode', true);
await Odac.Ipc.set('cache_key', { data: 123 }, 60);

// Get value
const status = await Odac.Ipc.get('maintenance_mode');

// Delete value
await Odac.Ipc.del('maintenance_mode');
```

### 2. Pub/Sub Messaging
```javascript
// Subscribe to a channel (usually in a service or app start)
await Odac.Ipc.subscribe('notifications', (msg) => {
  console.log('Received:', msg);
});

// Publish a message from any worker
await Odac.Ipc.publish('notifications', { type: 'alert', text: 'System update' });
```

## Configuration
In `odac.json` or a config provider:
```json
{
  "ipc": {
    "driver": "redis",
    "redis": "default"
  }
}
```

## Best Practices
-   **Async First**: All IPC operations are asynchronous.
-   **TTL Usage**: Always set a TTL for temporary cache data to prevent memory bloat.
-   **Scaling**: Switch to `redis` driver when deploying across multiple containers or servers.

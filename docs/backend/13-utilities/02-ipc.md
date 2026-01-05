# IPC (Inter-Process Communication)

Odac provides a built-in IPC system that allows your application workers to communicate with each other, share data, and sync states. It abstracts the underlying driver, allowing you to switch between in-memory (cluster) and Redis-based communication with a simple configuration change.

## Configuration

To configure the IPC system, update your project configuration. The default driver is `memory`.

```javascript
// config.js
module.exports = {
  // ...
  database: {
    // ... other dbs
    redis: {
      default: {
        // node-redis connection options
        // e.g., url: 'redis://user:pass@host:port'
      }
    }
  },
  ipc: {
    driver: 'memory', // Options: 'memory' or 'redis'
    redis: 'default'  // The name of the redis connection to use (if driver is 'redis')
  }
}
```

### Drivers

- **memory**: Uses Node.js `cluster` IPC. Ideal for single-server deployments. Data is stored in the Main/Primary process RAM and shared across workers via `process.send`.
- **redis**: Uses a Redis server. Ideal for multi-server/horizontal scaling deployements. Requires a configured Redis connection.

## Usage

You can access the IPC module via `Odac.Ipc`.

### Data Storage (Key-Value)

You can set, get, and delete values. These values are shared across all workers.

```javascript
// Set a value (with optional TTL in seconds)
await Odac.Ipc.set('maintenance_mode', true);
await Odac.Ipc.set('temp_cache', { foo: 'bar' }, 60);

// Get a value
const isMaintenance = await Odac.Ipc.get('maintenance_mode');

// Delete a value
await Odac.Ipc.del('maintenance_mode');
```

> [!NOTE]
> `get`, `set`, and `del` are asynchronous and return Promises.

### Pub/Sub (Messaging)

You can publish messages to channels and subscribe to them in other workers.

```javascript
// Subscribe to a channel
// Best practice: Subscribe in your app initialization or a Service Provider
await Odac.Ipc.subscribe('chat:global', (message) => {
  console.log('New chat message:', message);
});

// Publish a message
await Odac.Ipc.publish('chat:global', { user: 'Emre', text: 'Hello World' });
```

> [!TIP]
> When using `memory` driver, the subscription listener is registered in the current worker. When a message is published, it goes to the Main process and is then broadcasted to all subscribed workers.

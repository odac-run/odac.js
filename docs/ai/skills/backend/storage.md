---
name: backend-persistent-storage-skill
description: Embedded ODAC storage usage patterns with LMDB for sub-millisecond key-value persistence across workers.
metadata:
  tags: backend, storage, lmdb, key-value, persistence, high-performance
---

# Backend Persistent Storage Skill

ODAC provides a high-performance, embedded key-value store using LMDB, exposed via `Odac.Storage`.

## Architectural Approach
Storage is ideal for persistent data that requires sub-millisecond access and does not need the complexity of a relational database. It is shared across all processes and workers.

## Core Rules
1.  **Usage**: Access via `Odac.Storage`.
2.  **Atomicity**: LMDB is ACID compliant and thread-safe.
3.  **Data Types**: Supports strings, numbers, and JSON objects natively.
4.  **Automatic Initialization**: The primary storage is initialized in the `storage/` directory automatically.

## Reference Patterns

### 1. Basic KV Operations
```javascript
// Setting data
Odac.Storage.put('setting_theme', 'dark');
Odac.Storage.put('app_data', { version: '1.0.0', last_check: Date.now() });

// Getting data
const theme = Odac.Storage.get('setting_theme');
const appData = Odac.Storage.get('app_data');

// Removing data
Odac.Storage.remove('setting_theme');
```

### 2. Range Queries
```javascript
// Get all keys starting with 'pref:'
const preferences = Odac.Storage.getRange({ start: 'pref:', end: 'pref:~' });
for (const { key, value } of preferences) {
  console.log(key, value);
}
```

## Best Practices
-   **Keyspacing**: Use prefixes like `sess:`, `cache:`, or `pref:` to organize your keys.
-   **Performance**: Since it's memory-mapped, random reads are extremely fast (O(1)).
-   **No Migrations**: Unlike SQL, Storage is schemaless. Ensure your code handles version changes in the stored JSON objects.
-   **Avoid Large Blobs**: While it can store large values, keep them reasonable to maintain OS-level cache efficiency.

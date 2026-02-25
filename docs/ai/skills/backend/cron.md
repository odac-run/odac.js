# Backend Cron Jobs Skill

ODAC provides a built-in cron system for automating background tasks without external dependencies.

## Architectural Approach
Cron jobs are defined in routes and executed by the internal scheduler. They can use either external controller files (recommended) or inline functions.

## Core Rules
1.  **Definition**: Use `Odac.Route.cron('name')` to start a definition.
2.  **Scheduling**: Use fluent methods like `.everyMinute(n)`, `.at('HH:MM')`, `.day(n)`, etc.
3.  **Controllers**: Cron controllers should be in `controller/cron/`. They receive the `Odac` instance.
4.  **Wildcard Warning**: If you specify an hour but no minute, it will run every minute during that hour. Always use `.at()` or specify the minute.

## Reference Patterns

### 1. File-Based Cron (Recommended)
```javascript
// route/cron.js
Odac.Route.cron('cleanup').at('03:00'); // Runs daily at 03:00

// controller/cron/cleanup.js
module.exports = async (Odac) => {
  console.log('Running nightly cleanup...');
  await Odac.DB.table('logs').where('created_at', '<', 'NOW() - INTERVAL 30 DAY').delete();
};
```

### 2. Inline Function Cron
```javascript
Odac.Route.cron(async () => {
  const stats = await Odac.DB.table('orders').count();
  console.log('Current orders:', stats);
}).everyHour(1);
```

### 3. Raw Unix Cron Patterns
```javascript
// Run every 15 minutes
Odac.Route.cron('sync').raw('*/15 * * * *');
```

## Available Schedulers
-   `.minute(0-59)`, `.hour(0-23)`, `.day(1-31)`, `.month(1-12)`, `.weekDay(0-6)`.
-   `.everyMinute(n)`, `.everyHour(n)`, `.everyDay(n)`.
-   `.at('HH:MM')`: Shorthand for setting specific hour and minute.

## Best Practices
-   **Logging**: Always log the start and completion of background tasks to the console or a file.
-   **Timeouts**: Be aware that long-running tasks might overlap if the interval is too short.
-   **Service Injection**: Use Service Classes inside cron jobs to keep the logic clean.

## 2024-02-18 - [Route Matching Optimization]
**Learning:** Moving string operations (`split`, `includes`) from the hot request path to the route registration phase yields massive gains (5x) for parameterized route lookups.
**Action:** Always look for invariant calculations inside loops that can be pre-computed and cached on the object itself during initialization.

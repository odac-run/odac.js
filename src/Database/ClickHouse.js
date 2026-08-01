'use strict'

/**
 * ClickHouse DDL & type-mapping helpers for the ODAC schema-first migration engine.
 *
 * Why a dedicated module: ClickHouse is an OLAP (columnar) database whose CREATE TABLE
 * requirements — a mandatory table ENGINE, a sorting key (ORDER BY), optional PARTITION BY —
 * have no equivalent in Knex's schema builder, which the SQL (MySQL/PG/SQLite) path relies on.
 * These helpers are pure string builders (no I/O), so the whole DDL surface is unit-testable
 * without a live ClickHouse server. The ClickHouseAdapter executes what these produce.
 *
 * Schema format extension (ClickHouse-only fields, ignored by SQL engines):
 *   module.exports = {
 *     engine: 'MergeTree',                 // default 'MergeTree'; pass 'ReplacingMergeTree(ver)' etc. verbatim
 *     orderBy: ['created_at', 'id'],       // sorting key; defaults to tuple() when omitted
 *     partitionBy: 'toYYYYMM(created_at)', // optional partitioning expression
 *     ttl: 'created_at + INTERVAL 30 DAY', // optional table-level data retention (raw TTL expression)
 *     settings: 'index_granularity = 8192',// optional raw SETTINGS clause
 *     columns: {
 *       // Per-column TTL: expires just this column's value (reset to default), not the whole row.
 *       secret: {type: 'string', ttl: 'created_at + INTERVAL 7 DAY'}
 *     }
 *   }
 *
 * TTL is a raw ClickHouse expression, passed through verbatim (like partitionBy/settings): the
 * caller owns the syntax, including optional `DELETE` / `TO DISK` / `TO VOLUME` / `GROUP BY` tails.
 * Only MergeTree-family engines support TTL; other engines silently ignore the clause at CREATE.
 *
 * Rollup DSL (`rollup` field): a declarative shorthand that COMPILES to `orderBy` + `ttl`. Instead of
 * hand-writing multi-tier TTL GROUP BY expressions (and the exact ORDER BY prefix they require), you
 * declare intent and `compileRollup()` emits the DDL:
 *   rollup: {
 *     time: 't',                    // timestamp column every tier ages against
 *     by:   ['resource_id'],        // non-time leading dimensions (kept at every tier)
 *     count: 'samples',             // sample-count column (default 'samples'); alias: samplesColumn
 *     tiers: [
 *       {olderThan: '24 HOUR', bucket: 'tenMinutes'},  // >24h → 10-minute buckets
 *       {olderThan: '30 DAY',  bucket: 'day'},         // >30d → daily buckets
 *       {bucket: 'week', reserve: true},               // pre-register 'week' in ORDER BY only (no TTL)
 *       {olderThan: '2 YEAR',  delete: true}           // >2y  → purge (optional final tier)
 *     ],
 *     set: {cpu: 'sum', pids: 'max'} // per-column aggregate (sum|max|min|any); avg is rejected
 *   }
 * Why a `samples` column: avg-of-avg drifts across tiers, so mean is NOT aggregated directly. The
 * compiler injects `samples UInt64 DEFAULT 1` and sums it at every tier — read-side mean = sum/samples.
 * ORDER BY is DERIVED (`[...by, buckets coarse→fine]`) so each tier's GROUP BY is a primary-key prefix;
 * a hand-written `orderBy` is allowed only if it starts with that derived prefix (else compile throws).
 * A `reserve: true` tier adds its bucket to ORDER BY without emitting a TTL step, so activating that
 * granularity later (swap `reserve: true` for an `olderThan`) is a MODIFY TTL with no table recreate.
 *
 * IMPORTANT nullable semantics: SQL engines treat an unspecified `nullable` as NULLABLE.
 * ClickHouse columns are NOT NULL by default and must be explicitly wrapped in Nullable(T).
 * To stay predictable we invert the default here: a ClickHouse column is nullable ONLY when
 * the schema sets `nullable: true`. Anything else is emitted as a plain (non-null) type.
 */

const DIALECT = 'clickhouse'

/** MergeTree-family engines require an ORDER BY clause; others (Log, Memory…) do not. */
const MERGE_TREE = /mergetree/i

/**
 * True when the (normalized) engine expression belongs to the MergeTree family.
 * @param {string} engine
 * @returns {boolean}
 */
function isMergeTreeEngine(engine) {
  return MERGE_TREE.test(engine)
}

/**
 * Quotes a ClickHouse identifier (table/column) with backticks, escaping embedded backticks.
 * @param {string} name
 * @returns {string}
 */
function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

/**
 * Quotes a scalar value as a ClickHouse string literal, escaping single quotes and backslashes.
 * @param {string|number} value
 * @returns {string}
 */
function quoteLiteral(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

/**
 * Maps an ODAC column definition to a ClickHouse column type.
 * Why: The SQL type map (varchar/int/…) does not exist in ClickHouse; column types and the
 * Nullable() wrapper model are fundamentally different. `specificType` passes through verbatim,
 * which is the escape hatch for native CH types (LowCardinality, Array(T), Enum8, DateTime64…).
 * @param {object} def - Column definition from a schema file
 * @returns {string} ClickHouse type expression (already Nullable-wrapped when applicable)
 */
function mapColumnType(def) {
  const base = baseType(def)

  // specificType is a raw passthrough — the caller owns nullability, don't double-wrap.
  if (def.type === 'specificType') return base

  return def.nullable === true ? `Nullable(${base})` : base
}

/**
 * Resolves the non-nullable base ClickHouse type for a column definition.
 * @param {object} def
 * @returns {string}
 */
function baseType(def) {
  switch (def.type) {
    case 'increments':
    case 'integer':
      return def.unsigned ? 'UInt32' : 'Int32'
    case 'bigIncrements':
    case 'bigInteger':
      return def.unsigned ? 'UInt64' : 'Int64'
    case 'float':
      return 'Float64'
    case 'decimal':
      return `Decimal(${def.precision || 10}, ${def.scale || 2})`
    case 'boolean':
      // ClickHouse has a Bool alias backed by UInt8; UInt8 is the portable, universally-supported form.
      return 'UInt8'
    case 'string':
    case 'text':
    case 'nanoid':
    case 'time':
      // Length is intentionally ignored: FixedString(n) right-pads with null bytes, which corrupts
      // variable-length values. Plain String is the correct ClickHouse home for these.
      return 'String'
    case 'date':
      return 'Date'
    case 'datetime':
    case 'timestamp':
      return 'DateTime'
    case 'uuid':
      return 'UUID'
    case 'json':
    case 'jsonb':
      // The native JSON type is still experimental across CH versions; String is the safe default.
      return 'String'
    case 'binary':
      return 'String'
    case 'enum':
      return buildEnumType(def.values)
    case 'specificType':
      return def.length || def.specificType || 'String'
    default:
      // Unknown/native type name passed straight through (e.g. 'IPv4', 'Array(String)').
      return def.type || 'String'
  }
}

/**
 * Builds an Enum8 type from a list of string values, assigning stable 1-based ids.
 * @param {string[]} values
 * @returns {string}
 */
function buildEnumType(values) {
  if (!Array.isArray(values) || values.length === 0) return 'String'
  const members = values.map((v, i) => `${quoteLiteral(v)} = ${i + 1}`)
  return `Enum8(${members.join(', ')})`
}

/**
 * Renders the DEFAULT clause fragment for a column, or '' when none applies.
 * Special-cases SQL time keywords (now()/current_timestamp) to their ClickHouse form.
 * @param {object} def
 * @returns {string}
 */
function defaultClause(def) {
  if (def.default === undefined) return ''

  const value = def.default
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim()
    if (lower === 'now()' || lower === 'current_timestamp' || lower === 'current_timestamp()') {
      return ' DEFAULT now()'
    }
    return ` DEFAULT ${quoteLiteral(value)}`
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return ` DEFAULT ${Number(value)}`
  }
  return ''
}

/**
 * Renders the column-level TTL fragment (" TTL <expr>"), or '' when none applies.
 * ClickHouse column TTL expires an individual column's value (reset to its default) rather than
 * the whole row. The expression is passed through verbatim — the caller owns the syntax.
 * @param {object} def
 * @returns {string}
 */
function ttlColumnClause(def) {
  if (!def.ttl || typeof def.ttl !== 'string' || def.ttl.trim() === '') return ''
  return ` TTL ${def.ttl.trim()}`
}

/**
 * Renders a single "`col` Type [DEFAULT …] [TTL …]" column fragment.
 * Clause order follows ClickHouse grammar: type → DEFAULT → TTL.
 * @param {string} colName
 * @param {object} def
 * @returns {string}
 */
function columnFragment(colName, def) {
  return `${quoteIdent(colName)} ${mapColumnType(def)}${defaultClause(def)}${ttlColumnClause(def)}`
}

/**
 * Expands the schema column map into concrete ClickHouse column fragments.
 * Handles the virtual 'timestamps' type (created_at/updated_at) like the SQL path.
 * @param {object} columns - Schema column definitions
 * @returns {string[]} Column fragments in declaration order
 */
function buildColumnFragments(columns) {
  const fragments = []

  for (const [colName, def] of Object.entries(columns || {})) {
    if (def.type === 'timestamps') {
      fragments.push(columnFragment('created_at', {type: 'datetime', default: 'now()'}))
      fragments.push(columnFragment('updated_at', {type: 'datetime', default: 'now()'}))
      continue
    }
    fragments.push(columnFragment(colName, def))
  }

  return fragments
}

/**
 * Normalizes the schema `engine` field into a valid ENGINE expression.
 * Appends "()" when the engine name carries no parameter list (e.g. 'MergeTree' → 'MergeTree()').
 * @param {string} [engine]
 * @returns {string}
 */
function normalizeEngine(engine) {
  const name = (engine || 'MergeTree').trim()
  return name.includes('(') ? name : `${name}()`
}

/** A bare column reference — anything else in ORDER BY is treated as a raw expression. */
const SIMPLE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Renders one ORDER BY element. A bare identifier is backtick-quoted; anything else — a function
 * call like `toStartOfDay(t)` or a compound expression — is a raw ClickHouse expression passed
 * through verbatim. Without this, an expression would be quoted into a nonexistent column name.
 * @param {string} col
 * @returns {string}
 */
function orderByExpr(col) {
  const s = String(col).trim()
  return SIMPLE_IDENT.test(s) ? quoteIdent(s) : s
}

/**
 * Renders the ORDER BY clause. MergeTree-family engines require one; tuple() (no sorting)
 * is the valid, non-throwing default when a schema omits `orderBy`. Elements may be bare
 * identifiers (quoted) or raw expressions (passed through) — see orderByExpr.
 * @param {string|string[]} [orderBy]
 * @param {string} engine - Normalized engine expression
 * @returns {string} ORDER BY fragment or '' for engines that don't take one
 */
function orderByClause(orderBy, engine) {
  if (!MERGE_TREE.test(engine)) return ''

  if (!orderBy || (Array.isArray(orderBy) && orderBy.length === 0)) {
    return 'ORDER BY tuple()'
  }

  const cols = Array.isArray(orderBy) ? orderBy : [orderBy]
  return `ORDER BY (${cols.map(orderByExpr).join(', ')})`
}

/**
 * Renders the table-level TTL clause. MergeTree-family engines are the only ones that support
 * data retention TTL; for others the clause is omitted (CH would reject it at CREATE otherwise).
 * The expression is passed through verbatim, including any DELETE/TO DISK/GROUP BY tail.
 * @param {string} [ttl] - Raw TTL expression from schema
 * @param {string} engine - Normalized engine expression
 * @returns {string} TTL fragment or '' when not applicable
 */
function ttlTableClause(ttl, engine) {
  if (!ttl || typeof ttl !== 'string' || ttl.trim() === '') return ''
  if (!MERGE_TREE.test(engine)) return ''
  return `TTL ${ttl.trim()}`
}

/** Rollup bucket vocabulary → ClickHouse toStartOf* function. */
const BUCKET_FUNCTIONS = {
  minute: 'toStartOfMinute',
  fiveMinutes: 'toStartOfFiveMinutes',
  tenMinutes: 'toStartOfTenMinutes',
  fifteenMinutes: 'toStartOfFifteenMinutes',
  hour: 'toStartOfHour',
  day: 'toStartOfDay',
  week: 'toStartOfWeek',
  month: 'toStartOfMonth',
  quarter: 'toStartOfQuarter',
  year: 'toStartOfYear'
}

/** Coarseness rank (approx seconds) — orders buckets coarse→fine for ORDER BY and prefix slicing. */
const BUCKET_RANK = {
  minute: 60,
  fiveMinutes: 300,
  tenMinutes: 600,
  fifteenMinutes: 900,
  hour: 3600,
  day: 86400,
  week: 604800,
  month: 2592000,
  quarter: 7776000,
  year: 31536000
}

/** INTERVAL units → approx seconds, used only to order tiers by age (not for exact arithmetic). */
const INTERVAL_UNITS = {
  SECOND: 1,
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800,
  MONTH: 2592000,
  QUARTER: 7776000,
  YEAR: 31536000
}

/** Aggregates valid in a rollup SET. avg is intentionally absent: avg-of-avg drifts across tiers. */
const SET_FUNCTIONS = new Set(['sum', 'max', 'min', 'any'])

/**
 * Parses a rollup tier interval like '30 DAY' / '24 HOURS' into a normalized INTERVAL expression
 * plus an approximate second-count for age ordering. Throws on malformed input.
 * @param {string} raw
 * @returns {{seconds: number, text: string}}
 */
function parseInterval(raw) {
  if (typeof raw !== 'string') {
    throw new Error(`ClickHouse rollup: tier 'olderThan' must be a string like '24 HOUR', got ${JSON.stringify(raw)}`)
  }
  const m = raw.trim().match(/^(\d+)\s+([A-Za-z]+)$/)
  if (!m) {
    throw new Error(`ClickHouse rollup: invalid 'olderThan' interval '${raw}' (expected '<number> <UNIT>', e.g. '30 DAY')`)
  }
  const unit = m[2].toUpperCase().replace(/S$/, '')
  if (!INTERVAL_UNITS[unit]) {
    throw new Error(`ClickHouse rollup: unknown interval unit '${m[2]}' in '${raw}' (allowed: ${Object.keys(INTERVAL_UNITS).join(', ')})`)
  }
  return {seconds: Number(m[1]) * INTERVAL_UNITS[unit], text: `INTERVAL ${m[1]} ${unit}`}
}

/**
 * Compiles a schema's declarative `rollup` block into concrete `orderBy` + `ttl` + an injected
 * sample-count column, returning a NEW schema object with `rollup` removed. A no-op (returns the
 * input unchanged) when there is no `rollup` — so it is idempotent and safe to call more than once.
 *
 * The emitted TTL string is single-line and deterministic (stable tier/SET ordering) so the
 * migration engine's TTL-diff (tracking-table based) stays idempotent across restarts.
 * @param {object} schema - Full schema definition, possibly carrying `rollup`
 * @returns {object} Schema with `orderBy`/`ttl`/`columns` resolved and `rollup` stripped
 */
function compileRollup(schema) {
  if (!schema || !schema.rollup) return schema
  const r = schema.rollup

  if (!MERGE_TREE.test(normalizeEngine(schema.engine))) {
    throw new Error(`ClickHouse rollup: requires a MergeTree-family engine, got '${schema.engine || 'MergeTree'}'`)
  }

  // Set of declared column names (expanding the virtual 'timestamps' type like the DDL path).
  const columns = schema.columns || {}
  const columnNames = new Set(Object.keys(columns))
  for (const def of Object.values(columns)) {
    if (def && def.type === 'timestamps') {
      columnNames.add('created_at')
      columnNames.add('updated_at')
    }
  }

  // time column
  if (typeof r.time !== 'string' || !r.time.trim()) {
    throw new Error(`ClickHouse rollup: 'time' (timestamp column) is required`)
  }
  const time = r.time.trim()
  if (!columnNames.has(time)) {
    throw new Error(`ClickHouse rollup: 'time' column '${time}' is not declared in columns`)
  }

  // leading non-time dimensions
  const by = r.by == null ? [] : r.by
  if (!Array.isArray(by)) throw new Error(`ClickHouse rollup: 'by' must be an array of column names`)
  for (const d of by) {
    if (typeof d !== 'string' || !columnNames.has(d)) {
      throw new Error(`ClickHouse rollup: 'by' column '${d}' is not declared in columns`)
    }
    if (d === time) throw new Error(`ClickHouse rollup: 'by' must not include the time column '${time}'`)
  }

  // sample-count column name (override via `count` or `samplesColumn`)
  const rawSamples = r.count || r.samplesColumn || 'samples'
  if (typeof rawSamples !== 'string' || !rawSamples.trim()) {
    throw new Error(`ClickHouse rollup: 'count'/'samplesColumn' must be a non-empty string`)
  }
  const samplesCol = rawSamples.trim()

  // tiers → classify into rollup / delete / reserve. A `reserve: true` tier carries no `olderThan`
  // and emits NO TTL — it only pre-registers its bucket in ORDER BY, so a later {olderThan, bucket}
  // activation of that granularity is a pure MODIFY TTL with no table recreate.
  if (!Array.isArray(r.tiers) || r.tiers.length === 0) {
    throw new Error(`ClickHouse rollup: 'tiers' must be a non-empty array`)
  }
  const rollupTiers = []
  const reserveBuckets = []
  let deleteTier = null

  r.tiers.forEach((tier, i) => {
    if (!tier || typeof tier !== 'object') throw new Error(`ClickHouse rollup: tier #${i + 1} must be an object`)
    const isReserve = tier.reserve === true
    const isDelete = tier.delete === true
    if (isReserve && isDelete) throw new Error(`ClickHouse rollup: tier #${i + 1} cannot be both 'reserve' and 'delete'`)

    if (isReserve) {
      if (tier.olderThan != null) {
        throw new Error(
          `ClickHouse rollup: a reserve tier ('${tier.bucket}') must not have 'olderThan' — it only pre-registers the ` +
            `bucket in ORDER BY; add 'olderThan' later to activate it (no table recreate needed)`
        )
      }
      if (typeof tier.bucket !== 'string' || !BUCKET_FUNCTIONS[tier.bucket]) {
        throw new Error(
          `ClickHouse rollup: reserve tier #${i + 1} has invalid bucket '${tier.bucket}' (allowed: ${Object.keys(BUCKET_FUNCTIONS).join(', ')})`
        )
      }
      reserveBuckets.push(tier.bucket)
      return
    }

    if (isDelete) {
      if (tier.bucket) throw new Error(`ClickHouse rollup: delete tier ('${tier.olderThan}') must not also specify a 'bucket'`)
      if (deleteTier) throw new Error(`ClickHouse rollup: only one delete tier is allowed`)
      deleteTier = {interval: parseInterval(tier.olderThan), isDelete: true}
      return
    }

    if (tier.olderThan == null) {
      throw new Error(`ClickHouse rollup: tier #${i + 1} needs an 'olderThan' (or mark it 'reserve: true' / 'delete: true')`)
    }
    if (typeof tier.bucket !== 'string' || !BUCKET_FUNCTIONS[tier.bucket]) {
      throw new Error(
        `ClickHouse rollup: tier '${tier.olderThan}' has invalid bucket '${tier.bucket}' (allowed: ${Object.keys(BUCKET_FUNCTIONS).join(', ')})`
      )
    }
    rollupTiers.push({interval: parseInterval(tier.olderThan), bucket: tier.bucket, isDelete: false})
  })

  if (rollupTiers.length === 0) throw new Error(`ClickHouse rollup: needs at least one non-delete tier with a bucket`)
  rollupTiers.sort((a, b) => a.interval.seconds - b.interval.seconds)

  // Buckets must coarsen (or stay equal) as data ages — a finer bucket on older data is nonsensical
  // and would break the ORDER BY prefix relationship the tiers depend on.
  for (let i = 1; i < rollupTiers.length; i++) {
    if (BUCKET_RANK[rollupTiers[i].bucket] < BUCKET_RANK[rollupTiers[i - 1].bucket]) {
      throw new Error(
        `ClickHouse rollup: buckets must get coarser (or equal) as data ages — ` +
          `'${rollupTiers[i - 1].bucket}' then '${rollupTiers[i].bucket}' goes finer`
      )
    }
  }

  // A reserve bucket a rollup tier already uses is redundant; reject it so the schema stays honest.
  const activeBuckets = new Set(rollupTiers.map(t => t.bucket))
  const seenReserve = new Set()
  for (const b of reserveBuckets) {
    if (activeBuckets.has(b)) throw new Error(`ClickHouse rollup: bucket '${b}' is already used by a rollup tier — drop the reserve entry`)
    if (seenReserve.has(b)) throw new Error(`ClickHouse rollup: bucket '${b}' is reserved more than once`)
    seenReserve.add(b)
  }

  // Age-ordered tiers that actually emit TTL (rollups + optional delete). Delete must be the oldest.
  const timedTiers = deleteTier ? [...rollupTiers, deleteTier].sort((a, b) => a.interval.seconds - b.interval.seconds) : rollupTiers
  if (deleteTier && !timedTiers[timedTiers.length - 1].isDelete) {
    throw new Error(`ClickHouse rollup: the delete tier must have the largest 'olderThan' (it purges what earlier tiers rolled up)`)
  }

  // Distinct buckets (active + reserved), coarse→fine — the tail of the derived ORDER BY. A reserved
  // bucket widens ORDER BY only: coarser ones ride along in every GROUP BY (redundant but harmless,
  // since a finer active bucket already determines them); finer ones stay out of every GROUP BY
  // until a future tier activates them.
  const distinctBuckets = [...new Set([...rollupTiers.map(t => t.bucket), ...reserveBuckets])].sort(
    (a, b) => BUCKET_RANK[b] - BUCKET_RANK[a]
  )
  const bucketExpr = b => `${BUCKET_FUNCTIONS[b]}(${time})`
  const derivedOrderBy = [...by, ...distinctBuckets.map(bucketExpr)]

  // A hand-written orderBy is honored only if it starts with the derived prefix (never silently
  // ignored) — otherwise a tier's GROUP BY would not be a primary-key prefix and CH would reject it.
  let orderBy = derivedOrderBy
  if (schema.orderBy != null) {
    const provided = Array.isArray(schema.orderBy) ? schema.orderBy : [schema.orderBy]
    const norm = s => String(s).replace(/\s+/g, '')
    const isPrefix = derivedOrderBy.every((el, i) => provided[i] != null && norm(provided[i]) === norm(el))
    if (!isPrefix) {
      throw new Error(
        `ClickHouse rollup: provided 'orderBy' [${provided.join(', ')}] must start with the derived ` +
          `rollup key prefix [${derivedOrderBy.join(', ')}] so every tier's GROUP BY is a primary-key prefix`
      )
    }
    orderBy = provided
  }

  // SET clause — validated aggregates, plus the always-summed sample count.
  const set = r.set || {}
  if (typeof set !== 'object' || Array.isArray(set)) {
    throw new Error(`ClickHouse rollup: 'set' must be an object of column -> aggregate function`)
  }
  const bySet = new Set(by)
  const setFragments = []
  for (const [col, fn] of Object.entries(set)) {
    if (!columnNames.has(col)) throw new Error(`ClickHouse rollup: 'set' column '${col}' is not declared in columns`)
    if (col === time) throw new Error(`ClickHouse rollup: 'set' must not aggregate the time column '${time}'`)
    if (bySet.has(col)) throw new Error(`ClickHouse rollup: 'set' must not include a 'by' dimension ('${col}' is a grouping key)`)
    if (col === samplesCol) {
      throw new Error(`ClickHouse rollup: 'set' must not include the samples column '${samplesCol}' (it is summed automatically)`)
    }
    const f = String(fn).toLowerCase()
    if (f === 'avg' || f === 'mean' || f === 'average') {
      throw new Error(
        `ClickHouse rollup: 'avg' is unsafe across tiers (avg-of-avg drifts). Use 'sum' and divide by '${samplesCol}' at read time.`
      )
    }
    if (!SET_FUNCTIONS.has(f)) {
      throw new Error(`ClickHouse rollup: unsupported aggregate '${fn}' for '${col}' (allowed: ${[...SET_FUNCTIONS].join(', ')})`)
    }
    setFragments.push(`${col} = ${f}(${col})`)
  }
  if (setFragments.length === 0) throw new Error(`ClickHouse rollup: 'set' needs at least one column to aggregate`)
  setFragments.push(`${samplesCol} = sum(${samplesCol})`)
  const setClause = setFragments.join(', ')

  // Emit tiers in age order: rollups as "time + INTERVAL … GROUP BY … SET …", delete as "… DELETE".
  // Reserve tiers emit nothing (they only shaped ORDER BY above).
  const parts = timedTiers.map(t => {
    if (t.isDelete) return `${time} + ${t.interval.text} DELETE`
    const depth = distinctBuckets.indexOf(t.bucket) + 1
    const groupBy = [...by, ...distinctBuckets.slice(0, depth).map(bucketExpr)]
    return `${time} + ${t.interval.text} GROUP BY ${groupBy.join(', ')} SET ${setClause}`
  })
  const ttl = parts.join(', ')

  // Inject the sample-count column (skip if the author already declared it).
  const outColumns = {...columns}
  if (!outColumns[samplesCol]) {
    outColumns[samplesCol] = {type: 'specificType', length: 'UInt64', default: 1}
  }

  const out = {...schema, orderBy, ttl, columns: outColumns}
  delete out.rollup
  return out
}

/**
 * Builds a complete CREATE TABLE IF NOT EXISTS statement for a ClickHouse table.
 * Clause order follows ClickHouse grammar: ENGINE → PARTITION BY → ORDER BY → TTL → SETTINGS.
 * @param {string} tableName
 * @param {object} schema - Full schema definition (columns + CH engine fields)
 * @returns {string} DDL statement
 */
function buildCreateTableDDL(tableName, rawSchema) {
  const schema = compileRollup(rawSchema)
  const fragments = buildColumnFragments(schema.columns)
  if (fragments.length === 0) {
    throw new Error(`ClickHouse: schema for '${tableName}' has no columns.`)
  }

  const engine = normalizeEngine(schema.engine)
  const lines = [
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (`,
    fragments.map(f => `  ${f}`).join(',\n'),
    `)`,
    `ENGINE = ${engine}`
  ]

  if (schema.partitionBy) lines.push(`PARTITION BY ${schema.partitionBy}`)

  const orderBy = orderByClause(schema.orderBy, engine)
  if (orderBy) lines.push(orderBy)

  const ttl = ttlTableClause(schema.ttl, engine)
  if (ttl) lines.push(ttl)

  if (schema.settings) lines.push(`SETTINGS ${schema.settings}`)

  return lines.join('\n')
}

/**
 * Builds an idempotent ADD COLUMN statement for an existing ClickHouse table.
 * @param {string} tableName
 * @param {string} colName
 * @param {object} def - Column definition
 * @returns {string} DDL statement
 */
function buildAddColumnDDL(tableName, colName, def) {
  return `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN IF NOT EXISTS ${columnFragment(colName, def)}`
}

module.exports = {
  DIALECT,
  quoteIdent,
  quoteLiteral,
  mapColumnType,
  defaultClause,
  ttlColumnClause,
  ttlTableClause,
  buildColumnFragments,
  buildCreateTableDDL,
  buildAddColumnDDL,
  normalizeEngine,
  isMergeTreeEngine,
  orderByClause,
  compileRollup
}

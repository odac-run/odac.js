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

/**
 * Renders the ORDER BY clause. MergeTree-family engines require one; tuple() (no sorting)
 * is the valid, non-throwing default when a schema omits `orderBy`.
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
  return `ORDER BY (${cols.map(quoteIdent).join(', ')})`
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

/**
 * Builds a complete CREATE TABLE IF NOT EXISTS statement for a ClickHouse table.
 * Clause order follows ClickHouse grammar: ENGINE → PARTITION BY → ORDER BY → TTL → SETTINGS.
 * @param {string} tableName
 * @param {object} schema - Full schema definition (columns + CH engine fields)
 * @returns {string} DDL statement
 */
function buildCreateTableDDL(tableName, schema) {
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
  orderByClause
}

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const nanoid = require('./nanoid')
const clickhouse = require('./ClickHouse')

/**
 * ODAC Migration Engine — "Schema-First with Auto-Diff"
 *
 * Why: AI agents and developers need a single source of truth for database state.
 * Instead of scanning hundreds of migration files, read `schema/` to know the final state.
 * The engine diffs desired state vs current DB state and applies changes automatically.
 */
class Migration {
  constructor() {
    this.schemaDir = null
    this.migrationDir = null
    this.connections = null
    this.trackingTable = '_odac_migrations'
  }

  /**
   * Initializes the migration engine with the project directory context.
   * @param {string} projectDir - Absolute path to the project root
   * @param {object} connections - DatabaseManager.connections map
   */
  init(projectDir, connections) {
    this.schemaDir = path.join(projectDir, 'schema')
    this.migrationDir = path.join(projectDir, 'migration')
    this.connections = connections
  }

  // ---------------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------------

  /**
   * Runs all pending migrations: schema diff + imperative migration files + seeds.
   * @param {object} options
   * @param {string} [options.db] - Target a specific connection key (default: all)
   * @param {boolean} [options.dryRun=false] - Only show changes, don't apply
   * @returns {Promise<object>} Summary of applied changes per connection
   */
  async migrate(options = {}) {
    const targetDb = options.db || null
    const dryRun = options.dryRun || false
    const summary = {}

    const connectionKeys = targetDb ? [targetDb] : Object.keys(this.connections)

    for (const key of connectionKeys) {
      const knex = this.connections[key]
      if (!knex) throw new Error(`ODAC Migration: Unknown database connection '${key}'.`)

      // ClickHouse (OLAP) diverges from the Knex schema-builder pipeline: it needs
      // engine-aware CREATE TABLE, has no FK/unique/index diffing, and is add-column only.
      if (this._dialect(knex) === clickhouse.DIALECT) {
        summary[key] = await this._migrateClickHouse(knex, key, dryRun)
        continue
      }

      await this._ensureTrackingTable(knex)

      const schemaChanges = await this._applySchemaChanges(knex, key, dryRun)
      const fileChanges = await this._applyMigrationFiles(knex, key, dryRun)
      const seedChanges = await this._applySeeds(knex, key, dryRun)

      summary[key] = {schema: schemaChanges, files: fileChanges, seeds: seedChanges}
    }

    return summary
  }

  /**
   * Resolves the dialect of a connection.
   * Why: ClickHouse connections are ClickHouseAdapter instances (not Knex) and carry an
   * `_odacDialect` marker; Knex connections expose it via `client.config.client`.
   * @param {object} conn - Connection (Knex instance or ClickHouseAdapter)
   * @returns {string} Dialect identifier ('clickhouse', 'pg', 'mysql2', 'sqlite3', …)
   */
  _dialect(conn) {
    return conn._odacDialect || conn.client?.config?.client || 'unknown'
  }

  /**
   * Shows pending changes without applying them.
   * @param {object} options
   * @param {string} [options.db] - Target a specific connection key
   * @returns {Promise<object>} Pending changes per connection
   */
  async status(options = {}) {
    return this.migrate({...options, dryRun: true})
  }

  /**
   * Rolls back the last batch of imperative migration files.
   * Schema changes are NOT rolled back (use schema files to revert).
   * @param {object} options
   * @param {string} [options.db] - Target a specific connection key
   * @returns {Promise<object>} Rolled-back migrations per connection
   */
  async rollback(options = {}) {
    const targetDb = options.db || null
    const result = {}

    const connectionKeys = targetDb ? [targetDb] : Object.keys(this.connections)

    for (const key of connectionKeys) {
      const knex = this.connections[key]
      if (!knex) throw new Error(`ODAC Migration: Unknown database connection '${key}'.`)

      // Rollback relies on DELETE from the tracking table; on ClickHouse a DELETE is a heavy
      // async mutation, and CH schema files are append-only. Rolling back is intentionally unsupported.
      if (this._dialect(knex) === clickhouse.DIALECT) {
        throw new Error(`ODAC Migration: rollback is not supported on ClickHouse connection '${key}'.`)
      }

      await this._ensureTrackingTable(knex)
      result[key] = await this._rollbackLastBatch(knex, key)
    }

    return result
  }

  /**
   * Reverse-engineers the current database into schema/ files.
   * @param {object} options
   * @param {string} [options.db] - Target a specific connection key
   * @returns {Promise<object>} Generated file paths per connection
   */
  async snapshot(options = {}) {
    const targetDb = options.db || null
    const result = {}

    const connectionKeys = targetDb ? [targetDb] : Object.keys(this.connections)

    for (const key of connectionKeys) {
      const knex = this.connections[key]
      if (!knex) throw new Error(`ODAC Migration: Unknown database connection '${key}'.`)

      // Snapshot reverse-maps DB types back to ODAC schema types; ClickHouse types and engine
      // metadata don't round-trip cleanly, so schema files stay the source of truth for CH.
      if (this._dialect(knex) === clickhouse.DIALECT) {
        throw new Error(`ODAC Migration: snapshot is not supported on ClickHouse connection '${key}'.`)
      }

      result[key] = await this._snapshotDatabase(knex, key)
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // SCHEMA DIFF PIPELINE
  // ---------------------------------------------------------------------------

  /**
   * Reads schema files, diffs against DB, and applies structural changes.
   * @param {object} knex - Knex connection instance
   * @param {string} connectionKey - Connection identifier
   * @param {boolean} dryRun - If true, only compute changes
   * @returns {Promise<Array>} List of applied operations
   */
  async _applySchemaChanges(knex, connectionKey, dryRun) {
    const desiredSchemas = this._loadSchemaFiles(connectionKey)
    const operations = []

    for (const [tableName, desired] of Object.entries(desiredSchemas)) {
      const exists = await knex.schema.hasTable(tableName)

      if (!exists) {
        const op = {type: 'create_table', table: tableName, columns: desired.columns, indexes: desired.indexes}
        operations.push(op)

        if (!dryRun) {
          await this._createTable(knex, tableName, desired)
        }
      } else {
        const currentColumns = await this._introspectColumns(knex, tableName)
        const currentIndexes = await this._introspectIndexes(knex, tableName)
        const currentForeignKeys = await this._introspectForeignKeys(knex, tableName)
        const diff = this._computeDiff(desired, currentColumns, currentIndexes, currentForeignKeys)

        if (diff.length > 0) {
          operations.push(...diff.map(d => ({...d, table: tableName})))

          if (!dryRun) {
            await this._applyDiff(knex, tableName, diff)
          }
        }
      }
    }

    return operations
  }

  /**
   * Loads and parses schema definition files from the schema/ directory.
   * Root-level files map to the 'default' connection.
   * Subdirectories map to named connections.
   * @param {string} connectionKey - Which connection to load schemas for
   * @returns {object} Map of tableName -> schema definition
   */
  _loadSchemaFiles(connectionKey) {
    const schemas = {}

    if (!fs.existsSync(this.schemaDir)) return schemas

    if (connectionKey === 'default') {
      const files = fs.readdirSync(this.schemaDir).filter(f => f.endsWith('.js') && fs.statSync(path.join(this.schemaDir, f)).isFile())
      for (const file of files) {
        const tableName = path.basename(file, '.js')
        const filePath = path.join(this.schemaDir, file)
        schemas[tableName] = this._normalizeSchema(this._requireSchema(filePath))
      }
    } else {
      const subDir = path.join(this.schemaDir, connectionKey)
      if (!fs.existsSync(subDir)) return schemas

      const files = fs.readdirSync(subDir).filter(f => f.endsWith('.js') && fs.statSync(path.join(subDir, f)).isFile())
      for (const file of files) {
        const tableName = path.basename(file, '.js')
        const filePath = path.join(subDir, file)
        schemas[tableName] = this._normalizeSchema(this._requireSchema(filePath))
      }
    }

    return schemas
  }

  /**
   * Why: Column-level `unique: true` creates a DB constraint during CREATE but is
   * invisible to the diff engine's index comparison. This caused two bugs:
   *   1. Silent constraint DROP on subsequent runs (not in desiredIndexes).
   *   2. Duplicate constraint ADD if also listed explicitly in indexes array.
   * Normalizing once at load time gives every downstream path (create, diff, apply)
   * a single, deduplicated source of truth for indexes.
   * @param {object} schema - Raw schema definition from file
   * @returns {object} Schema with column-level unique constraints merged into indexes
   */
  _normalizeSchema(schema) {
    const columns = schema.columns || {}
    const indexes = [...(schema.indexes || [])]
    const existingSignatures = new Set(indexes.map(idx => this._indexSignature(idx)))

    for (const [colName, colDef] of Object.entries(columns)) {
      if (!colDef.unique) continue
      if (colDef.type === 'timestamps' || colDef.type === 'increments' || colDef.type === 'bigIncrements' || colDef.type === 'nanoid')
        continue

      const implicitIdx = {columns: [colName], unique: true}
      const sig = this._indexSignature(implicitIdx)

      if (!existingSignatures.has(sig)) {
        indexes.push(implicitIdx)
        existingSignatures.add(sig)
      }
    }

    return {...schema, indexes}
  }

  /**
   * Loads a schema/migration file from disk without relying on require.cache.
   * Why: Node's require cache (and Jest's module registry) can serve stale modules
   * when files are overwritten at the same path. Reading raw source avoids this.
   * @param {string} filePath - Absolute path to schema file
   * @returns {object} Parsed module exports
   */
  _requireSchema(filePath) {
    const Module = require('node:module')
    const source = fs.readFileSync(filePath, 'utf8')
    const m = new Module(filePath)
    m.filename = filePath
    m.paths = Module._nodeModulePaths(path.dirname(filePath))
    m._compile(source, filePath)
    return m.exports
  }

  // ---------------------------------------------------------------------------
  // INTROSPECTION — Read current DB state
  // ---------------------------------------------------------------------------

  /**
   * Reads column metadata from the database for a given table.
   * Uses knex.columnInfo() augmented with raw queries for precision.
   * @param {object} knex - Knex connection instance
   * @param {string} tableName - Table to introspect
   * @returns {Promise<object>} Normalized column map
   */
  async _introspectColumns(knex, tableName) {
    const info = await knex(tableName).columnInfo()
    const columns = {}

    for (const [colName, meta] of Object.entries(info)) {
      columns[colName] = {
        type: meta.type,
        maxLength: meta.maxLength,
        nullable: meta.nullable,
        defaultValue: meta.defaultValue
      }
    }

    return columns
  }

  /**
   * Reads index metadata from the database for a given table.
   * Supports MySQL, PostgreSQL, and SQLite.
   * @param {object} knex - Knex connection instance
   * @param {string} tableName - Table to introspect
   * @returns {Promise<Array>} Normalized index list
   */
  async _introspectIndexes(knex, tableName) {
    const client = knex.client.config.client

    if (client === 'mysql2' || client === 'mysql') {
      return this._introspectIndexesMySQL(knex, tableName)
    } else if (client === 'pg') {
      return this._introspectIndexesPG(knex, tableName)
    } else if (client === 'sqlite3') {
      return this._introspectIndexesSQLite(knex, tableName)
    }

    return []
  }

  async _introspectIndexesMySQL(knex, tableName) {
    const [rows] = await knex.raw('SHOW INDEX FROM ??', [tableName])
    const indexMap = {}

    for (const row of rows) {
      const name = row.Key_name
      if (name === 'PRIMARY') continue

      if (!indexMap[name]) {
        indexMap[name] = {
          name,
          columns: [],
          unique: !row.Non_unique
        }
      }
      indexMap[name].columns.push(row.Column_name)
    }

    return Object.values(indexMap)
  }

  /**
   * Why: The previous pg_class + pg_index + pg_attribute + int2vector::int[] cast
   * approach broke across PostgreSQL versions and non-default search_path configs.
   * pg_indexes is a stable, high-level view that works reliably across all PG
   * versions (9.1+) without manual type casting or complex joins.
   * We parse column names from the index definition using a regex to avoid all
   * low-level catalog compatibility issues.
   * @param {object} knex - Knex connection instance
   * @param {string} tableName - Table to introspect
   * @returns {Promise<Array>} Normalized index list
   */
  async _introspectIndexesPG(knex, tableName) {
    const result = await knex.raw(
      `
      SELECT
        i.relname  AS index_name,
        ix.indisunique AS is_unique,
        array_agg(a.attname ORDER BY a.attnum) AS columns
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = ?
        AND n.nspname = current_schema()
        AND ix.indisprimary = false
        AND a.attnum > 0
      GROUP BY i.relname, ix.indisunique
    `,
      [tableName]
    )

    return result.rows.map(row => ({
      name: row.index_name,
      columns: Array.isArray(row.columns) ? row.columns : [],
      unique: !!row.is_unique
    }))
  }

  async _introspectIndexesSQLite(knex, tableName) {
    const safeTableName = this._quoteSQLiteIdentifier(tableName)
    const rawIndexes = await knex.raw(`PRAGMA index_list(${safeTableName})`)
    const indexes = Array.isArray(rawIndexes) ? rawIndexes : []
    const result = []

    for (const idx of indexes) {
      if (idx.origin === 'pk') continue
      // Skip auto-generated unique constraint indexes (created by Knex .unique())
      // These have origin='c' but we still track them since they are user-defined

      const safeIndexName = this._quoteSQLiteIdentifier(idx.name)
      const rawCols = await knex.raw(`PRAGMA index_info(${safeIndexName})`)
      const cols = Array.isArray(rawCols) ? rawCols : []
      result.push({
        name: idx.name,
        columns: cols.map(c => c.name),
        unique: !!idx.unique
      })
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // FOREIGN KEY INTROSPECTION
  // ---------------------------------------------------------------------------

  /**
   * Introspects existing foreign key constraints for a given table.
   * Why: The diff engine needs current FK state to detect when a schema adds, changes,
   * or removes a `references` / `onDelete` / `onUpdate` definition on an existing column.
   * @param {object} knex - Knex instance
   * @param {string} tableName - Table to introspect
   * @returns {Promise<Object>} Map of columnName -> {table, column, onDelete, onUpdate}
   */
  async _introspectForeignKeys(knex, tableName) {
    const client = knex.client.config.client
    const fks = {}

    if (client === 'pg') {
      const result = await knex.raw(
        `SELECT
           kcu.column_name,
           ccu.table_name  AS foreign_table,
           ccu.column_name AS foreign_column,
           rc.delete_rule,
           rc.update_rule,
           tc.constraint_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
         JOIN information_schema.referential_constraints rc
           ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ?`,
        [tableName]
      )
      for (const row of result.rows) {
        fks[row.column_name] = {
          table: row.foreign_table,
          column: row.foreign_column,
          onDelete: (row.delete_rule || 'NO ACTION').toUpperCase(),
          onUpdate: (row.update_rule || 'NO ACTION').toUpperCase(),
          constraintName: row.constraint_name
        }
      }
    } else if (client === 'mysql2' || client === 'mysql') {
      const [rows] = await knex.raw(
        `SELECT
           kcu.COLUMN_NAME          AS column_name,
           kcu.REFERENCED_TABLE_NAME AS foreign_table,
           kcu.REFERENCED_COLUMN_NAME AS foreign_column,
           rc.DELETE_RULE            AS delete_rule,
           rc.UPDATE_RULE            AS update_rule,
           kcu.CONSTRAINT_NAME       AS constraint_name
         FROM information_schema.KEY_COLUMN_USAGE kcu
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
         WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
        [tableName]
      )
      for (const row of rows) {
        fks[row.column_name] = {
          table: row.foreign_table,
          column: row.foreign_column,
          onDelete: (row.delete_rule || 'NO ACTION').toUpperCase(),
          onUpdate: (row.update_rule || 'NO ACTION').toUpperCase(),
          constraintName: row.constraint_name
        }
      }
    } else if (client === 'sqlite3') {
      const result = await knex.raw(`PRAGMA foreign_key_list('${tableName}')`)
      const rows = Array.isArray(result) ? result : []
      for (const row of rows) {
        fks[row.from] = {
          table: row.table,
          column: row.to,
          onDelete: (row.on_delete || 'NO ACTION').toUpperCase(),
          onUpdate: (row.on_update || 'NO ACTION').toUpperCase(),
          constraintName: null
        }
      }
    }

    return fks
  }

  // ---------------------------------------------------------------------------
  // DIFF ENGINE — Compute desired vs current delta
  // ---------------------------------------------------------------------------

  /**
   * Computes the structural diff between desired schema and current DB state.
   * Produces a list of atomic operations to reconcile the two.
   * @param {object} desired - Schema definition from file
   * @param {object} currentColumns - Introspected column map
   * @param {Array} currentIndexes - Introspected index list
   * @returns {Array} Ordered list of diff operations
   */
  _computeDiff(desired, currentColumns, currentIndexes, currentForeignKeys = {}) {
    const ops = []
    const desiredColumns = desired.columns || {}
    const desiredIndexes = desired.indexes || []
    const currentColNames = Object.keys(currentColumns)

    // --- Column additions ---
    for (const [colName, colDef] of Object.entries(desiredColumns)) {
      if (colDef.type === 'timestamps') continue // Virtual type handled separately
      if (!currentColumns[colName]) {
        ops.push({type: 'add_column', column: colName, definition: colDef})
      }
    }

    // Handle timestamps virtual type
    if (this._hasTimestamps(desiredColumns)) {
      if (!currentColumns['created_at']) {
        ops.push({type: 'add_column', column: 'created_at', definition: {type: 'timestamp'}})
      }
      if (!currentColumns['updated_at']) {
        ops.push({type: 'add_column', column: 'updated_at', definition: {type: 'timestamp'}})
      }
    }

    // --- Column removals ---
    const desiredColNames = new Set()
    for (const [colName, colDef] of Object.entries(desiredColumns)) {
      if (colDef.type === 'timestamps') {
        desiredColNames.add('created_at')
        desiredColNames.add('updated_at')
      } else {
        desiredColNames.add(colName)
      }
    }

    for (const colName of currentColNames) {
      if (!desiredColNames.has(colName)) {
        ops.push({type: 'drop_column', column: colName})
      }
    }

    // --- Column modifications ---
    for (const [colName, colDef] of Object.entries(desiredColumns)) {
      if (colDef.type === 'timestamps' || colDef.type === 'increments') continue
      if (!currentColumns[colName]) continue // New column, handled above

      if (this._columnNeedsAlter(colDef, currentColumns[colName])) {
        ops.push({type: 'alter_column', column: colName, definition: colDef, currentNullable: currentColumns[colName].nullable})
      }
    }

    // --- Foreign key synchronization ---
    for (const [colName, colDef] of Object.entries(desiredColumns)) {
      if (colDef.type === 'timestamps') continue
      if (!currentColumns[colName]) continue // New column — _addColumn handles FK

      const desiredRef = colDef.references || null
      const currentFK = currentForeignKeys[colName] || null
      const desiredOnDelete = (colDef.onDelete || 'NO ACTION').toUpperCase()
      const desiredOnUpdate = (colDef.onUpdate || 'NO ACTION').toUpperCase()

      if (desiredRef && !currentFK) {
        // FK added to existing column
        ops.push({type: 'add_foreign_key', column: colName, definition: colDef})
      } else if (!desiredRef && currentFK) {
        // FK removed from schema
        ops.push({type: 'drop_foreign_key', column: colName, constraintName: currentFK.constraintName})
      } else if (desiredRef && currentFK) {
        // FK exists — check if target table/column or actions changed
        const targetChanged = desiredRef.table !== currentFK.table || desiredRef.column !== currentFK.column
        const actionChanged = desiredOnDelete !== currentFK.onDelete || desiredOnUpdate !== currentFK.onUpdate

        if (targetChanged || actionChanged) {
          ops.push({type: 'drop_foreign_key', column: colName, constraintName: currentFK.constraintName})
          ops.push({type: 'add_foreign_key', column: colName, definition: colDef})
        }
      }
    }

    // --- Index synchronization ---
    const desiredIndexSignatures = new Set(desiredIndexes.map(idx => this._indexSignature(idx)))
    const currentIndexSignatures = new Set(currentIndexes.map(idx => this._indexSignature(idx)))

    // Indexes to add
    for (const idx of desiredIndexes) {
      const sig = this._indexSignature(idx)
      if (!currentIndexSignatures.has(sig)) {
        ops.push({type: 'add_index', index: idx})
      }
    }

    // Indexes to drop
    for (const idx of currentIndexes) {
      const sig = this._indexSignature(idx)
      if (!desiredIndexSignatures.has(sig)) {
        ops.push({type: 'drop_index', index: idx})
      }
    }

    return ops
  }

  /**
   * Checks if a column definition differs from the current DB metadata enough to warrant ALTER.
   * Conservative: only alters when there is a clear type or constraint mismatch.
   * Why: Without type comparison, changing a column from e.g. 'string' to 'text' in the
   * schema file would be silently ignored — the DB would never receive the ALTER.
   * @param {object} desired - Column definition from schema file
   * @param {object} current - Column metadata from introspection
   * @returns {boolean}
   */
  _columnNeedsAlter(desired, current) {
    // Type mismatch — map the raw DB type back to an ODAC type and compare.
    // nanoid is stored as 'string' (varchar) in the DB, so normalize before comparison.
    // specificType uses the raw DB type directly (def.length holds the actual PG type),
    // so compare against the raw introspected type instead of reverse-mapping.
    if (desired.type === 'specificType') {
      const rawDesired = (desired.length || '').toLowerCase().trim()
      const rawCurrent = (current.type || '').toLowerCase().trim()
      if (rawDesired !== rawCurrent) return true
    } else {
      const desiredType = desired.type === 'nanoid' ? 'string' : desired.type
      const currentType = this._reverseMapType(current.type)
      if (desiredType !== currentType) return true
    }

    // Nullable mismatch
    if (desired.nullable === false && current.nullable === true) return true
    if (desired.nullable === true && current.nullable === false) return true

    // Length mismatch for string types — use Number() coercion since some
    // drivers (SQLite) return maxLength as a string, e.g. '100' vs 100.
    if (desired.type !== 'specificType' && desired.length && current.maxLength && Number(desired.length) !== Number(current.maxLength))
      return true

    // Default value mismatch — normalize both sides before comparing because
    // drivers return defaults as strings (e.g. "'active'" in PG, "active" in SQLite).
    const desiredDefault = desired.default !== undefined ? this._normalizeDefaultValue(desired.default) : null
    const currentDefault =
      current.defaultValue !== undefined && current.defaultValue !== null ? this._normalizeDefaultValue(current.defaultValue) : null

    if (desiredDefault !== currentDefault) return true

    return false
  }

  /**
   * Normalizes a column default value to a canonical string for cross-driver comparison.
   * Why: Each DB driver serializes defaults differently — PG wraps strings in single quotes
   * and appends type casts (e.g. `'active'::character varying`), SQLite returns raw values,
   * MySQL returns unquoted strings. Stripping quotes and casts gives a stable comparison key.
   * @param {*} value - Raw default value from schema definition or DB introspection
   * @returns {string} Normalized string representation
   */
  _normalizeDefaultValue(value) {
    if (value === null || value === undefined) return 'null'

    let str = String(value)

    // Strip PG type cast suffix: 'foo'::character varying → 'foo'
    str = str.replace(/::[\w\s]+$/, '')

    // Strip surrounding single quotes added by PG/MySQL: 'foo' → foo
    if (str.startsWith("'") && str.endsWith("'")) {
      str = str.slice(1, -1)
    }

    return str.trim().toLowerCase()
  }

  /**
   * Generates a deterministic signature for an index to enable set comparison.
   * @param {object} idx - Index definition {columns, unique}
   * @returns {string} Canonical signature string
   */
  _indexSignature(idx) {
    const cols = [...idx.columns].sort().join(',')
    return `${idx.unique ? 'U' : 'I'}:${cols}`
  }

  /**
   * Checks if the desired columns include a 'timestamps' virtual type.
   * @param {object} columns - Desired column definitions
   * @returns {boolean}
   */
  _hasTimestamps(columns) {
    for (const colDef of Object.values(columns)) {
      if (colDef.type === 'timestamps') return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // APPLY CHANGES — Execute DDL operations
  // ---------------------------------------------------------------------------

  /**
   * Creates a new table from a schema definition.
   * @param {object} knex - Knex connection instance
   * @param {string} tableName - Table name
   * @param {object} schema - Full schema definition
   */
  async _createTable(knex, tableName, schema) {
    await knex.schema.createTable(tableName, table => {
      this._buildColumns(knex, table, schema.columns)
      this._buildIndexes(table, schema.indexes)
    })
  }

  /**
   * Applies a list of diff operations to an existing table.
   * Why split into two phases: Knex wraps all alterTable operations into a single
   * statement batch. If one index DDL fails (e.g. "already exists" due to introspection
   * gaps across PG versions), the entire batch — including column changes — is aborted.
   * Phase 1 handles column ops in a single alterTable. Phase 2 handles index ops
   * individually with idempotent error handling so duplicate/missing index errors
   * never crash the migration pipeline.
   * @param {object} knex - Knex connection instance
   * @param {string} tableName - Table name
   * @param {Array} diff - List of operations from _computeDiff
   */
  async _applyDiff(knex, tableName, diff) {
    const columnOps = diff.filter(op => op.type === 'add_column' || op.type === 'drop_column' || op.type === 'alter_column')
    const indexOps = diff.filter(op => op.type === 'add_index' || op.type === 'drop_index')
    const fkOps = diff.filter(op => op.type === 'add_foreign_key' || op.type === 'drop_foreign_key')

    // Separate primary key alter ops — PostgreSQL's ALTER COLUMN via Knex emits
    // DROP NOT NULL before SET NOT NULL, which PG rejects on PK columns (42P16).
    // These must be handled with raw ALTER COLUMN ... TYPE ... USING instead.
    const isPG = knex.client?.config?.client === 'pg' || knex.client?.config?.client === 'postgresql'
    const pkAlterOps = isPG ? columnOps.filter(op => op.type === 'alter_column' && op.definition.primary) : []
    const batchOps = isPG ? columnOps.filter(op => !(op.type === 'alter_column' && op.definition.primary)) : columnOps

    // Phase 1a: Batch column operations (non-PK alters + adds + drops)
    if (batchOps.length > 0) {
      await knex.schema.alterTable(tableName, table => {
        for (const op of batchOps) {
          switch (op.type) {
            case 'add_column':
              this._addColumn(knex, table, op.column, op.definition)
              break
            case 'drop_column':
              table.dropColumn(op.column)
              break
            case 'alter_column':
              this._alterColumn(knex, table, op.column, op.definition, op.currentNullable)
              break
          }
        }
      })
    }

    // Phase 1b: Primary key column type changes on PostgreSQL — raw SQL.
    // Why: Knex .alter() generates "DROP NOT NULL" + "SET NOT NULL" sequence,
    // but PG forbids DROP NOT NULL on primary key columns. Raw ALTER COLUMN TYPE
    // changes the type without touching the NOT NULL constraint.
    for (const op of pkAlterOps) {
      const sqlType = this._pgColumnType(op.definition)
      await knex.raw(`ALTER TABLE ?? ALTER COLUMN ?? TYPE ${sqlType} USING ??::${sqlType}`, [tableName, op.column, op.column])

      // Apply default value change if specified
      if (op.definition.default !== undefined) {
        const lower = String(op.definition.default).toLowerCase().trim()
        if (lower === 'now()' || lower === 'current_timestamp' || lower === 'current_timestamp()') {
          await knex.raw(`ALTER TABLE ?? ALTER COLUMN ?? SET DEFAULT ${lower}`, [tableName, op.column])
        } else {
          await knex.raw(`ALTER TABLE ?? ALTER COLUMN ?? SET DEFAULT ?`, [tableName, op.column, op.definition.default])
        }
      }
    }

    // Phase 2: Foreign key operations — drop before add to handle replacements
    for (const op of fkOps) {
      if (op.type === 'drop_foreign_key') {
        await this._applyForeignKeyOp(knex, tableName, op)
      }
    }
    for (const op of fkOps) {
      if (op.type === 'add_foreign_key') {
        await this._applyForeignKeyOp(knex, tableName, op)
      }
    }

    // Phase 3: Index operations — each applied individually for idempotent safety
    for (const op of indexOps) {
      await this._applyIndexOp(knex, tableName, op)
    }
  }

  /**
   * Maps an ODAC column definition to a PostgreSQL type string for raw ALTER COLUMN TYPE.
   * @param {object} def - Column definition from schema
   * @returns {string} PostgreSQL type name
   */
  _pgColumnType(def) {
    switch (def.type) {
      case 'nanoid':
      case 'string':
        return `varchar(${def.length || (def.type === 'nanoid' ? 21 : 255)})`
      case 'text':
        return 'text'
      case 'integer':
        return 'integer'
      case 'bigInteger':
        return 'bigint'
      case 'boolean':
        return 'boolean'
      case 'float':
        return 'double precision'
      case 'decimal':
        return `numeric(${def.precision || 10},${def.scale || 2})`
      case 'uuid':
        return 'uuid'
      case 'json':
        return 'json'
      case 'jsonb':
        return 'jsonb'
      case 'timestamp':
        return 'timestamp'
      case 'datetime':
        return 'timestamp'
      case 'date':
        return 'date'
      case 'time':
        return 'time'
      case 'binary':
        return 'bytea'
      case 'specificType':
        return def.length || def.specificType || def.type
      default:
        return def.type
    }
  }

  /**
   * Why: PostgreSQL introspection can miss existing constraints across PG versions
   * (int2vector cast edge cases, search_path mismatches, expression indexes).
   * Rather than silently crashing the entire migration, we catch "already exists"
   * (42P07) and "does not exist" (42704/3F000) errors that indicate the DB is
   * already in the desired state.
   * @param {object} knex - Knex connection instance
   * @param {string} tableName - Table name
   * @param {object} op - Single index diff operation
   */
  async _applyIndexOp(knex, tableName, op) {
    try {
      if (op.type === 'add_index') {
        await knex.schema.alterTable(tableName, table => {
          if (op.index.unique) {
            table.unique(op.index.columns)
          } else {
            table.index(op.index.columns)
          }
        })
      } else if (op.type === 'drop_index') {
        await knex.schema.alterTable(tableName, table => {
          if (op.index.unique) {
            table.dropUnique(op.index.columns)
          } else {
            table.dropIndex(op.index.columns)
          }
        })
      }
    } catch (e) {
      const isDuplicate = e.code === '42P07' || e.code === 'ER_DUP_KEYNAME' || (e.message && e.message.includes('already exists'))
      const isNotFound = e.code === '42704' || e.code === '3F000' || (e.message && e.message.includes('does not exist'))

      if ((op.type === 'add_index' && isDuplicate) || (op.type === 'drop_index' && isNotFound)) {
        // DB is already in the desired state — safe no-op
        return
      }

      throw e
    }
  }

  /**
   * Applies a single foreign key add/drop operation with idempotent error handling.
   * Why: Knex's col.alter() cannot manage FK constraints — they require table-level
   * alterTable calls (add .foreign() / drop .dropForeign()) which are separate from column ops.
   * @param {object} knex - Knex instance
   * @param {string} tableName - Target table
   * @param {object} op - FK operation {type, column, definition?, constraintName?}
   */
  async _applyForeignKeyOp(knex, tableName, op) {
    try {
      if (op.type === 'add_foreign_key') {
        const ref = op.definition.references

        // Clean orphan rows before adding constraint — existing data may reference
        // rows that no longer exist in the parent table, which would cause PG error 23503.
        // Nullable columns get SET NULL safely. Non-nullable columns are NOT deleted —
        // instead the constraint is skipped with a warning to prevent silent data loss.
        const orphanCondition = knex(tableName).whereNotIn(op.column, knex(ref.table).select(ref.column)).whereNotNull(op.column)

        if (op.definition.nullable !== false) {
          await orphanCondition.update({[op.column]: null})
        } else {
          const [{count: orphanCount}] = await orphanCondition.clone().count('* as count')

          if (Number(orphanCount) > 0) {
            console.error(
              `\x1b[31m[ODAC Migration]\x1b[0m Skipping foreign key on "${tableName}.${op.column}" → ` +
                `"${ref.table}.${ref.column}": ${orphanCount} orphan row(s) found. ` +
                `Column is NOT NULL so rows cannot be nullified. ` +
                `Clean the data manually and restart, or make the column nullable.`
            )
            return
          }
        }

        await knex.schema.alterTable(tableName, table => {
          const fk = table.foreign(op.column).references(ref.column).inTable(ref.table)
          if (op.definition.onDelete) fk.onDelete(op.definition.onDelete)
          if (op.definition.onUpdate) fk.onUpdate(op.definition.onUpdate)
        })
      } else if (op.type === 'drop_foreign_key') {
        await knex.schema.alterTable(tableName, table => {
          table.dropForeign(op.column)
        })
      }
    } catch (e) {
      const isDuplicate = e.message && (e.message.includes('already exists') || e.code === '42710')
      const isNotFound = e.message && (e.message.includes('does not exist') || e.code === '42704')

      if ((op.type === 'add_foreign_key' && isDuplicate) || (op.type === 'drop_foreign_key' && isNotFound)) {
        return
      }

      throw e
    }
  }

  /**
   * Translates schema column definitions into Knex schema builder calls.
   * Supports all common column types with their modifiers.
   * @param {object} table - Knex TableBuilder instance
   * @param {object} columns - Column definition map
   */
  /**
   * Resolves a column default value, wrapping special SQL keywords in knex.raw().
   * Why: Knex.defaultTo() quotes string values by default. For keywords like
   * CURRENT_TIMESTAMP, this results in 'CURRENT_TIMESTAMP' which MySQL rejects.
   * Wrapping in knex.raw() ensures the keyword is emitted without quotes.
   * @param {object} knex - Knex instance
   * @param {*} value - Raw default value from schema
   * @returns {*} Resolved value (possibly knex.raw)
   */
  _resolveDefault(knex, value) {
    if (typeof value !== 'string') return value

    const lower = value.toLowerCase().trim()
    if (lower === 'current_timestamp' || lower === 'current_timestamp()' || lower === 'now()') {
      return knex.raw(value)
    }

    return value
  }

  _buildColumns(knex, table, columns) {
    if (!columns) return

    for (const [colName, def] of Object.entries(columns)) {
      if (def.type === 'timestamps') {
        table.timestamps(true, true)
        continue
      }

      const col = this._createColumnBuilder(table, colName, def)
      if (!col) continue

      if (def.nullable === false) col.notNullable()
      else if (def.nullable === true) col.nullable()

      if (def.default !== undefined) col.defaultTo(this._resolveDefault(knex, def.default))
      if (def.unsigned) col.unsigned()
      // Column-level unique is handled via _normalizeSchema → _buildIndexes.
      // Applying it here as well would create duplicate constraints.
      if (def.primary) col.primary()
      if (def.references) col.references(def.references.column).inTable(def.references.table)
      if (def.onDelete) col.onDelete(def.onDelete)
      if (def.onUpdate) col.onUpdate(def.onUpdate)
      if (def.comment) col.comment(def.comment)
    }
  }

  /**
   * Creates a Knex column builder call for a given type.
   * @param {object} table - Knex TableBuilder
   * @param {string} colName - Column name
   * @param {object} def - Column definition
   * @returns {object|null} Knex ColumnBuilder or null
   */
  _createColumnBuilder(table, colName, def) {
    switch (def.type) {
      case 'increments':
        return table.increments(colName)
      case 'bigIncrements':
        return table.bigIncrements(colName)
      case 'integer':
        return table.integer(colName)
      case 'bigInteger':
        return table.bigInteger(colName)
      case 'float':
        return table.float(colName, def.precision, def.scale)
      case 'decimal':
        return table.decimal(colName, def.precision || 10, def.scale || 2)
      case 'string':
        return table.string(colName, def.length || 255)
      case 'text':
        return table.text(colName, def.textType || 'text')
      case 'boolean':
        return table.boolean(colName)
      case 'date':
        return table.date(colName)
      case 'datetime':
        return table.datetime(colName)
      case 'timestamp':
        return table.timestamp(colName)
      case 'time':
        return table.time(colName)
      case 'binary':
        return table.binary(colName, def.length)
      case 'json':
        return table.json(colName)
      case 'jsonb':
        return table.jsonb(colName)
      case 'nanoid':
        return table.string(colName, def.length || 21)
      case 'uuid':
        return table.uuid(colName)
      case 'enum':
        return table.enum(colName, def.values || [])
      case 'specificType':
        return table.specificType(colName, def.length || def.specificType || def.type)
      default:
        return table.specificType(colName, def.type)
    }
  }

  /**
   * Builds index definitions on a table during creation.
   * @param {object} table - Knex TableBuilder
   * @param {Array} indexes - Index definition array
   */
  _buildIndexes(table, indexes) {
    if (!indexes || !Array.isArray(indexes)) return

    for (const idx of indexes) {
      if (idx.unique) {
        table.unique(idx.columns)
      } else {
        table.index(idx.columns)
      }
    }
  }

  /**
   * Adds a single column to an existing table via ALTER.
   * @param {object} table - Knex TableBuilder (alter context)
   * @param {string} colName - Column name
   * @param {object} def - Column definition
   */
  _addColumn(knex, table, colName, def) {
    const col = this._createColumnBuilder(table, colName, def)
    if (!col) return

    if (def.nullable === false) col.notNullable()
    else col.nullable()

    if (def.default !== undefined) col.defaultTo(this._resolveDefault(knex, def.default))
    if (def.unsigned) col.unsigned()
    if (def.references) col.references(def.references.column).inTable(def.references.table)
    if (def.onDelete) col.onDelete(def.onDelete)
    if (def.onUpdate) col.onUpdate(def.onUpdate)
  }

  /**
   * Alters an existing column to match the desired definition.
   * @param {object} table - Knex TableBuilder (alter context)
   * @param {string} colName - Column name
   * @param {object} def - Column definition
   */
  _alterColumn(knex, table, colName, def, currentNullable) {
    const col = this._createColumnBuilder(table, colName, def)
    if (!col) return

    // Knex .alter() defaults to nullable when no explicit nullable/notNullable is set,
    // which generates "ALTER COLUMN ... DROP NOT NULL" — PostgreSQL rejects this on
    // primary key columns (error 42P16). When the schema doesn't specify nullable,
    // preserve the column's current DB state to avoid destructive no-op alterations.
    if (def.nullable === false) col.notNullable()
    else if (def.nullable === true) col.nullable()
    else if (currentNullable === false) col.notNullable()
    else if (currentNullable === true) col.nullable()

    if (def.default !== undefined) col.defaultTo(this._resolveDefault(knex, def.default))

    col.alter()
  }

  // ---------------------------------------------------------------------------
  // IMPERATIVE MIGRATION FILES
  // ---------------------------------------------------------------------------

  /**
   * Runs pending imperative migration files (developer-written data migrations).
   * @param {object} knex - Knex connection instance
   * @param {string} connectionKey - Connection identifier
   * @param {boolean} dryRun - If true, only list pending files
   * @returns {Promise<Array>} Applied migration file names
   */
  async _applyMigrationFiles(knex, connectionKey, dryRun) {
    const migrationFiles = this._loadMigrationFiles(connectionKey)
    if (migrationFiles.length === 0) return []

    const applied = await knex(this.trackingTable).where('connection', connectionKey).where('type', 'file').select('name')

    const appliedNames = new Set(applied.map(r => r.name))
    const pending = migrationFiles.filter(f => !appliedNames.has(f.name))

    if (dryRun) {
      return pending.map(f => ({type: 'pending_file', name: f.name}))
    }

    // Determine the next batch number
    const lastBatch = await knex(this.trackingTable).where('connection', connectionKey).max('batch as maxBatch').first()
    const batch = (lastBatch?.maxBatch || 0) + 1

    const results = []

    for (const file of pending) {
      const migration = this._requireSchema(file.path)

      if (typeof migration.up !== 'function') {
        throw new Error(`ODAC Migration: File '${file.name}' is missing an 'up' function.`)
      }

      await migration.up(knex)

      await knex(this.trackingTable).insert({
        name: file.name,
        connection: connectionKey,
        type: 'file',
        batch,
        applied_at: new Date()
      })

      results.push({type: 'applied_file', name: file.name})
    }

    return results
  }

  /**
   * Loads imperative migration files sorted by filename (timestamp order).
   * @param {string} connectionKey - Connection identifier
   * @returns {Array<{name: string, path: string}>} Sorted migration file descriptors
   */
  _loadMigrationFiles(connectionKey) {
    let dir

    if (connectionKey === 'default') {
      dir = this.migrationDir
    } else {
      dir = path.join(this.migrationDir, connectionKey)
    }

    if (!fs.existsSync(dir)) return []

    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.js') && !fs.statSync(path.join(dir, f)).isDirectory())
      .sort()
      .map(f => ({name: f, path: path.join(dir, f)}))
  }

  /**
   * Rolls back the last batch of imperative migration files.
   * @param {object} knex - Knex connection instance
   * @param {string} connectionKey - Connection identifier
   * @returns {Promise<Array>} Rolled-back migration names
   */
  async _rollbackLastBatch(knex, connectionKey) {
    const lastBatch = await knex(this.trackingTable)
      .where('connection', connectionKey)
      .where('type', 'file')
      .max('batch as maxBatch')
      .first()

    if (!lastBatch?.maxBatch) return []

    const migrations = await knex(this.trackingTable)
      .where('connection', connectionKey)
      .where('type', 'file')
      .where('batch', lastBatch.maxBatch)
      .orderBy('name', 'desc')
      .select('name')

    const results = []

    for (const row of migrations) {
      const filePath = this._resolveMigrationFilePath(connectionKey, row.name)
      if (!filePath) continue

      const migration = this._requireSchema(filePath)

      if (typeof migration.down === 'function') {
        await migration.down(knex)
      }

      await knex(this.trackingTable).where('connection', connectionKey).where('name', row.name).where('type', 'file').del()

      results.push({type: 'rolled_back', name: row.name})
    }

    return results
  }

  /**
   * Resolves the absolute file path for a migration file by name.
   * @param {string} connectionKey - Connection identifier
   * @param {string} name - Migration file name (e.g. '20260225_001_auto.js')
   * @returns {string|null} Absolute path or null if not found
   */
  _resolveMigrationFilePath(connectionKey, name) {
    const dir = connectionKey === 'default' ? this.migrationDir : path.join(this.migrationDir, connectionKey)

    const filePath = path.join(dir, name)
    return fs.existsSync(filePath) ? filePath : null
  }

  // ---------------------------------------------------------------------------
  // SEED DATA
  // ---------------------------------------------------------------------------

  /**
   * Applies seed data from schema definitions using idempotent upsert logic.
   * @param {object} knex - Knex connection instance
   * @param {string} connectionKey - Connection identifier
   * @param {boolean} dryRun - If true, only list pending seeds
   * @returns {Promise<Array>} Seed operation results
   */
  async _applySeeds(knex, connectionKey, dryRun) {
    const schemas = this._loadSchemaFiles(connectionKey)
    const results = []

    for (const [tableName, schema] of Object.entries(schemas)) {
      if (!schema.seed || !Array.isArray(schema.seed) || schema.seed.length === 0) continue

      const seedKey = schema.seedKey

      if (!seedKey) {
        throw new Error(`ODAC Migration: Schema '${tableName}' has seed data but no seedKey defined.`)
      }

      for (const row of schema.seed) {
        const keyValue = row[seedKey]
        if (keyValue === undefined) continue

        const preparedRow = this._prepareSeedRow(row, schema)
        const existing = await knex(tableName).where(seedKey, keyValue).first()

        if (!existing) {
          // Auto-generate nanoid for columns with type 'nanoid' that are missing from seed data
          this._fillNanoidColumns(preparedRow, schema)

          if (!dryRun) {
            await knex(tableName).insert(preparedRow)
          }
          results.push({type: 'seed_insert', table: tableName, key: keyValue})
        } else {
          const needsUpdate = this._seedRowNeedsUpdate(row, existing, seedKey)

          if (needsUpdate) {
            if (!dryRun) {
              await knex(tableName).where(seedKey, keyValue).update(preparedRow)
            }
            results.push({type: 'seed_update', table: tableName, key: keyValue})
          }
        }
      }
    }

    return results
  }

  /**
   * Prepares a seed row for insertion/updating by stringifying JSON columns.
   * Why: Knex/pg driver converts JavaScript arrays to PostgreSQL array literals (e.g. {1,2,3})
   * instead of JSON arrays (e.g. [1,2,3]). This causes "invalid input syntax for type json"
   * when seeding JSONB columns with arrays. Stringifying them explicitly fixes this.
   * @param {object} row - Raw seed row
   * @param {object} schema - Table schema definition
   * @returns {object} Prepared row
   */
  _prepareSeedRow(row, schema) {
    const prepared = {...row}
    const columns = schema.columns || {}

    for (const [key, value] of Object.entries(prepared)) {
      const colDef = columns[key]
      if (colDef && (colDef.type === 'json' || colDef.type === 'jsonb')) {
        if (value !== null && typeof value !== 'string') {
          prepared[key] = JSON.stringify(value)
        }
      }
    }

    return prepared
  }

  /**
   * Why: The previous `String()` coercion broke for JSON/JSONB columns in two ways:
   *   1. `String({})` produces "[object Object]" — useless for deep comparison.
   *   2. PG may return parsed objects while seeds hold raw objects — identical data
   *      compared as different → false-positive UPDATE → Knex double-stringifies
   *      the already-serialized JSON → PG throws "invalid input syntax for type json".
   *
   * This method normalizes both sides to canonical JSON before comparing, which
   * handles: objects, arrays, numbers-as-strings (SQLite), null vs undefined,
   * and Date objects.
   * @param {object} seedRow - Desired seed row from schema file
   * @param {object} existingRow - Current row from DB
   * @param {string} seedKey - The key column to skip during comparison
   * @returns {boolean} True if the DB row needs updating
   */
  _seedRowNeedsUpdate(seedRow, existingRow, seedKey) {
    for (const key of Object.keys(seedRow)) {
      if (key === seedKey) continue

      const desired = seedRow[key]
      const current = existingRow[key]

      // Both nullish — no change
      if (desired == null && current == null) continue

      // One nullish, other not — changed
      if (desired == null || current == null) return true

      // Both primitives — numeric-safe loose comparison
      if (typeof desired !== 'object' && typeof current !== 'object') {
        if (String(desired) !== String(current)) return true
        continue
      }

      // At least one side is an object/array — canonical JSON comparison
      const desiredJson = typeof desired === 'string' ? desired : JSON.stringify(desired)
      const currentJson = typeof current === 'string' ? current : JSON.stringify(current)

      if (desiredJson !== currentJson) return true
    }

    return false
  }

  // ---------------------------------------------------------------------------
  // CLICKHOUSE PIPELINE — engine-aware, add-column-only, no FK/index/mutation
  // ---------------------------------------------------------------------------

  /**
   * Runs the migration pipeline for a ClickHouse connection.
   * Scope (by design, matching ClickHouse's OLAP model):
   *   - CREATE TABLE (engine + ORDER BY aware) and ADD COLUMN only — no drop/alter/index/FK.
   *   - Seeds are insert-only (no mutation-based updates).
   *   - Rollback/snapshot are unsupported (guarded in their public methods).
   * @param {object} conn - ClickHouseAdapter instance
   * @param {string} connectionKey - Connection identifier
   * @param {boolean} dryRun - If true, compute operations without executing
   * @returns {Promise<object>} Summary {schema, files, seeds}
   */
  async _migrateClickHouse(conn, connectionKey, dryRun) {
    await this._ensureTrackingTableClickHouse(conn, dryRun)

    const schema = await this._applySchemaChangesClickHouse(conn, connectionKey, dryRun)
    const files = await this._applyMigrationFilesClickHouse(conn, connectionKey, dryRun)
    const seeds = await this._applySeedsClickHouse(conn, connectionKey, dryRun)

    return {schema, files, seeds}
  }

  /**
   * Ensures the migration tracking table exists on a ClickHouse connection.
   * Uses a MergeTree table ordered by (connection, name) — append-only, no primary key needed.
   * The `value` column stores the last-applied table TTL expression (type='ttl' rows).
   * @param {object} conn - ClickHouseAdapter instance
   * @param {boolean} dryRun
   */
  async _ensureTrackingTableClickHouse(conn, dryRun) {
    if (dryRun) return

    if (!(await conn.hasTable(this.trackingTable))) {
      await conn.exec(
        `CREATE TABLE IF NOT EXISTS ${clickhouse.quoteIdent(this.trackingTable)} (\n` +
          `  name String,\n  connection String,\n  type String,\n  batch UInt32,\n  value String DEFAULT '',\n  applied_at DateTime DEFAULT now()\n` +
          `) ENGINE = MergeTree() ORDER BY (connection, name)`
      )
      return
    }

    // Older tracking tables predate the `value` column — idempotent metadata-only upgrade.
    await conn.exec(`ALTER TABLE ${clickhouse.quoteIdent(this.trackingTable)} ADD COLUMN IF NOT EXISTS \`value\` String DEFAULT ''`)
  }

  /**
   * Applies structural schema changes to a ClickHouse connection: creates missing tables and
   * adds missing columns. Column drops, type alters, indexes and foreign keys are intentionally
   * out of scope for ClickHouse.
   * @param {object} conn - ClickHouseAdapter instance
   * @param {string} connectionKey - Connection identifier
   * @param {boolean} dryRun
   * @returns {Promise<Array>} List of applied operations
   */
  async _applySchemaChangesClickHouse(conn, connectionKey, dryRun) {
    const desiredSchemas = this._loadSchemaFiles(connectionKey)
    const operations = []

    for (const [tableName, desired] of Object.entries(desiredSchemas)) {
      const exists = await conn.hasTable(tableName)

      if (!exists) {
        operations.push({type: 'create_table', table: tableName, columns: desired.columns})
        if (!dryRun) {
          await conn.exec(clickhouse.buildCreateTableDDL(tableName, desired))

          // Record the TTL baked into CREATE so later schema edits diff against it.
          const initialTtl = this._desiredClickHouseTTL(desired)
          if (initialTtl) await this._recordClickHouseTTL(conn, connectionKey, tableName, initialTtl, 1)
        }
        continue
      }

      const current = await conn.columnInfo(tableName)
      const desiredCols = this._expandClickHouseColumns(desired.columns)

      for (const [colName, def] of Object.entries(desiredCols)) {
        if (current[colName]) continue
        operations.push({type: 'add_column', table: tableName, column: colName})
        if (!dryRun) await conn.exec(clickhouse.buildAddColumnDDL(tableName, colName, def))
      }

      const ttlOp = await this._syncClickHouseTableTTL(conn, connectionKey, tableName, desired, dryRun)
      if (ttlOp) operations.push(ttlOp)
    }

    return operations
  }

  /**
   * Resolves the effective table-level TTL a schema asks for: the trimmed expression, or ''
   * when the schema has none or the engine is not MergeTree-family (TTL unsupported there).
   * @param {object} schema - Full schema definition
   * @returns {string}
   */
  _desiredClickHouseTTL(schema) {
    if (!clickhouse.isMergeTreeEngine(clickhouse.normalizeEngine(schema.engine))) return ''
    return typeof schema.ttl === 'string' ? schema.ttl.trim() : ''
  }

  /**
   * Reconciles an existing ClickHouse table's TTL with the schema's `ttl` field.
   *
   * Why tracking-table based (not introspection): ClickHouse normalizes TTL expressions in
   * system.tables ('INTERVAL 30 DAY' → 'toIntervalDay(30)'), so comparing the schema's raw
   * string against introspected DDL would never match — re-issuing MODIFY TTL (a mutation that
   * rewrites parts) on every startup. Diffing against the expression ODAC last applied, stored
   * as type='ttl' rows in the tracking table, is deterministic and idempotent. `batch` acts as
   * a per-table revision counter (append-only table — latest revision wins). Consequence:
   * out-of-band TTL changes (manual ALTER) are invisible to this diff by design.
   * @param {object} conn - ClickHouseAdapter instance
   * @param {string} connectionKey - Connection identifier
   * @param {string} tableName - Target table
   * @param {object} schema - Full schema definition
   * @param {boolean} dryRun
   * @returns {Promise<object|null>} The applied operation, or null when TTL is already in sync
   */
  async _syncClickHouseTableTTL(conn, connectionKey, tableName, schema, dryRun) {
    const desired = this._desiredClickHouseTTL(schema)
    const recorded = await this._recordedClickHouseTTL(conn, connectionKey, tableName)
    if (desired === recorded.value) return null

    const op = desired ? {type: 'modify_ttl', table: tableName, ttl: desired} : {type: 'remove_ttl', table: tableName}

    if (!dryRun) {
      const t = clickhouse.quoteIdent(tableName)
      // MODIFY TTL materializes the new policy on existing parts (background mutation) — can be
      // heavy on large tables, but it is exactly what the schema declares.
      await conn.exec(desired ? `ALTER TABLE ${t} MODIFY TTL ${desired}` : `ALTER TABLE ${t} REMOVE TTL`)
      await this._recordClickHouseTTL(conn, connectionKey, tableName, desired, recorded.revision + 1)
    }

    return op
  }

  /**
   * Reads the latest TTL revision ODAC recorded for a table ('' / revision 0 when none).
   * Tolerates a missing tracking table or a pre-`value`-column tracking table (dry-run on a
   * fresh database, or status before the idempotent upgrade ran).
   * @param {object} conn - ClickHouseAdapter instance
   * @param {string} connectionKey - Connection identifier
   * @param {string} tableName - Target table
   * @returns {Promise<{value: string, revision: number}>}
   */
  async _recordedClickHouseTTL(conn, connectionKey, tableName) {
    if (!(await conn.hasTable(this.trackingTable))) return {value: '', revision: 0}

    const cols = await conn.columnInfo(this.trackingTable)
    if (!cols.value) return {value: '', revision: 0}

    const tt = clickhouse.quoteIdent(this.trackingTable)
    const rows = await conn.query(
      `SELECT value, batch FROM ${tt} WHERE connection = ${clickhouse.quoteLiteral(connectionKey)}` +
        ` AND type = 'ttl' AND name = ${clickhouse.quoteLiteral(tableName)} ORDER BY batch DESC LIMIT 1`
    )

    if (rows.length === 0) return {value: '', revision: 0}
    return {value: rows[0].value || '', revision: Number(rows[0].batch) || 0}
  }

  /**
   * Appends a TTL revision row to the tracking table.
   * @param {object} conn - ClickHouseAdapter instance
   * @param {string} connectionKey - Connection identifier
   * @param {string} tableName - Target table
   * @param {string} value - Applied TTL expression ('' for removal)
   * @param {number} revision - Monotonic per-table revision number
   */
  async _recordClickHouseTTL(conn, connectionKey, tableName, value, revision) {
    // applied_at omitted → DEFAULT now() fills it (same convention as file-migration rows).
    await conn.insert(this.trackingTable, [{name: tableName, connection: connectionKey, type: 'ttl', batch: revision, value}])
  }

  /**
   * Expands a schema column map into concrete ClickHouse column definitions, resolving the
   * virtual 'timestamps' type into created_at/updated_at. Mirrors the SQL diff engine's handling.
   * @param {object} columns - Desired column definitions
   * @returns {object} Map of columnName -> definition
   */
  _expandClickHouseColumns(columns) {
    const expanded = {}
    for (const [colName, def] of Object.entries(columns || {})) {
      if (def.type === 'timestamps') {
        expanded['created_at'] = {type: 'datetime', default: 'now()'}
        expanded['updated_at'] = {type: 'datetime', default: 'now()'}
        continue
      }
      expanded[colName] = def
    }
    return expanded
  }

  /**
   * Runs pending imperative migration files against a ClickHouse connection and records them in
   * the tracking table. The migration file's up(conn) receives the ClickHouseAdapter.
   * @param {object} conn - ClickHouseAdapter instance
   * @param {string} connectionKey - Connection identifier
   * @param {boolean} dryRun
   * @returns {Promise<Array>} Applied/pending file descriptors
   */
  async _applyMigrationFilesClickHouse(conn, connectionKey, dryRun) {
    const migrationFiles = this._loadMigrationFiles(connectionKey)
    if (migrationFiles.length === 0) return []

    const tt = clickhouse.quoteIdent(this.trackingTable)
    const connLit = clickhouse.quoteLiteral(connectionKey)

    const appliedRows = await conn.query(`SELECT name FROM ${tt} WHERE connection = ${connLit} AND type = 'file'`)
    const appliedNames = new Set(appliedRows.map(r => r.name))
    const pending = migrationFiles.filter(f => !appliedNames.has(f.name))

    if (dryRun) return pending.map(f => ({type: 'pending_file', name: f.name}))

    // type='file' filter: TTL revision rows also live in this table and reuse `batch` as their
    // own per-table counter — they must not inflate the file-migration batch numbering.
    const batchRows = await conn.query(`SELECT max(batch) AS maxBatch FROM ${tt} WHERE connection = ${connLit} AND type = 'file'`)
    const batch = (Number(batchRows[0]?.maxBatch) || 0) + 1

    const results = []

    for (const file of pending) {
      const migration = this._requireSchema(file.path)
      if (typeof migration.up !== 'function') {
        throw new Error(`ODAC Migration: File '${file.name}' is missing an 'up' function.`)
      }

      await migration.up(conn)

      // applied_at is omitted so the column's DEFAULT now() fills it (JSONEachRow default fill).
      await conn.insert(this.trackingTable, [{name: file.name, connection: connectionKey, type: 'file', batch}])
      results.push({type: 'applied_file', name: file.name})
    }

    return results
  }

  /**
   * Applies seed data to a ClickHouse connection using insert-only semantics.
   * Existing rows (matched by seedKey) are left untouched — ClickHouse has no cheap row update.
   * @param {object} conn - ClickHouseAdapter instance
   * @param {string} connectionKey - Connection identifier
   * @param {boolean} dryRun
   * @returns {Promise<Array>} Seed operation results
   */
  async _applySeedsClickHouse(conn, connectionKey, dryRun) {
    const schemas = this._loadSchemaFiles(connectionKey)
    const results = []

    for (const [tableName, schema] of Object.entries(schemas)) {
      if (!schema.seed || !Array.isArray(schema.seed) || schema.seed.length === 0) continue

      const seedKey = schema.seedKey
      if (!seedKey) {
        throw new Error(`ODAC Migration: Schema '${tableName}' has seed data but no seedKey defined.`)
      }

      for (const row of schema.seed) {
        const keyValue = row[seedKey]
        if (keyValue === undefined) continue

        const existing = await conn.query(
          `SELECT 1 FROM ${clickhouse.quoteIdent(tableName)} WHERE ${clickhouse.quoteIdent(seedKey)} = ${this._clickhouseValue(keyValue)} LIMIT 1`
        )

        if (existing.length > 0) continue

        const preparedRow = this._prepareSeedRow(row, schema)
        this._fillNanoidColumns(preparedRow, schema)

        if (!dryRun) await conn.insert(tableName, [preparedRow])
        results.push({type: 'seed_insert', table: tableName, key: keyValue})
      }
    }

    return results
  }

  /**
   * Renders a scalar value for a ClickHouse WHERE comparison: numbers bare, everything else quoted.
   * @param {*} value
   * @returns {string}
   */
  _clickhouseValue(value) {
    return typeof value === 'number' ? String(value) : clickhouse.quoteLiteral(value)
  }

  // ---------------------------------------------------------------------------
  // SNAPSHOT — Reverse-engineer DB into schema files
  // ---------------------------------------------------------------------------

  /**
   * Reads the current database structure and generates schema/ files.
   * @param {object} knex - Knex connection instance
   * @param {string} connectionKey - Connection identifier
   * @returns {Promise<Array>} Generated file paths
   */
  async _snapshotDatabase(knex, connectionKey) {
    const tables = await this._listTables(knex)
    const generatedFiles = []
    const targetDir = connectionKey === 'default' ? this.schemaDir : path.join(this.schemaDir, connectionKey)

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, {recursive: true})
    }

    for (const tableName of tables) {
      if (tableName === this.trackingTable) continue

      const columns = await this._introspectColumns(knex, tableName)
      const indexes = await this._introspectIndexes(knex, tableName)
      const schemaContent = this._generateSchemaFileContent(tableName, columns, indexes)
      const safeFileStem = this._toSafeFileStem(tableName)
      const filePath = path.resolve(targetDir, `${safeFileStem}.js`)
      const targetRoot = path.resolve(targetDir) + path.sep

      if (!filePath.startsWith(targetRoot)) {
        throw new Error(`ODAC Migration: Unsafe snapshot path generated for table '${tableName}'.`)
      }

      fs.writeFileSync(filePath, schemaContent, 'utf8')
      generatedFiles.push(filePath)
    }

    return generatedFiles
  }

  /**
   * Lists all user tables in the current database (excluding system tables).
   * @param {object} knex - Knex connection
   * @returns {Promise<string[]>} Table name list
   */
  async _listTables(knex) {
    const client = knex.client.config.client

    if (client === 'mysql2' || client === 'mysql') {
      const [rows] = await knex.raw('SHOW TABLES')
      return rows.map(row => Object.values(row)[0])
    } else if (client === 'pg') {
      const result = await knex.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
      return result.rows.map(r => r.tablename)
    } else if (client === 'sqlite3') {
      const rows = await knex.raw("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      return rows.map(r => r.name)
    }

    return []
  }

  /**
   * Generates a human-readable schema file from introspected metadata.
   * @param {string} tableName - Table name
   * @param {object} columns - Introspected column map
   * @param {Array} indexes - Introspected index list
   * @returns {string} JavaScript module source code
   */
  _generateSchemaFileContent(tableName, columns, indexes) {
    const lines = []
    const safeTableLabel = this._toJsLiteral(String(tableName))
    lines.push(`// Schema definition for ${safeTableLabel} — auto-generated by ODAC snapshot`)
    lines.push(`// Review and adjust types/constraints as needed before using as source of truth.`)
    lines.push(`'use strict'`)
    lines.push('')
    lines.push('module.exports = {')
    lines.push('  columns: {')

    const colEntries = Object.entries(columns)
    for (let i = 0; i < colEntries.length; i++) {
      const [colName, meta] = colEntries[i]
      const parts = []

      const mappedType = this._reverseMapType(meta.type)
      parts.push(`type: ${this._toJsLiteral(mappedType)}`)

      if (meta.maxLength) {
        const parsedLength = Number(meta.maxLength)
        if (Number.isFinite(parsedLength) && parsedLength > 0) {
          parts.push(`length: ${Math.trunc(parsedLength)}`)
        }
      }
      if (meta.nullable === false) parts.push('nullable: false')
      if (meta.defaultValue !== null && meta.defaultValue !== undefined) {
        parts.push(`default: ${this._toJsLiteral(meta.defaultValue)}`)
      }

      const comma = i < colEntries.length - 1 ? ',' : ''
      lines.push(`    ${this._toObjectKey(colName)}: {${parts.join(', ')}}${comma}`)
    }

    lines.push('  },')
    lines.push('')

    if (indexes.length > 0) {
      lines.push('  indexes: [')
      for (let i = 0; i < indexes.length; i++) {
        const idx = indexes[i]
        const colsStr = idx.columns.map(c => this._toJsLiteral(String(c))).join(', ')
        const uniqueStr = idx.unique ? ', unique: true' : ''
        const comma = i < indexes.length - 1 ? ',' : ''
        lines.push(`    {columns: [${colsStr}]${uniqueStr}}${comma}`)
      }
      lines.push('  ]')
    } else {
      lines.push('  indexes: []')
    }

    lines.push('}')
    lines.push('')

    return lines.join('\n')
  }

  _toJsLiteral(value) {
    if (typeof value === 'bigint') return `${value}n`
    return JSON.stringify(value)
  }

  _toObjectKey(key) {
    const normalized = String(key)
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) return normalized
    return this._toJsLiteral(normalized)
  }

  _toSafeFileStem(name) {
    const normalized = String(name)
      .normalize('NFKC')
      .replace(/[\\/\0]/g, '_')
      .replace(/\.+/g, '.')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .trim()

    return normalized.length > 0 ? normalized : 'table'
  }

  _quoteSQLiteIdentifier(value) {
    const normalized = String(value)
    return `"${normalized.replace(/"/g, '""')}"`
  }

  /**
   * Maps raw database type strings back to ODAC schema type names.
   * @param {string} rawType - Database-reported type string
   * @returns {string} ODAC schema type
   */
  _reverseMapType(rawType) {
    if (!rawType) return 'string'
    const t = rawType.toLowerCase()

    if (t.includes('int') && t.includes('auto')) return 'increments'
    if (t === 'bigint') return 'bigInteger'
    if (t.includes('int')) return 'integer'
    if (t.includes('varchar') || t.includes('character varying')) return 'string'
    if (t === 'text' || t === 'mediumtext' || t === 'longtext') return 'text'
    if (t === 'boolean' || t === 'tinyint(1)') return 'boolean'
    if (t === 'date') return 'date'
    if (t.includes('datetime')) return 'datetime'
    if (t.includes('timestamp')) return 'timestamp'
    if (t === 'time') return 'time'
    if (t.includes('decimal') || t.includes('numeric')) return 'decimal'
    if (t.includes('float') || t.includes('double') || t.includes('real')) return 'float'
    if (t === 'json' || t === 'jsonb') return t
    if (t === 'uuid') return 'uuid'
    if (t.includes('blob') || t.includes('binary') || t.includes('bytea')) return 'binary'
    if (t.includes('enum')) return 'enum'

    return 'string'
  }

  // ---------------------------------------------------------------------------
  // TRACKING TABLE
  // ---------------------------------------------------------------------------

  /**
   * Ensures the migration tracking table exists in the given connection.
   * @param {object} knex - Knex connection instance
   */
  async _ensureTrackingTable(knex) {
    const exists = await knex.schema.hasTable(this.trackingTable)
    if (exists) return

    await knex.schema.createTable(this.trackingTable, table => {
      table.increments('id')
      table.string('name').notNullable()
      table.string('connection').notNullable()
      table.string('type').notNullable() // 'file' or 'schema'
      table.integer('batch').notNullable()
      table.timestamp('applied_at').defaultTo(knex.fn.now())
      table.index(['connection', 'type'])
    })
  }

  /**
   * Populates missing nanoid columns in a data row before insertion.
   * Why: Zero-config DX — developers should not manually call nanoid() for every insert.
   * When a schema defines a column as type 'nanoid', the framework auto-generates
   * the value if the caller did not provide one.
   * @param {object} row - Data row to mutate in-place
   * @param {object} schema - Table schema definition
   */
  _fillNanoidColumns(row, schema) {
    const columns = schema.columns || {}

    for (const [colName, colDef] of Object.entries(columns)) {
      if (colDef.type === 'nanoid' && !row[colName]) {
        row[colName] = nanoid(colDef.length || 21)
      }
    }
  }
}

module.exports = new Migration()

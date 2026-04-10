'use strict'

const fs = require('node:fs')
const path = require('node:path')
const nanoid = require('./nanoid')

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

      await this._ensureTrackingTable(knex)

      const schemaChanges = await this._applySchemaChanges(knex, key, dryRun)
      const fileChanges = await this._applyMigrationFiles(knex, key, dryRun)
      const seedChanges = await this._applySeeds(knex, key, dryRun)

      summary[key] = {schema: schemaChanges, files: fileChanges, seeds: seedChanges}
    }

    return summary
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
        ops.push({type: 'alter_column', column: colName, definition: colDef})
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
   * @param {object} desired - Column definition from schema file
   * @param {object} current - Column metadata from introspection
   * @returns {boolean}
   */
  _columnNeedsAlter(desired, current) {
    // Nullable mismatch
    if (desired.nullable === false && current.nullable === true) return true
    if (desired.nullable === true && current.nullable === false) return true

    // Length mismatch for string types — use Number() coercion since some
    // drivers (SQLite) return maxLength as a string, e.g. '100' vs 100.
    if (desired.length && current.maxLength && Number(desired.length) !== Number(current.maxLength)) return true

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
      this._buildColumns(table, schema.columns)
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

    // Phase 1: Column operations — atomic batch
    if (columnOps.length > 0) {
      await knex.schema.alterTable(tableName, table => {
        for (const op of columnOps) {
          switch (op.type) {
            case 'add_column':
              this._addColumn(table, op.column, op.definition)
              break
            case 'drop_column':
              table.dropColumn(op.column)
              break
            case 'alter_column':
              this._alterColumn(table, op.column, op.definition)
              break
          }
        }
      })
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
  _buildColumns(table, columns) {
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

      if (def.default !== undefined) col.defaultTo(def.default)
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
  _addColumn(table, colName, def) {
    const col = this._createColumnBuilder(table, colName, def)
    if (!col) return

    if (def.nullable === false) col.notNullable()
    else col.nullable()

    if (def.default !== undefined) col.defaultTo(def.default)
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
  _alterColumn(table, colName, def) {
    const col = this._createColumnBuilder(table, colName, def)
    if (!col) return

    if (def.nullable === false) col.notNullable()
    else if (def.nullable === true) col.nullable()

    if (def.default !== undefined) col.defaultTo(def.default)

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

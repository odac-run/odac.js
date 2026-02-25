// Schema definition for 'users' — example schema file
// This is the single source of truth for the 'users' table.
// AI agents read this file to understand the final database state.
'use strict'

module.exports = {
  columns: {
    id: {type: 'increments'},
    name: {type: 'string', length: 255, nullable: false},
    email: {type: 'string', length: 255, nullable: false},
    password: {type: 'string', length: 255, nullable: false},
    role: {type: 'enum', values: ['admin', 'user'], default: 'user'},
    is_active: {type: 'boolean', default: true},
    timestamps: {type: 'timestamps'}
  },

  indexes: [{columns: ['email'], unique: true}, {columns: ['role', 'is_active']}],

  // Seed data — idempotent, runs on every migrate.
  // seedKey determines the uniqueness check for upsert.
  seed: [{name: 'Admin', email: 'admin@example.com', password: 'changeme', role: 'admin'}],
  seedKey: 'email'
}

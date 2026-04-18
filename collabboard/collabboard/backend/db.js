/**
 * CollabBoard — Database Layer (SQLite via better-sqlite3)
 * Synchronous, fast, zero-config, perfect for self-hosted apps.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../data/collabboard.db');
const DATA_DIR = path.join(__dirname, '../data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    password    TEXT NOT NULL,
    avatar      TEXT,
    bio         TEXT,
    role        TEXT DEFAULT 'user',
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch()),
    last_seen   INTEGER DEFAULT (unixepoch()),
    is_active   INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch()),
    user_agent  TEXT,
    ip          TEXT
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    icon        TEXT DEFAULT '📋',
    color       TEXT DEFAULT '#c8ff57',
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch()),
    is_archived INTEGER DEFAULT 0,
    settings    TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS project_members (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member',
    invited_by  TEXT REFERENCES users(id),
    joined_at   INTEGER DEFAULT (unixepoch()),
    UNIQUE(project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS invites (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    token       TEXT UNIQUE NOT NULL,
    role        TEXT DEFAULT 'member',
    invited_by  TEXT REFERENCES users(id),
    created_at  INTEGER DEFAULT (unixepoch()),
    expires_at  INTEGER NOT NULL,
    accepted_at INTEGER,
    status      TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'todo',
    priority    TEXT NOT NULL DEFAULT 'medium',
    tags        TEXT DEFAULT '[]',
    assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reporter_id TEXT REFERENCES users(id),
    due_date    TEXT,
    position    REAL DEFAULT 0,
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER,
    checklist   TEXT DEFAULT '[]',
    attachments TEXT DEFAULT '[]',
    cover_color TEXT,
    estimated_hours REAL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch()),
    edited      INTEGER DEFAULT 0,
    reactions   TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS activity (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    meta        TEXT DEFAULT '{}',
    created_at  INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    link        TEXT,
    read        INTEGER DEFAULT 0,
    created_at  INTEGER DEFAULT (unixepoch())
  );

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
  CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
  CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id);
  CREATE INDEX IF NOT EXISTS idx_members_project ON project_members(project_id);
  CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

console.log('✅ Database initialized');

module.exports = db;

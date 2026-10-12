// База трекера: встроенный node:sqlite, один файл в DATA_DIR.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tracker.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','assistant')),
  pass_hash TEXT NOT NULL,
  api_key_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id),
  assignee_id INTEGER REFERENCES users(id),
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('proposed','new','in_progress','review','done')),
  result_url TEXT,
  result_file TEXT,
  result_file_name TEXT,
  overdue_reason TEXT,
  overdue_comment TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('comment','change')),
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS login_attempts (
  login TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
`);

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Первый запуск: категории и два аккаунта. Пароли берутся из окружения.
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count === 0) {
    const names = ['Соцсети РФ', 'Соцсети зарубеж', 'Сайт', 'Маркетплейсы РФ', 'Маркетплейсы зарубеж'];
    const ins = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
    names.forEach((n, i) => ins.run(n, i));
  }
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (users === 0) {
    const adminPass = process.env.ADMIN_PASSWORD;
    const asstPass = process.env.ASSISTANT_PASSWORD;
    if (!adminPass || !asstPass) {
      throw new Error('Задайте ADMIN_PASSWORD и ASSISTANT_PASSWORD для первого запуска');
    }
    const ins = db.prepare('INSERT INTO users (login, name, role, pass_hash) VALUES (?, ?, ?, ?)');
    ins.run(process.env.ADMIN_LOGIN || 'evgenia', 'Евгения', 'admin', hashPassword(adminPass));
    ins.run(process.env.ASSISTANT_LOGIN || 'assistant', 'Ассистент (ИИ)', 'assistant', hashPassword(asstPass));
  }
}

module.exports = { db, DATA_DIR, hashPassword, verifyPassword, sha256, seed };

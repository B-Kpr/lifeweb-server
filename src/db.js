/* The database: one SQLite file (data/lifeweb.db), using the SQLite built into Node 24.
   Boards are stored item by item, and every change is kept, which is where History comes from. */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');

// each step runs once, in order; the database remembers how far it has got. A later change to the schema is a new step at the end.
const MIGRATIONS = [
  // the schema of Life Web Cloud 3 (board format 2). prev: the board a Save As onto the same name replaced; mcp_hash: a person's private connector link
  `CREATE TABLE people (
     name TEXT PRIMARY KEY, token_hash TEXT, admin INTEGER NOT NULL DEFAULT 0, ai INTEGER NOT NULL DEFAULT 1,
     created INTEGER NOT NULL, joined INTEGER, removed INTEGER, mcp_hash TEXT);
   CREATE INDEX people_mcp ON people (mcp_hash);
   CREATE TABLE invites (code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, by TEXT);
   -- a folder exists when it has a row here or a board inside it
   CREATE TABLE folders (owner TEXT NOT NULL, path TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (owner, path));
   -- path is "Folder/Sub/Name"; deleted boards keep their rows (deleted = when), so nothing is ever lost
   CREATE TABLE boards (
     id INTEGER PRIMARY KEY, owner TEXT NOT NULL, path TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL, updated INTEGER NOT NULL, deleted INTEGER, prev INTEGER);
   CREATE UNIQUE INDEX boards_live ON boards (owner, path) WHERE deleted IS NULL;
   -- every concept, tile, chip, cross-link, dependency, rank pick and tag colour, as the app's own JSON
   CREATE TABLE items (
     board INTEGER NOT NULL, coll TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, rev INTEGER NOT NULL,
     updated INTEGER NOT NULL, updated_by TEXT, PRIMARY KEY (board, coll, id));
   -- every change, in order per board (rev), with the item before and after (null = not there; see step 2 for diff)
   CREATE TABLE changes (
     board INTEGER NOT NULL, rev INTEGER NOT NULL, at INTEGER NOT NULL, user TEXT NOT NULL, via TEXT,
     coll TEXT NOT NULL, id TEXT NOT NULL, before TEXT, after TEXT, PRIMARY KEY (board, rev));
   CREATE INDEX changes_at ON changes (at);
   CREATE INDEX changes_board_at ON changes (board, at);
   CREATE INDEX changes_user ON changes (user, at);
   -- boards and folders made, renamed and deleted
   CREATE TABLE board_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user TEXT NOT NULL, owner TEXT NOT NULL, path TEXT NOT NULL, action TEXT NOT NULL, what TEXT NOT NULL, detail TEXT);
   CREATE INDEX board_events_at ON board_events (at);
   -- Assistant requests and answers, with the whole run (trace) as JSON
   CREATE TABLE chats (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user TEXT NOT NULL, board TEXT, assistant TEXT, model TEXT, ask TEXT, reply TEXT, error TEXT, trace TEXT);
   CREATE INDEX chats_at ON chats (at);`,
  // 2: History keeps only what changed. diff = 1: before and after hold just the changed fields (model.diffBodies); the rows already kept are slimmed down
  db => {
    db.exec('ALTER TABLE changes ADD COLUMN diff INTEGER NOT NULL DEFAULT 0');
    const { diffBodies } = require('./model'), up = db.prepare('UPDATE changes SET before = ?, after = ?, diff = 1 WHERE board = ? AND rev = ?');
    for (const r of db.prepare('SELECT board, rev, before, after FROM changes WHERE before IS NOT NULL AND after IS NOT NULL').all()) {
      const d = diffBodies(JSON.parse(r.before), JSON.parse(r.after)) || { before: {}, after: {} };
      up.run(JSON.stringify(d.before), JSON.stringify(d.after), r.board, r.rev);
    }
  }
];

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'lifeweb.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema').get();
  let v = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema (version) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN'); try { const step = MIGRATIONS[v]; if (typeof step === 'function') step(db); else db.exec(step); db.prepare('UPDATE schema SET version = ?').run(v + 1); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // a cache of prepared statements
  const cache = new Map();
  db.q = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  db.tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; } };
  return db;
}

/* a copy of the whole database, once a day, in data/backups (the newest 30 are kept). Safe while the server runs. */
function backup(db, dataDir, keep = 30) {
  const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'lifeweb-' + new Date().toISOString().slice(0, 10) + '.db');
  if (fs.existsSync(file)) return null;
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
  const all = fs.readdirSync(dir).filter(f => /^lifeweb-\d{4}-\d\d-\d\d\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, f));
  return file;
}

module.exports = { open, backup };

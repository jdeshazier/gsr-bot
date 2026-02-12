const Database = require("better-sqlite3");

const db = new Database("data.db");

// Create table if it doesn't exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    irating INTEGER,
    last_rank INTEGER
    iracing_customer_id INTEGER,
    iracing_access_token TEXT,
    iracing_refresh_token TEXT

  )
`).run();

module.exports = db;

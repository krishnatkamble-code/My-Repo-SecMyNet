const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

function resolveDatabaseUrl() {
  const existingDatabaseUrl = process.env.DATABASE_URL || '';
  if (existingDatabaseUrl) {
    return existingDatabaseUrl;
  }

  const azureHost = process.env.AZURE_POSTGRES_HOST || process.env.PGHOST;
  const azurePort = process.env.AZURE_POSTGRES_PORT || process.env.PGPORT || '5432';
  const azureDatabase = process.env.AZURE_POSTGRES_DB || process.env.PGDATABASE || 'secmynet';
  const azureUser = process.env.AZURE_POSTGRES_USER || process.env.PGUSER || 'secmynet';
  const azurePassword = process.env.AZURE_POSTGRES_PASSWORD || process.env.PGPASSWORD || '';
  const azureSslMode = process.env.AZURE_POSTGRES_SSLMODE || process.env.PGSSLMODE || 'require';

  if (azureHost && azureUser) {
    return `postgresql://${encodeURIComponent(azureUser)}:${encodeURIComponent(azurePassword)}@${azureHost}:${azurePort}/${azureDatabase}?sslmode=${azureSslMode}`;
  }

  return '';
}

const DATABASE_URL = resolveDatabaseUrl();
const isPostgresConfigured = /^postgres(ql)?:\/\//i.test(DATABASE_URL);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'secmynet.sqlite');

let sqliteDb = null;
let sqliteReady = false;
let postgresPool = null;
let initialized = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

async function initSqliteDb() {
  if (sqliteReady && sqliteDb) {
    return sqliteDb;
  }

  ensureDataDir();
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
  });

  const bytes = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : null;
  sqliteDb = bytes ? new SQL.Database(bytes) : new SQL.Database();

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  try {
    sqliteDb.run("ALTER TABLE users ADD COLUMN access_status TEXT NOT NULL DEFAULT 'enabled'");
  } catch (error) {
    // Existing databases already have this column after the first migration.
  }

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    admin_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    name TEXT NOT NULL,
    wifi_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'allowed',
    allowed_user_ids TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    data_used_mb REAL NOT NULL DEFAULT 0,
    connected_at TEXT NOT NULL,
    disconnected_at TEXT
  );`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    user_id TEXT,
    device_id TEXT,
    location_id TEXT,
    status TEXT NOT NULL DEFAULT 'unread',
    expires_at TEXT,
    created_at TEXT NOT NULL
  );`);
  try {
    sqliteDb.run("ALTER TABLE notifications ADD COLUMN expires_at TEXT");
  } catch (err) {
    // Column likely already exists or SQLite version doesn't support IF NOT EXISTS — ignore error
  }

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS openwrt_routers (
    id TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    name TEXT NOT NULL,
    agent_token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offline',
    last_seen_at TEXT,
    clients_json TEXT NOT NULL DEFAULT '[]',
    usage_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS openwrt_commands (
    id TEXT PRIMARY KEY,
    router_id TEXT NOT NULL,
    command_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    completed_at TEXT
  );`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS push_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_token TEXT NOT NULL,
    platform TEXT NOT NULL,
    device_name TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS admin_contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    phone TEXT,
    sms_opt_in INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );`);

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS usage_records (
    id TEXT PRIMARY KEY,
    router_id TEXT NOT NULL,
    client_mac TEXT NOT NULL,
    ip TEXT,
    hostname TEXT,
    rx_bytes INTEGER NOT NULL DEFAULT 0,
    tx_bytes INTEGER NOT NULL DEFAULT 0,
    delta_rx INTEGER NOT NULL DEFAULT 0,
    delta_tx INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL
  );`);

  persistSqliteDb();
  sqliteReady = true;
  return sqliteDb;
}

function persistSqliteDb() {
  if (!sqliteDb) return;
  const binary = Buffer.from(sqliteDb.export());
  fs.writeFileSync(DB_FILE, binary);
}

function normalizeSqliteSql(sql) {
  return sql
    .replace(/\$(\d+)/g, '?')
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
}

function sqliteRun(sql, params = []) {
  const normalizedSql = normalizeSqliteSql(sql);
  const statement = sqliteDb.prepare(normalizedSql);
  statement.run(params);
  statement.free();
  persistSqliteDb();
}

function sqliteAll(sql, params = []) {
  const normalizedSql = normalizeSqliteSql(sql);
  const statement = sqliteDb.prepare(normalizedSql);

  if (params.length > 0) {
    statement.bind(params);
  }

  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();
  return rows;
}

function sqliteGet(sql, params = []) {
  const rows = sqliteAll(sql, params);
  return rows[0] || null;
}

async function initDb() {
  if (initialized) {
    return isPostgresConfigured ? postgresPool : sqliteDb;
  }

  if (isPostgresConfigured) {
    const poolOptions = {
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined
    };

    postgresPool = new Pool(poolOptions);
    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await postgresPool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'enabled'");

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT NOT NULL,
        admin_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        location_id TEXT NOT NULL,
        name TEXT NOT NULL,
        wifi_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'allowed',
        allowed_user_ids TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data_used_mb REAL NOT NULL DEFAULT 0,
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disconnected_at TIMESTAMPTZ
      );
    `);

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        user_id TEXT,
        device_id TEXT,
        location_id TEXT,
        status TEXT NOT NULL DEFAULT 'unread',
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Ensure expires_at exists for older DBs
    await postgresPool.query("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ");

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS openwrt_routers (
        id TEXT PRIMARY KEY,
        location_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TIMESTAMPTZ,
        clients_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS openwrt_commands (
        id TEXT PRIMARY KEY,
        router_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
    `);

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        router_id TEXT NOT NULL,
        client_mac TEXT NOT NULL,
        ip TEXT,
        hostname TEXT,
        rx_bytes BIGINT NOT NULL DEFAULT 0,
        tx_bytes BIGINT NOT NULL DEFAULT 0,
        delta_rx BIGINT NOT NULL DEFAULT 0,
        delta_tx BIGINT NOT NULL DEFAULT 0,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_token TEXT NOT NULL,
        platform TEXT NOT NULL,
        device_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ
      );
    `);

    await postgresPool.query(`
      CREATE TABLE IF NOT EXISTS admin_contacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        phone TEXT,
        sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } else {
    await initSqliteDb();
  }

  initialized = true;
  return isPostgresConfigured ? postgresPool : sqliteDb;
}

async function run(sql, params = []) {
  if (isPostgresConfigured) {
    const client = await postgresPool.connect();
    try {
      await client.query(sql, params);
    } finally {
      client.release();
    }
    return;
  }

  sqliteRun(sql, params);
}

async function all(sql, params = []) {
  if (isPostgresConfigured) {
    const result = await postgresPool.query(sql, params);
    return result.rows;
  }

  return sqliteAll(sql, params);
}

async function get(sql, params = []) {
  if (isPostgresConfigured) {
    const rows = await all(sql, params);
    return rows[0] || null;
  }

  return sqliteGet(sql, params);
}

function makeId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

module.exports = {
  initDb,
  run,
  all,
  get,
  makeId,
  pool: postgresPool
};

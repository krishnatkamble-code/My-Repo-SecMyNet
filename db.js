const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

function resolveDatabaseUrl() {
  const directCandidates = [
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_PRISMA_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.NEON_DATABASE_URL,
    process.env.VERCEL_POSTGRES_URL,
    process.env.PRIMARY_DATABASE_URL_DATABASE_URL,
    process.env.PRIMARY_DATABASE_URL_POSTGRES_URL,
    process.env.PRIMARY_DATABASE_URL_POSTGRES_PRISMA_URL,
    process.env.PRIMARY_DATABASE_URL_POSTGRES_URL_NON_POOLING
  ];

  for (const candidate of directCandidates) {
    if (candidate && /^postgres(ql)?:\/\//i.test(candidate.trim())) {
      return candidate.trim();
    }
  }

  // Scan all environment variables for any connection string matching postgres:// or postgresql://
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && /^postgres(ql)?:\/\//i.test(value.trim()) && /(DATABASE_URL|POSTGRES_URL)/i.test(key)) {
      return value.trim();
    }
  }

  const host =
    process.env.PRIMARY_DATABASE_URL_POSTGRES_HOST ||
    process.env.PRIMARY_DATABASE_URL_PGHOST ||
    process.env.POSTGRES_HOST ||
    process.env.AZURE_POSTGRES_HOST ||
    process.env.PGHOST;
  const port =
    process.env.PRIMARY_DATABASE_URL_PGPORT ||
    process.env.POSTGRES_PORT ||
    process.env.AZURE_POSTGRES_PORT ||
    process.env.PGPORT ||
    '5432';
  const database =
    process.env.PRIMARY_DATABASE_URL_POSTGRES_DATABASE ||
    process.env.PRIMARY_DATABASE_URL_PGDATABASE ||
    process.env.POSTGRES_DATABASE ||
    process.env.AZURE_POSTGRES_DB ||
    process.env.PGDATABASE ||
    'secmynet';
  const user =
    process.env.PRIMARY_DATABASE_URL_POSTGRES_USER ||
    process.env.PRIMARY_DATABASE_URL_PGUSER ||
    process.env.POSTGRES_USER ||
    process.env.AZURE_POSTGRES_USER ||
    process.env.PGUSER ||
    'secmynet';
  const password =
    process.env.PRIMARY_DATABASE_URL_POSTGRES_PASSWORD ||
    process.env.PRIMARY_DATABASE_URL_PGPASSWORD ||
    process.env.POSTGRES_PASSWORD ||
    process.env.AZURE_POSTGRES_PASSWORD ||
    process.env.PGPASSWORD ||
    '';
  const sslMode =
    process.env.POSTGRES_SSLMODE ||
    process.env.AZURE_POSTGRES_SSLMODE ||
    process.env.PGSSLMODE ||
    'require';

  if (host && user) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslMode}`;
  }

  return '';
}

const DATABASE_URL = resolveDatabaseUrl();
const isPostgresConfigured = /^postgres(ql)?:\/\//i.test(DATABASE_URL);
const isVercel = Boolean(process.env.VERCEL || process.env.NOW_BUILDER_ANNOTATION);
const DATA_DIR = isVercel
  ? path.join(os.tmpdir(), 'secmynet-data')
  : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'secmynet.sqlite');

let sqliteDb = null;
let sqliteReady = false;
let postgresPool = null;
let initialized = false;

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('Could not create data directory:', err.message);
  }
}

async function initSqliteDb() {
  if (sqliteReady && sqliteDb) {
    return sqliteDb;
  }

  ensureDataDir();

  let locateFile = (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file);
  try {
    const resolvedWasm = require.resolve('sql.js/dist/sql-wasm.wasm');
    const resolvedDir = path.dirname(resolvedWasm);
    locateFile = (file) => path.join(resolvedDir, file);
  } catch (e) {
    // fallback to default locateFile
  }

  const SQL = await initSqlJs({ locateFile });

  let bytes = null;
  try {
    if (fs.existsSync(DB_FILE)) {
      bytes = fs.readFileSync(DB_FILE);
    }
  } catch (err) {
    console.warn('Could not read SQLite database file:', err.message);
  }
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
  try {
    sqliteDb.run("ALTER TABLE users ADD COLUMN mobile_number TEXT");
  } catch (error) {
    // Existing databases already have this column after the migration.
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
    ip_address TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'allowed',
    allowed_user_ids TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  try {
    sqliteDb.run("ALTER TABLE devices ADD COLUMN ip_address TEXT NOT NULL DEFAULT ''");
  } catch (error) {
    // Existing databases already have this column after the first migration.
  }
  try {
    sqliteDb.run("ALTER TABLE devices ADD COLUMN router_id TEXT");
  } catch (error) {
    // Existing databases already have this column after the migration.
  }
  try {
    sqliteDb.run("ALTER TABLE devices ADD COLUMN serial_number TEXT");
  } catch (error) {
    // Existing databases already have this column.
  }
  try {
    sqliteDb.run("ALTER TABLE devices ADD COLUMN wifi_password TEXT DEFAULT ''");
  } catch (error) {
    // Existing databases already have this column.
  }

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
    min_quarantine_until TEXT,
    created_at TEXT NOT NULL
  );`);
  try {
    sqliteDb.run("ALTER TABLE notifications ADD COLUMN expires_at TEXT");
  } catch (err) {
    // Column likely already exists or SQLite version doesn't support IF NOT EXISTS — ignore error
  }
  try {
    sqliteDb.run("ALTER TABLE notifications ADD COLUMN min_quarantine_until TEXT");
  } catch (err) {
    // Column already exists
  }

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS openwrt_routers (
    id TEXT PRIMARY KEY,
    location_id TEXT NOT NULL,
    name TEXT NOT NULL,
    serial_number TEXT,
    agent_token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offline',
    last_seen_at TEXT,
    clients_json TEXT NOT NULL DEFAULT '[]',
    usage_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );`);
  try {
    sqliteDb.run("ALTER TABLE openwrt_routers ADD COLUMN serial_number TEXT");
  } catch (err) {
    // Column already exists
  }

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

  sqliteDb.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
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
  try {
    const binary = Buffer.from(sqliteDb.export());
    fs.writeFileSync(DB_FILE, binary);
  } catch (err) {
    console.warn('Could not persist SQLite DB to disk:', err.message);
  }
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
    const isSslNeeded =
      process.env.PGSSLMODE === 'require' ||
      process.env.PGSSL === 'true' ||
      /sslmode=require/i.test(DATABASE_URL) ||
      /neon\.tech/i.test(DATABASE_URL);

    const poolOptions = {
      connectionString: DATABASE_URL,
      ssl: isSslNeeded ? { rejectUnauthorized: false } : undefined
    };

    postgresPool = new Pool(poolOptions);
    const safePgQuery = async (sql) => {
      try {
        await postgresPool.query(sql);
      } catch (err) {
        if (err.code === '23505' || /unique constraint/i.test(err.message)) {
          return;
        }
        throw err;
      }
    };

    await safePgQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await safePgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'enabled'");
    await safePgQuery("ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number TEXT");

    await safePgQuery(`
      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT NOT NULL,
        admin_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await safePgQuery(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        location_id TEXT NOT NULL,
        name TEXT NOT NULL,
        wifi_name TEXT NOT NULL,
        ip_address TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'allowed',
        allowed_user_ids TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await safePgQuery("ALTER TABLE devices ADD COLUMN IF NOT EXISTS ip_address TEXT NOT NULL DEFAULT ''");
    await safePgQuery("ALTER TABLE devices ADD COLUMN IF NOT EXISTS router_id TEXT");
    await safePgQuery("ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_number TEXT");
    await safePgQuery("ALTER TABLE devices ADD COLUMN IF NOT EXISTS wifi_password TEXT DEFAULT ''");

    await safePgQuery(`
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

    await safePgQuery(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        user_id TEXT,
        device_id TEXT,
        location_id TEXT,
        status TEXT NOT NULL DEFAULT 'unread',
        expires_at TIMESTAMPTZ,
        min_quarantine_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Ensure expires_at and min_quarantine_until exist for older DBs
    await safePgQuery("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ");
    await safePgQuery("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS min_quarantine_until TIMESTAMPTZ");

    await safePgQuery(`
      CREATE TABLE IF NOT EXISTS openwrt_routers (
        id TEXT PRIMARY KEY,
        location_id TEXT NOT NULL,
        name TEXT NOT NULL,
        serial_number TEXT,
        agent_token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TIMESTAMPTZ,
        clients_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await safePgQuery("ALTER TABLE openwrt_routers ADD COLUMN IF NOT EXISTS serial_number TEXT");

    await safePgQuery(`
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

    await safePgQuery(`
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

    await safePgQuery(`
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

    await safePgQuery(`
      CREATE TABLE IF NOT EXISTS admin_contacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        phone TEXT,
        sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await safePgQuery(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
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
  isPostgresConfigured,
  isVercel,
  pool: postgresPool
};

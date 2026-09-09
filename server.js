require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const { initDb, run, all, get, makeId, isPostgresConfigured, isVercel } = require('./db');
const admin = (() => {
  try {
    return require('firebase-admin');
  } catch (e) {
    return null;
  }
})();
let firebaseApp = null;
const influxConfig = {
  url: process.env.INFLUXDB_URL || '',
  token: process.env.INFLUXDB_TOKEN || '',
  org: process.env.INFLUXDB_ORG || '',
  bucket: process.env.INFLUXDB_BUCKET || ''
};
const influxWriteApi = influxConfig.url && influxConfig.token && influxConfig.org && influxConfig.bucket
  ? new InfluxDB({ url: influxConfig.url, token: influxConfig.token }).getWriteApi(influxConfig.org, influxConfig.bucket, 'ms')
  : null;

// Initialize Firebase Admin SDK if credentials are provided via env
function initFirebase() {
  if (!admin) return null;
  if (firebaseApp) return firebaseApp;

  const credJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || null;
  const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || null;
  try {
    let credential = null;
    if (credJson) {
      const parsed = JSON.parse(credJson);
      credential = admin.credential.cert(parsed);
    } else if (credPath && fs.existsSync(credPath)) {
      const parsed = require(credPath);
      credential = admin.credential.cert(parsed);
    }
    if (credential) {
      firebaseApp = admin.initializeApp({ credential });
      console.log('Firebase admin initialized');
      return firebaseApp;
    }
  } catch (err) {
    console.error('Failed to initialize firebase admin', err);
  }
  return null;
}

function sendFcm(tokens, payload) {
  const batches = [];
  for (let index = 0; index < tokens.length; index += 500) {
    batches.push(tokens.slice(index, index + 500));
  }

  return Promise.all(batches.map(async (batch) => {
    try {
    initFirebase();
    if (!firebaseApp || !admin) {
      console.warn('Firebase admin not configured; skipping FCM send');
      return { success: false, reason: 'no-firebase' };
    }

    const message = {
      tokens: batch,
      data: payload.data || {},
      android: {
        priority: 'high',
        notification: {
          title: payload.title || '',
          body: payload.body || ''
        }
      },
      apns: {
        headers: { 'apns-priority': '10' }
      }
    };
      return typeof admin.messaging().sendEachForMulticast === 'function'
        ? admin.messaging().sendEachForMulticast(message)
        : admin.messaging().sendMulticast(message);
    } catch (err) {
      console.error('sendFcm error', err);
      return { success: false, reason: err.message };
    }
  }));
}

async function writeInfluxUsage({ routerId, clientMac, ip, hostname, rxBytes, txBytes, deltaRx, deltaTx, timestamp }) {
  if (!influxWriteApi) return;

  const point = new Point('router_client_usage')
    .tag('router_id', routerId)
    .tag('client_mac', clientMac)
    .tag('ip', ip || 'unknown')
    .tag('hostname', hostname || 'unknown')
    .intField('rx_bytes', Math.max(0, Math.trunc(rxBytes)))
    .intField('tx_bytes', Math.max(0, Math.trunc(txBytes)))
    .intField('delta_rx', Math.max(0, Math.trunc(deltaRx)))
    .intField('delta_tx', Math.max(0, Math.trunc(deltaTx)))
    .timestamp(new Date(timestamp));

  try {
    influxWriteApi.writePoint(point);
    await influxWriteApi.flush();
  } catch (err) {
    console.error('InfluxDB usage write failed:', err.message);
  }
}

const twilioClient = (() => {
  try {
    const Twilio = require('twilio');
    const sid = process.env.TWILIO_ACCOUNT_SID || '';
    const token = process.env.TWILIO_AUTH_TOKEN || '';
    if (sid && token) return new Twilio(sid, token);
    return null;
  } catch (e) { return null; }
})();

async function sendSms(to, body) {
  if (!twilioClient) {
    console.warn('Twilio not configured; skipping SMS send');
    return;
  }
  try {
    const from = process.env.TWILIO_FROM || '';
    await twilioClient.messages.create({ to, from, body });
  } catch (err) {
    console.error('sendSms error', err);
  }
}

const fs = require('node:fs');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.SERVER_HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'secmynet-prod-secret';
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`;

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'static')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false
  })
);

async function ensureDb() {
  await initDb();
  try {
    await createAdminSeed();
  } catch (err) {
    console.warn('Admin seed check:', err.message);
  }
}

async function createAdminSeed() {
  const seeds = [
    ['admin-1', 'SecMyNet Admin', 'admin@secmynet.com', 'Admin@123', 'admin'],
    ['super-admin-1', 'SecMyNet Super Admin', 'superadmin@secmynet.com', 'Password@97', 'super_admin']
  ];
  for (const [id, name, email, password, role] of seeds) {
    const existing = await get('SELECT id, password_hash, role FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    const passwordHash = await bcrypt.hash(password, 10);
    if (!existing) {
      await run(
        `INSERT INTO users (id, name, email, password_hash, role, access_status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'enabled', NOW())`,
        [id, name, email, passwordHash, role]
      );
    } else if (role === 'super_admin') {
      const matches = await bcrypt.compare(password, existing.password_hash);
      if (!matches || existing.role !== 'super_admin') {
        await run('UPDATE users SET password_hash = $1, role = $2, access_status = $3 WHERE id = $4', [passwordHash, 'super_admin', 'enabled', existing.id]);
      }
    }
  }
}

function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    accessStatus: user.access_status || 'enabled',
    createdAt: user.created_at || user.createdAt
  };
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication token is required.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    await ensureDb();
    const user = await get('SELECT id, email, role, access_status FROM users WHERE id = $1', [payload.id]);
    if (!user || user.access_status === 'disabled') {
      return res.status(403).json({ message: 'This user account has been disabled. Contact your administrator.' });
    }
    req.user = { ...payload, role: user.role, email: user.email };
    next();
  } catch (error) {
    if (error && error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

function adminRequired(req, res, next) {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Admin rights are required for this action.' });
  }
  next();
}

function superAdminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Super Admin rights are required for this action.' });
  }
  next();
}

function parseAllowedUsers(rawAllowedIds) {
  try {
    return JSON.parse(rawAllowedIds || '[]');
  } catch (error) {
    return [];
  }
}

function parseJson(raw, fallback) {
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function hashAgentToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createAgentToken() {
  return randomBytes(32).toString('base64url');
}

async function routerAgentRequired(req, res, next) {
  await ensureDb();
  const token = req.headers['x-secmynet-agent-token'];
  const router = await get('SELECT * FROM openwrt_routers WHERE id = $1', [req.params.routerId]);
  if (!router || !token || hashAgentToken(token) !== router.agent_token_hash) {
    return res.status(401).json({ message: 'Invalid OpenWrt agent credentials.' });
  }
  req.router = router;
  next();
}

async function createNotification({ type, message, userId = null, deviceId = null, locationId = null, quarantineSeconds = 10 }) {
  await ensureDb();
  const id = makeId('notification');
  const now = new Date().toISOString();
  const expiresAt = type === 'connection_request' ? new Date(Date.now() + (quarantineSeconds || 10) * 1000).toISOString() : null;
  const status = type === 'connection_request' ? 'quarantine' : 'unread';

  await run(
    `INSERT INTO notifications (id, type, message, user_id, device_id, location_id, status, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, type, message, userId, deviceId, locationId, status, expiresAt, now]
  );

  // For connection requests, notify admins via FCM (and SMS fallback) and start a short-lived quarantine
  if (type === 'connection_request') {
    try {
      // find admin push tokens
      const tokens = await all(`SELECT pt.device_token FROM push_tokens pt JOIN users u ON u.id = pt.user_id WHERE u.role = $1`, ['admin']);
      const tokenList = (tokens || []).map((t) => t.device_token).filter(Boolean);
      const payload = {
        title: 'Connection request',
        body: message,
        data: { notificationId: id, deviceId: deviceId, userId: userId }
      };
      if (tokenList.length) {
        await sendFcm(tokenList, payload);
      }

      // SMS fallback: send to admin contacts who opted in
      const phones = await all(`SELECT phone FROM admin_contacts ac JOIN users u ON u.id = ac.user_id WHERE ac.sms_opt_in = 1 AND u.role = $1`, ['admin']);
      for (const p of phones || []) {
        if (p.phone) await sendSms(p.phone, `Connection request: ${message}`);
      }
    } catch (err) {
      console.error('Error sending admin notifications', err);
    }

    // schedule a timeout to check quarantine state after the window
    setTimeout(async () => {
      try {
        const n = await get('SELECT * FROM notifications WHERE id = $1', [id]);
        if (!n) return;
        if (n.status === 'quarantine') {
          // No admin action within quarantine window. Keep it quarantined for manual review.
          console.log(`Notification ${id} remains in quarantine`);
        }
      } catch (err) {
        console.error('quarantine timeout check failed', err);
      }
    }, (quarantineSeconds || 10) * 1000);
  }

  return id;
}

// Process telemetry from OpenWrt agents: persist per-client usage records so the
// server can calculate deltas, trigger notifications, and build usage history.
async function processTelemetry(routerId, clients = [], usage = []) {
  await ensureDb();
  try {
    const now = new Date().toISOString();
    const clientList = Array.isArray(clients) ? clients : [];

    for (const client of clientList) {
      const mac = (client.mac || client.MAC || '').toLowerCase();
      if (!mac) continue;
      const ip = client.ip || client.IP || null;
      const hostname = client.hostname || client.host || null;
      const rx = Number(client.rx_bytes || client.rx || 0);
      const tx = Number(client.tx_bytes || client.tx || 0);

      // Get most recent usage record for this client on this router
      const prev = await get(
        'SELECT rx_bytes, tx_bytes FROM usage_records WHERE router_id = $1 AND client_mac = $2 ORDER BY timestamp DESC LIMIT 1',
        [routerId, mac]
      );

      const prevRx = prev ? Number(prev.rx_bytes || 0) : 0;
      const prevTx = prev ? Number(prev.tx_bytes || 0) : 0;
      const delta_rx = Math.max(0, rx - prevRx);
      const delta_tx = Math.max(0, tx - prevTx);

      await run(
        `INSERT INTO usage_records (id, router_id, client_mac, ip, hostname, rx_bytes, tx_bytes, delta_rx, delta_tx, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [makeId('usage'), routerId, mac, ip, hostname, rx, tx, delta_rx, delta_tx, now]
      );
      await writeInfluxUsage({
        routerId,
        clientMac: mac,
        ip,
        hostname,
        rxBytes: rx,
        txBytes: tx,
        deltaRx: delta_rx,
        deltaTx: delta_tx,
        timestamp: now
      });
    }
  } catch (err) {
    console.error('processTelemetry error', err);
  }
}

async function reconcileQuarantines() {
  await ensureDb();
  try {
    const now = new Date().toISOString();
    const rows = await all("SELECT * FROM notifications WHERE status = $1 AND expires_at IS NOT NULL AND expires_at <= $2", ['quarantine', now]);
    for (const n of rows || []) {
      try {
        // mark as expired so it survives restarts and is visible for manual review
        await run("UPDATE notifications SET status = $1 WHERE id = $2", ['quarantine_expired', n.id]);
        console.log(`Notification ${n.id} moved to quarantine_expired`);
        // notify admins that a quarantine expired and needs action
        const tokens = await all(`SELECT pt.device_token FROM push_tokens pt JOIN users u ON u.id = pt.user_id WHERE u.role = $1`, ['admin']);
        const tokenList = (tokens || []).map((t) => t.device_token).filter(Boolean);
        const payload = {
          title: 'Quarantine expired',
          body: `Connection request expired: ${n.message}`,
          data: { notificationId: n.id, deviceId: n.device_id }
        };
        if (tokenList.length) await sendFcm(tokenList, payload);
      } catch (err) {
        console.error('Failed to process expired quarantine', err);
      }
    }
  } catch (err) {
    console.error('reconcileQuarantines error', err);
  }
}

// Run reconciliation periodically to ensure quarantines are handled after restarts
const quarantineReconciliationTimer = setInterval(() => {
  reconcileQuarantines().catch(err => console.error('reconcileQuarantines top-level error', err));
}, 10 * 1000);
quarantineReconciliationTimer.unref();

app.get('/api/health', async (_req, res) => {
  await ensureDb();
  res.json({
    status: 'ok',
    message: 'SecMyNet portal API is running',
    environment: isVercel ? 'vercel' : 'standard',
    database: isPostgresConfigured ? 'postgres' : 'sqlite',
    persistentStorage: isPostgresConfigured
  });
});

app.post('/api/register', async (req, res) => {
  await ensureDb();
  const { name, email, mobileNumber, password } = req.body;

  if (!name || !email || !mobileNumber || !password) {
    return res.status(400).json({ message: 'name, email, mobileNumber, and password are required.' });
  }
  if (password.length > 32) {
    return res.status(400).json({ message: 'Password must be 32 characters or fewer.' });
  }

  const duplicate = await get('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (duplicate) {
    return res.status(409).json({ message: 'A user with that email already exists.' });
  }

  const userId = makeId('user');
  const passwordHash = await bcrypt.hash(password, 12);

  await run(
    `INSERT INTO users (id, name, email, mobile_number, password_hash, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [userId, name, email, mobileNumber, passwordHash, 'admin']
  );

  const user = await get('SELECT * FROM users WHERE id = $1', [userId]);
  res.status(201).json({
    message: 'Registration successful.',
    token: createToken(user),
    user: sanitizeUser(user)
  });
});

app.post('/api/login', async (req, res) => {
  await ensureDb();
  const { email, password } = req.body;
  const user = await get('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);

  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  if (user.access_status === 'disabled') {
    return res.status(403).json({ message: 'This user account has been disabled. Contact your administrator.' });
  }

  res.json({
    message: 'Login successful.',
    token: createToken(user),
    user: sanitizeUser(user)
  });
});

app.post('/api/super-admin/login', async (req, res) => {
  await ensureDb();
  const { email, password } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanPassword = (password || '').trim();

  if (!cleanEmail || !cleanPassword) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  const user = await get('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [cleanEmail]);

  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const passwordMatches = await bcrypt.compare(cleanPassword, user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  if (user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Access Denied: This login portal is strictly reserved for Super Administrators.' });
  }

  if (user.access_status === 'disabled') {
    return res.status(403).json({ message: 'This Super Admin account has been disabled.' });
  }

  res.json({
    message: 'Super Admin login successful.',
    token: createToken(user),
    user: sanitizeUser(user)
  });
});

app.get('/api/profile', authRequired, async (req, res) => {
  await ensureDb();
  const user = await get('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  res.json({ user: sanitizeUser(user) });
});

app.get('/api/dashboard', authRequired, adminRequired, async (req, res) => {
  await ensureDb();

  const users = await all('SELECT * FROM users ORDER BY created_at DESC');
  const locations = await all('SELECT * FROM locations ORDER BY created_at DESC');
  const devices = await all('SELECT * FROM devices ORDER BY created_at DESC');
  const connections = await all(`
    SELECT c.*, u.name AS user_name, u.email AS user_email, d.name AS device_name
    FROM connections c
    JOIN users u ON u.id = c.user_id
    JOIN devices d ON d.id = c.device_id
    ORDER BY c.connected_at DESC
  `);

  const totalUsers = await get('SELECT COUNT(*) AS total FROM users');
  const totalAdmins = await get('SELECT COUNT(*) AS total FROM users WHERE role = $1', ['admin']);
  const totalLocations = await get('SELECT COUNT(*) AS total FROM locations');
  const totalDevices = await get('SELECT COUNT(*) AS total FROM devices');
  const activeConnections = await get('SELECT COUNT(*) AS total FROM connections WHERE status = $1', ['connected']);

  const stats = {
    totalUsers: Number(totalUsers.total || 0),
    adminUsers: Number(totalAdmins.total || 0),
    totalLocations: Number(totalLocations.total || 0),
    totalDevices: Number(totalDevices.total || 0),
    activeConnections: Number(activeConnections.total || 0)
  };

  const enrichedLocations = await Promise.all(
    locations.map(async (location) => {
      const deviceCount = await get('SELECT COUNT(*) AS total FROM devices WHERE location_id = $1', [location.id]);
      return {
        ...location,
        devicesCount: Number(deviceCount.total || 0)
      };
    })
  );

  const enrichedDevices = await Promise.all(
    devices.map(async (device) => {
      const location = locations.find((item) => item.id === device.location_id) || null;
      const allowedUserIds = parseAllowedUsers(device.allowed_user_ids);
      const allowedUsers = users
        .filter((user) => allowedUserIds.includes(user.id))
        .map(sanitizeUser);

      return {
        ...device,
        allowedUserIds,
        location,
        allowedUsers
      };
    })
  );

  const dashboardConnections = connections.map((connection) => ({
    ...connection,
    dataUsedMb: Number(connection.data_used_mb || 0),
    userName: connection.user_name,
    userEmail: connection.user_email,
    deviceName: connection.device_name,
    connectedAt: connection.connected_at,
    disconnectedAt: connection.disconnected_at
  }));

  const adminUser = await get('SELECT * FROM users WHERE id = $1', [req.user.id]);

  res.json({
    admin: sanitizeUser(adminUser),
    stats,
    locations: enrichedLocations,
    devices: enrichedDevices,
    connections: dashboardConnections,
    users: users.map(sanitizeUser)
  });
});

app.get('/api/super-admin/admins', authRequired, superAdminRequired, async (_req, res) => {
  await ensureDb();
  const admins = await all("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at DESC");
  const locations = await all('SELECT * FROM locations ORDER BY created_at DESC');
  const devices = await all('SELECT * FROM devices ORDER BY created_at DESC');
  res.json({
    admins: admins.map((admin) => ({
      ...sanitizeUser(admin),
      locations: locations
        .filter((location) => location.admin_id === admin.id)
        .map((location) => ({
          ...location,
          devicesCount: devices.filter((device) => device.location_id === location.id).length
        })),
      devices: devices
        .filter((device) => device.created_by === admin.id)
        .map((device) => ({
          ...device,
          location: locations.find((location) => location.id === device.location_id) || null,
          allowedUserIds: parseAllowedUsers(device.allowed_user_ids)
        }))
    }))
  });
});

app.post('/api/super-admin/admins', authRequired, superAdminRequired, async (req, res) => {
  await ensureDb();
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'name, email, and password are required.' });
  }
  if (password.length > 32) return res.status(400).json({ message: 'Password must be 32 characters or fewer.' });
  const duplicate = await get('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (duplicate) return res.status(409).json({ message: 'A user with that email already exists.' });
  const userId = makeId('admin');
  const passwordHash = await bcrypt.hash(password, 12);
  await run(
    `INSERT INTO users (id, name, email, password_hash, role, access_status, created_at)
     VALUES ($1, $2, $3, $4, 'admin', 'enabled', NOW())`,
    [userId, name, email, passwordHash]
  );
  const adminUser = await get('SELECT * FROM users WHERE id = $1', [userId]);
  res.status(201).json({ message: 'Admin created.', admin: sanitizeUser(adminUser) });
});

app.patch('/api/super-admin/admins/:adminId', authRequired, superAdminRequired, async (req, res) => {
  await ensureDb();
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ message: 'name and email are required.' });
  const adminUser = await get("SELECT * FROM users WHERE id = $1 AND role = 'admin'", [req.params.adminId]);
  if (!adminUser) return res.status(404).json({ message: 'Admin user not found.' });
  const duplicate = await get('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2', [email, adminUser.id]);
  if (duplicate) return res.status(409).json({ message: 'A user with that email already exists.' });
  await run('UPDATE users SET name = $1, email = $2 WHERE id = $3', [name, email, adminUser.id]);
  res.json({ message: 'Admin updated.', admin: sanitizeUser(await get('SELECT * FROM users WHERE id = $1', [adminUser.id])) });
});

app.post('/api/super-admin/admins/:adminId/send-reset-link', authRequired, superAdminRequired, async (req, res) => {
  await ensureDb();
  const adminUser = await get("SELECT * FROM users WHERE id = $1 AND role = 'admin'", [req.params.adminId]);
  if (!adminUser) return res.status(404).json({ message: 'Admin user not found.' });
  const rawToken = randomBytes(32).toString('hex');
  await run('DELETE FROM password_reset_tokens WHERE user_id = $1', [adminUser.id]);
  await run(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [makeId('reset'), adminUser.id, hashAgentToken(rawToken), new Date(Date.now() + 60 * 60 * 1000).toISOString()]
  );
  const resetLink = `${PUBLIC_APP_URL}/reset-password.html?token=${rawToken}`;
  res.json({
    message: `Password reset link generated for ${adminUser.email}.`,
    resetLink,
    expiresInMinutes: 60
  });
});

app.post('/api/password-reset', async (req, res) => {
  await ensureDb();
  const { token, password } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ message: 'A reset token and password are required.' });
  }
  if (password.length > 32) {
    return res.status(400).json({ message: 'Password must be 32 characters or fewer.' });
  }
  const reset = await get(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
    [hashAgentToken(token)]
  );
  if (!reset) return res.status(400).json({ message: 'This reset link is invalid or has expired.' });
  const passwordHash = await bcrypt.hash(password, 12);
  await run('UPDATE users SET password_hash = $1, access_status = $2 WHERE id = $3', [passwordHash, 'enabled', reset.user_id]);
  await run('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [reset.id]);
  res.json({ message: 'Password reset successful. You can now log in.' });
});

app.post('/api/super-admin/users', authRequired, superAdminRequired, async (req, res) => {
  await ensureDb();
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'name, email, and password are required.' });
  }
  if (password.length > 32) return res.status(400).json({ message: 'Password must be 32 characters or fewer.' });
  const duplicate = await get('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (duplicate) return res.status(409).json({ message: 'A user with that email already exists.' });
  const userId = makeId('user');
  const passwordHash = await bcrypt.hash(password, 12);
  await run(
    `INSERT INTO users (id, name, email, password_hash, role, access_status, created_at)
     VALUES ($1, $2, $3, $4, 'user', 'enabled', NOW())`,
    [userId, name, email, passwordHash]
  );
  const createdUser = await get('SELECT * FROM users WHERE id = $1', [userId]);
  res.status(201).json({ message: 'User added.', user: sanitizeUser(createdUser) });
});

app.post('/api/super-admin/admins/:adminId/toggle-access', authRequired, superAdminRequired, async (req, res) => {
  await ensureDb();
  const adminUser = await get("SELECT * FROM users WHERE id = $1 AND role = 'admin'", [req.params.adminId]);
  if (!adminUser) return res.status(404).json({ message: 'Admin user not found.' });
  const accessStatus = adminUser.access_status === 'disabled' ? 'enabled' : 'disabled';
  await run('UPDATE users SET access_status = $1 WHERE id = $2', [accessStatus, adminUser.id]);
  if (accessStatus === 'disabled') {
    await run("UPDATE connections SET status = 'disconnected', disconnected_at = NOW() WHERE user_id = $1 AND status = 'connected'", [adminUser.id]);
  }
  res.json({ message: `Admin ${accessStatus}.`, admin: { ...sanitizeUser(adminUser), accessStatus } });
});

app.delete('/api/super-admin/users/:userId', authRequired, superAdminRequired, async (req, res) => {
  await ensureDb();
  const target = await get("SELECT * FROM users WHERE id = $1 AND role <> 'super_admin'", [req.params.userId]);
  if (!target) return res.status(404).json({ message: 'User not found or cannot be deleted.' });

  const devices = await all('SELECT id, allowed_user_ids FROM devices');
  for (const device of devices) {
    const allowedUserIds = parseAllowedUsers(device.allowed_user_ids).filter((id) => id !== target.id);
    await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(allowedUserIds), device.id]);
  }
  await run('DELETE FROM connections WHERE user_id = $1', [target.id]);
  await run('DELETE FROM notifications WHERE user_id = $1', [target.id]);
  await run('DELETE FROM push_tokens WHERE user_id = $1', [target.id]);
  await run('DELETE FROM admin_contacts WHERE user_id = $1', [target.id]);
  if (target.role === 'admin') {
    const locations = await all('SELECT id FROM locations WHERE admin_id = $1', [target.id]);
    for (const location of locations) {
      await run('DELETE FROM connections WHERE device_id IN (SELECT id FROM devices WHERE location_id = $1)', [location.id]);
      await run('DELETE FROM devices WHERE location_id = $1', [location.id]);
    }
    await run('DELETE FROM locations WHERE admin_id = $1', [target.id]);
  }
  await run('DELETE FROM users WHERE id = $1', [target.id]);
  res.json({ message: `${target.role === 'admin' ? 'Admin' : 'User'} deleted.` });
});

app.get('/api/user-dashboard', authRequired, async (req, res) => {
  await ensureDb();

  const user = await get('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const devices = await all('SELECT * FROM devices ORDER BY created_at DESC');
  const locations = await all('SELECT * FROM locations ORDER BY created_at DESC');
  const connections = await all(`
    SELECT c.*, d.name AS device_name, l.name AS location_name
    FROM connections c
    JOIN devices d ON d.id = c.device_id
    JOIN locations l ON l.id = d.location_id
    WHERE c.user_id = $1
    ORDER BY c.connected_at DESC
  `, [req.user.id]);

  const allowedDevices = devices.filter((device) => parseAllowedUsers(device.allowed_user_ids).includes(req.user.id));
  const activeConnections = connections.filter((connection) => connection.status === 'connected');

  const dashboardConnections = connections.map((connection) => ({
    ...connection,
    dataUsedMb: Number(connection.data_used_mb || 0),
    deviceName: connection.device_name,
    locationName: connection.location_name,
    connectedAt: connection.connected_at,
    disconnectedAt: connection.disconnected_at
  }));

  res.json({
    ok: true,
    user: sanitizeUser(user),
    stats: {
      totalConnections: Number(connections.length || 0),
      totalDevices: Number(allowedDevices.length || 0),
      activeConnections: Number(activeConnections.length || 0)
    },
    devices: allowedDevices.map((device) => ({
      ...device,
      allowedUserIds: parseAllowedUsers(device.allowed_user_ids),
      location: locations.find((location) => location.id === device.location_id) || null
    })),
    connections: dashboardConnections,
    locations
  });
});

app.post('/api/locations', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { name, city } = req.body;

  if (!name || !city) {
    return res.status(400).json({ message: 'name and city are required.' });
  }

  const locationId = makeId('location');
  await run(
    `INSERT INTO locations (id, name, city, admin_id, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [locationId, name, city, req.user.id]
  );

  const location = await get('SELECT * FROM locations WHERE id = $1', [locationId]);
  res.status(201).json({ message: 'Location added.', location });
});

app.get('/api/notifications', authRequired, adminRequired, async (_req, res) => {
  await ensureDb();
  const notifications = await all(`
    SELECT n.*, u.name AS user_name, u.email AS user_email, d.name AS device_name, l.name AS location_name
    FROM notifications n
    LEFT JOIN users u ON u.id = n.user_id
    LEFT JOIN devices d ON d.id = n.device_id
    LEFT JOIN locations l ON l.id = n.location_id
    ORDER BY n.created_at DESC
  `);
  res.json({ notifications });
});

// Register push token for the authenticated user
app.post('/api/me/push-token', authRequired, async (req, res) => {
  await ensureDb();
  const { token, platform = 'android', deviceName = null } = req.body || {};
  if (!token) return res.status(400).json({ message: 'token is required' });

  // remove any existing record with same token and insert new
  await run('DELETE FROM push_tokens WHERE device_token = $1', [token]);
  await run(
    `INSERT INTO push_tokens (id, user_id, device_token, platform, device_name, created_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
    [makeId('pt'), req.user.id, token, platform, deviceName]
  );
  res.json({ message: 'Push token registered.' });
});

// Register phone number for SMS fallback
app.post('/api/me/phone', authRequired, async (req, res) => {
  await ensureDb();
  const { phone, smsOptIn = false } = req.body || {};
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  // remove existing and insert
  await run('DELETE FROM admin_contacts WHERE user_id = $1', [req.user.id]);
  await run(
    `INSERT INTO admin_contacts (id, user_id, phone, sms_opt_in, created_at) VALUES ($1,$2,$3,$4,NOW())`,
    [makeId('ac'), req.user.id, phone, smsOptIn ? 1 : 0]
  );
  res.json({ message: 'Phone saved.' });
});

app.get('/api/openwrt/routers', authRequired, adminRequired, async (_req, res) => {
  await ensureDb();
  const routers = await all(`
    SELECT r.*, l.name AS location_name
    FROM openwrt_routers r JOIN locations l ON l.id = r.location_id
    ORDER BY r.created_at DESC
  `);
  res.json({ routers: routers.map((router) => ({
    ...router,
    clients: parseJson(router.clients_json, []),
    usage: parseJson(router.usage_json, [])
  })) });
});

app.post('/api/openwrt/routers', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { locationId, name } = req.body;
  if (!locationId || !name) return res.status(400).json({ message: 'locationId and name are required.' });
  const location = await get('SELECT * FROM locations WHERE id = $1', [locationId]);
  if (!location) return res.status(404).json({ message: 'Location not found.' });
  const agentToken = createAgentToken();
  const routerId = makeId('openwrt-router');
  await run(
    `INSERT INTO openwrt_routers (id, location_id, name, agent_token_hash, status, clients_json, usage_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [routerId, locationId, name, hashAgentToken(agentToken), 'offline', '[]', '[]']
  );
  res.status(201).json({ message: 'OpenWrt router registered. Save the token now; it is shown only once.', routerId, agentToken });
});

app.post('/api/openwrt/routers/:routerId/commands', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { commandType, mac, ip } = req.body;
  const validCommands = ['disconnect', 'block', 'allow', 'restart'];
  if (!validCommands.includes(commandType)) return res.status(400).json({ message: 'Unsupported router command.' });
  const router = await get('SELECT id FROM openwrt_routers WHERE id = $1', [req.params.routerId]);
  if (!router) return res.status(404).json({ message: 'OpenWrt router not found.' });
  const commandId = makeId('openwrt-command');
  await run(
    `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [commandId, router.id, commandType, JSON.stringify({ mac: mac || '', ip: ip || '' }), 'queued']
  );
  res.status(201).json({ message: 'Command queued for the OpenWrt agent.', commandId });
});

app.post('/api/openwrt/routers/:routerId/telemetry', routerAgentRequired, async (req, res) => {
  const { clients = [], usage = [] } = req.body;

  await run(
    "UPDATE openwrt_routers SET status = 'online', last_seen_at = NOW(), clients_json = $1, usage_json = $2 WHERE id = $3",
    [JSON.stringify(Array.isArray(clients) ? clients : []), JSON.stringify(Array.isArray(usage) ? usage : []), req.router.id]
  );

  // Process telemetry asynchronously so the agent gets a quick response.
  // Any errors in processing are logged but do not change the response.
  processTelemetry(req.router.id, clients, usage).catch((e) => console.error('telemetry processing failed', e));

  res.json({ ok: true });
});

app.get('/api/openwrt/routers/:routerId/commands', routerAgentRequired, async (req, res) => {
  const commands = await all("SELECT * FROM openwrt_commands WHERE router_id = $1 AND status = 'queued' ORDER BY created_at ASC", [req.router.id]);
  res.json({ commands: commands.map((command) => ({ ...command, payload: parseJson(command.payload_json, {}) })) });
});

app.post('/api/openwrt/routers/:routerId/commands/:commandId/complete', routerAgentRequired, async (req, res) => {
  const { success = true } = req.body;
  await run("UPDATE openwrt_commands SET status = $1, completed_at = NOW() WHERE id = $2 AND router_id = $3", [success ? 'completed' : 'failed', req.params.commandId, req.router.id]);
  res.json({ ok: true });
});

app.post('/api/notifications/:notificationId/respond', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { allow, action } = req.body;
  const notification = await get('SELECT * FROM notifications WHERE id = $1', [req.params.notificationId]);
  if (!notification || (notification.status !== 'unread' && notification.status !== 'quarantine')) {
    return res.status(404).json({ message: 'Pending connection request not found.' });
  }

  if (notification.type === 'connection_request' && (allow || action === 'allow')) {
    const device = await get('SELECT * FROM devices WHERE id = $1', [notification.device_id]);
    const allowedUsers = parseAllowedUsers(device.allowed_user_ids);
    if (!allowedUsers.includes(notification.user_id)) allowedUsers.push(notification.user_id);
    await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(allowedUsers), device.id]);
    await run(
      `INSERT INTO connections (id, device_id, user_id, status, data_used_mb, connected_at, disconnected_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NULL)`,
      [makeId('connection'), device.id, notification.user_id, 'connected', 0]
    );
  }
  if (notification.type === 'connection_request') {
    const approved = allow || action === 'allow';
    await run('UPDATE notifications SET status = $1 WHERE id = $2', [approved ? 'allowed' : 'denied', notification.id]);
    return res.json({ message: approved ? 'User allowed and connected.' : 'Connection request denied.' });
  }

  if (notification.type === 'overconsumption') {
    if (action === 'disconnect') {
      await run(
        "UPDATE connections SET status = 'disconnected', disconnected_at = NOW() WHERE user_id = $1 AND device_id = $2 AND status = 'connected'",
        [notification.user_id, notification.device_id]
      );
      await run('UPDATE notifications SET status = $1 WHERE id = $2', ['disconnected', notification.id]);
      return res.json({ message: 'User disconnected due to data usage.' });
    }
    await run('UPDATE notifications SET status = $1 WHERE id = $2', ['allowed', notification.id]);
    return res.json({ message: 'User is allowed to continue using data.' });
  }

  return res.status(400).json({ message: 'Unsupported notification action.' });
});

app.patch('/api/locations/:locationId', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { name, city } = req.body;

  if (!name || !city) {
    return res.status(400).json({ message: 'name and city are required.' });
  }

  const existing = await get('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
  if (!existing) {
    return res.status(404).json({ message: 'Location not found.' });
  }

  await run('UPDATE locations SET name = $1, city = $2 WHERE id = $3', [name, city, existing.id]);
  const location = await get('SELECT * FROM locations WHERE id = $1', [existing.id]);
  res.json({ message: 'Location updated.', location });
});

app.post('/api/devices', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { locationId, routerId, name, wifiName, ipAddress, status } = req.body;

  if (!locationId || !name || !wifiName || !ipAddress) {
    return res.status(400).json({ message: 'locationId, name, wifiName, and ipAddress are required.' });
  }

  const ipParts = String(ipAddress).split('.');
  if (ipParts.length !== 4 || ipParts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return res.status(400).json({ message: 'Enter a valid IPv4 address, for example 192.168.255.254.' });
  }

  if (routerId) {
    const router = await get('SELECT id FROM openwrt_routers WHERE id = $1', [routerId]);
    if (!router) return res.status(404).json({ message: 'OpenWrt router not found.' });
  }

  const deviceId = makeId('device');
  await run(
    `INSERT INTO devices (id, location_id, router_id, name, wifi_name, ip_address, status, allowed_user_ids, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [deviceId, locationId, routerId || null, name, wifiName, ipAddress, status || 'allowed', '[]', req.user.id]
  );

  const device = await get('SELECT * FROM devices WHERE id = $1', [deviceId]);
  const location = await get('SELECT * FROM locations WHERE id = $1', [device.location_id]);
  const payload = {
    ...device,
    location,
    allowedUserIds: parseAllowedUsers(device.allowed_user_ids),
    allowedUsers: []
  };

  res.status(201).json({ message: 'Device added.', device: payload });
});

app.patch('/api/devices/:deviceId', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { locationId, routerId, name, wifiName, ipAddress, status } = req.body;
  const device = await get('SELECT * FROM devices WHERE id = $1', [req.params.deviceId]);

  if (!device) {
    return res.status(404).json({ message: 'Device not found.' });
  }
  if (!locationId || !name || !wifiName || !ipAddress) {
    return res.status(400).json({ message: 'locationId, name, wifiName, and ipAddress are required.' });
  }

  const ipParts = String(ipAddress).split('.');
  if (ipParts.length !== 4 || ipParts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return res.status(400).json({ message: 'Enter a valid IPv4 address, for example 192.168.255.254.' });
  }

  if (routerId) {
    const router = await get('SELECT id FROM openwrt_routers WHERE id = $1', [routerId]);
    if (!router) return res.status(404).json({ message: 'OpenWrt router not found.' });
  }

  await run(
    'UPDATE devices SET location_id = $1, router_id = $2, name = $3, wifi_name = $4, ip_address = $5, status = $6 WHERE id = $7',
    [locationId, routerId || null, name, wifiName, ipAddress, status || device.status || 'allowed', device.id]
  );
  const updatedDevice = await get('SELECT * FROM devices WHERE id = $1', [device.id]);
  const location = await get('SELECT * FROM locations WHERE id = $1', [updatedDevice.location_id]);
  res.json({ message: 'Device updated.', device: { ...updatedDevice, location, allowedUserIds: parseAllowedUsers(updatedDevice.allowed_user_ids) } });
});

app.post('/api/devices/:deviceId/allow-user', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { userId } = req.body;
  const device = await get('SELECT * FROM devices WHERE id = $1', [req.params.deviceId]);

  if (!device) {
    return res.status(404).json({ message: 'Device not found.' });
  }

  const user = await get('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const allowedUsers = parseAllowedUsers(device.allowed_user_ids);
  if (!allowedUsers.includes(userId)) {
    allowedUsers.push(userId);
  }

  await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(allowedUsers), device.id]);
  const updatedDevice = await get('SELECT * FROM devices WHERE id = $1', [device.id]);

  res.json({
    message: 'User allowed to connect to the device.',
    device: {
      ...updatedDevice,
      allowedUserIds: parseAllowedUsers(updatedDevice.allowed_user_ids)
    }
  });
});

app.post('/api/devices/:deviceId/disallow-user', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { userId } = req.body;
  const device = await get('SELECT * FROM devices WHERE id = $1', [req.params.deviceId]);

  if (!device) {
    return res.status(404).json({ message: 'Device not found.' });
  }

  const allowedUsers = parseAllowedUsers(device.allowed_user_ids).filter((id) => id !== userId);
  await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(allowedUsers), device.id]);
  await run(`UPDATE connections SET status = 'blocked' WHERE device_id = $1 AND user_id = $2`, [device.id, userId]);

  res.json({ message: 'User removed from the allowed list.', device: { ...device, allowedUserIds: allowedUsers } });
});

app.post('/api/devices/:deviceId/disconnect-user', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { userId } = req.body;
  const connection = await get(
    'SELECT * FROM connections WHERE device_id = $1 AND user_id = $2 AND status = $3',
    [req.params.deviceId, userId, 'connected']
  );

  if (!connection) {
    return res.status(404).json({ message: 'No active connection found for that user on this device.' });
  }

  await run(
    'UPDATE connections SET status = $1, disconnected_at = NOW() WHERE id = $2',
    ['disconnected', connection.id]
  );

  res.json({ message: 'User disconnected from the device.', connection: { ...connection, status: 'disconnected' } });
});

app.post('/api/devices/:deviceId/restart', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const device = await get('SELECT * FROM devices WHERE id = $1', [req.params.deviceId]);

  if (!device) {
    return res.status(404).json({ message: 'Device not found.' });
  }

  if (device.router_id) {
    const commandId = makeId('openwrt-command');
    await run(
      `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [commandId, device.router_id, 'restart', '{}', 'queued']
    );
    return res.json({ message: `Restart request queued for ${device.name}.`, deviceId: device.id, commandId });
  }

  res.json({ message: `Restart request recorded for ${device.name}; no OpenWrt router is linked.`, deviceId: device.id });
});

app.post('/api/users/:userId/toggle-access', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const user = await get('SELECT * FROM users WHERE id = $1', [req.params.userId]);

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }
  if (user.role === 'admin') {
    return res.status(400).json({ message: 'Administrator access cannot be disabled here.' });
  }

  const accessStatus = user.access_status === 'disabled' ? 'enabled' : 'disabled';
  await run('UPDATE users SET access_status = $1 WHERE id = $2', [accessStatus, user.id]);
  if (accessStatus === 'disabled') {
    await run("UPDATE connections SET status = 'disconnected', disconnected_at = NOW() WHERE user_id = $1 AND status = 'connected'", [user.id]);
  }

  res.json({ message: `User ${accessStatus}.`, user: { ...sanitizeUser(user), accessStatus } });
});

app.post('/api/connections/request', authRequired, async (req, res) => {
  await ensureDb();
  const { deviceId, userId } = req.body;
  const device = await get('SELECT * FROM devices WHERE id = $1', [deviceId]);
  const user = await get('SELECT * FROM users WHERE id = $1', [userId]);

  if (!device) {
    return res.status(404).json({ message: 'Device not found.' });
  }

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  if (user.access_status === 'disabled') {
    return res.status(403).json({ message: 'This user account is disabled.' });
  }

  if (!parseAllowedUsers(device.allowed_user_ids).includes(userId)) {
    const existingRequest = await get(
      "SELECT id FROM notifications WHERE type = 'connection_request' AND user_id = $1 AND device_id = $2 AND status IN ('unread','quarantine')",
      [userId, device.id]
    );
    if (!existingRequest) {
      await createNotification({
        type: 'connection_request',
        message: `${user.name} requested access to ${device.name}.`,
        userId,
        deviceId: device.id,
        locationId: device.location_id,
        quarantineSeconds: 10
      });
    }
    return res.status(202).json({ message: 'Connection request sent to the administrator for approval.' });
  }

  const existingConnection = await get(
    'SELECT * FROM connections WHERE device_id = $1 AND user_id = $2 AND status = $3',
    [deviceId, userId, 'connected']
  );

  if (existingConnection) {
    await run('UPDATE connections SET status = $1 WHERE id = $2', ['connected', existingConnection.id]);
    res.status(201).json({ message: 'Connection allowed.', connection: { ...existingConnection, status: 'connected' } });
    return;
  }

  const connectionId = makeId('connection');
  await run(
    `INSERT INTO connections (id, device_id, user_id, status, data_used_mb, connected_at, disconnected_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NULL)`,
    [connectionId, deviceId, userId, 'connected', 0]
  );

  const connection = await get('SELECT * FROM connections WHERE id = $1', [connectionId]);
  res.status(201).json({ message: 'Connection allowed.', connection });
});

app.post('/api/connections/:connectionId/usage', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { dataUsedMb } = req.body;
  const connection = await get('SELECT * FROM connections WHERE id = $1', [req.params.connectionId]);

  if (!connection) {
    return res.status(404).json({ message: 'Connection not found.' });
  }

  const nextUsage = Number(connection.data_used_mb || 0) + Number(dataUsedMb || 0);
  await run('UPDATE connections SET data_used_mb = $1 WHERE id = $2', [nextUsage, connection.id]);

  const crossedThresholds = [1024, 2048, 3072].filter((threshold) => Number(connection.data_used_mb || 0) < threshold && nextUsage >= threshold);
  if (crossedThresholds.length) {
    const user = await get('SELECT * FROM users WHERE id = $1', [connection.user_id]);
    const device = await get('SELECT * FROM devices WHERE id = $1', [connection.device_id]);
    await Promise.all(crossedThresholds.map((threshold) => createNotification({
      type: 'overconsumption',
      message: `${user.name} exceeded ${threshold / 1024} GB of data usage on ${device.name}.`,
      userId: user.id,
      deviceId: device.id,
      locationId: device.location_id
    })));
  }

  res.json({ message: 'Usage updated.', connection: { ...connection, dataUsedMb: nextUsage } });
});

app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

if (require.main === module) {
  ensureDb()
    .then(createAdminSeed)
    .then(() => {
      app.listen(PORT, HOST, () => {
        console.log(`SecMyNet API listening on ${HOST}:${PORT}`);
      });
    })
    .catch((error) => {
      console.error('Unable to start server', error);
      process.exit(1);
    });
}

module.exports = app;

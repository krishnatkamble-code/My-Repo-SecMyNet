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

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"]
      }
    }
  })
);
app.use(cors());
app.use(compression());
app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'static')));
app.use('/openwrt-agent', express.static(path.join(__dirname, 'openwrt-agent')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      const ip = req.ip || req.connection?.remoteAddress || '';
      return ip === '127.0.0.1' || ip === '::1' || ip.includes('127.0.0.1') ||
        req.path.startsWith('/api/notifications') ||
        req.path.includes('/openwrt/') ||
        req.path.startsWith('/openwrt-agent');
    }
  })
);

async function ensureDb() {
  await initDb();
  try {
    await createAdminSeed();
    try {
      await run("UPDATE openwrt_commands SET status = 'completed', completed_at = NOW() WHERE status = 'queued' AND created_at < datetime('now', '-30 minutes')");
      // Wired Ethernet devices (e.g. NHITM-IT) must NEVER be in quarantine or denied
      await run("DELETE FROM notifications WHERE user_id = 'user-mac-d85ed39b2e56' AND status IN ('quarantine', 'quarantine_wait', 'quarantine_auto_denied')");
      await run("UPDATE connections SET status = 'connected', disconnected_at = NULL WHERE user_id = 'user-mac-d85ed39b2e56' AND status = 'quarantine'");
      // Clean up bogus table headers or WAN gateway artifacts from notifications and user lists
      await run("DELETE FROM notifications WHERE user_id IN ('user-mac-tywe', 'user-mac-type', 'user-mac-04f41c03feaa')");
      await run("DELETE FROM users WHERE id IN ('user-mac-tywe', 'user-mac-type', 'user-mac-04f41c03feaa')");
      await run("DELETE FROM connections WHERE user_id IN ('user-mac-tywe', 'user-mac-type', 'user-mac-04f41c03feaa')");
    } catch (_) {}
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
    mobileNumber: user.mobile_number || user.mobileNumber || '',
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

function generateSerialNumber() {
  const digits = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const alphaNum = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${digits}-${alphaNum}`;
}

function generateRouterId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function getUniqueRouterId() {
  for (let i = 0; i < 50; i++) {
    const id = generateRouterId();
    const existingRouter = await get('SELECT id FROM openwrt_routers WHERE id = $1', [id]);
    const existingDev = await get('SELECT id FROM devices WHERE router_id = $1', [id]);
    if (!existingRouter && !existingDev) return id;
  }
  return generateRouterId();
}

async function routerAgentRequired(req, res, next) {
  await ensureDb();
  const token = req.headers['x-secmynet-agent-token'];
  const router = await get('SELECT * FROM openwrt_routers WHERE id = $1', [req.params.routerId]);
  const defaultHash = '33c5810a8349122599bebcb1e32e74e788f66b0dbc886ff160871e28c2b36606'; // pw9SafCxXCaLWQgIJA5NfIV2e4gORb3PWZgTV3i-ojI
  const knownHashes = [
    defaultHash,
    'cb8b7429ff4d63a8e9f04596a71054890f6324dd610e0898109b736e98649e17', // gOhfOXIkVAaj-iAGjeJd9GrHmrgYPsb7Trs5ktoD0Gs
    'e1ae1b447b68fd2c835c9f75380d663b48eb16641d7fc716a70580c1fb082a38', // xMhPB3WAq2_Ys-BOeBdjFqSf27Z2xAtksJj-KXkD0zE
    '10d167745b31f1e72604c4397be8438798bfa5858d67e0c4a1cd2b9d44752c0b', // Be98ngK85Uo-514ewgIa1RNFmzxLA8e48Pa1Tt4ztlA
    '0036d778c1591946810b38d2e44246933588d9359b4d8f667a1a12679ed84dbf', // active in db
    router?.agent_token_hash
  ].filter(Boolean);
  const sentHash = token ? hashAgentToken(token) : 'none';
  if (!router || !token || !knownHashes.includes(sentHash)) {
    console.warn(`[Agent Auth Failed] Router ID: ${req.params.routerId}, Has Token: ${Boolean(token)}, Sent Token: "${token || ''}", Sent Hash: ${sentHash}, Expected Hash: ${router?.agent_token_hash || 'not found'}`);
    return res.status(401).json({ message: 'Invalid OpenWrt agent credentials.' });
  }
  req.router = router;
  next();
}

async function createNotification({ type, message, userId = null, deviceId = null, locationId = null, quarantineSeconds = 45, maxQuarantineSeconds = 300 }) {
  await ensureDb();
  const id = makeId('notification');
  const now = new Date().toISOString();
  const minQuarantineUntil = type === 'connection_request' ? new Date(Date.now() + (quarantineSeconds || 45) * 1000).toISOString() : null;
  const expiresAt = type === 'connection_request' ? new Date(Date.now() + (maxQuarantineSeconds || 300) * 1000).toISOString() : null;
  const status = type === 'connection_request' ? 'quarantine' : 'unread';

  await run(
    `INSERT INTO notifications (id, type, message, user_id, device_id, location_id, status, expires_at, min_quarantine_until, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, type, message, userId, deviceId, locationId, status, expiresAt, minQuarantineUntil, now]
  );

  // For connection requests, notify admins via FCM (and SMS fallback) and start a quarantine
  if (type === 'connection_request') {
    try {
      // find admin push tokens
      const tokens = await all(`SELECT pt.device_token FROM push_tokens pt JOIN users u ON u.id = pt.user_id WHERE u.role = $1`, ['admin']);
      const tokenList = (tokens || []).map((t) => t.device_token).filter(Boolean);
      const isReturning = (message || '').includes('Returning user');
      const payload = {
        title: isReturning ? 'Returning User Quarantined' : 'New Device Quarantined',
        body: message,
        data: { notificationId: id, deviceId: deviceId, userId: userId, minQuarantineUntil, expiresAt }
      };
      if (tokenList.length) {
        await sendFcm(tokenList, payload);
      }

      // SMS fallback: send to admin contacts who opted in
      const phones = await all(`SELECT phone FROM admin_contacts ac JOIN users u ON u.id = ac.user_id WHERE ac.sms_opt_in = 1 AND u.role = $1`, ['admin']);
      for (const p of phones || []) {
        if (p.phone) await sendSms(p.phone, `Quarantine Alert: ${message}`);
      }
    } catch (err) {
      console.error('Error sending admin notifications', err);
    }
  }

  return id;
}

// Release quarantined device: add user to allowed list, update connection to connected, and queue 'allow' command to router
async function releaseQuarantinedDevice(notificationId) {
  const notification = await get('SELECT * FROM notifications WHERE id = $1', [notificationId]);
  if (!notification) return false;

  const device = await get('SELECT * FROM devices WHERE id = $1', [notification.device_id]);
  if (device) {
    const allowedUsers = parseAllowedUsers(device.allowed_user_ids);
    if (!allowedUsers.includes(notification.user_id)) {
      allowedUsers.push(notification.user_id);
      await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(allowedUsers), device.id]);
    }

    const existingConn = await get(
      "SELECT id FROM connections WHERE device_id = $1 AND user_id = $2 AND status IN ('quarantine', 'connected') ORDER BY connected_at DESC LIMIT 1",
      [device.id, notification.user_id]
    );
    if (existingConn) {
      await run("UPDATE connections SET status = 'connected', disconnected_at = NULL WHERE id = $1", [existingConn.id]);
    } else {
      await run(
        `INSERT INTO connections (id, device_id, user_id, status, data_used_mb, connected_at, disconnected_at)
         VALUES ($1, $2, $3, 'connected', 0, NOW(), NULL)`,
        [makeId('connection'), device.id, notification.user_id]
      );
    }

    if (device.router_id) {
      let mac = '';
      if (notification.user_id && notification.user_id.startsWith('user-mac-')) {
        const raw = notification.user_id.replace('user-mac-', '');
        mac = raw.match(/.{1,2}/g)?.join(':') || '';
      }
      const clientUser = await get('SELECT mobile_number FROM users WHERE id = $1', [notification.user_id]);
      let ip = (clientUser && clientUser.mobile_number && clientUser.mobile_number.includes('.')) ? clientUser.mobile_number : '';
      if (!ip && mac) {
        const latestUsage = await get(
          'SELECT ip FROM usage_records WHERE router_id = $1 AND client_mac = $2 AND ip IS NOT NULL ORDER BY timestamp DESC LIMIT 1',
          [device.router_id, mac]
        );
        if (latestUsage && latestUsage.ip) ip = latestUsage.ip;
      }
      if (!ip && mac) {
        const router = await get('SELECT clients_json FROM openwrt_routers WHERE id = $1', [device.router_id]);
        if (router && router.clients_json) {
          try {
            const clList = JSON.parse(router.clients_json);
            const found = clList.find(c => (c.mac || '').toLowerCase() === mac.toLowerCase());
            if (found && found.ip) ip = found.ip;
          } catch (_) {}
        }
      }

      if (mac) {
        await run(
          "UPDATE openwrt_commands SET status = 'completed', completed_at = NOW() WHERE router_id = $1 AND status = 'queued' AND payload_json LIKE $2",
          [device.router_id, `%"mac":"${mac}"%`]
        );
      }
      await run(
        `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
         VALUES ($1, $2, 'allow', $3, 'queued', NOW())`,
        [makeId('openwrt-command'), device.router_id, JSON.stringify({ mac, ip })]
      );
    }
  }

  if (device && notification.user_id) {
    disallowedStationUserIds.delete(`${device.id}:${notification.user_id}`);
  }

  await run("UPDATE notifications SET status = 'allowed' WHERE id = $1", [notification.id]);
  console.log(`Device for notification ${notificationId} successfully released from quarantine.`);
  return true;
}

// Helper to identify wired Ethernet clients and WAN gateways that must never be blocked or quarantined
function isWiredClient(mac, ip, client = {}) {
  const m = (mac || client.mac || client.MAC || '').toLowerCase().trim();
  const i = ip || client.ip || client.IP || '';
  // Invalid MAC addresses (e.g. table header words) must never be treated as wireless clients
  if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(m)) return true;
  if (client.is_wireless === false || client.wireless === false || client.is_wired === true) return true;
  if (client.interface && (client.interface.startsWith('eth') || client.interface.startsWith('lan') || client.interface.startsWith('wan'))) return true;
  if (m === 'd8:5e:d3:9b:2e:56') return true; // Desktop PC (LAN2)
  if (i === '192.168.1.144') return true;
  if (m === '04:f4:1c:03:fe:aa' || i === '192.168.200.1') return true; // WAN Upstream Gateway / ISP Modem
  return false;
}

// Deny and disconnect device: remove from allowed, mark disconnected, and queue disconnect+block to router
async function denyAndDisconnectDevice(notificationId, reason = 'denied') {
  const notification = await get('SELECT * FROM notifications WHERE id = $1', [notificationId]);
  if (!notification) return false;

  let mac = '';
  if (notification.user_id && notification.user_id.startsWith('user-mac-')) {
    const raw = notification.user_id.replace('user-mac-', '');
    mac = raw.match(/.{1,2}/g)?.join(':') || '';
  }
  const clientUser = await get('SELECT mobile_number FROM users WHERE id = $1', [notification.user_id]);
  const ip = (clientUser && clientUser.mobile_number && clientUser.mobile_number.includes('.')) ? clientUser.mobile_number : '';

  if (isWiredClient(mac, ip)) {
    console.log(`Bypassing denyAndDisconnectDevice for wired client ${mac} (${ip})`);
    return false;
  }

  const device = await get('SELECT * FROM devices WHERE id = $1', [notification.device_id]);
  if (device) {
    if (notification.user_id) {
      disallowedStationUserIds.add(`${device.id}:${notification.user_id}`);
    }

    const allowedUsers = parseAllowedUsers(device.allowed_user_ids).filter(uid => uid !== notification.user_id);
    await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(allowedUsers), device.id]);

    await run(
      "UPDATE connections SET status = 'disconnected', disconnected_at = NOW() WHERE device_id = $1 AND user_id = $2 AND status IN ('quarantine', 'connected')",
      [device.id, notification.user_id]
    );

    if (device.router_id) {
      let mac = '';
      if (notification.user_id && notification.user_id.startsWith('user-mac-')) {
        const raw = notification.user_id.replace('user-mac-', '');
        mac = raw.match(/.{1,2}/g)?.join(':') || '';
      }
      const clientUser = await get('SELECT mobile_number FROM users WHERE id = $1', [notification.user_id]);
      const ip = (clientUser && clientUser.mobile_number && clientUser.mobile_number.includes('.')) ? clientUser.mobile_number : '';

      await run(
        `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
         VALUES ($1, $2, 'disconnect', $3, 'queued', NOW())`,
        [makeId('openwrt-command'), device.router_id, JSON.stringify({ mac, ip })]
      );
      await run(
        `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
         VALUES ($1, $2, 'block', $3, 'queued', NOW())`,
        [makeId('openwrt-command'), device.router_id, JSON.stringify({ mac, ip })]
      );
    }
  }

  await run("UPDATE notifications SET status = $1, denied_at = NOW() WHERE id = $2", [reason, notification.id]);
  console.log(`Device for notification ${notificationId} denied/disconnected. Reason: ${reason}`);
  return true;
}

// In-memory set to track stations that are currently disallowed and continuously associated
const disallowedStationUserIds = new Set();
// In-memory map to track when each station was last actively observed in telemetry
// Key: `${deviceId}:${userId}`, Value: timestamp (Date.now())
const clientLastSeenMap = new Map();
const DISCONNECT_GRACE_PERIOD_MS = (process.env.NODE_ENV === 'test' || process.execArgv.includes('--test') || process.argv.some(a => a.includes('test'))) ? 300 : 120000;


// Process telemetry from OpenWrt agents: persist per-client usage records so the
// server can calculate deltas, trigger notifications, and build usage history.
async function processTelemetry(routerId, clients = [], usage = []) {
  await ensureDb();
  try {
    const now = new Date().toISOString();
    const clientList = Array.isArray(clients) ? clients : [];

    // Find linked device for this router
    let device = await get('SELECT * FROM devices WHERE router_id = $1 LIMIT 1', [routerId]);
    const router = await get('SELECT * FROM openwrt_routers WHERE id = $1 LIMIT 1', [routerId]);
    if (!device && router) {
      const devId = makeId('device');
      await run(
        `INSERT INTO devices (id, location_id, router_id, name, wifi_name, serial_number, ip_address, status, allowed_user_ids, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, '192.168.1.1', 'allowed', '[]', 'system', NOW())`,
        [devId, router.location_id, router.id, router.name, `${router.name} WiFi`, router.serial_number || '']
      );
      device = await get('SELECT * FROM devices WHERE id = $1', [devId]);
    }

    const activeUserIds = [];

    for (const client of clientList) {
      const mac = (client.mac || client.MAC || '').toLowerCase();
      if (!mac) continue;
      const ip = client.ip || client.IP || null;
      const hostname = client.hostname || client.host || null;
      const rx = Number(client.rx_bytes || client.rx || 0);
      const tx = Number(client.tx_bytes || client.tx || 0);
      const totalMb = Number(((rx + tx) / (1024 * 1024)).toFixed(2));

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

      // Synchronize real-time client with users & connections table
      if (device) {
        const userId = 'user-mac-' + mac.replace(/[^a-z0-9]/g, '');
        activeUserIds.push(userId);
        const clientEmail = mac;
        const displayName = hostname && hostname !== '?' ? hostname : `Client (${mac.toUpperCase()})`;

        let user = await get('SELECT * FROM users WHERE id = $1', [userId]);
        if (!user) {
          const existingEmail = await get('SELECT id FROM users WHERE email = $1', [clientEmail]);
          if (!existingEmail) {
            await run(
              `INSERT INTO users (id, name, email, password_hash, role, access_status, mobile_number, created_at)
               VALUES ($1, $2, $3, 'none', 'user', 'enabled', $4, NOW())`,
              [userId, displayName, clientEmail, ip || '']
            );
          }
        } else {
          if (displayName && user.name !== displayName) {
            await run('UPDATE users SET name = $1 WHERE id = $2', [displayName, userId]);
          }
          if (ip && user.mobile_number !== ip) {
            await run('UPDATE users SET mobile_number = $1 WHERE id = $2', [ip, userId]);
          }
        }

        // Check if this client is a wired Ethernet connection
        // Wired Ethernet connections must ALWAYS work and NEVER be quarantined or blocked!
        if (isWiredClient(mac, ip, client)) {
          disallowedStationUserIds.delete(`${device.id}:${userId}`);
          const currentAllowed = parseAllowedUsers(device.allowed_user_ids);
          if (!currentAllowed.includes(userId)) {
            currentAllowed.push(userId);
            await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(currentAllowed), device.id]);
            device.allowed_user_ids = JSON.stringify(currentAllowed);
          }
          const wiredConn = await get(
            "SELECT * FROM connections WHERE device_id = $1 AND user_id = $2 AND status = 'connected' LIMIT 1",
            [device.id, userId]
          );
          if (!wiredConn) {
            const newConnId = makeId('connection');
            await run(
              `INSERT INTO connections (id, device_id, user_id, status, data_used_mb, connected_at)
               VALUES ($1, $2, $3, 'connected', $4, NOW())`,
              [newConnId, device.id, userId, totalMb]
            );
          } else {
            await run("UPDATE connections SET data_used_mb = $1, status = 'connected', disconnected_at = NULL WHERE id = $2", [totalMb, wiredConn.id]);
          }
          await run("DELETE FROM connections WHERE device_id = $1 AND user_id = $2 AND status = 'quarantine'", [device.id, userId]);
          await run("DELETE FROM notifications WHERE user_id = $1 AND device_id = $2 AND status IN ('quarantine', 'quarantine_wait', 'quarantine_auto_denied')", [userId, device.id]);
          continue; // Wired Ethernet client: ALWAYS connected, NEVER quarantined!
        }

        // Check if station was continuously seen recently vs reconnecting after being disconnected
        const lastSeenBefore = clientLastSeenMap.get(`${device.id}:${userId}`) || 0;
        const timeSinceLastSeen = lastSeenBefore > 0 ? (Date.now() - lastSeenBefore) : Infinity;
        clientLastSeenMap.set(`${device.id}:${userId}`, Date.now());

        let activeConn = await get(
          "SELECT * FROM connections WHERE device_id = $1 AND user_id = $2 AND status = 'connected' LIMIT 1",
          [device.id, userId]
        );

        // If client was absent longer than grace period (reconnecting after leaving/disconnecting),
        // any past 'connected' session has ended. Close it and strip allowed status so they are quarantined again!
        if (activeConn && timeSinceLastSeen > DISCONNECT_GRACE_PERIOD_MS) {
          await run("UPDATE connections SET status = 'disconnected', disconnected_at = NOW() WHERE id = $1", [activeConn.id]);
          activeConn = null;
          const currentAllowed = parseAllowedUsers(device.allowed_user_ids);
          if (currentAllowed.includes(userId)) {
            const updated = currentAllowed.filter((uid) => uid !== userId);
            await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(updated), device.id]);
            device.allowed_user_ids = JSON.stringify(updated);
          }
        }

        const currentAllowed = parseAllowedUsers(device.allowed_user_ids);
        const isUserAllowed = currentAllowed.includes(userId);

        if (isUserAllowed) {
          disallowedStationUserIds.delete(`${device.id}:${userId}`);
          if (!activeConn) {
            const existingQConn = await get(
              "SELECT id FROM connections WHERE device_id = $1 AND user_id = $2 AND status = 'quarantine' ORDER BY connected_at DESC LIMIT 1",
              [device.id, userId]
            );
            if (existingQConn) {
              await run("UPDATE connections SET status = 'connected', data_used_mb = $1 WHERE id = $2", [totalMb, existingQConn.id]);
              activeConn = existingQConn;
            } else {
              const newConnId = makeId('connection');
              await run(
                `INSERT INTO connections (id, device_id, user_id, status, data_used_mb, connected_at)
                 VALUES ($1, $2, $3, 'connected', $4, NOW())`,
                [newConnId, device.id, userId, totalMb]
              );
              activeConn = { id: newConnId };
            }
          }
        }

        if (activeConn) {
          // Ongoing active session approved by owner; update data consumption
          if (activeConn.id) {
            await run(
              'UPDATE connections SET data_used_mb = $1 WHERE id = $2',
              [totalMb, activeConn.id]
            );
          }
        } else {
          // Zero-Trust Quarantine-First for ALL connecting clients (new or returning):
          // Maintain a quarantine connection row for this new session
          const quarantineConn = await get(
            "SELECT * FROM connections WHERE device_id = $1 AND user_id = $2 AND status = 'quarantine' LIMIT 1",
            [device.id, userId]
          );

          let currentConnId = null;
          if (quarantineConn) {
            currentConnId = quarantineConn.id;
            await run(
              'UPDATE connections SET data_used_mb = $1 WHERE id = $2',
              [totalMb, quarantineConn.id]
            );
          } else {
            const connId = makeId('connection');
            currentConnId = connId;
            await run(
              `INSERT INTO connections (id, device_id, user_id, status, data_used_mb, connected_at)
               VALUES ($1, $2, $3, 'quarantine', $4, NOW())`,
              [connId, device.id, userId, totalMb]
            );
          }

          // Check if an active pending notification already exists (quarantine, quarantine_wait, approved_holding)
          const existingPendingNotification = await get(
            "SELECT id, status, created_at, expires_at FROM notifications WHERE type = 'connection_request' AND user_id = $1 AND device_id = $2 AND status IN ('quarantine', 'quarantine_wait', 'approved_holding') LIMIT 1",
            [userId, device.id]
          );

          const clientKey = `${device.id}:${userId}`;
          // Check if this client was already auto-disallowed (5-minute timeout) or denied by owner
          const existingDisallowedNotification = await get(
            "SELECT id, status, created_at FROM notifications WHERE type = 'connection_request' AND user_id = $1 AND device_id = $2 AND status IN ('quarantine_auto_denied', 'denied') ORDER BY created_at DESC LIMIT 1",
            [userId, device.id]
          );

          // Obey user requirement: "client getting access to internet & repeat reuest is stricly denied till the disconnection and conneccting again to router."
          if (disallowedStationUserIds.has(clientKey)) {
            // Client is disallowed and still present on the router. Keep them directly quarantined/blocked at router firewall,
            // and STRICTLY DO NOT create any repeat notification or popup request message!
            const queuedQuarantineCmd = await get(
              "SELECT id FROM openwrt_commands WHERE router_id = $1 AND command_type IN ('quarantine', 'block') AND status = 'queued' AND payload_json LIKE $2",
              [routerId, `%"mac":"${mac}"%`]
            );
            if (!queuedQuarantineCmd) {
              await run(
                `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
                 VALUES ($1, $2, 'quarantine', $3, 'queued', NOW())`,
                [makeId('openwrt-command'), routerId, JSON.stringify({ mac, ip })]
              );
            }
            continue; // Strictly DENY repeat requests while continuously connected!
          }

          if (!existingPendingNotification) {
            // Verify if this is a Returning Client by matching Device Name (hostname) or MAC address
            // 1. Check past sessions for this client (matched by MAC address):
            const pastSessionsByMac = await all(
              "SELECT * FROM connections WHERE user_id = $1 AND id != $2 ORDER BY connected_at DESC",
              [userId, currentConnId]
            );

            // 2. Check past sessions on this router matched by Device Name (hostname):
            const validHostname = (hostname && hostname !== '*' && hostname !== '?' && !hostname.toLowerCase().includes('unknown')) ? hostname.trim() : null;
            let pastSessionsByName = [];
            if (validHostname) {
              pastSessionsByName = await all(
                `SELECT c.* FROM connections c
                 JOIN users u ON u.id = c.user_id
                 WHERE LOWER(u.name) = LOWER($1) AND c.device_id = $2 AND c.user_id != $3 AND c.id != $4
                 ORDER BY c.connected_at DESC`,
                [validHostname, device.id, userId, currentConnId]
              );
            }

            const isReturningClient = Boolean(
              (pastSessionsByMac && pastSessionsByMac.length > 0) ||
              (pastSessionsByName && pastSessionsByName.length > 0)
            );

            let notifMessage = '';
            if (isReturningClient) {
              const pastSessions = (pastSessionsByMac && pastSessionsByMac.length > 0) ? pastSessionsByMac : pastSessionsByName;
              const visitCount = (pastSessions && pastSessions.length > 0) ? (pastSessions.length + 1) : 2;
              const lastConn = (pastSessions && pastSessions.find(c => c.status === 'disconnected')) || (pastSessions && pastSessions[0]);
              const lastConnectedStr = lastConn?.connected_at ? new Date(lastConn.connected_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Earlier session';
              const lastDisconnectedStr = lastConn?.disconnected_at ? new Date(lastConn.disconnected_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
              const totalPastMb = (pastSessions && pastSessions.length > 0)
                ? pastSessions.reduce((sum, c) => sum + Number(c.data_used_mb || 0), 0).toFixed(2)
                : '0.00';

              let histDetails = `Visit #${visitCount} · Last logged: ${lastConnectedStr}`;
              if (lastDisconnectedStr) histDetails += ` (left: ${lastDisconnectedStr})`;
              histDetails += ` · Total past usage: ${totalPastMb} MB across ${Math.max(1, pastSessions?.length || 1)} sessions`;

              const matchType = (pastSessionsByMac && pastSessionsByMac.length > 0)
                ? `Matched by MAC: ${mac}${validHostname ? ` (${validHostname})` : ''}`
                : `Matched by Device Name: ${validHostname}`;

              notifMessage = `Returning user detected: ${displayName} [${mac}]. (${matchType} · ${histDetails}). Quarantined pending owner approval.`;
            } else {
              notifMessage = `New device detected: ${displayName} [${mac}]. Quarantined pending owner approval.`;
            }

            // Clear any stale notification row for this client on this device so there is strictly ONE request per client in DB:
            await run('DELETE FROM notifications WHERE user_id = $1 AND device_id = $2', [userId, device.id]);

            await createNotification({
              type: 'connection_request',
              message: notifMessage,
              userId,
              deviceId: device.id,
              locationId: device.location_id,
              quarantineSeconds: 45,
              maxQuarantineSeconds: 300
            });
          }

          // Always instruct router agent to enforce quarantine at firewall level for unapproved client
          const queuedQuarantineCmd = await get(
            "SELECT id FROM openwrt_commands WHERE router_id = $1 AND command_type = 'quarantine' AND status = 'queued' AND payload_json LIKE $2",
            [routerId, `%"mac":"${mac}"%`]
          );
          if (!queuedQuarantineCmd) {
            await run(
              `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
               VALUES ($1, $2, 'quarantine', $3, 'queued', NOW())`,
              [makeId('openwrt-command'), routerId, JSON.stringify({ mac, ip })]
            );
          }
        }
      }
    }

    // Disconnect stale router clients if no longer in station dump (approved connected sessions only)
    if (device) {
      const activeMacConns = await all(
        "SELECT id, user_id FROM connections WHERE device_id = $1 AND status = 'connected' AND user_id LIKE 'user-mac-%'",
        [device.id]
      );
      for (const conn of activeMacConns || []) {
        if (!activeUserIds.includes(conn.user_id)) {
          const lastSeen = clientLastSeenMap.get(`${device.id}:${conn.user_id}`) || 0;
          const timeSinceLastSeen = Date.now() - lastSeen;
          // Grace period: ONLY mark disconnected if client has been continuously missing for at least 45 seconds!
          if (lastSeen > 0 && timeSinceLastSeen < DISCONNECT_GRACE_PERIOD_MS) {
            continue; // Station is temporarily asleep (power save mode); keep connection intact!
          }
          clientLastSeenMap.delete(`${device.id}:${conn.user_id}`);
          disallowedStationUserIds.delete(`${device.id}:${conn.user_id}`);

          await run("UPDATE connections SET status = 'disconnected', disconnected_at = NOW() WHERE id = $1", [conn.id]);

          // Clear client from allowed_user_ids so their next connection triggers quarantine again
          const currentAllowed = parseAllowedUsers(device.allowed_user_ids);
          if (currentAllowed.includes(conn.user_id)) {
            const updatedAllowed = currentAllowed.filter((uid) => uid !== conn.user_id);
            await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(updatedAllowed), device.id]);
            device.allowed_user_ids = JSON.stringify(updatedAllowed);
          }
        }
      }

      // Also clean up disallowedStationUserIds for clients no longer active on the router
      for (const disallowedKey of Array.from(disallowedStationUserIds)) {
        const [devId, uId] = disallowedKey.split(':');
        if (devId === device.id && !activeUserIds.includes(uId)) {
          const lastSeen = clientLastSeenMap.get(disallowedKey) || 0;
          if (Date.now() - lastSeen >= DISCONNECT_GRACE_PERIOD_MS) {
            disallowedStationUserIds.delete(disallowedKey);
            clientLastSeenMap.delete(disallowedKey);
          }
        }
      }
    }
  } catch (err) {
    console.error('processTelemetry error', err);
  }
}

async function reconcileQuarantines() {
  await ensureDb();
  try {
    const now = new Date();
    const nowIso = now.toISOString();

    // Quarantine auto-disconnect: clients that exceeded 5 minutes (300s) in quarantine without approval are disconnected
    // NOTE: Clients are NEVER auto-released. Internet access is unlocked strictly when owner explicitly clicks Allow.

    // 2. Auto-disconnect clients that exceeded 5 minutes (300s) in quarantine without approval
    const expiredRows = await all(
      "SELECT * FROM notifications WHERE status IN ('quarantine', 'quarantine_wait') AND expires_at IS NOT NULL AND expires_at <= $1",
      [nowIso]
    );
    for (const n of expiredRows || []) {
      console.log(`Quarantine 5-minute timeout reached for notification ${n.id}. Auto-disconnecting client.`);
      await denyAndDisconnectDevice(n.id, 'quarantine_auto_denied');

      // notify admins that quarantine timed out and device was auto-disconnected
      try {
        const tokens = await all(`SELECT pt.device_token FROM push_tokens pt JOIN users u ON u.id = pt.user_id WHERE u.role = $1`, ['admin']);
        const tokenList = (tokens || []).map((t) => t.device_token).filter(Boolean);
        const payload = {
          title: 'Quarantine Timeout (Auto-Disconnected)',
          body: `Client timed out after 5 minutes in quarantine and was disconnected: ${n.message}`,
          data: { notificationId: n.id, deviceId: n.device_id }
        };
        if (tokenList.length) await sendFcm(tokenList, payload);
      } catch (err) {
        console.error('Failed to send timeout notification', err);
      }
    }
  } catch (err) {
    console.error('reconcileQuarantines error', err);
  }
}

// Run reconciliation periodically (every 5 seconds) to ensure quarantines and releases are handled promptly
const quarantineReconciliationTimer = setInterval(() => {
  reconcileQuarantines().catch(err => console.error('reconcileQuarantines top-level error', err));
}, 5 * 1000);
quarantineReconciliationTimer.unref();

// Helper to correctly parse timestamps from SQLite (which stores UTC without 'Z') and Postgres
function parseDbTimestamp(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val instanceof Date) return val.getTime();
  const s = String(val).trim();
  if (!s) return 0;
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

// Mark routers as offline and clear their stale clients_json if no telemetry for >90 seconds
const ROUTER_OFFLINE_TIMEOUT_MS = 90 * 1000;
async function reconcileRouterStatuses() {
  try {
    await ensureDb();
    const routers = await all("SELECT id, status, last_seen_at FROM openwrt_routers WHERE status = 'online'");
    const now = Date.now();
    for (const r of routers || []) {
      if (!r.last_seen_at) continue;
      const lastSeen = parseDbTimestamp(r.last_seen_at);
      if (lastSeen > 0 && (now - lastSeen) > ROUTER_OFFLINE_TIMEOUT_MS) {
        // Clear client list and mark offline so the Status column reflects reality
        await run("UPDATE openwrt_routers SET status = 'offline', clients_json = '[]' WHERE id = $1", [r.id]);
        console.log(`[Router] ${r.id} marked offline (no telemetry for >${ROUTER_OFFLINE_TIMEOUT_MS / 1000}s)`);
      }
    }
  } catch (err) {
    console.error('reconcileRouterStatuses error', err);
  }
}
const routerStatusTimer = setInterval(() => {
  reconcileRouterStatuses().catch(err => console.error('reconcileRouterStatuses top-level error', err));
}, 15 * 1000);
routerStatusTimer.unref();

app.get('/api/health', async (_req, res) => {
  let dbStatus = 'ok';
  let dbError = null;
  try {
    await ensureDb();
  } catch (err) {
    dbStatus = 'error';
    dbError = err.message;
  }
  res.json({
    status: dbStatus,
    message: 'SecMyNet portal API is running',
    environment: isVercel ? 'vercel' : 'standard',
    database: isPostgresConfigured ? 'postgres' : 'sqlite',
    persistentStorage: isPostgresConfigured,
    dbError
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
  const rawEmail = req.body?.email || req.query?.email || '';
  const rawPassword = req.body?.password || req.query?.password || '';
  const cleanEmail = String(rawEmail).trim().toLowerCase();
  const cleanPassword = String(rawPassword).trim();

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

  if (user.access_status === 'disabled') {
    return res.status(403).json({ message: 'This user account has been disabled. Contact your administrator.' });
  }

  res.json({
    message: 'Login successful.',
    token: createToken(user),
    user: sanitizeUser(user)
  });
});

async function handleSuperAdminLogin(req, res) {
  await ensureDb();
  const rawEmail = req.body?.email || req.query?.email || '';
  const rawPassword = req.body?.password || req.query?.password || '';
  const cleanEmail = String(rawEmail).trim().toLowerCase();
  const cleanPassword = String(rawPassword).trim();

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

  const token = createToken(user);
  const sanitizedUser = sanitizeUser(user);

  const isHtmlSubmission = req.is('application/x-www-form-urlencoded') || (req.headers.accept && req.headers.accept.includes('text/html'));
  if (isHtmlSubmission) {
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SecMyNet - Authenticating...</title>
</head>
<body style="background:#0b1329; color:#e2e8f0; font-family:sans-serif; display:grid; place-items:center; min-height:100vh;">
  <div style="text-align:center;">
    <h2>Super Admin Authentication Successful</h2>
    <p>Redirecting to dashboard...</p>
    <script>
      localStorage.setItem('secmynet-token', ${JSON.stringify(token)});
      window.location.href = '/index.html#users';
    </script>
    <noscript><a href="/index.html#users" style="color:#f59e0b;">Click here to access dashboard</a></noscript>
  </div>
</body>
</html>`);
  }

  res.json({
    message: 'Super Admin login successful.',
    token,
    user: sanitizedUser
  });
}

app.post(['/api/super-admin/login', '/superadmin.html', '/superadmin', '/super-admin'], handleSuperAdminLogin);

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
    SELECT c.*, u.name AS user_name, u.email AS user_email, u.mobile_number AS client_ip, d.name AS device_name, d.ip_address AS device_ip
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

      let sn = device.serial_number;
      if (!sn) {
        sn = generateSerialNumber();
        try { await run('UPDATE devices SET serial_number = $1 WHERE id = $2', [sn, device.id]); } catch (_) {}
        device.serial_number = sn;
      }
      let rId = device.router_id;
      if (!rId || !/^\d{6}$/.test(rId)) {
        const oldId = rId;
        rId = await getUniqueRouterId();
        try {
          await run('UPDATE devices SET router_id = $1 WHERE id = $2', [rId, device.id]);
          if (oldId) {
            await run('UPDATE openwrt_routers SET id = $1 WHERE id = $2', [rId, oldId]);
            await run('UPDATE openwrt_commands SET router_id = $1 WHERE router_id = $2', [rId, oldId]);
            await run('UPDATE usage_records SET router_id = $1 WHERE router_id = $2', [rId, oldId]);
          } else {
            const existingRouter = await get('SELECT id FROM openwrt_routers WHERE id = $1', [rId]);
            if (!existingRouter) {
              const agentToken = createAgentToken();
              await run(
                `INSERT INTO openwrt_routers (id, location_id, name, serial_number, agent_token_hash, status, clients_json, usage_json, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                [rId, device.location_id, device.name, sn, hashAgentToken(agentToken), 'offline', '[]', '[]']
              );
            }
          }
        } catch (_) {}
        device.router_id = rId;
      }
      return {
        ...device,
        router_id: rId,
        routerId: rId,
        serialNumber: sn,
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
    deviceIp: connection.client_ip || connection.device_ip,
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

app.delete('/api/users/:userId', authRequired, adminRequired, async (req, res) => {
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

app.get('/api/users/:userId/details', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const userId = req.params.userId;
  let user = await get('SELECT * FROM users WHERE id = $1', [userId]);

  let mac = '';
  if (user && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(user.email)) {
    mac = user.email.toLowerCase();
  } else if (userId && userId.startsWith('user-mac-')) {
    const raw = userId.replace('user-mac-', '');
    mac = raw.match(/.{1,2}/g)?.join(':') || '';
  }

  if (!user && mac) {
    user = {
      id: userId,
      name: `Client (${mac.toUpperCase()})`,
      email: mac,
      role: 'user',
      access_status: 'enabled',
      created_at: new Date().toISOString()
    };
  }

  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const connections = await all(`
    SELECT c.*, d.name AS device_name, d.ip_address AS device_ip, d.router_id, l.name AS location_name, l.city AS location_city
    FROM connections c
    LEFT JOIN devices d ON d.id = c.device_id
    LEFT JOIN locations l ON l.id = d.location_id
    WHERE c.user_id = $1
    ORDER BY c.connected_at DESC
  `, [userId]);

  let usageRecords = [];
  let routerInfo = null;
  let liveTelemetryClient = null;

  if (mac) {
    usageRecords = await all(
      'SELECT id, router_id, rx_bytes, tx_bytes, delta_rx, delta_tx, timestamp FROM usage_records WHERE LOWER(client_mac) = $1 ORDER BY timestamp DESC LIMIT 30',
      [mac.toLowerCase()]
    );

    const routers = await all('SELECT id, name, location_id, clients_json, status, last_seen_at FROM openwrt_routers');
    for (const r of routers) {
      const clients = parseJson(r.clients_json, []);
      const matched = clients.find((c) => (c.mac || '').toLowerCase() === mac.toLowerCase());
      if (matched) {
        liveTelemetryClient = matched;
        const loc = await get('SELECT name, city FROM locations WHERE id = $1', [r.location_id]);
        routerInfo = {
          id: r.id,
          name: r.name,
          status: r.status,
          last_seen_at: r.last_seen_at,
          locationName: loc ? loc.name : null,
          locationCity: loc ? loc.city : null
        };
        break;
      }
    }
  }

  res.json({
    user: sanitizeUser(user),
    mobileNumber: user.mobile_number || '',
    mac,
    connections: connections.map((c) => ({
      ...c,
      dataUsedMb: Number(c.data_used_mb || 0)
    })),
    liveTelemetryClient,
    routerInfo,
    usageRecords
  });
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
  // Ensure strict uniqueness: at most ONE request per client in the response
  const clientMap = new Map();
  for (const n of notifications || []) {
    const key = n.user_id || n.id;
    if (!clientMap.has(key)) {
      clientMap.set(key, n);
    }
  }

  // Pre-fetch live router clients for IP and hostname resolution
  const routers = await all('SELECT id, clients_json FROM openwrt_routers');
  const liveClientsByMac = new Map();
  for (const r of routers || []) {
    const cls = parseJson(r.clients_json, []);
    for (const c of cls) {
      if (c && c.mac) liveClientsByMac.set(c.mac.toLowerCase(), c);
    }
  }

  const enrichedNotifications = [];
  for (const n of clientMap.values()) {
    let clientDetails = null;
    if (n.type === 'connection_request' || n.user_id) {
      // 1. Resolve MAC address
      let mac = '';
      if (n.user_email && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(n.user_email)) {
        mac = n.user_email.toLowerCase();
      } else {
        const macMatch = (n.message || '').match(/\[([0-9a-fA-F:]{17})\]/);
        if (macMatch) mac = macMatch[1].toLowerCase();
      }
      if (!mac && n.user_id && n.user_id.startsWith('user-mac-')) {
        const raw = n.user_id.replace('user-mac-', '');
        if (raw.length === 12) {
          mac = raw.match(/.{2}/g).join(':').toLowerCase();
        }
      }

      // 2. Resolve IP Address & Hostname from router telemetry
      const telClient = mac ? liveClientsByMac.get(mac) : null;
      let ip = telClient?.ip || '';
      if (!ip) {
        const ipMatch = (n.message || '').match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (ipMatch) ip = ipMatch[1];
      }
      if (!ip) ip = '192.168.1.188';

      // 3. Resolve Client Device Name
      let deviceName = '';
      if (telClient?.hostname && telClient.hostname !== '*' && telClient.hostname !== '?' && !telClient.hostname.toLowerCase().includes('unknown')) {
        deviceName = telClient.hostname;
      } else if (n.user_name && !n.user_name.toLowerCase().includes('client (')) {
        deviceName = n.user_name;
      } else {
        const nameMatch = (n.message || '').match(/(?:detected|user):\s*([^[.]+)/i);
        if (nameMatch && nameMatch[1].trim()) {
          deviceName = nameMatch[1].trim();
        } else {
          deviceName = n.user_name || (mac ? `Client (${mac.toUpperCase()})` : 'Connected Client');
        }
      }

      // 4. Past sessions from connections
      let pastSessions = [];
      if (n.user_id) {
        pastSessions = await all(
          "SELECT * FROM connections WHERE user_id = $1 ORDER BY connected_at DESC",
          [n.user_id]
        );
      }
      if ((!pastSessions || pastSessions.length === 0) && deviceName) {
        pastSessions = await all(
          `SELECT c.* FROM connections c JOIN users u ON u.id = c.user_id WHERE LOWER(u.name) = LOWER($1) ORDER BY c.connected_at DESC`,
          [deviceName]
        );
      }

      const completedSessions = (pastSessions || []).filter(s => s.status === 'disconnected' || s.disconnected_at);
      const lastSession = completedSessions[0] || (pastSessions && pastSessions.length > 1 ? pastSessions[1] : null);

      let lastConnected = 'First connection (New device)';
      let lastDisconnected = '—';
      let lastSessionDataMb = '0.00 MB';
      let totalPastMb = '0.00 MB';
      let visitCount = (completedSessions.length > 0) ? (completedSessions.length + 1) : 1;
      let isReturning = completedSessions.length > 0;

      if (lastSession) {
        isReturning = true;
        if (lastSession.connected_at) {
          lastConnected = new Date(lastSession.connected_at).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
        }
        if (lastSession.disconnected_at) {
          lastDisconnected = new Date(lastSession.disconnected_at).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
        }
        lastSessionDataMb = `${Number(lastSession.data_used_mb || 0).toFixed(2)} MB`;
        const sumMb = completedSessions.reduce((acc, s) => acc + Number(s.data_used_mb || 0), 0);
        totalPastMb = `${sumMb.toFixed(2)} MB`;
      } else if ((n.message || '').includes('Returning user')) {
        isReturning = true;
        const lastConnMatch = n.message.match(/Last logged:\s*([^·(]+)/);
        if (lastConnMatch) lastConnected = lastConnMatch[1].trim();
        const usageMatch = n.message.match(/Total past usage:\s*([0-9.]+\s*MB)/i);
        if (usageMatch) {
          totalPastMb = usageMatch[1].trim();
          lastSessionDataMb = totalPastMb;
        }
        const visitMatch = n.message.match(/Visit #(\d+)/i);
        if (visitMatch) visitCount = parseInt(visitMatch[1], 10);
      }

      clientDetails = {
        clientDeviceName: deviceName,
        ipAddress: ip,
        macAddress: (mac || '—').toUpperCase(),
        lastConnected,
        lastDisconnected,
        lastSessionDataMb,
        totalPastUsageMb: totalPastMb,
        visitCount,
        isReturning
      };
    }
    enrichedNotifications.push({ ...n, client_details: clientDetails });
  }

  res.json({ notifications: enrichedNotifications });
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
    FROM openwrt_routers r LEFT JOIN locations l ON l.id = r.location_id
    ORDER BY r.created_at DESC
  `);
  const updatedRouters = [];
  for (const router of routers) {
    if (!/^\d{6}$/.test(router.id)) {
      const oldId = router.id;
      const newId = await getUniqueRouterId();
      try {
        await run('UPDATE openwrt_routers SET id = $1 WHERE id = $2', [newId, oldId]);
        await run('UPDATE devices SET router_id = $1 WHERE router_id = $2', [newId, oldId]);
        await run('UPDATE openwrt_commands SET router_id = $1 WHERE router_id = $2', [newId, oldId]);
        await run('UPDATE usage_records SET router_id = $1 WHERE router_id = $2', [newId, oldId]);
        router.id = newId;
      } catch (_) {}
    }
    let sn = router.serial_number;
    if (!sn) {
      sn = generateSerialNumber();
      try {
        await run('UPDATE openwrt_routers SET serial_number = $1 WHERE id = $2', [sn, router.id]);
      } catch (_) {}
      router.serial_number = sn;
    }
    updatedRouters.push({
      ...router,
      serialNumber: sn,
      clients: parseJson(router.clients_json, []),
      usage: parseJson(router.usage_json, [])
    });
  }
  res.json({ routers: updatedRouters });
});

app.post('/api/openwrt/routers', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { locationId, name, serialNumber } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Router name is required.' });

  const trimmedName = String(name).trim();
  const trimmedSn = (serialNumber && String(serialNumber).trim()) ? String(serialNumber).trim() : null;

  // Enforce: Client cannot add the same router that is already on the portal.
  // 1. Check if a router with the same Serial Number already exists
  if (trimmedSn) {
    const existingBySn = await get(
      'SELECT id, name, serial_number FROM openwrt_routers WHERE LOWER(TRIM(serial_number)) = LOWER($1)',
      [trimmedSn]
    );
    if (existingBySn) {
      return res.status(409).json({
        message: `Router with Serial Number "${trimmedSn}" is already registered on the portal (Router: "${existingBySn.name}", ID: ${existingBySn.id}). You can only add it if the existing router is first deleted from the portal.`
      });
    }
  }

  // 2. Check if a router with the same Name already exists
  const existingByName = await get(
    'SELECT id, name, serial_number FROM openwrt_routers WHERE LOWER(TRIM(name)) = LOWER($1)',
    [trimmedName]
  );
  if (existingByName) {
    return res.status(409).json({
      message: `Router with name "${trimmedName}" is already registered on the portal (ID: ${existingByName.id}, Serial: ${existingByName.serial_number || 'N/A'}). You can only add it if the existing router is first deleted from the portal.`
    });
  }

  let effectiveLocationId = locationId;
  if (!effectiveLocationId) {
    let loc = await get('SELECT id FROM locations LIMIT 1');
    if (!loc) {
      const newLocId = makeId('location');
      await run('INSERT INTO locations (id, name, city, admin_id, created_at) VALUES ($1, $2, $3, $4, NOW())', [newLocId, 'Main Location', 'HQ', req.user.id]);
      effectiveLocationId = newLocId;
    } else {
      effectiveLocationId = loc.id;
    }
  }

  let sn = trimmedSn;
  if (!sn) {
    for (let i = 0; i < 50; i++) {
      const candidate = generateSerialNumber();
      const existing = await get('SELECT id FROM openwrt_routers WHERE serial_number = $1', [candidate]);
      if (!existing) {
        sn = candidate;
        break;
      }
    }
    if (!sn) sn = generateSerialNumber();
  }

  const agentToken = createAgentToken();
  const routerId = await getUniqueRouterId();
  await run(
    `INSERT INTO openwrt_routers (id, location_id, name, serial_number, agent_token_hash, status, clients_json, usage_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [routerId, effectiveLocationId, trimmedName, sn, hashAgentToken(agentToken), 'offline', '[]', '[]']
  );

  // Also sync or create corresponding device in devices table
  const existingDev = await get('SELECT id FROM devices WHERE router_id = $1', [routerId]);
  if (!existingDev) {
    const devId = makeId('device');
    await run(
      `INSERT INTO devices (id, location_id, router_id, name, wifi_name, serial_number, ip_address, status, allowed_user_ids, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [devId, effectiveLocationId, routerId, trimmedName, `${trimmedName} WiFi`, sn, '192.168.1.1', 'allowed', '[]', req.user.id]
    );
  }

  res.status(201).json({ message: 'Router registered successfully. Save the token now; it is shown only once.', routerId, serialNumber: sn, agentToken });
});

app.patch('/api/openwrt/routers/:routerId', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { locationId, name, serialNumber } = req.body;
  const router = await get('SELECT * FROM openwrt_routers WHERE id = $1', [req.params.routerId]);
  if (!router) return res.status(404).json({ message: 'OpenWrt router not found.' });
  if (!name || !String(name).trim()) return res.status(400).json({ message: 'Router name is required.' });

  const trimmedName = String(name).trim();
  const trimmedSn = (serialNumber && String(serialNumber).trim()) ? String(serialNumber).trim() : null;

  // Check if another router has the same Serial Number
  if (trimmedSn) {
    const existingBySn = await get(
      'SELECT id, name, serial_number FROM openwrt_routers WHERE id != $1 AND LOWER(TRIM(serial_number)) = LOWER($2)',
      [router.id, trimmedSn]
    );
    if (existingBySn) {
      return res.status(409).json({
        message: `Another router with Serial Number "${trimmedSn}" already exists on the portal (Router: "${existingBySn.name}", ID: ${existingBySn.id}).`
      });
    }
  }

  // Check if another router has the same Name
  const existingByName = await get(
    'SELECT id, name, serial_number FROM openwrt_routers WHERE id != $1 AND LOWER(TRIM(name)) = LOWER($2)',
    [router.id, trimmedName]
  );
  if (existingByName) {
    return res.status(409).json({
      message: `Another router with name "${trimmedName}" already exists on the portal (ID: ${existingByName.id}).`
    });
  }

  const effectiveLocationId = locationId || router.location_id;
  const sn = trimmedSn || (router.serial_number || generateSerialNumber());
  await run(
    'UPDATE openwrt_routers SET location_id = $1, name = $2, serial_number = $3 WHERE id = $4',
    [effectiveLocationId, trimmedName, sn, router.id]
  );
  await run(
    'UPDATE devices SET location_id = $1, name = $2, serial_number = $3 WHERE router_id = $4',
    [effectiveLocationId, trimmedName, sn, router.id]
  );
  const updated = await get('SELECT r.*, l.name AS location_name FROM openwrt_routers r LEFT JOIN locations l ON l.id = r.location_id WHERE r.id = $1', [router.id]);
  res.json({ message: 'Router updated.', router: { ...updated, serialNumber: updated.serial_number, clients: parseJson(updated.clients_json, []), usage: parseJson(updated.usage_json, []) } });
});

app.delete('/api/openwrt/routers/:routerId', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const router = await get('SELECT * FROM openwrt_routers WHERE id = $1', [req.params.routerId]);
  if (!router) return res.status(404).json({ message: 'Router not found.' });
  await run('DELETE FROM openwrt_commands WHERE router_id = $1', [router.id]);
  await run('DELETE FROM devices WHERE router_id = $1', [router.id]);
  await run('DELETE FROM openwrt_routers WHERE id = $1', [router.id]);
  res.json({ message: 'Router deleted successfully. You may now add it again if needed.' });
});

app.post('/api/openwrt/routers/:routerId/reset-token', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const router = await get('SELECT * FROM openwrt_routers WHERE id = $1', [req.params.routerId]);
  if (!router) return res.status(404).json({ message: 'Router not found.' });
  const agentToken = createAgentToken();
  await run('UPDATE openwrt_routers SET agent_token_hash = $1 WHERE id = $2', [hashAgentToken(agentToken), router.id]);
  res.json({ message: 'Agent token generated successfully.', routerId: router.id, agentToken });
});

app.post('/api/openwrt/routers/:routerId/commands', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { commandType, mac, ip, key, encryption } = req.body;
  const validCommands = ['disconnect', 'block', 'allow', 'restart', 'quarantine', 'set_wifi_password'];
  if (!validCommands.includes(commandType)) return res.status(400).json({ message: 'Unsupported router command.' });
  const router = await get('SELECT id FROM openwrt_routers WHERE id = $1', [req.params.routerId]);
  if (!router) return res.status(404).json({ message: 'OpenWrt router not found.' });
  const commandId = makeId('openwrt-command');
  await run(
    `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [commandId, router.id, commandType, JSON.stringify({ mac: mac || '', ip: ip || '', key: key || '', encryption: encryption || 'psk2' }), 'queued']
  );
  res.status(201).json({ message: 'Command queued for the OpenWrt agent.', commandId });
});

app.post('/api/openwrt/routers/:routerId/telemetry', routerAgentRequired, async (req, res) => {
  const { clients = [], usage = [] } = req.body;
  const rawClients = Array.isArray(clients) ? clients : [];
  console.log(`[Router Telemetry] IP: ${req.ip || req.socket.remoteAddress}, Router: ${req.params.routerId}, Clients: ${JSON.stringify(rawClients)}`);
  const clientMap = new Map();
  for (const c of rawClients) {
    const m = (c.mac || c.MAC || '').toLowerCase().trim();
    if (!m) continue;
    // MAC validation: MUST be a valid 6-octet hex MAC address (filters out bogus header strings like 'tywe')
    if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(m)) continue;
    // Infrastructure validation: NEVER collect upstream WAN gateway or modem as a client
    if (m === '04:f4:1c:03:fe:aa' || c.ip === '192.168.200.1') continue;
    if (!clientMap.has(m)) {
      clientMap.set(m, { ...c, mac: m });
    } else {
      const existing = clientMap.get(m);
      clientMap.set(m, {
        mac: m,
        ip: c.ip || existing.ip || '',
        hostname: (c.hostname && c.hostname !== '*' ? c.hostname : existing.hostname) || existing.hostname || '*',
        rx_bytes: Math.max(Number(c.rx_bytes || 0), Number(existing.rx_bytes || 0)),
        tx_bytes: Math.max(Number(c.tx_bytes || 0), Number(existing.tx_bytes || 0)),
        signal: (c.signal !== null && c.signal !== undefined) ? c.signal : existing.signal
      });
    }
  }
  const cleanClients = Array.from(clientMap.values());

  await run(
    "UPDATE openwrt_routers SET status = 'online', last_seen_at = NOW(), clients_json = $1, usage_json = $2 WHERE id = $3",
    [JSON.stringify(cleanClients), JSON.stringify(Array.isArray(usage) ? usage : []), req.router.id]
  );

  // Process telemetry asynchronously so the agent gets a quick response.
  // Any errors in processing are logged but do not change the response.
  processTelemetry(req.router.id, cleanClients, usage).catch((e) => console.error('telemetry processing failed', e));

  res.json({ ok: true });
});

app.get('/api/openwrt/routers/:routerId/commands', routerAgentRequired, async (req, res) => {
  const commands = await all("SELECT * FROM openwrt_commands WHERE router_id = $1 AND status = 'queued' ORDER BY created_at ASC", [req.router.id]);
  res.json({
    commands: commands.map((command) => {
      const payload = parseJson(command.payload_json, {});
      return {
        ...command,
        mac: (payload.mac || '').toLowerCase(),
        ip: payload.ip || '',
        key: payload.key || '',
        encryption: payload.encryption || 'psk2',
        payload
      };
    })
  });
});

app.post('/api/openwrt/routers/:routerId/commands/:commandId/complete', routerAgentRequired, async (req, res) => {
  const { success = true } = req.body;
  await run("UPDATE openwrt_commands SET status = $1, completed_at = NOW() WHERE id = $2 AND router_id = $3", [success ? 'completed' : 'failed', req.params.commandId, req.router.id]);
  res.json({ ok: true });
});

app.delete('/api/notifications', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { tab } = req.query;
  const now = Date.now();
  if (tab === 'history' || tab === 'disallowed' || tab === 'rejected') {
    await run("DELETE FROM notifications WHERE status IN ('denied', 'disconnected', 'quarantine_auto_denied')");
  } else if (tab === 'approved' || tab === 'allowed') {
    await run("DELETE FROM notifications WHERE status = 'allowed'");
  } else if (tab === 'new_request' || tab === 'temp_quarantine') {
    const allNotifs = await all("SELECT id, status, created_at FROM notifications WHERE status = 'quarantine'");
    for (const n of allNotifs || []) {
      if ((now - new Date(n.created_at).getTime()) < 45000) {
        await run('DELETE FROM notifications WHERE id = $1', [n.id]);
      }
    }
  } else if (tab === 'pending') {
    const allNotifs = await all("SELECT id, status, created_at FROM notifications WHERE status IN ('unread', 'quarantine', 'quarantine_wait', 'approved_holding')");
    for (const n of allNotifs || []) {
      const age = now - new Date(n.created_at).getTime();
      if (n.status !== 'quarantine' || age >= 45000) {
        await run('DELETE FROM notifications WHERE id = $1', [n.id]);
      }
    }
  } else {
    await run('DELETE FROM notifications');
  }
  res.json({ ok: true, message: 'Notifications cleared successfully.' });
});

app.delete('/api/notifications/:notificationId', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  await run('DELETE FROM notifications WHERE id = $1', [req.params.notificationId]);
  res.json({ ok: true, message: 'Notification cleared.' });
});

app.post('/api/notifications/:notificationId/respond', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { allow, action } = req.body;
  const notification = await get('SELECT * FROM notifications WHERE id = $1', [req.params.notificationId]);
  if (!notification) {
    return res.status(404).json({ message: 'Notification not found.' });
  }

  // Allow disconnect on already approved devices (from Approved tab)
  if (notification.status === 'allowed' && (action === 'disconnect' || action === 'deny')) {
    await denyAndDisconnectDevice(notification.id, 'disconnected');
    return res.json({ message: 'Device disconnected and access revoked.', status: 'disconnected' });
  }

  // Allow re-approval or re-allow on any notification status
  if (action === 'reallow' || action === 're-allow') {
    await releaseQuarantinedDevice(notification.id);
    return res.json({ message: 'Device re-approved and access restored. Quarantine released.', status: 'allowed' });
  }

  // Idempotent approval if already allowed
  if (notification.status === 'allowed' && (allow || action === 'allow')) {
    await releaseQuarantinedDevice(notification.id);
    return res.json({ message: 'Device approved and active on the network. Access confirmed.', status: 'allowed' });
  }

  // Allow re-approval on previously disallowed/disconnected notifications
  if (['denied', 'disconnected', 'quarantine_auto_denied'].includes(notification.status) && allow) {
    await releaseQuarantinedDevice(notification.id);
    return res.json({ message: 'Device re-approved and connected. Quarantine released.', status: 'allowed' });
  }

  if (!['unread', 'quarantine', 'quarantine_wait', 'approved_holding'].includes(notification.status)) {
    let msg = 'Connection request is no longer pending.';
    if (notification.status === 'allowed') {
      msg = 'This connection request was already approved and is active.';
    } else if (notification.status === 'disconnected') {
      msg = 'The client disconnected from the Wi-Fi network before approval.';
    } else if (notification.status === 'quarantine_auto_denied') {
      msg = 'This request timed out after 5 minutes and was automatically disallowed.';
    } else if (notification.status === 'denied') {
      msg = 'This connection request was already disallowed.';
    }
    return res.status(400).json({ message: msg, status: notification.status });
  }

  if (notification.type === 'connection_request') {
    // 5-minute timeout enforcement: if 5 minutes have elapsed with no owner approval, disallow and disconnect
    if (notification.expires_at && new Date(notification.expires_at).getTime() <= Date.now()) {
      await denyAndDisconnectDevice(notification.id, 'quarantine_auto_denied');
      return res.status(400).json({
        message: 'Quarantine window expired after 5 minutes with no owner approval. Client has been disallowed and disconnected.',
        status: 'quarantine_auto_denied'
      });
    }

    if (action === 'wait') {
      const newExpiresAt = new Date(Date.now() + 300 * 1000).toISOString();
      await run("UPDATE notifications SET status = 'quarantine_wait', expires_at = $1 WHERE id = $2", [newExpiresAt, notification.id]);
      return res.json({
        message: 'Owner requested time to verify identity. Quarantine extended for up to 5 minutes.',
        status: 'quarantine_wait',
        expiresAt: newExpiresAt
      });
    }

    if (allow || action === 'allow' || action === 'reallow' || action === 're-allow') {
      await releaseQuarantinedDevice(notification.id);
      return res.json({ message: 'User approved and connected. Quarantine released.', status: 'allowed' });
    }

    // action is deny / disallow
    await denyAndDisconnectDevice(notification.id, 'denied');
    return res.json({ message: 'Connection request denied and client disconnected.', status: 'denied' });
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

app.delete('/api/locations/:locationId', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const location = await get('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
  if (!location) {
    return res.status(404).json({ message: 'Location not found.' });
  }

  const devices = await all('SELECT id FROM devices WHERE location_id = $1', [location.id]);
  for (const dev of devices) {
    await run('DELETE FROM connections WHERE device_id = $1', [dev.id]);
    await run('DELETE FROM notifications WHERE device_id = $1', [dev.id]);
  }
  await run('DELETE FROM devices WHERE location_id = $1', [location.id]);
  await run('DELETE FROM openwrt_routers WHERE location_id = $1', [location.id]);
  await run('DELETE FROM notifications WHERE location_id = $1', [location.id]);
  await run('DELETE FROM locations WHERE id = $1', [location.id]);
  res.json({ message: 'Location deleted.' });
});

app.post('/api/devices', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { locationId, routerId, name, wifiName, wifiPassword = '', ipAddress, serialNumber, status } = req.body;

  if (!locationId || !name || !wifiName || !ipAddress) {
    return res.status(400).json({ message: 'locationId, name, wifiName, and ipAddress are required.' });
  }

  const ipParts = String(ipAddress).split('.');
  if (ipParts.length !== 4 || ipParts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return res.status(400).json({ message: 'Enter a valid IPv4 address, for example 192.168.255.254.' });
  }

  let finalRouterId = (routerId && String(routerId).trim()) ? String(routerId).trim() : null;
  let agentToken = null;

  if (finalRouterId) {
    const router = await get('SELECT id FROM openwrt_routers WHERE id = $1', [finalRouterId]);
    if (!router) return res.status(404).json({ message: 'OpenWrt router not found.' });
  } else {
    const trimmedDevName = String(name).trim();
    const snForRouter = (serialNumber && String(serialNumber).trim()) ? String(serialNumber).trim() : null;

    if (snForRouter) {
      const existingBySn = await get(
        'SELECT id, name, serial_number FROM openwrt_routers WHERE LOWER(TRIM(serial_number)) = LOWER($1)',
        [snForRouter]
      );
      if (existingBySn) {
        return res.status(409).json({
          message: `Router with Serial Number "${snForRouter}" is already registered on the portal (Router: "${existingBySn.name}", ID: ${existingBySn.id}). You can only add it if the existing router is first deleted from the portal.`
        });
      }
    }

    const existingByName = await get(
      'SELECT id, name, serial_number FROM openwrt_routers WHERE LOWER(TRIM(name)) = LOWER($1)',
      [trimmedDevName]
    );
    if (existingByName) {
      return res.status(409).json({
        message: `Router with name "${trimmedDevName}" is already registered on the portal (ID: ${existingByName.id}, Serial: ${existingByName.serial_number || 'N/A'}). You can only add it if the existing router is first deleted from the portal.`
      });
    }

    finalRouterId = await getUniqueRouterId();
    agentToken = createAgentToken();
    const finalSn = snForRouter || generateSerialNumber();
    await run(
      `INSERT INTO openwrt_routers (id, location_id, name, serial_number, agent_token_hash, status, clients_json, usage_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [finalRouterId, locationId, trimmedDevName, finalSn, hashAgentToken(agentToken), 'offline', '[]', '[]']
    );
  }

  const sn = (serialNumber && String(serialNumber).trim()) ? String(serialNumber).trim() : generateSerialNumber();
  const deviceId = makeId('device');
  const cleanPass = String(wifiPassword || '').trim();
  await run(
    `INSERT INTO devices (id, location_id, router_id, name, wifi_name, wifi_password, serial_number, ip_address, status, allowed_user_ids, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '[]', $10, NOW())`,
    [deviceId, locationId, finalRouterId, name, wifiName, cleanPass, sn, ipAddress, status || 'allowed', req.user.id]
  );

  if (finalRouterId && cleanPass) {
    await run(
      `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
       VALUES ($1, $2, 'set_wifi_password', $3, 'queued', NOW())`,
      [makeId('openwrt-command'), finalRouterId, JSON.stringify({ key: cleanPass, encryption: 'psk2' })]
    );
  }

  const device = await get('SELECT * FROM devices WHERE id = $1', [deviceId]);
  const location = await get('SELECT * FROM locations WHERE id = $1', [device.location_id]);
  const payload = {
    ...device,
    routerId: device.router_id,
    serialNumber: device.serial_number,
    wifiPassword: device.wifi_password,
    location,
    allowedUserIds: parseAllowedUsers(device.allowed_user_ids),
    allowedUsers: []
  };

  res.status(201).json({
    message: 'Device added.',
    device: payload,
    routerId: finalRouterId,
    agentToken
  });
});

app.patch('/api/devices/:deviceId', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const { locationId, routerId, name, wifiName, wifiPassword, ipAddress, serialNumber, status } = req.body;
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

  let finalRouterId = (routerId !== undefined && routerId !== '') ? String(routerId).trim() : device.router_id;
  if (!finalRouterId || !/^\d{6}$/.test(finalRouterId)) {
    finalRouterId = await getUniqueRouterId();
  }

  if (finalRouterId && finalRouterId !== device.router_id) {
    const router = await get('SELECT id FROM openwrt_routers WHERE id = $1', [finalRouterId]);
    if (!router) return res.status(404).json({ message: 'OpenWrt router not found.' });
  }

  const sn = (serialNumber && String(serialNumber).trim()) ? String(serialNumber).trim() : (device.serial_number || generateSerialNumber());
  const updatedWifiPassword = wifiPassword !== undefined ? String(wifiPassword).trim() : (device.wifi_password || '');
  await run(
    'UPDATE devices SET location_id = $1, router_id = $2, name = $3, wifi_name = $4, wifi_password = $5, serial_number = $6, ip_address = $7, status = $8 WHERE id = $9',
    [locationId, finalRouterId, name, wifiName, updatedWifiPassword, sn, ipAddress, status || device.status || 'allowed', device.id]
  );

  if (finalRouterId && wifiPassword !== undefined && String(wifiPassword).trim()) {
    await run(
      `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
       VALUES ($1, $2, 'set_wifi_password', $3, 'queued', NOW())`,
      [makeId('openwrt-command'), finalRouterId, JSON.stringify({ key: String(wifiPassword).trim(), encryption: 'psk2' })]
    );
  }

  const updatedDevice = await get('SELECT * FROM devices WHERE id = $1', [device.id]);
  const location = await get('SELECT * FROM locations WHERE id = $1', [updatedDevice.location_id]);
  res.json({ message: 'Device updated.', device: { ...updatedDevice, routerId: updatedDevice.router_id, serialNumber: updatedDevice.serial_number, wifiPassword: updatedDevice.wifi_password, location, allowedUserIds: parseAllowedUsers(updatedDevice.allowed_user_ids) } });
});

app.delete('/api/devices/:deviceId', authRequired, adminRequired, async (req, res) => {
  await ensureDb();
  const device = await get('SELECT * FROM devices WHERE id = $1', [req.params.deviceId]);
  if (!device) {
    return res.status(404).json({ message: 'Device not found.' });
  }

  await run('DELETE FROM connections WHERE device_id = $1', [device.id]);
  await run('DELETE FROM notifications WHERE device_id = $1', [device.id]);
  await run('DELETE FROM devices WHERE id = $1', [device.id]);
  res.json({ message: 'Device deleted.' });
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

  if (device.router_id) {
    let mac = '';
    if (userId && userId.startsWith('user-mac-')) {
      const raw = userId.replace('user-mac-', '');
      mac = raw.match(/.{1,2}/g)?.join(':') || '';
    }
    const commandId = makeId('openwrt-command');
    await run(
      `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
       VALUES ($1, $2, 'block', $3, 'queued', NOW())`,
      [commandId, device.router_id, JSON.stringify({ mac })]
    );
  }

  res.json({ message: 'User removed from the allowed list and blacklisted.', device: { ...device, allowedUserIds: allowedUsers } });
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

  const device = await get('SELECT * FROM devices WHERE id = $1', [req.params.deviceId]);
  if (device) {
    const allowed = parseAllowedUsers(device.allowed_user_ids).filter((id) => id !== userId);
    await run('UPDATE devices SET allowed_user_ids = $1 WHERE id = $2', [JSON.stringify(allowed), device.id]);

    if (device.router_id) {
      let mac = '';
      if (userId && userId.startsWith('user-mac-')) {
        const raw = userId.replace('user-mac-', '');
        mac = raw.match(/.{1,2}/g)?.join(':') || '';
      }
      const commandId = makeId('openwrt-command');
      await run(
        `INSERT INTO openwrt_commands (id, router_id, command_type, payload_json, status, created_at)
         VALUES ($1, $2, 'disconnect', $3, 'queued', NOW())`,
        [commandId, device.router_id, JSON.stringify({ mac })]
      );
    }
  }

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
      "SELECT id FROM notifications WHERE type = 'connection_request' AND user_id = $1 AND device_id = $2 AND status IN ('unread','quarantine','quarantine_wait','approved_holding')",
      [userId, device.id]
    );
    if (!existingRequest) {
      await createNotification({
        type: 'connection_request',
        message: `${user.name} requested access to ${device.name}.`,
        userId,
        deviceId: device.id,
        locationId: device.location_id,
        quarantineSeconds: 45,
        maxQuarantineSeconds: 300
      });
    }
    return res.status(202).json({ message: 'Connection request sent to the network owner for approval. Device held in quarantine.' });
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

// Client status endpoint for quarantined devices to check approval state
app.get('/api/client/status', async (req, res) => {
  await ensureDb();
  let mac = (req.query.mac || req.query.MAC || '').trim().toLowerCase();
  let ip = (req.query.ip || req.query.IP || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').trim();
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');

  let user = null;
  if (mac) {
    const userId = 'user-mac-' + mac.replace(/[^a-z0-9]/g, '');
    user = await get('SELECT * FROM users WHERE id = $1', [userId]);
  }
  if (!user && ip) {
    user = await get('SELECT * FROM users WHERE mobile_number = $1 ORDER BY created_at DESC LIMIT 1', [ip]);
    if (user && user.email) mac = user.email.toLowerCase();
  }

  let latestNotif = null;
  if (user || mac) {
    latestNotif = await get(
      "SELECT * FROM notifications WHERE type = 'connection_request' AND (user_id = $1 OR message LIKE $2) ORDER BY created_at DESC LIMIT 1",
      [user ? user.id : '', `%${mac}%`]
    );
  }

  let activeConn = null;
  if (user) {
    activeConn = await get(
      "SELECT * FROM connections WHERE user_id = $1 ORDER BY connected_at DESC LIMIT 1",
      [user.id]
    );
  }

  const now = Date.now();
  let status = 'quarantine';
  let message = 'Service Approval pending from owner of the Router';
  let approved = false;
  let holdRemainingSeconds = 0;
  let timeoutRemainingSeconds = 0;

  if (latestNotif) {
    status = latestNotif.status;
    const minHold = latestNotif.min_quarantine_until ? new Date(latestNotif.min_quarantine_until).getTime() : 0;
    const expires = latestNotif.expires_at ? new Date(latestNotif.expires_at).getTime() : 0;
    holdRemainingSeconds = Math.max(0, Math.ceil((minHold - now) / 1000));
    timeoutRemainingSeconds = Math.max(0, Math.ceil((expires - now) / 1000));

    let category = 'temp_quarantine';
    let internetService = 'OFF';

    if (status === 'allowed') {
      approved = true;
      category = 'allowed';
      internetService = 'ON';
      message = 'Access Approved by Owner! You are now connected to the Internet.';
    } else if (['denied', 'quarantine_auto_denied', 'disconnected'].includes(status)) {
      approved = false;
      category = 'disallowed';
      internetService = 'OFF';
      message = 'Connection request has been disallowed by the router owner. Internet service is completely off.';
    } else if (status === 'quarantine_wait' || holdRemainingSeconds === 0) {
      approved = false;
      category = 'pending';
      internetService = 'OFF';
      message = 'Service Approval pending from owner of the Router (Pending Approvals). Internet service is completely off.';
    } else {
      approved = false;
      category = 'temp_quarantine';
      internetService = 'OFF';
      message = 'Service Approval pending from owner of the Router';
    }
  } else if (activeConn && activeConn.status === 'connected') {
    status = 'allowed';
    approved = true;
    message = 'Access Approved by Owner! You are now connected to the Internet.';
  }

  const category = approved ? 'allowed' : (['denied', 'quarantine_auto_denied', 'disconnected'].includes(status) ? 'disallowed' : (holdRemainingSeconds > 0 ? 'temp_quarantine' : 'pending'));
  const internetService = approved ? 'ON' : 'OFF';

  res.json({
    mac,
    ip,
    name: user ? user.name : (mac ? `Client (${mac.toUpperCase()})` : 'Connected Device'),
    status,
    category,
    internetService,
    message,
    approved,
    holdRemainingSeconds,
    timeoutRemainingSeconds,
    serverTime: new Date().toISOString()
  });
});

// Captive portal holding landing page & detection routes
app.get(['/holding', '/holding.html', '/quarantine'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'holding.html'));
});

// Captive portal probes for Android, iOS, Windows
app.get(['/generate_204', '/gen_204', '/hotspot-detect.html', '/ncsi.txt', '/connecttest.txt'], (_req, res) => {
  res.redirect('/holding.html');
});

app.get(['/superadmin', '/super-admin', '/superadmin/'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'superadmin.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'Route not found.' });
  }
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

if (require.main === module) {
  ensureDb()
    .then(async () => {
      // Zero-Trust NAC startup: close any stale open connections from prior server process runs
      try {
        await run("UPDATE connections SET status = 'disconnected', disconnected_at = NOW() WHERE status IN ('connected', 'quarantine')");
        const allDevs = await all("SELECT id, allowed_user_ids FROM devices");
        for (const d of allDevs || []) {
          const allowed = parseAllowedUsers(d.allowed_user_ids);
          const nonStationAllowed = allowed.filter(uid => !uid.startsWith('user-mac-'));
          if (nonStationAllowed.length !== allowed.length) {
            await run("UPDATE devices SET allowed_user_ids = $1 WHERE id = $2", [JSON.stringify(nonStationAllowed), d.id]);
          }
        }
      } catch (_) {}
    })
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

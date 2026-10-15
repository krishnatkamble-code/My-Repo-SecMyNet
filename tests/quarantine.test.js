const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../server');

test('Quarantine-first lifecycle and timing test', async (t) => {
  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(() => {
    if (server) server.close();
  });

  // 1. Admin Login
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@secmynet.com', password: 'Admin@123' })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();
  assert.ok(adminToken);

  // 2. Register OpenWrt router
  const routerRes = await fetch(`${baseUrl}/api/openwrt/routers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ name: 'Quarantine-Test-AP' })
  });
  assert.equal(routerRes.status, 201);
  const { routerId, agentToken } = await routerRes.json();
  assert.ok(routerId);
  assert.ok(agentToken);

  // 3. Post telemetry with a brand new, unapproved client
  const rand1 = Math.floor(Math.random() * 89 + 10).toString();
  const testMac = `02:00:00:11:22:${rand1}`;
  const telemetryRes = await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/telemetry`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SecMyNet-Agent-Token': agentToken
    },
    body: JSON.stringify({
      clients: [
        {
          mac: testMac,
          ip: '192.168.1.188',
          hostname: 'Quarantine-Target-Phone',
          rx_bytes: 10240,
          tx_bytes: 5120
        }
      ],
      usage: []
    })
  });
  assert.equal(telemetryRes.status, 200);

  // Allow async processTelemetry to run
  await new Promise((r) => setTimeout(r, 600));

  // 4. Verify notification was created with quarantine status, min_quarantine_until (~45s), and expires_at (~300s)
  const notifRes = await fetch(`${baseUrl}/api/notifications`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(notifRes.status, 200);
  const { notifications } = await notifRes.json();
  const qNotif = notifications.find((n) => n.message && n.message.includes(testMac));
  assert.ok(qNotif, 'Quarantine notification should exist for new client');
  assert.equal(qNotif.status, 'quarantine');
  assert.ok(qNotif.min_quarantine_until, 'min_quarantine_until must be present');
  assert.ok(qNotif.expires_at, 'expires_at must be present');

  const minHoldRemaining = (new Date(qNotif.min_quarantine_until).getTime() - Date.now()) / 1000;
  assert.ok(minHoldRemaining > 30 && minHoldRemaining <= 46, `min hold should be ~45s, got ${minHoldRemaining}`);

  // 5. Check that router command queue has 'quarantine' command queued
  const commandsRes = await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/commands`, {
    headers: { 'X-SecMyNet-Agent-Token': agentToken }
  });
  assert.equal(commandsRes.status, 200);
  const { commands } = await commandsRes.json();
  const qCmd = commands.find((c) => c.command_type === 'quarantine' && c.payload.mac === testMac);
  assert.ok(qCmd, 'Router should have queued quarantine command for new client');

  // Complete the quarantine command
  await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/commands/${qCmd.id}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SecMyNet-Agent-Token': agentToken
    },
    body: JSON.stringify({ success: true })
  });

  // 6. Test 'wait' action (extending quarantine up to 5 min)
  const waitRes = await fetch(`${baseUrl}/api/notifications/${qNotif.id}/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ action: 'wait' })
  });
  assert.equal(waitRes.status, 200);
  const waitBody = await waitRes.json();
  assert.equal(waitBody.status, 'quarantine_wait');

  // 7. Test 'allow' action while mandatory 45s hold is still active -> should be placed in approved_holding
  const allowRes = await fetch(`${baseUrl}/api/notifications/${qNotif.id}/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ action: 'allow' })
  });
  assert.equal(allowRes.status, 200);
  const allowBody = await allowRes.json();
  assert.equal(allowBody.status, 'approved_holding');
  assert.ok(allowBody.holdingRemainingSeconds > 0);

  // 8. Test 'deny' / 'disallow' action -> should deny and queue disconnect + block
  const denyRes = await fetch(`${baseUrl}/api/notifications/${qNotif.id}/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ action: 'deny' })
  });
  assert.equal(denyRes.status, 200);
  const denyBody = await denyRes.json();
  assert.equal(denyBody.status, 'denied');

  // Verify router received disconnect and block commands
  const finalCmdsRes = await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/commands`, {
    headers: { 'X-SecMyNet-Agent-Token': agentToken }
  });
  const { commands: finalCmds } = await finalCmdsRes.json();
  const discCmd = finalCmds.find((c) => c.command_type === 'disconnect' && c.payload.mac === testMac);
  const blkCmd = finalCmds.find((c) => c.command_type === 'block' && c.payload.mac === testMac);
  assert.ok(discCmd, 'Router should receive disconnect command');
  assert.ok(blkCmd, 'Router should receive block command');
});

test('Returning user re-quarantine and connection history retention', async (t) => {
  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(() => {
    if (server) server.close();
  });

  // 1. Admin Login
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@secmynet.com', password: 'Admin@123' })
  });
  const { token: adminToken } = await loginRes.json();

  // 2. Register router
  const routerRes = await fetch(`${baseUrl}/api/openwrt/routers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Returning-Test-Router' })
  });
  const { routerId, agentToken } = await routerRes.json();

  const rand2 = Math.floor(Math.random() * 89 + 10).toString();
  const clientMac = `02:00:00:aa:bb:${rand2}`;
  const clientHostname = 'Returning-Phone';

  // 3. First connection: brand new device
  await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SecMyNet-Agent-Token': agentToken },
    body: JSON.stringify({
      clients: [{ mac: clientMac, ip: '192.168.1.155', hostname: clientHostname, rx_bytes: 10485760, tx_bytes: 5242880 }], // ~15 MB
      usage: []
    })
  });
  await new Promise((r) => setTimeout(r, 600));

  // Verify first notification is "New device detected"
  const notif1Res = await fetch(`${baseUrl}/api/notifications`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const { notifications: notifs1 } = await notif1Res.json();
  const firstNotif = notifs1.find((n) => n.message && n.message.includes(clientMac));
  assert.ok(firstNotif);
  assert.ok(firstNotif.message.includes('New device detected'), 'First connection should say New device detected');

  // Allow the first connection
  await fetch(`${baseUrl}/api/notifications/${firstNotif.id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ action: 'allow' })
  });

  // 4. Client disconnects: router sends telemetry without the client
  await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SecMyNet-Agent-Token': agentToken },
    body: JSON.stringify({ clients: [], usage: [] })
  });
  await new Promise((r) => setTimeout(r, 600));

  // Check user details: previous connection should be marked disconnected with data saved
  const userId = 'user-mac-' + clientMac.replace(/[^a-z0-9]/g, '');
  const userDetailsRes = await fetch(`${baseUrl}/api/users/${userId}/details`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(userDetailsRes.status, 200);
  const userDetails = await userDetailsRes.json();
  assert.ok(userDetails.connections.length >= 1, 'Should have at least 1 historical connection record');
  const pastSession = userDetails.connections[0];
  assert.equal(pastSession.status, 'disconnected', 'Session should be marked disconnected after client leaves');
  assert.ok(pastSession.disconnected_at, 'disconnected_at timestamp must be recorded');
  assert.ok(Number(pastSession.dataUsedMb) > 0, 'Past data usage must be preserved');

  // 5. Client RECONNECTS (Returning user)
  await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SecMyNet-Agent-Token': agentToken },
    body: JSON.stringify({
      clients: [{ mac: clientMac, ip: '192.168.1.155', hostname: clientHostname, rx_bytes: 204800, tx_bytes: 102400 }],
      usage: []
    })
  });
  await new Promise((r) => setTimeout(r, 600));

  // 6. Verify returning user quarantine notification is created!
  const notif2Res = await fetch(`${baseUrl}/api/notifications`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const { notifications: notifs2 } = await notif2Res.json();
  const returningNotif = notifs2.find((n) => n.message && n.message.includes(clientMac) && n.status === 'quarantine');
  assert.ok(returningNotif, 'Returning client MUST receive a new quarantine notification');
  assert.ok(returningNotif.message.includes('Returning user detected'), 'Notification must explicitly state Returning user detected');
  assert.ok(returningNotif.message.includes('Visit #2'), 'Notification must include Visit count');
  assert.ok(returningNotif.message.includes('Last logged'), 'Notification must include last logged time');
  assert.ok(returningNotif.message.includes('Total past usage'), 'Notification must include total past data consumed');

  // 7. Verify OpenWrt router received a quarantine command for the returning user
  const cmdsRes = await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/commands`, {
    headers: { 'X-SecMyNet-Agent-Token': agentToken }
  });
  const { commands } = await cmdsRes.json();
  const qCmd = commands.find((c) => c.command_type === 'quarantine' && c.payload.mac === clientMac);
  assert.ok(qCmd, 'Router command queue must have quarantine command for returning user');
});

test('Quarantine 5-minute timeout auto-disallow and expiration rejection', async (t) => {
  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(() => {
    if (server) server.close();
  });

  // Admin Login
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@secmynet.com', password: 'Admin@123' })
  });
  const { token: adminToken } = await loginRes.json();

  // Register router
  const routerRes = await fetch(`${baseUrl}/api/openwrt/routers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Timeout-Test-Router' })
  });
  const { routerId, agentToken } = await routerRes.json();

  const timeoutMac = `02:00:00:99:88:${Math.floor(Math.random() * 89 + 10)}`;

  // Post telemetry
  await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SecMyNet-Agent-Token': agentToken },
    body: JSON.stringify({
      clients: [{ mac: timeoutMac, ip: '192.168.1.199', hostname: 'Timeout-Target', rx_bytes: 1024, tx_bytes: 1024 }],
      usage: []
    })
  });
  await new Promise((r) => setTimeout(r, 600));

  // Get quarantine notification
  const notifRes = await fetch(`${baseUrl}/api/notifications`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const { notifications } = await notifRes.json();
  const qNotif = notifications.find((n) => n.message && n.message.includes(timeoutMac) && n.status === 'quarantine');
  assert.ok(qNotif, 'Quarantine notification must exist');

  // Manually fast-forward expires_at to 1 second in past in the database to simulate 5 minutes having elapsed
  const db = require('../db');
  await db.run("UPDATE notifications SET expires_at = $1 WHERE id = $2", [new Date(Date.now() - 1000).toISOString(), qNotif.id]);

  // Attempt to approve expired quarantine request -> must be rejected with 400 and status quarantine_auto_denied
  const lateAllowRes = await fetch(`${baseUrl}/api/notifications/${qNotif.id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ action: 'allow' })
  });
  assert.equal(lateAllowRes.status, 400);
  const lateAllowBody = await lateAllowRes.json();
  assert.equal(lateAllowBody.status, 'quarantine_auto_denied');

  // Verify notification in database is marked quarantine_auto_denied
  const updatedNotif = await db.get("SELECT * FROM notifications WHERE id = $1", [qNotif.id]);
  assert.equal(updatedNotif.status, 'quarantine_auto_denied');

  // Verify OpenWrt router received disconnect and block commands
  const cmdsRes = await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/commands`, {
    headers: { 'X-SecMyNet-Agent-Token': agentToken }
  });
  const { commands } = await cmdsRes.json();
  const discCmd = commands.find((c) => c.command_type === 'disconnect' && c.payload.mac === timeoutMac);
  const blkCmd = commands.find((c) => c.command_type === 'block' && c.payload.mac === timeoutMac);
  assert.ok(discCmd, 'Disconnect command must be queued on 5m timeout auto-disallow');
  assert.ok(blkCmd, 'Block command must be queued on 5m timeout auto-disallow');
});

test('Client quarantine status endpoint and captive holding notification page', async (t) => {
  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(() => {
    if (server) server.close();
  });

  // 1. Verify holding page and captive probe redirect
  const holdingRes = await fetch(`${baseUrl}/holding.html`);
  assert.equal(holdingRes.status, 200);
  const holdingHtml = await holdingRes.text();
  assert.ok(holdingHtml.includes('Service Approval Pending'));

  const probeRes = await fetch(`${baseUrl}/generate_204`, { redirect: 'manual' });
  assert.equal(probeRes.status, 302);
  assert.equal(probeRes.headers.get('location'), '/holding.html');

  // 2. Admin Login & Router Registration
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@secmynet.com', password: 'Admin@123' })
  });
  const { token: adminToken } = await loginRes.json();

  const routerRes = await fetch(`${baseUrl}/api/openwrt/routers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Captive-Test-Router' })
  });
  const { routerId, agentToken } = await routerRes.json();

  const clientMac = `02:00:00:cc:dd:${Math.floor(Math.random() * 89 + 10)}`;

  // 3. Post telemetry for new client
  await fetch(`${baseUrl}/api/openwrt/routers/${routerId}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SecMyNet-Agent-Token': agentToken },
    body: JSON.stringify({
      clients: [{ mac: clientMac, ip: '192.168.1.177', hostname: 'Galaxy-Tester', rx_bytes: 512, tx_bytes: 512 }],
      usage: []
    })
  });
  await new Promise((r) => setTimeout(r, 600));

  // 4. Client queries /api/client/status?mac=...
  const statusRes = await fetch(`${baseUrl}/api/client/status?mac=${clientMac}`);
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.equal(statusData.status, 'quarantine');
  assert.equal(statusData.approved, false);
  assert.equal(statusData.message, 'Service Approval pending from owner of the Router');
  assert.ok(statusData.holdRemainingSeconds > 0);

  // 5. Owner approves the client
  const notifRes = await fetch(`${baseUrl}/api/notifications`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const { notifications } = await notifRes.json();
  const notif = notifications.find((n) => n.message && n.message.includes(clientMac));
  assert.ok(notif);

  // Release device
  const db = require('../db');
  await db.run("UPDATE notifications SET min_quarantine_until = $1 WHERE id = $2", [new Date(Date.now() - 1000).toISOString(), notif.id]);
  const approveRes = await fetch(`${baseUrl}/api/notifications/${notif.id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ action: 'allow' })
  });
  assert.equal(approveRes.status, 200);

  // 6. Client re-queries status -> must now be approved!
  const statusAfterRes = await fetch(`${baseUrl}/api/client/status?mac=${clientMac}`);
  assert.equal(statusAfterRes.status, 200);
  const statusAfterData = await statusAfterRes.json();
  assert.equal(statusAfterData.status, 'allowed');
  assert.equal(statusAfterData.approved, true);
  assert.ok(statusAfterData.message.includes('Access Approved by Owner'));
});




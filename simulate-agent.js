/**
 * SecMyNet OpenWrt Agent Simulator
 * 
 * Usage:
 *   node simulate-agent.js <ROUTER_ID> <AGENT_TOKEN>
 * 
 * If you don't provide arguments, it will automatically authenticate as admin,
 * pick the first registered router (or router 558971), regenerate a valid token,
 * and send simulated real-time client station telemetry!
 */

const http = require('http');

const SERVER_URL = process.env.SECMYNET_URL || 'http://localhost:3000';
let routerId = process.argv[2];
let agentToken = process.argv[3];

async function request(path, options = {}) {
  const url = new URL(path, SERVER_URL);
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function main() {
  console.log(`Connecting to SecMyNet server at ${SERVER_URL}...`);

  if (!routerId || !agentToken) {
    console.log('Logging in as admin to retrieve router information...');
    const loginRes = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { email: 'admin@secmynet.com', password: 'Admin@123' }
    });

    if (loginRes.status !== 200 || !loginRes.body.token) {
      console.error('Failed to log in as admin:', loginRes.body);
      process.exit(1);
    }

    const adminToken = loginRes.body.token;
    const routersRes = await request('/api/openwrt/routers', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const routers = routersRes.body.routers || [];
    if (!routers.length) {
      console.error('No routers registered. Register a router on the portal first!');
      process.exit(1);
    }

    const targetRouter = routers.find((r) => r.id === '558971') || routers[0];
    routerId = targetRouter.id;
    console.log(`Found router: "${targetRouter.name}" (ID: ${routerId})`);

    console.log('Regenerating a fresh agent token for simulation...');
    const tokenRes = await request(`/api/openwrt/routers/${routerId}/reset-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    if (tokenRes.status !== 200) {
      console.error('Failed to reset token:', tokenRes.body);
      process.exit(1);
    }

    agentToken = tokenRes.body.agentToken;
    console.log(`Generated Agent Token: ${agentToken}`);
  }

  // Simulated clients
  const isQuarantineTest = process.argv.includes('--new-client') || process.argv.includes('--quarantine');
  const mockClients = [
    {
      mac: '50:eb:f6:12:34:56',
      ip: '192.168.1.101',
      hostname: 'Krishnas-iPhone',
      rx_bytes: 142058920, // ~135 MB
      tx_bytes: 84930210,  // ~81 MB
      signal: -52
    },
    {
      mac: '3c:22:fb:78:9a:bc',
      ip: '192.168.1.102',
      hostname: 'MacBook-Pro',
      rx_bytes: 524288000, // ~500 MB
      tx_bytes: 262144000, // ~250 MB
      signal: -45
    },
    {
      mac: 'a4:c3:f0:44:55:66',
      ip: '192.168.1.105',
      hostname: 'Galaxy-S23',
      rx_bytes: 47185920,  // ~45 MB
      tx_bytes: 15728640,  // ~15 MB
      signal: -63
    }
  ];

  const isReturningTest = process.argv.includes('--returning-client');

  if (isQuarantineTest) {
    const randomHex = Math.floor(Math.random() * 899 + 100).toString();
    mockClients.push({
      mac: `fa:99:11:22:33:${randomHex.slice(-2)}`,
      ip: '192.168.1.199',
      hostname: 'New-Guest-Device',
      rx_bytes: 409600,
      tx_bytes: 204800,
      signal: -58
    });
    console.log(`\n🚨 SIMULATION: Added brand new device [New-Guest-Device, MAC: fa:99:11:22:33:${randomHex.slice(-2)}] to test Quarantine-First enforcement!`);
  }

  if (isReturningTest) {
    console.log(`\n🔄 SIMULATION: Posting telemetry for returning client [Krishnas-iPhone, MAC: 50:eb:f6:12:34:56] to test returning user quarantine and past history logging!`);
  }

  console.log(`Posting telemetry with ${mockClients.length} clients to router ${routerId}...`);
  const telemetryRes = await request(`/api/openwrt/routers/${routerId}/telemetry`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SecMyNet-Agent-Token': agentToken
    },
    body: {
      clients: mockClients,
      usage: []
    }
  });

  if (telemetryRes.status === 200 || telemetryRes.status === 201) {
    console.log('\n✅ SUCCESS: Telemetry posted successfully!');
    console.log(`- Router ID: ${routerId}`);
    console.log(`- Status: Online`);
    console.log(`- Active Clients Reported: ${mockClients.length}`);

    // Poll command queue
    console.log('\nChecking OpenWrt router command queue from SecMyNet server...');
    const cmdRes = await request(`/api/openwrt/routers/${routerId}/commands`, {
      headers: { 'X-SecMyNet-Agent-Token': agentToken }
    });

    const commands = cmdRes.body.commands || [];
    if (commands.length) {
      console.log(`📬 Received ${commands.length} queued command(s) from server:`);
      for (const cmd of commands) {
        console.log(`   - [Command ${cmd.id}] Type: ${cmd.command_type.toUpperCase()} | Payload:`, cmd.payload);
        // Acknowledge command completion
        await request(`/api/openwrt/routers/${routerId}/commands/${cmd.id}/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-SecMyNet-Agent-Token': agentToken
          },
          body: { success: true }
        });
        console.log(`     -> Marked command ${cmd.id} as completed on router.`);
      }
    } else {
      console.log('ℹ️ No pending commands in router queue.');
    }

    console.log('\nOpen your browser at http://localhost:3000/#overview or #notifications to inspect the active quarantine hold and approvals!');
  } else {
    console.error('❌ Telemetry post failed with code:', telemetryRes.status, telemetryRes.body);
  }
}

main().catch(console.error);

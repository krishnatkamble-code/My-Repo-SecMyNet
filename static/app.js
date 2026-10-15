const state = { token: localStorage.getItem('secmynet-token') || '', data: null, userData: null, superAdmins: [], routers: [], notifications: [], page: 'overview', userPage: 'locations', selected: null, showLocationForm: false, locationFormTarget: null, showRouterForm: false, routerFormTarget: null, usagePeriod: 'all', deviceUsagePeriod: 'all' };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
function generateClientSerialNumber() {
  const digits = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const alphaNum = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${digits}-${alphaNum}`;
}
const mb = (value) => `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
const authHeaders = (headers = {}) => state.token ? { ...headers, Authorization: `Bearer ${state.token}` } : headers;
const sessionStartedAt = () => { const existing = sessionStorage.getItem('secmynet-session-start'); if (existing) return existing; const started = new Date().toISOString(); sessionStorage.setItem('secmynet-session-start', started); return started; };
const formatSessionTime = (value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function apiRequest(url, options = {}) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Request failed.'); return data; }
function usage(connections, period = 'all') { const cutoffs = { day: 1, week: 7, month: 30, year: 365 }; const from = cutoffs[period] ? Date.now() - cutoffs[period] * 86400000 : 0; return connections.filter((c) => !from || new Date(c.connectedAt || c.connected_at).getTime() >= from).reduce((sum, c) => sum + Number(c.dataUsedMb || c.data_used_mb || 0), 0); }
function stat(label, value, note = '') { return `<div class="stat-box"><span>${escapeHtml(label)}</span><strong>${value}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`; }
function table(headers, body) { return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${headers.length}" class="empty">No records available yet.</td></tr>`}</tbody></table></div>`; }
function connectedForDevice(id) { return state.data.connections.filter((c) => (c.device_id || c.deviceId) === id && c.status === 'connected'); }
function connectionsForDevice(id) { return state.data.connections.filter((c) => (c.device_id || c.deviceId) === id); }
function locationForDevice(device) { return device.location || state.data.locations.find((l) => l.id === device.location_id); }

function renderOverview() {
  const d = state.data;
  const telemetryClients = (state.routers || []).flatMap((r) => (r.clients || []).map((cl) => ({ ...cl, routerName: r.name })));
  const totalActive = Math.max(d.stats.activeConnections, telemetryClients.length);
  const connRows = d.connections.filter((c) => c.status === 'connected').map((c) => `<tr><td>${escapeHtml(c.userName)}</td><td>${escapeHtml(c.deviceName)}</td><td>${mb(c.dataUsedMb)}</td><td><span class="status-badge connected">Connected</span></td></tr>`).join('');
  const telemetryRows = telemetryClients.map((cl) => {
    const totalMb = ((Number(cl.rx_bytes || 0) + Number(cl.tx_bytes || 0)) / (1024 * 1024)).toFixed(2);
    return `<tr><td><strong>${escapeHtml(cl.hostname || 'Client')}</strong><small>${escapeHtml(cl.mac || '')}</small></td><td>${escapeHtml(cl.routerName)}</td><td>${mb(totalMb)}</td><td><span class="status-badge connected">Connected</span></td></tr>`;
  }).join('');
  const allRows = (connRows + telemetryRows);
  return `<div class="stats">${stat('Locations', d.stats.totalLocations, 'managed sites')}${stat('Devices', d.stats.totalDevices, 'WiFi devices')}${stat('Users', d.stats.totalUsers, 'registered accounts')}${stat('Connected now', totalActive, 'active sessions')}</div><section class="content-card"><h3>Quick access</h3><div class="quick-links"><button data-go="locations">View locations</button><button data-go="devices">View devices</button><button data-go="users">Review users</button><button data-go="manage">Manage access</button></div></section><section class="content-card"><h3>Current connections</h3>${table(['User / Client', 'Device / Router', 'Data used', 'Status'], allRows)}</section>`;
}
function renderLocations() { const cards = state.data.locations.map((l) => { const devices = state.data.devices.filter((d) => d.location_id === l.id); const conns = devices.flatMap((d) => connectionsForDevice(d.id)); return `<article class="location-card"><button class="location-card-content" data-location="${escapeHtml(l.id)}"><span class="card-kicker">${escapeHtml(l.city)}</span><h3>${escapeHtml(l.name)}</h3><div><strong>${devices.length}</strong> devices · <strong>${mb(usage(conns))}</strong> consumed</div><small>${connectedForLocation(l.id)} users connected now</small><span class="card-link">Open location details →</span></button><div style="display:flex;gap:6px;margin-top:auto"><button class="action-button edit-location" data-edit-location="${escapeHtml(l.id)}">Edit Location</button><button class="action-button danger-action" data-delete-location="${escapeHtml(l.id)}">Delete Location</button></div></article>`; }).join(''); const target = state.locationFormTarget; const addForm = state.showLocationForm ? `<section class="content-card"><h3>${target ? 'Edit Location' : 'Add Location'}</h3><form id="locationForm"><input name="name" placeholder="Location name" value="${escapeHtml(target?.name || '')}" required><input name="city" placeholder="City" value="${escapeHtml(target?.city || '')}" required><button class="compact-button">${target ? 'Update Location' : 'Save Location'}</button></form></section>` : ''; const addButton = state.showLocationForm ? '' : '<button data-add="location">+ Add Location</button>'; return `${addForm}<div class="section-toolbar"><p>Choose a location to see every WiFi device and its users.</p>${addButton}</div><div class="location-grid">${cards || '<p class="empty">No locations have been added yet.</p>'}</div>`; }
function connectedForLocation(id) { return state.data.devices.filter((d) => d.location_id === id).reduce((count, d) => count + connectedForDevice(d.id).length, 0); }
function renderLocationDetail(location) { const devices = state.data.devices.filter((d) => d.location_id === location.id); return `<div class="detail-summary"><span class="card-kicker">${escapeHtml(location.city)}</span><h3>${escapeHtml(location.name)}</h3><p>${devices.length} WiFi devices · ${connectedForLocation(location.id)} users currently connected</p><div style="display:flex;gap:8px;"><button class="action-button" data-edit-location="${escapeHtml(location.id)}">Edit Location</button><button class="action-button danger-action" data-delete-location="${escapeHtml(location.id)}">Delete Location</button></div></div>${devices.map(renderDeviceBlock).join('') || '<p class="empty">There are no WiFi devices at this location yet.</p>'}`; }
function periodCells(conns) { return `<td>${mb(usage(conns, 'day'))}</td><td>${mb(usage(conns, 'week'))}</td><td>${mb(usage(conns, 'month'))}</td><td>${mb(usage(conns, 'year'))}</td>`; }
function renderDeviceBlock(device) { const conns = connectionsForDevice(device.id); const active = connectedForDevice(device.id); const users = active.map((c) => { const userConns = conns.filter((x) => (x.user_id || x.userId) === (c.user_id || c.userId)); return `<tr><td>${escapeHtml(c.userName)}<small>${escapeHtml(c.userEmail)}</small></td>${periodCells(userConns)}<td>${mb(usage(userConns))}</td><td><button class="action-button danger-action" data-disconnect="${device.id}|${c.user_id || c.userId}">Disconnect</button><button class="action-button danger-action" data-block="${device.id}|${c.user_id || c.userId}">Blacklist</button><button class="action-button danger-action" data-delete-user="${c.user_id || c.userId}">Delete User</button></td></tr>`; }).join(''); return `<section class="content-card device-block"><div class="device-heading"><div><h3>${escapeHtml(device.name)}</h3><p>${escapeHtml(device.wifi_name || device.wifiName)} · ${active.length} connected</p></div><span class="status-badge ${escapeHtml(device.status)}">${escapeHtml(device.status)}</span></div>${table(['Internet user', 'Today', 'Week', 'Month', 'Year', 'Since start', 'Actions'], users)}</section>`; }
function deviceList() { const deviceFilter = `<div class="usage-header"><button type="button" id="deviceUsageFilterToggle" class="column-filter-title">Data Consumed</button><select id="deviceUsageFilter" aria-label="Filter device data consumed period"><option value="all" ${state.deviceUsagePeriod === 'all' ? 'selected' : ''}>Since Start</option><option value="month" ${state.deviceUsagePeriod === 'month' ? 'selected' : ''}>Last Month</option><option value="week" ${state.deviceUsagePeriod === 'week' ? 'selected' : ''}>Last Week</option><option value="day" ${state.deviceUsagePeriod === 'day' ? 'selected' : ''}>Today</option></select></div>`; const body = state.data.devices.map((d) => { const l = locationForDevice(d) || {}; const router = state.routers.find((r) => r.id === d.router_id); const conns = connectionsForDevice(d.id); const sn = d.serial_number || d.serialNumber || (router ? (router.serial_number || router.serialNumber) : 'N/A'); const routerId = d.router_id || d.routerId || (router ? router.id : '') || 'N/A'; return `<tr><td style="text-align:center"><button class="text-link" data-device="${d.id}">${escapeHtml(d.name)}</button><button class="action-button edit-device-button" style="display:block;margin:6px auto 0" data-edit-device="${d.id}">Edit Device</button></td><td><code style="background:#eef2f7;padding:3px 8px;border-radius:4px;font-family:monospace;font-weight:600;color:#0f172a;">${escapeHtml(routerId)}</code></td><td><code style="background:#eef2f7;padding:3px 8px;border-radius:4px;font-family:monospace;font-weight:600;color:#0f172a;">${escapeHtml(sn)}</code></td><td>${escapeHtml(d.wifi_name || d.wifiName)}</td><td>${escapeHtml(l.name || 'Unknown')}</td><td>${escapeHtml(d.ip_address || d.ipAddress || 'IP unavailable')}</td><td>${mb(usage(conns, state.deviceUsagePeriod))}</td><td>${connectedForDevice(d.id).length}</td><td><button class="action-button" data-restart="${d.id}">Restart</button><button class="action-button" data-device="${d.id}">Details</button><button class="action-button danger-action" data-delete-device="${d.id}">Delete</button></td></tr>`; }).join(''); return table(['Device Name', 'Router ID', 'Serial Number', 'WiFi Name', 'Location', 'IP address', deviceFilter, 'Active Users', 'Actions'], body); }
function renderDevices() { return `<div class="section-toolbar"><p>All WiFi devices across every managed location.</p></div>${deviceList()}`; }
function renderAddDevice(device = null) { const editing = Boolean(device); const routerId = device?.router_id || device?.routerId || ''; return `<section class="content-card"><h3>${editing ? 'Edit the WiFi device' : 'Add a WiFi device'}</h3><p>${editing ? 'Update the device details.' : 'Add a device to one of your existing locations. Router ID is automatically generated in the database upon registration.'}</p><form id="deviceForm" data-editing-device="${editing ? escapeHtml(device.id) : ''}"><select name="locationId" required><option value="">Select location</option>${state.data.locations.map((l) => `<option value="${escapeHtml(l.id)}" ${device?.location_id === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}</select><input name="name" placeholder="Device name" value="${editing ? escapeHtml(device.name) : ''}" required>${editing ? `<div style="margin-bottom:12px;"><label style="font-size:0.85rem;color:#64748b;display:block;margin-bottom:4px;font-weight:500;">Router ID (generated in database)</label><input name="routerId" value="${escapeHtml(routerId)}" readonly style="background:#f8fafc;cursor:not-allowed;font-family:monospace;font-weight:600;color:#0f172a;"></div>` : ''}<input name="wifiName" placeholder="WiFi name" value="${editing ? escapeHtml(device.wifi_name || device.wifiName) : ''}" required><input name="wifiPassword" placeholder="WiFi Password (min 8 characters, e.g. 97198400)" value="${editing ? escapeHtml(device.wifi_password || device.wifiPassword || '') : ''}"><input id="deviceSerialInput" name="serialNumber" placeholder="Serial Number (e.g. 849201-X7K2M9)" value="${editing ? escapeHtml(device.serial_number || device.serialNumber || '') : ''}"><input name="ipAddress" type="text" inputmode="numeric" autocomplete="off" maxlength="15" pattern="(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}" placeholder="IPv4 address (e.g. 192.168.255.254)" value="${editing ? escapeHtml(device.ip_address || device.ipAddress || '') : ''}" aria-label="IPv4 address" required><button>${editing ? 'Update device' : 'Save device'}</button></form></section>${editing ? '' : `<section class="content-card"><h3>Already listed devices</h3>${deviceList()}</section>`}`; }
function renderDeviceDetail(device) { const location = locationForDevice(device) || {}; const routerId = device.router_id || device.routerId || 'N/A'; const wifiPass = (device.wifi_password || device.wifiPassword) ? ` · Password: <code style="background:#eef2f7;padding:3px 8px;border-radius:4px;font-family:monospace;font-weight:600;color:#0f172a;">${escapeHtml(device.wifi_password || device.wifiPassword)}</code>` : ''; return `<div class="detail-summary"><span class="card-kicker">${escapeHtml(location.name || 'Unknown location')}</span><h3>${escapeHtml(device.name)}</h3><p>Router ID: <code style="background:#eef2f7;padding:3px 8px;border-radius:4px;font-family:monospace;font-weight:600;color:#0f172a;">${escapeHtml(routerId)}</code> · WiFi: ${escapeHtml(device.wifi_name || device.wifiName)}${wifiPass} · ${mb(usage(connectionsForDevice(device.id)))} consumed since start</p></div>${renderDeviceBlock(device)}`; }
function userRows() {
	const activeConnections = state.data.connections.filter((connection) => connection.status === 'connected');
	const pendingRequests = state.notifications.filter((notification) => notification.type === 'connection_request' && ['unread', 'quarantine'].includes(notification.status) && !activeConnections.some((connection) => (connection.user_id || connection.userId) === notification.user_id && (connection.device_id || connection.deviceId) === notification.device_id));
	const registeredUsers = state.data.users.filter((user) => user.role === 'user' && !activeConnections.some((c) => (c.user_id || c.userId) === user.id) && !pendingRequests.some((p) => p.user_id === user.id));

	const connectionItems = [...activeConnections, ...pendingRequests].map((connection) => {
		const userId = connection.user_id || connection.userId;
		const deviceId = connection.device_id || connection.deviceId;
		const device = state.data.devices.find((item) => item.id === deviceId) || {};
		const deviceIp = connection.deviceIp || device.ip || device.device_ip || device.ipAddress || 'IP unavailable';
		const location = locationForDevice(device) || {};
		const user = state.data.users.find((item) => item.id === userId) || {};
		const userConnections = state.data.connections.filter((item) => (item.user_id || item.userId) === userId && (item.device_id || item.deviceId) === deviceId);
		const pendingRequest = state.notifications.find((notification) => notification.type === 'connection_request' && notification.user_id === userId && notification.device_id === deviceId && ['unread', 'quarantine'].includes(notification.status));
		const disabled = user.accessStatus === 'disabled';
		const status = disabled ? '<span class="status-badge blocked">Disabled</span>' : pendingRequest ? '<span class="status-badge quarantine">Quarantine</span>' : '<span class="status-badge connected">Connected</span>';
		const actions = pendingRequest
			? `<button class="action-button" data-notification-response="${pendingRequest.id}|allow">Allow</button><button class="action-button danger" data-notification-response="${pendingRequest.id}|deny">Blacklist</button><button class="action-button danger-action" data-delete-user="${escapeHtml(userId)}">Delete</button>`
			: `<button class="action-button" data-user-details="${escapeHtml(userId)}">Details</button><button class="action-button danger-action" data-disconnect="${escapeHtml(deviceId)}|${escapeHtml(userId)}">Disconnect</button><button class="action-button danger" data-block="${escapeHtml(deviceId)}|${escapeHtml(userId)}">Blacklist</button><button class="action-button danger-action" data-delete-user="${escapeHtml(userId)}">Delete</button>`;

		// Check if there is telemetry from any router for this user/client
		const clientMac = (user.email || connection.userEmail || '').toLowerCase();
		const isMac = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(clientMac) || (userId && userId.startsWith('user-mac-'));
		const rClient = (state.routers || []).flatMap((r) => r.clients || []).find((c) => (c.mac || '').toLowerCase() === clientMac);
		let usageHtml = '';
		const totalDataVal = usage(userConnections, state.usagePeriod);
		if (rClient) {
			const rxMb = (Number(rClient.rx_bytes || 0) / (1024 * 1024)).toFixed(2);
			const txMb = (Number(rClient.tx_bytes || 0) / (1024 * 1024)).toFixed(2);
			const liveTotalMb = ((Number(rClient.rx_bytes || 0) + Number(rClient.tx_bytes || 0)) / (1024 * 1024)).toFixed(2);
			const finalTotal = state.usagePeriod === 'all' ? Math.max(Number(totalDataVal), Number(liveTotalMb)).toFixed(2) : totalDataVal;
			usageHtml = `<strong>${mb(finalTotal)}</strong><small style="display:block;color:#64748b;font-size:0.75rem;margin-top:2px;">RX: ${mb(rxMb)} · TX: ${mb(txMb)}</small>`;
		} else {
			usageHtml = `<strong>${mb(totalDataVal)}</strong>`;
		}

		const nameHtml = `<strong>${escapeHtml(user.name || connection.userName)}</strong><small>${isMac ? 'MAC: ' : ''}${escapeHtml(user.email || connection.userEmail)}</small>${rClient && rClient.signal !== undefined ? `<small style="display:block;color:#0284c7;font-size:0.72rem;margin-top:2px;">📶 Signal: ${rClient.signal} dBm</small>` : ''}`;
		const devHtml = `<strong>${escapeHtml(device.name || connection.deviceName)}</strong><small>IP: <code>${escapeHtml(deviceIp)}</code></small>${device.router_id || device.routerId ? `<small style="display:block;color:#64748b;font-size:0.72rem;">Router ID: ${escapeHtml(device.router_id || device.routerId)}</small>` : ''}`;

		return `<tr><td>${nameHtml}</td><td>${escapeHtml(location.name || '—')}</td><td>${devHtml}</td><td>${usageHtml}</td><td>${status}</td><td>${actions}</td></tr>`;
	});

	// Also include any real-time OpenWrt clients that might not be in connectionItems yet
	const routerClientItems = (state.routers || []).flatMap((r) => {
		return (r.clients || []).filter((cl) => {
			const mac = (cl.mac || '').toLowerCase();
			return !activeConnections.some((c) => (c.user_email || c.userEmail || c.user_id || '').toLowerCase().includes(mac));
		}).map((cl) => {
			const rxMb = (Number(cl.rx_bytes || 0) / (1024 * 1024)).toFixed(2);
			const txMb = (Number(cl.tx_bytes || 0) / (1024 * 1024)).toFixed(2);
			const totalMb = ((Number(cl.rx_bytes || 0) + Number(cl.tx_bytes || 0)) / (1024 * 1024)).toFixed(2);
			const devName = r.name || 'OpenWrt Router';
			const devIp = cl.ip || '192.168.1.1';
			const locName = r.location_name || 'Unassigned';
			const fakeUserId = 'user-mac-' + (cl.mac || '').toLowerCase().replace(/[^a-z0-9]/g, '');
			const actions = `<button class="action-button" data-user-details="${escapeHtml(fakeUserId)}">Details</button><button class="action-button danger-action" data-disconnect-router-client="${r.id}|${cl.mac}">Disconnect</button><button class="action-button danger" data-block-router-client="${r.id}|${cl.mac}">Blacklist</button>`;
			return `<tr><td><strong>${escapeHtml(cl.hostname || 'Client')}</strong><small>MAC: ${escapeHtml(cl.mac || '')}</small><small style="display:block;color:#0284c7;font-size:0.72rem;margin-top:2px;">📶 Signal: ${cl.signal !== undefined ? cl.signal + ' dBm' : '—'} · Wi-Fi Client</small></td><td>${escapeHtml(locName)}</td><td><strong>${escapeHtml(devName)}</strong><small>IP: <code>${escapeHtml(devIp)}</code></small><small style="display:block;color:#64748b;font-size:0.72rem;">Router ID: ${escapeHtml(r.id)}</small></td><td><strong>${mb(totalMb)}</strong><small style="display:block;color:#64748b;font-size:0.75rem;margin-top:2px;">RX: ${mb(rxMb)} · TX: ${mb(txMb)}</small></td><td><span class="status-badge connected">Connected</span></td><td>${actions}</td></tr>`;
		});
	});

	const extraUserItems = registeredUsers.map((user) => {
		const userConns = state.data.connections.filter((item) => (item.user_id || item.userId) === user.id);
		const disabled = user.accessStatus === 'disabled';
		const status = disabled ? '<span class="status-badge blocked">Disabled</span>' : '<span class="status-badge">Registered</span>';
		const clientMac = (user.email || '').toLowerCase();
		const isMac = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(clientMac) || user.id.startsWith('user-mac-');
		const rClient = (state.routers || []).flatMap((r) => r.clients || []).find((c) => (c.mac || '').toLowerCase() === clientMac);
		const matchedRouter = rClient ? (state.routers || []).find((r) => (r.clients || []).some((c) => (c.mac || '').toLowerCase() === clientMac)) : null;

		let usageHtml = '';
		const totalDataVal = usage(userConns, state.usagePeriod);
		if (rClient) {
			const rxMb = (Number(rClient.rx_bytes || 0) / (1024 * 1024)).toFixed(2);
			const txMb = (Number(rClient.tx_bytes || 0) / (1024 * 1024)).toFixed(2);
			const liveTotalMb = ((Number(rClient.rx_bytes || 0) + Number(rClient.tx_bytes || 0)) / (1024 * 1024)).toFixed(2);
			const finalTotal = state.usagePeriod === 'all' ? Math.max(Number(totalDataVal), Number(liveTotalMb)).toFixed(2) : totalDataVal;
			usageHtml = `<strong>${mb(finalTotal)}</strong><small style="display:block;color:#64748b;font-size:0.75rem;margin-top:2px;">RX: ${mb(rxMb)} · TX: ${mb(txMb)}</small>`;
		} else {
			usageHtml = `<strong>${mb(totalDataVal)}</strong>`;
		}

		const nameHtml = `<strong>${escapeHtml(user.name)}</strong><small>${isMac ? 'MAC: ' : ''}${escapeHtml(user.email)}</small>${rClient && rClient.signal !== undefined ? `<small style="display:block;color:#0284c7;font-size:0.72rem;margin-top:2px;">📶 Signal: ${rClient.signal} dBm</small>` : ''}`;
		const locName = matchedRouter?.location_name || '—';
		const devName = matchedRouter?.name ? `<strong>${escapeHtml(matchedRouter.name)}</strong><small>IP: <code>${escapeHtml(rClient?.ip || user.mobileNumber || user.mobile_number || '—')}</code></small>` : (user.mobileNumber || user.mobile_number ? `<code>${escapeHtml(user.mobileNumber || user.mobile_number)}</code>` : '—');
		const actions = `<button class="action-button" data-user-details="${escapeHtml(user.id)}">Details</button><button class="action-button" data-toggle-user="${escapeHtml(user.id)}">${disabled ? 'Enable Access' : 'Disable Access'}</button><button class="action-button danger-action" data-delete-user="${escapeHtml(user.id)}">Delete</button>`;
		return `<tr><td>${nameHtml}</td><td>${escapeHtml(locName)}</td><td>${devName}</td><td>${usageHtml}</td><td>${status}</td><td>${actions}</td></tr>`;
	});

	return [...connectionItems, ...routerClientItems, ...extraUserItems].join('');
}
function renderUsers() { const periodFilter = `<div class="usage-header"><button type="button" id="userUsageFilterToggle" class="column-filter-title">Data Used</button><select id="userUsageFilter" aria-label="Filter data used period"><option value="all" ${state.usagePeriod === 'all' ? 'selected' : ''}>Since start</option><option value="day" ${state.usagePeriod === 'day' ? 'selected' : ''}>Today</option><option value="week" ${state.usagePeriod === 'week' ? 'selected' : ''}>Week</option><option value="month" ${state.usagePeriod === 'month' ? 'selected' : ''}>Month</option><option value="year" ${state.usagePeriod === 'year' ? 'selected' : ''}>Year</option></select></div>`; return `<p class="page-intro">All user accounts, their active location, total data consumption, and access controls.</p>${table(['Name', 'Location', 'Device IP & Name', periodFilter, 'Status', 'Actions'], userRows())}`; }
function renderManage() { const rows = state.data.locations.map((location) => { const devices = state.data.devices.filter((device) => device.location_id === location.id); return `<tr><td><button class="text-link" data-location="${escapeHtml(location.id)}">${escapeHtml(location.name)}</button></td><td>${escapeHtml(location.city)}</td><td>${devices.length}</td><td>${connectedForLocation(location.id)}</td><td><button class="action-button" data-location="${escapeHtml(location.id)}">View location</button><button class="action-button" data-edit-location="${escapeHtml(location.id)}">Edit Location</button><button class="action-button danger-action" data-delete-location="${escapeHtml(location.id)}">Delete Location</button></td></tr>`; }).join(''); return `<p class="page-intro">All locations currently available in your SecMyNet account.</p>${table(['Location', 'City', 'WiFi devices', 'Active Users', 'Actions'], rows)}`; }
let notificationsLiveTimer = null;
function renderNotifications() {
  if (notificationsLiveTimer) { clearInterval(notificationsLiveTimer); notificationsLiveTimer = null; }
  state.notificationTab = state.notificationTab || 'pending';
  const now = Date.now();

  const allItems = state.notifications || [];
  const pendingItems = allItems.filter((n) => n.type === 'connection_request' && ['unread', 'quarantine', 'quarantine_wait', 'approved_holding'].includes(n.status));
  const approvedItems = allItems.filter((n) => n.status === 'allowed');
  const disallowedItems = allItems.filter((n) => ['denied', 'quarantine_auto_denied', 'disconnected'].includes(n.status) || (n.type === 'overconsumption' && n.status !== 'allowed'));

  const pendingRows = pendingItems.map((n) => {
    const isReturning = (n.message || '').includes('Returning user');
    const expires = n.expires_at ? new Date(n.expires_at).getTime() : (now + 300000);
    const timeoutRemaining = Math.max(0, Math.ceil((expires - now) / 1000));
    const ageSec = Math.floor((now - new Date(n.created_at).getTime()) / 1000);
    const mins = Math.floor(timeoutRemaining / 60);
    const secs = String(timeoutRemaining % 60).padStart(2, '0');

    let actions = '';
    if (timeoutRemaining === 0) {
      actions = `<span class="status-badge blocked">Disallowed (5m Timeout)</span>${n.user_id ? `<button class="action-button" style="background:#0284c7;color:#fff;margin-left:6px;" data-user-details="${escapeHtml(n.user_id)}">History</button>` : ''}`;
    } else {
      const waitLabel = ageSec >= 45 ? `Pending (${Math.floor(ageSec / 60)}m ${ageSec % 60}s)` : `Review (${45 - ageSec}s)`;
      actions = `<span class="status-badge" style="background:#fef3c7;color:#92400e;font-size:0.75rem;margin-right:6px;">${waitLabel}</span><button class="action-button" style="background:#166534;color:#fff;font-weight:600;" data-notification-response="${n.id}|allow">Allow Access</button><button class="action-button" style="background:#f59e0b;color:#fff;" data-notification-response="${n.id}|wait">Wait (5m)</button><button class="action-button danger" data-notification-response="${n.id}|deny">Disallow</button>${n.user_id ? `<button class="action-button" style="background:#0284c7;color:#fff;" data-user-details="${escapeHtml(n.user_id)}">History</button>` : ''}`;
    }
    const typeBadge = isReturning ? '<span class="status-badge" style="background:#e0f2fe;color:#0369a1;font-size:0.72rem;margin-left:6px;">Returning Client</span>' : '';
    return `<tr><td>Connection request${typeBadge}</td><td><strong>${escapeHtml(n.message)}</strong><small style="color:#b45309;">⏳ Auto-disconnects in ${mins}m ${secs}s if unapproved</small></td><td>${escapeHtml(n.location_name || '—')}</td><td>${new Date(n.created_at).toLocaleString()}</td><td>${actions}</td></tr>`;
  }).join('');

  const approvedRows = approvedItems.map((n) => {
    const isReturning = (n.message || '').includes('Returning user');
    const typeBadge = isReturning ? '<span class="status-badge" style="background:#e0f2fe;color:#0369a1;font-size:0.72rem;margin-left:6px;">Returning Client</span>' : '';
    const actions = `<button class="action-button danger" data-notification-response="${n.id}|disconnect">Disconnect</button>${n.user_id ? `<button class="action-button" style="background:#0284c7;color:#fff;" data-user-details="${escapeHtml(n.user_id)}">View History</button>` : ''}<button class="action-button secondary" data-notification-clear="${n.id}">Clear</button>`;
    return `<tr><td>Approved access${typeBadge}</td><td><strong>${escapeHtml(n.message)}</strong><span class="status-badge allowed" style="margin-left:6px;">Allowed / Online</span></td><td>${escapeHtml(n.location_name || '—')}</td><td>${new Date(n.created_at).toLocaleString()}</td><td>${actions}</td></tr>`;
  }).join('');

  const disallowedRows = disallowedItems.map((n) => {
    const badgeCls = ['denied', 'disconnected', 'quarantine_auto_denied'].includes(n.status) ? 'blocked' : '';
    const displayStatus = n.status === 'quarantine_auto_denied' ? 'Disallowed (5m Timeout)' : n.status.replace(/_/g, ' ');
    const actions = `<button class="action-button" style="background:#166534;color:#fff;" data-notification-response="${n.id}|allow">Re-Allow</button>${n.user_id ? `<button class="action-button" style="background:#0284c7;color:#fff;" data-user-details="${escapeHtml(n.user_id)}">View History</button>` : ''}<button class="action-button secondary" data-notification-clear="${n.id}">Clear</button>`;
    return `<tr><td>Disallowed / Closed</td><td><strong>${escapeHtml(n.message)}</strong><span class="status-badge ${badgeCls}" style="margin-left:6px;">${escapeHtml(displayStatus)}</span></td><td>${escapeHtml(n.location_name || '—')}</td><td>${new Date(n.created_at).toLocaleString()}</td><td>${actions}</td></tr>`;
  }).join('');

  const activeTab = state.notificationTab;
  let activeContent = '';
  let activeIntro = '';

  if (activeTab === 'pending') {
    activeIntro = 'Category 1: Pending Approvals — Connection requests exceeding 45s review window or awaiting owner decision. Client has ZERO internet access until approved.';
    activeContent = pendingItems.length ? table(['Type', 'Notification', 'Location', 'Requested Time', 'Actions'], pendingRows) : '<p class="empty">No pending connection requests. All clients have been reviewed.</p>';
  } else if (activeTab === 'approved') {
    activeIntro = 'Category 2: Approved Requests — Client devices approved by the owner with internet access granted.';
    activeContent = approvedItems.length ? table(['Type', 'Notification', 'Location', 'Approved Time', 'Actions'], approvedRows) : '<p class="empty">No approved connection records.</p>';
  } else {
    activeIntro = 'Category 3: Disallowed / History — Devices that were disallowed, disconnected, or timed out.';
    activeContent = disallowedItems.length ? table(['Type', 'Notification', 'Location', 'Time', 'Actions'], disallowedRows) : '<p class="empty">No disallowed or disconnected records.</p>';
  }

  const tabsHtml = `
    <div class="notification-tabs" style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">
      <button class="action-button ${activeTab === 'pending' ? 'active-tab' : ''}" data-notif-tab="pending" style="${activeTab === 'pending' ? 'background:#2d5aa8;color:#fff;font-weight:700;border-color:#2d5aa8;' : 'background:#fff;color:#334155;'}">
        ⏳ 1. Pending Approvals (${pendingItems.length})
      </button>
      <button class="action-button ${activeTab === 'approved' ? 'active-tab' : ''}" data-notif-tab="approved" style="${activeTab === 'approved' ? 'background:#166534;color:#fff;font-weight:700;border-color:#166534;' : 'background:#fff;color:#334155;'}">
        ✅ 2. Approved Requests (${approvedItems.length})
      </button>
      <button class="action-button ${activeTab === 'disallowed' ? 'active-tab' : ''}" data-notif-tab="disallowed" style="${activeTab === 'disallowed' ? 'background:#475569;color:#fff;font-weight:700;border-color:#475569;' : 'background:#fff;color:#334155;'}">
        🚫 3. Disallowed / History (${disallowedItems.length})
      </button>
      <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="action-button secondary" data-notification-clear-tab="${activeTab}" style="background:#475569;color:#fff;font-weight:600;" title="Clear notifications in current tab">
          🧹 Clear This Tab
        </button>
        <button class="action-button secondary" data-notification-clear-all="true" style="background:#b91c1c;color:#fff;border-color:#991b1b;font-weight:600;" title="Clear all notifications across all categories">
          🗑️ Clear All
        </button>
      </div>
    </div>
  `;

  notificationsLiveTimer = setInterval(() => {
    if (state.page !== 'notifications') { clearInterval(notificationsLiveTimer); notificationsLiveTimer = null; return; }
    // Only re-render if on pending tab to update countdowns
    if (state.notificationTab === 'pending' && pendingItems.length > 0) {
      renderAdmin();
    }
  }, 3000);

  return `${tabsHtml}<p class="page-intro">${activeIntro}</p>${activeContent}`;
}
function renderSuperAdmin() { const adminRows = state.superAdmins.map((admin) => `<tr><td>${escapeHtml(admin.name)}<small>${escapeHtml(admin.email)}</small></td><td>${admin.accessStatus === 'disabled' ? '<span class="status-badge blocked">Blocked</span>' : '<span class="status-badge allowed">Enabled</span>'}</td><td>${admin.locations.map((location) => `${escapeHtml(location.name)} (${location.devicesCount} devices)`).join('<br>') || 'None'}</td><td>${admin.devices.map((device) => escapeHtml(device.name)).join('<br>') || 'None'}</td><td><button class="action-button" data-super-edit="${escapeHtml(admin.id)}">Edit admin</button><button class="action-button" data-super-reset="${escapeHtml(admin.id)}">Send reset link</button><button class="action-button" data-super-toggle="${escapeHtml(admin.id)}">${admin.accessStatus === 'disabled' ? 'Unblock' : 'Block portal access'}</button><button class="action-button danger-action" data-super-delete="${escapeHtml(admin.id)}">Delete Admin</button></td></tr>`).join(''); return `<section class="content-card"><h3>Create admin</h3><form id="superAdminForm"><input name="name" placeholder="Admin name" required><input name="email" type="email" placeholder="Admin email" required><input name="password" type="password" placeholder="Temporary password" maxlength="32" required><button>Create admin</button></form></section><section class="content-card"><h3>Administrators and resources</h3>${table(['Admin', 'Portal access', 'Locations', 'Devices', 'Actions'], adminRows)}</section>`; }
function renderRouters() {
  const target = state.routerFormTarget;
  const editing = Boolean(target);
  const formHtml = `<section class="content-card"><h3>${editing ? 'Edit Router' : 'Register Router'}</h3><p>${editing ? 'Update router details and serial number.' : 'Register a router to generate an agent token and unique serial number.'}</p><form id="routerForm" data-editing-router="${editing ? escapeHtml(target.id) : ''}"><select name="locationId" ${state.data?.locations?.length ? 'required' : ''}><option value="">${state.data?.locations?.length ? 'Select location' : 'Default Location (Auto-assigned)'}</option>${state.data?.locations?.map((l) => `<option value="${escapeHtml(l.id)}" ${target?.location_id === l.id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('') || ''}</select><input name="name" placeholder="Router name" value="${escapeHtml(target?.name || '')}" required><input id="routerSerialInput" name="serialNumber" placeholder="Serial Number" value="${editing ? escapeHtml(target.serial_number || target.serialNumber || '') : ''}"><div style="margin-top:10px;display:flex;gap:8px;"><button class="compact-button">${editing ? 'Update Router' : 'Register'}</button>${editing ? `<button type="button" class="action-button secondary" id="cancelRouterEditBtn">Cancel</button>` : ''}</div></form></section>`;
  const rows = state.routers.map((r) => {
    const sn = r.serial_number || r.serialNumber || 'N/A';
    const lastSeen = r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : 'Never';
    const clientCount = Array.isArray(r.clients) ? r.clients.length : 0;
    const statusBadge = r.status === 'online' ? `<span class="status-badge allowed">Online (${clientCount} client${clientCount === 1 ? '' : 's'})</span>` : '<span class="status-badge blocked">Offline</span>';
    return `<tr><td><button class="text-link" data-router="${escapeHtml(r.id)}"><strong>${escapeHtml(r.name)}</strong></button></td><td><code style="background:#eef2f7;padding:3px 8px;border-radius:4px;font-family:monospace;font-weight:600;color:#0f172a;">${escapeHtml(sn)}</code></td><td><small>${escapeHtml(r.id)}</small></td><td>${escapeHtml(r.location_name || 'Unassigned')}</td><td>${statusBadge}</td><td><small>${lastSeen}</small></td><td><button class="action-button" data-router="${escapeHtml(r.id)}">Details</button><button class="action-button" data-edit-router="${escapeHtml(r.id)}">Edit</button><button class="action-button danger-action" data-delete-router="${escapeHtml(r.id)}">Delete</button></td></tr>`;
  }).join('');
  return `${formHtml}<section class="content-card"><h3>Registered Routers</h3>${table(['Router Name', 'Serial Number', 'Router ID', 'Location', 'Status', 'Last Seen', 'Actions'], rows)}</section>`;
}
function renderRouterDetail(router) {
  const current = state.routers.find((x) => x.id === router.id) || router;
  const sn = current.serial_number || current.serialNumber || 'N/A';
  const lastSeen = current.last_seen_at ? new Date(current.last_seen_at).toLocaleString() : 'Never';
  const agentClients = Array.isArray(current.clients) ? current.clients : [];
  const statusBadge = current.status === 'online' ? `<span class="status-badge allowed">Online (${agentClients.length} client${agentClients.length === 1 ? '' : 's'})</span>` : '<span class="status-badge blocked">Offline</span>';
  const linkedDevices = state.data?.devices?.filter((d) => d.router_id === current.id || d.routerId === current.id) || [];
  const linkedDeviceIds = linkedDevices.map((d) => d.id);
  const conns = state.data?.connections?.filter((c) => linkedDeviceIds.includes(c.device_id || c.deviceId)) || [];
  const activeConns = conns.filter((c) => c.status === 'connected');
  const baseUsage = usage(conns);

  const telemetryTotalBytes = agentClients.reduce((sum, cl) => sum + Number(cl.rx_bytes || 0) + Number(cl.tx_bytes || 0), 0);
  const telemetryTotalMb = (telemetryTotalBytes / (1024 * 1024)).toFixed(2);
  const totalDisplayUsage = (Number(baseUsage) + Number(telemetryTotalMb)).toFixed(2);
  const totalActiveUsers = Math.max(activeConns.length, agentClients.length);

  const summary = `<div class="detail-summary"><span class="card-kicker">${escapeHtml(current.location_name || 'Unassigned location')}</span><h3>${escapeHtml(current.name)}</h3><p>Router ID: <code style="background:#eef2f7;padding:3px 8px;border-radius:4px;font-family:monospace;font-weight:600;color:#0f172a;">${escapeHtml(current.id)}</code> · Serial Number: <code style="background:#eef2f7;padding:3px 8px;border-radius:4px;font-family:monospace;font-weight:600;color:#0f172a;">${escapeHtml(sn)}</code> · Status: ${statusBadge} · Last Seen: ${lastSeen}</p><div style="display:flex;gap:8px;margin-top:10px;"><button class="action-button" data-edit-router="${escapeHtml(current.id)}">Edit</button><button class="action-button" data-reset-router-token="${escapeHtml(current.id)}">Regenerate Agent Token</button><button class="action-button danger-action" data-delete-router="${escapeHtml(current.id)}">Delete</button></div></div>`;
  const statsHtml = `<div class="stats">${stat('Total Data Used', mb(totalDisplayUsage), 'across router & linked devices')}${stat('Active Users', totalActiveUsers, 'connected right now')}${stat('Linked Devices', linkedDevices.length, 'WiFi access points')}${stat('Router Status', current.status === 'online' ? 'Online' : 'Offline', current.status === 'online' ? 'Agent reporting' : 'Awaiting agent')}</div>`;

  const uniqueUserIds = [...new Set(conns.map((c) => c.user_id || c.userId))];
  const userRowsHtml = uniqueUserIds.map((userId) => {
    const userConns = conns.filter((c) => (c.user_id || c.userId) === userId);
    const latestConn = userConns[userConns.length - 1] || {};
    const device = linkedDevices.find((d) => d.id === (latestConn.device_id || latestConn.deviceId)) || {};
    const userObj = state.data?.users?.find((u) => u.id === userId) || {};
    const isConnected = userConns.some((c) => c.status === 'connected');
    const status = isConnected ? '<span class="status-badge connected">Connected</span>' : '<span class="status-badge">Disconnected</span>';
    const actions = isConnected ? `<button class="action-button danger-action" data-disconnect="${device.id}|${userId}">Disconnect</button><button class="action-button danger-action" data-block="${device.id}|${userId}">Blacklist</button><button class="action-button danger-action" data-delete-user="${userId}">Delete User</button>` : `<button class="action-button danger-action" data-delete-user="${userId}">Delete User</button>`;
    return `<tr><td><strong>${escapeHtml(userObj.name || latestConn.userName || 'Unknown')}</strong><small>${escapeHtml(userObj.email || latestConn.userEmail || '')}</small></td><td>${escapeHtml(device.name || latestConn.deviceName || 'Unknown')}</td>${periodCells(userConns)}<td><strong>${mb(usage(userConns))}</strong></td><td>${status}</td><td>${actions}</td></tr>`;
  }).join('');

  const telemetryUserRows = agentClients.map((cl) => {
    const rxMb = (Number(cl.rx_bytes || 0) / (1024 * 1024)).toFixed(2);
    const totalMbVal = ((Number(cl.rx_bytes || 0) + Number(cl.tx_bytes || 0)) / (1024 * 1024)).toFixed(2);
    const devName = linkedDevices[0]?.name || current.name;
    const actions = `<button class="action-button danger-action" data-block="${current.id}|${cl.mac}">Blacklist</button>`;
    return `<tr><td><strong>${escapeHtml(cl.hostname || 'Unknown')}</strong><small>${escapeHtml(cl.mac || '')}</small></td><td>${escapeHtml(devName)}</td><td>${mb(rxMb)}</td><td>—</td><td>—</td><td>—</td><td><strong>${mb(totalMbVal)}</strong></td><td><span class="status-badge connected">Connected</span></td><td>${actions}</td></tr>`;
  }).join('');
  const allUserRows = (userRowsHtml + telemetryUserRows) || '<tr><td colspan="9" style="text-align:center;padding:24px;color:#64748b;">No connected users currently detected.</td></tr>';
  const usersSection = `<section class="content-card"><h3>Users & Data Consumption</h3><p class="page-intro" style="margin-top:0;">Details of users connected through this router and their data usage over time.</p>${table(['User', 'Device', 'Today / RX', 'Week', 'Month', 'Year', 'Total Used', 'Status', 'Actions'], allUserRows)}</section>`;

  const deviceRows = linkedDevices.map((d) => {
    const dConns = connectionsForDevice(d.id);
    const dActive = connectedForDevice(d.id).length || agentClients.length;
    const dUsage = Math.max(Number(usage(dConns)), Number(telemetryTotalMb));
    return `<tr><td><strong>${escapeHtml(d.name)}</strong></td><td>${escapeHtml(d.wifi_name || d.wifiName || '—')}</td><td><code>${escapeHtml(d.ip_address || d.ipAddress || 'IP unavailable')}</code></td><td><span class="status-badge ${escapeHtml(d.status || 'unknown')}">${escapeHtml(d.status || 'Unknown')}</span></td><td>${dActive}</td><td>${mb(dUsage)}</td><td><button class="action-button" data-restart="${d.id}">Restart</button><button class="action-button" data-device="${d.id}">Details</button><button class="action-button danger-action" data-delete-device="${d.id}">Delete</button></td></tr>`;
  }).join('');
  const devicesSection = `<section class="content-card"><h3>Linked WiFi Devices (${linkedDevices.length})</h3><p class="page-intro" style="margin-top:0;">WiFi access points configured with Router ID <code>${escapeHtml(current.id)}</code>.</p>${table(['Device Name', 'WiFi SSID', 'IP Address', 'Status', 'Active Users', 'Data Used', 'Actions'], deviceRows)}</section>`;

  let telemetrySection = '';
  if (agentClients.length > 0) {
    const clientRows = agentClients.map((cl) => {
      const rxMb = (Number(cl.rx_bytes || cl.rxBytes || 0) / (1024 * 1024)).toFixed(2);
      const txMb = (Number(cl.tx_bytes || cl.txBytes || 0) / (1024 * 1024)).toFixed(2);
      const totalMb = ((Number(cl.rx_bytes || cl.rxBytes || 0) + Number(cl.tx_bytes || cl.txBytes || 0)) / (1024 * 1024)).toFixed(2);
      const sigText = cl.signal !== null && cl.signal !== undefined ? `${cl.signal} dBm` : '—';
      return `<tr><td><strong>${escapeHtml(cl.hostname || 'Unknown')}</strong><small>${escapeHtml(cl.mac || cl.client_mac || '—')}</small></td><td><code>${escapeHtml(cl.ip || '—')}</code></td><td>${sigText}</td><td>${mb(rxMb)}</td><td>${mb(txMb)}</td><td><strong>${mb(totalMb)}</strong></td></tr>`;
    }).join('');
    telemetrySection = `<section class="content-card"><h3>OpenWrt Real-time Telemetry Clients (${agentClients.length})</h3><p class="page-intro" style="margin-top:0;">Real-time clients actively detected by OpenWrt agent telemetry.</p>${table(['Client Hostname / MAC', 'IP Address', 'Signal', 'RX Data', 'TX Data', 'Total Bandwidth'], clientRows)}</section>`;
  } else {
    telemetrySection = `<section class="content-card"><h3>OpenWrt Real-time Telemetry Clients (0)</h3><p class="page-intro" style="margin-top:0;">No active wireless clients detected by OpenWrt agent at this moment.</p></section>`;
  }

  return `${summary}${statsHtml}${usersSection}${devicesSection}${telemetrySection}`;
}
function pageMeta(page) { return ({ overview: ['Overview', 'A real-time summary of your managed WiFi network.'], locations: ['My Locations', 'View locations and open a site to manage its WiFi devices and users.'], devices: ['My Devices', 'Review WiFi devices, usage, connected users, and device controls.'], 'add-device': ['Add Device', 'Add a WiFi device, then review the devices already configured.'], routers: ['Manage Routers', 'Manage hardware routers, unique serial numbers, connection tokens, and router status.'], users: [state.data?.admin?.role === 'super_admin' ? 'All Users' : 'My Users', 'See all user accounts, active location, total data consumption, and access controls.'], manage: ['Manage Locations', 'View the list of locations currently available in your account.'], 'super-admin': ['Admin Accounts Console', 'Manage administrator accounts, create admins, block/unblock portal access, and reset passwords.'], notifications: ['Notifications', 'Connection approvals and data-usage alerts.'] })[page]; }
function renderAdmin() { const [title, description] = pageMeta(state.page); $('#pageTitle').textContent = state.selected ? `${title}: ${state.selected.name}` : title; $('#pageDescription').textContent = description; $('#backToListBtn').classList.toggle('hidden', !state.selected); $('#addDeviceTopBtn').classList.toggle('hidden', state.page !== 'devices' || Boolean(state.selected)); const admin = state.data?.admin; $('#adminWorkspaceLabel').textContent = admin?.role === 'super_admin' ? 'SuperAdmin Workspace' : 'Admin workspace'; $('#superAdminNavLink')?.classList.toggle('hidden', admin?.role !== 'super_admin'); $('#adminIdentity').classList.toggle('hidden', !admin); if (admin) { const role = admin.role === 'super_admin' ? 'Super Admin' : 'Administrator'; const loggedSince = sessionStartedAt(); $('#adminIdentityLogo').textContent = admin.role === 'super_admin' ? 'SA' : 'AD'; $('#adminIdentity').setAttribute('aria-label', `Logged-in ${role}`); $('#adminIdentityName').textContent = admin.name; $('#adminIdentityEmail').textContent = admin.email; $('#adminIdentityRole').textContent = role; $('#adminIdentityLoggedSince').textContent = formatSessionTime(loggedSince); $('#adminIdentityLoggedSince').dateTime = loggedSince; } document.querySelectorAll('[data-page]').forEach((a) => a.classList.toggle('active', a.dataset.page === state.page)); let content; if (state.selected?.type === 'location') content = renderLocationDetail(state.selected); else if (state.selected?.type === 'device') content = renderDeviceDetail(state.selected); else if (state.selected?.type === 'router') content = renderRouterDetail(state.selected); else if (state.page === 'add-device') content = renderAddDevice(state.editingDevice); else content = ({ overview: renderOverview, locations: renderLocations, devices: renderDevices, routers: renderRouters, users: renderUsers, manage: renderManage, 'super-admin': renderSuperAdmin, notifications: renderNotifications })[state.page](); $('#pageContent').innerHTML = content; bindDynamicEvents(); }
async function showUserDetailsModal(userId) {
  const modal = $('#userDetailsModal');
  const titleEl = $('#userDetailsModalTitle');
  const contentEl = $('#userDetailsModalContent');
  if (!modal || !contentEl) return;

  modal.classList.remove('hidden');
  titleEl.textContent = 'User & Client Details';
  contentEl.innerHTML = `<div style="text-align:center;padding:32px 16px;color:#64748b;"><div style="font-size:1.5rem;margin-bottom:8px;">⏳</div>Loading client telemetry &amp; data usage...</div>`;

  try {
    const data = await apiRequest(`/api/users/${encodeURIComponent(userId)}/details`, { headers: authHeaders() });
    const user = data.user || {};
    const mac = data.mac || (user.email && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(user.email) ? user.email : '');
    const isMacClient = Boolean(mac) || userId.startsWith('user-mac-');
    const tel = data.liveTelemetryClient || {};
    const router = data.routerInfo || {};
    const conns = data.connections || [];
    const activeConn = conns.find((c) => c.status === 'connected') || conns[0];
    const records = data.usageRecords || [];

    const displayName = tel.hostname || user.name || (mac ? `Client (${mac.toUpperCase()})` : 'User');
    titleEl.textContent = `${displayName} — Details`;

    const ipAddress = tel.ip || data.mobileNumber || user.mobileNumber || activeConn?.device_ip || '—';
    const routerName = router.name || activeConn?.device_name || '—';
    const routerId = router.id || activeConn?.router_id || '';
    const locName = router.locationName || activeConn?.location_name || '—';

    // Calculate usage
    const rxMb = tel.rx_bytes ? (Number(tel.rx_bytes) / (1024 * 1024)).toFixed(2) : (records[0]?.rx_bytes ? (Number(records[0].rx_bytes) / (1024 * 1024)).toFixed(2) : '—');
    const txMb = tel.tx_bytes ? (Number(tel.tx_bytes) / (1024 * 1024)).toFixed(2) : (records[0]?.tx_bytes ? (Number(records[0].tx_bytes) / (1024 * 1024)).toFixed(2) : '—');
    const totalDataVal = activeConn?.dataUsedMb || usage(conns);
    const liveTotalMb = tel.rx_bytes && tel.tx_bytes ? ((Number(tel.rx_bytes) + Number(tel.tx_bytes)) / (1024 * 1024)).toFixed(2) : totalDataVal;
    const finalTotal = Math.max(Number(totalDataVal), Number(liveTotalMb)).toFixed(2);

    const isConnected = Boolean(tel.mac) || (activeConn && activeConn.status === 'connected');
    const statusBadge = user.accessStatus === 'disabled'
      ? '<span class="status-badge blocked">Disabled</span>'
      : isConnected
        ? '<span class="status-badge connected">Connected</span>'
        : '<span class="status-badge">Offline / Registered</span>';

    const signalText = tel.signal !== undefined && tel.signal !== null ? `${tel.signal} dBm` : '—';
    const signalQuality = tel.signal ? (tel.signal >= -50 ? 'Excellent' : tel.signal >= -67 ? 'Good' : tel.signal >= -75 ? 'Fair' : 'Weak') : '';

    // Usage records table rows
    let recordsHtml = '';
    if (records.length > 0) {
      const rows = records.slice(0, 8).map((r) => {
        const time = new Date(r.timestamp).toLocaleTimeString();
        const dRxKb = (Number(r.delta_rx || 0) / 1024).toFixed(1);
        const dTxKb = (Number(r.delta_tx || 0) / 1024).toFixed(1);
        const curRxMb = (Number(r.rx_bytes || 0) / (1024 * 1024)).toFixed(2);
        const curTxMb = (Number(r.tx_bytes || 0) / (1024 * 1024)).toFixed(2);
        return `<tr><td style="font-size:0.75rem;padding:6px 8px;">${time}</td><td style="font-size:0.75rem;padding:6px 8px;color:#16a34a;font-weight:600;">+${dRxKb} KB</td><td style="font-size:0.75rem;padding:6px 8px;color:#ca8a04;font-weight:600;">+${dTxKb} KB</td><td style="font-size:0.75rem;padding:6px 8px;">${curRxMb} MB</td><td style="font-size:0.75rem;padding:6px 8px;">${curTxMb} MB</td></tr>`;
      }).join('');
      recordsHtml = `
        <div style="margin-top:16px;">
          <h4 style="margin:0 0 8px 0;font-size:0.85rem;color:#475569;text-transform:uppercase;letter-spacing:0.5px;">Recent Real-time OpenWrt Telemetry Packets</h4>
          <div class="table-wrap" style="max-height:160px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px;">
            <table style="width:100%;margin:0;font-size:0.78rem;">
              <thead><tr><th style="padding:6px 8px;">Time</th><th style="padding:6px 8px;">Delta RX</th><th style="padding:6px 8px;">Delta TX</th><th style="padding:6px 8px;">Total RX</th><th style="padding:6px 8px;">Total TX</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    }

    let historyHtml = '';
    if (conns.length > 0) {
      const connRows = conns.map((c, idx) => {
        const sessionNum = conns.length - idx;
        const connTime = c.connected_at ? new Date(c.connected_at).toLocaleString() : '—';
        const disconnTime = c.disconnected_at ? new Date(c.disconnected_at).toLocaleString() : (c.status === 'connected' ? '<span style="color:#16a34a;font-weight:600;">Active Session</span>' : (c.status === 'quarantine' ? '<span style="color:#b45309;font-weight:600;">Quarantine</span>' : '—'));
        const mbUsed = mb(c.data_used_mb || c.dataUsedMb || 0);
        const statusBadge = `<span class="status-badge ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>`;
        return `<tr><td style="font-size:0.78rem;padding:6px 8px;font-weight:600;">#${sessionNum}</td><td style="font-size:0.78rem;padding:6px 8px;">${connTime}</td><td style="font-size:0.78rem;padding:6px 8px;">${disconnTime}</td><td style="font-size:0.78rem;padding:6px 8px;font-weight:600;color:#0284c7;">${mbUsed}</td><td style="font-size:0.78rem;padding:6px 8px;">${statusBadge}</td></tr>`;
      }).join('');
      historyHtml = `
        <div style="margin-top:16px;">
          <h4 style="margin:0 0 8px 0;font-size:0.85rem;color:#475569;text-transform:uppercase;letter-spacing:0.5px;">📜 Client Connection History &amp; Past Logins (${conns.length} Session${conns.length === 1 ? '' : 's'})</h4>
          <div class="table-wrap" style="max-height:180px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px;">
            <table style="width:100%;margin:0;font-size:0.78rem;">
              <thead><tr><th style="padding:6px 8px;">Session</th><th style="padding:6px 8px;">Connected At</th><th style="padding:6px 8px;">Disconnected At</th><th style="padding:6px 8px;">Data Consumed</th><th style="padding:6px 8px;">Status</th></tr></thead>
              <tbody>${connRows}</tbody>
            </table>
          </div>
        </div>`;
    }

    contentEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div style="background:#f8fafc;padding:12px 14px;border-radius:8px;border:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:1.1rem;font-weight:700;color:#0f172a;">${escapeHtml(displayName)}</div>
            <div style="font-size:0.8rem;color:#64748b;margin-top:2px;">${isMacClient ? 'OpenWrt Wireless Client' : 'Portal User Account'}</div>
          </div>
          <div>${statusBadge}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.85rem;">
          <div style="padding:10px;background:#f1f5f9;border-radius:6px;">
            <span style="color:#64748b;display:block;font-size:0.72rem;text-transform:uppercase;font-weight:600;">Client IP Address</span>
            <code style="font-weight:600;color:#0f172a;font-size:0.9rem;">${escapeHtml(ipAddress)}</code>
          </div>
          <div style="padding:10px;background:#f1f5f9;border-radius:6px;">
            <span style="color:#64748b;display:block;font-size:0.72rem;text-transform:uppercase;font-weight:600;">MAC / Identifier</span>
            <code style="font-weight:600;color:#0f172a;font-size:0.85rem;">${escapeHtml(mac || user.email || '—')}</code>
          </div>
          <div style="padding:10px;background:#f1f5f9;border-radius:6px;">
            <span style="color:#64748b;display:block;font-size:0.72rem;text-transform:uppercase;font-weight:600;">Router &amp; Location</span>
            <span style="font-weight:600;color:#0f172a;">${escapeHtml(routerName)} ${routerId ? `<code style="font-size:0.75rem;padding:2px 4px;background:#e2e8f0;border-radius:3px;">ID:${routerId}</code>` : ''}</span>
            <small style="display:block;color:#64748b;">${escapeHtml(locName)}</small>
          </div>
          <div style="padding:10px;background:#f1f5f9;border-radius:6px;">
            <span style="color:#64748b;display:block;font-size:0.72rem;text-transform:uppercase;font-weight:600;">Wi-Fi Signal Strength</span>
            <span style="font-weight:600;color:#0284c7;font-size:0.95rem;">${escapeHtml(signalText)} ${signalQuality ? `<span style="font-size:0.75rem;color:#16a34a;font-weight:normal;">(${signalQuality})</span>` : ''}</span>
          </div>
        </div>

        <div>
          <h4 style="margin:0 0 8px 0;font-size:0.85rem;color:#475569;text-transform:uppercase;letter-spacing:0.5px;">Data Consumption Details</h4>
          <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;">
            <div style="padding:10px;background:#e0f2fe;border-radius:6px;text-align:center;">
              <span style="display:block;font-size:0.72rem;color:#0369a1;font-weight:600;">Total Used</span>
              <strong style="font-size:1.15rem;color:#0284c7;">${mb(finalTotal)}</strong>
            </div>
            <div style="padding:10px;background:#f0fdf4;border-radius:6px;text-align:center;">
              <span style="display:block;font-size:0.72rem;color:#15803d;font-weight:600;">Download (RX)</span>
              <strong style="font-size:1.15rem;color:#16a34a;">${rxMb !== '—' ? mb(rxMb) : '—'}</strong>
            </div>
            <div style="padding:10px;background:#fefce8;border-radius:6px;text-align:center;">
              <span style="display:block;font-size:0.72rem;color:#a16207;font-weight:600;">Upload (TX)</span>
              <strong style="font-size:1.15rem;color:#ca8a04;">${txMb !== '—' ? mb(txMb) : '—'}</strong>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:6px;margin-top:8px;">
            <div style="padding:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;text-align:center;">
              <small style="color:#64748b;display:block;font-size:0.68rem;">Today</small>
              <strong style="font-size:0.82rem;color:#0f172a;">${mb(usage(conns, 'day'))}</strong>
            </div>
            <div style="padding:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;text-align:center;">
              <small style="color:#64748b;display:block;font-size:0.68rem;">This Week</small>
              <strong style="font-size:0.82rem;color:#0f172a;">${mb(usage(conns, 'week'))}</strong>
            </div>
            <div style="padding:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;text-align:center;">
              <small style="color:#64748b;display:block;font-size:0.68rem;">This Month</small>
              <strong style="font-size:0.82rem;color:#0f172a;">${mb(usage(conns, 'month'))}</strong>
            </div>
            <div style="padding:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;text-align:center;">
              <small style="color:#64748b;display:block;font-size:0.68rem;">Since Start</small>
              <strong style="font-size:0.82rem;color:#0f172a;">${mb(usage(conns, 'all'))}</strong>
            </div>
          </div>
        </div>

        ${historyHtml}
        ${recordsHtml}
      </div>
    `;
  } catch (err) {
    contentEl.innerHTML = `<div style="padding:16px;color:#dc2626;background:#fef2f2;border-radius:6px;">Error loading user details: ${escapeHtml(err.message)}</div>`;
  }
}

function bindDynamicEvents() {
  document.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => navigate(b.dataset.go));
  document.querySelectorAll('[data-user-details]').forEach((b) => b.onclick = () => showUserDetailsModal(b.dataset.userDetails));
  document.querySelectorAll('[data-location]').forEach((b) => b.onclick = () => {
    state.showLocationForm = false;
    state.locationFormTarget = null;
    state.page = 'locations';
    state.selected = { ...state.data.locations.find((x) => x.id === b.dataset.location), type: 'location' };
    renderAdmin();
  });
  document.querySelectorAll('[data-edit-location]').forEach((b) => b.onclick = () => {
    state.page = 'locations';
    state.selected = null;
    state.showLocationForm = true;
    state.locationFormTarget = state.data.locations.find((x) => x.id === b.dataset.editLocation);
    renderAdmin();
  });
  document.querySelectorAll('[data-delete-location]').forEach((b) => b.onclick = () => deleteLocationItem(b.dataset.deleteLocation));
  document.querySelectorAll('[data-delete-device]').forEach((b) => b.onclick = () => deleteDeviceItem(b.dataset.deleteDevice));
  document.querySelectorAll('[data-delete-user]').forEach((b) => b.onclick = () => deleteUserItem(b.dataset.deleteUser));
  document.querySelectorAll('[data-device]').forEach((b) => b.onclick = () => {
    state.showLocationForm = false;
    state.locationFormTarget = null;
    state.page = 'devices';
    state.selected = { ...state.data.devices.find((x) => x.id === b.dataset.device), type: 'device' };
    renderAdmin();
  });
  document.querySelectorAll('[data-router]').forEach((b) => b.onclick = () => {
    state.showLocationForm = false;
    state.locationFormTarget = null;
    state.showRouterForm = false;
    state.routerFormTarget = null;
    state.page = 'routers';
    const found = state.routers.find((x) => x.id === b.dataset.router);
    if (found) {
      state.selected = { ...found, type: 'router' };
      renderAdmin();
    }
  });
  document.querySelectorAll('[data-edit-router]').forEach((b) => b.onclick = () => {
    state.page = 'routers';
    state.selected = null;
    state.routerFormTarget = state.routers.find((x) => x.id === b.dataset.editRouter);
    renderAdmin();
  });
  document.querySelectorAll('[data-reset-router-token]').forEach((b) => b.onclick = () => {
    confirmAction('Regenerate the Agent Token for this router? You will need to update /etc/secmynet-agent.conf on the router.', async () => {
      try {
        const res = await apiRequest(`/api/openwrt/routers/${b.dataset.resetRouterToken}/reset-token`, { method: 'POST', headers: authHeaders() });
        alert(`Agent Token Generated Successfully!\n\nRouter ID: ${res.routerId}\nAgent Token: ${res.agentToken}\n\nUpdate /etc/secmynet-agent.conf on your router:\nSECMYNET_ROUTER_ID="${res.routerId}"\nSECMYNET_AGENT_TOKEN="${res.agentToken}"`);
      } catch (e) { alert(e.message); }
    });
  });
  document.querySelectorAll('[data-delete-router]').forEach((b) => b.onclick = () => deleteRouterItem(b.dataset.deleteRouter));
  document.querySelectorAll('[data-disconnect]').forEach((b) => b.onclick = () => deviceAction(b.dataset.disconnect, 'disconnect-user', 'Disconnect this user?'));
  document.querySelectorAll('[data-block]').forEach((b) => b.onclick = () => deviceAction(b.dataset.block, 'disallow-user', 'Blacklist this user and remove their access?'));
  document.querySelectorAll('[data-disconnect-router-client]').forEach((b) => b.onclick = () => {
    const [routerId, mac] = b.dataset.disconnectRouterClient.split('|');
    confirmAction(`Disconnect client ${mac} from OpenWrt router?`, async () => {
      try {
        await apiRequest(`/api/openwrt/routers/${routerId}/commands`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ commandType: 'disconnect', mac })
        });
        alert('Disconnect command queued for OpenWrt router.');
        await loadDashboard();
      } catch (e) { alert(e.message); }
    });
  });
  document.querySelectorAll('[data-block-router-client]').forEach((b) => b.onclick = () => {
    const [routerId, mac] = b.dataset.blockRouterClient.split('|');
    confirmAction(`Blacklist and block client ${mac} on router?`, async () => {
      try {
        await apiRequest(`/api/openwrt/routers/${routerId}/commands`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ commandType: 'block', mac })
        });
        alert('Block command queued for OpenWrt router.');
        await loadDashboard();
      } catch (e) { alert(e.message); }
    });
  });
  document.querySelectorAll('[data-restart]').forEach((b) => b.onclick = () => restartDevice(b.dataset.restart));
  document.querySelectorAll('[data-toggle-user]').forEach((b) => b.onclick = () => toggleUserAccess(b.dataset.toggleUser));
  document.querySelectorAll('[data-super-toggle]').forEach((b) => b.onclick = () => toggleSuperAdmin(b.dataset.superToggle));
  document.querySelectorAll('[data-super-delete]').forEach((b) => b.onclick = () => deleteSuperUser(b.dataset.superDelete));
  document.querySelectorAll('[data-super-edit]').forEach((b) => b.onclick = () => editSuperAdmin(b.dataset.superEdit));
  document.querySelectorAll('[data-super-reset]').forEach((b) => b.onclick = () => sendAdminResetLink(b.dataset.superReset));
  $('#userUsageFilterToggle')?.addEventListener('click', () => $('.usage-header')?.classList.toggle('filter-open'));
  $('#userUsageFilter')?.addEventListener('change', (e) => {
    state.usagePeriod = e.target.value;
    renderAdmin();
  });
  $('#deviceUsageFilterToggle')?.addEventListener('click', () => $('#deviceUsageFilterToggle')?.closest('.usage-header')?.classList.toggle('filter-open'));
  $('#deviceUsageFilter')?.addEventListener('change', (e) => {
    state.deviceUsagePeriod = e.target.value;
    renderAdmin();
  });
  document.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
    if (b.dataset.add === 'location') {
      state.page = 'locations';
      state.selected = null;
      state.showLocationForm = true;
      state.locationFormTarget = null;
      renderAdmin();
    } else navigate('add-device');
  });
  $('#locationForm')?.addEventListener('submit', addLocation);
  $('#deviceForm')?.addEventListener('submit', addDevice);
  $('#routerForm')?.addEventListener('submit', addOrUpdateRouter);
  $('#cancelRouterEditBtn')?.addEventListener('click', () => { state.routerFormTarget = null; renderAdmin(); });
  $('#superAdminForm')?.addEventListener('submit', (e) => createSuperAccount(e, 'admins'));
  $('#userDetailsCloseBtn')?.addEventListener('click', () => $('#userDetailsModal')?.classList.add('hidden'));
  $('#userDetailsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'userDetailsModal') $('#userDetailsModal').classList.add('hidden');
  });
}
function confirmAction(message, action) { const modal = $('#confirmationModal'); $('#confirmationModalText').textContent = message; modal.classList.remove('hidden'); $('#confirmationYesBtn').onclick = async () => { modal.classList.add('hidden'); await action(); }; $('#confirmationNoBtn').onclick = () => modal.classList.add('hidden'); }
async function deviceAction(value, action, message) { confirmAction(message, async () => { const [deviceId, userId] = value.split('|'); try { await apiRequest(`/api/devices/${deviceId}/${action}`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ userId }) }); await loadDashboard(); } catch (e) { alert(e.message); } }); }
async function restartDevice(id) { confirmAction('You are changing the device configurations which may cause the service disconnection. Are you sure?', async () => { try { const result = await apiRequest(`/api/devices/${id}/restart`, { method: 'POST', headers: authHeaders() }); alert(result.message); } catch (e) { alert(e.message); } }); }
async function toggleUserAccess(userId) { try { const result = await apiRequest(`/api/users/${userId}/toggle-access`, { method: 'POST', headers: authHeaders() }); alert(result.message); await loadDashboard(); } catch (e) { alert(e.message); } }
async function createSuperAccount(e, type) { e.preventDefault(); try { await apiRequest(`/api/super-admin/${type}`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) }); e.currentTarget.reset(); await loadSuperAdmins(); alert(`${type === 'admins' ? 'Admin' : 'User'} created.`); } catch (error) { alert(error.message); } }
async function editSuperAdmin(id) { const admin = state.superAdmins.find((item) => item.id === id); if (!admin) return; const name = prompt('Admin name:', admin.name); if (name === null) return; const email = prompt('Admin email:', admin.email); if (email === null) return; try { await apiRequest(`/api/super-admin/admins/${id}`, { method: 'PATCH', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ name: name.trim(), email: email.trim() }) }); await loadSuperAdmins(); alert('Admin updated.'); } catch (error) { alert(error.message); } }
async function sendAdminResetLink(id) { try { const result = await apiRequest(`/api/super-admin/admins/${id}/send-reset-link`, { method: 'POST', headers: authHeaders() }); alert(`${result.message}\n\nShare this link with the admin:\n${result.resetLink}`); } catch (error) { alert(error.message); } }
async function toggleSuperAdmin(id) { try { const result = await apiRequest(`/api/super-admin/admins/${id}/toggle-access`, { method: 'POST', headers: authHeaders() }); alert(result.message); await loadSuperAdmins(); } catch (error) { alert(error.message); } }
async function deleteLocationItem(id) { confirmAction('Delete this location and all its associated devices?', async () => { try { const result = await apiRequest(`/api/locations/${id}`, { method: 'DELETE', headers: authHeaders() }); alert(result.message); await loadDashboard(); } catch (error) { alert(error.message); } }); }
async function deleteDeviceItem(id) { confirmAction('Delete this device and its access logs?', async () => { try { const result = await apiRequest(`/api/devices/${id}`, { method: 'DELETE', headers: authHeaders() }); alert(result.message); await loadDashboard(); } catch (error) { alert(error.message); } }); }
async function deleteUserItem(id) { confirmAction('Delete this user account?', async () => { try { const endpoint = state.data?.admin?.role === 'super_admin' ? `/api/super-admin/users/${id}` : `/api/users/${id}`; const result = await apiRequest(endpoint, { method: 'DELETE', headers: authHeaders() }); alert(result.message); await loadDashboard(); } catch (error) { alert(error.message); } }); }
async function deleteSuperUser(id) { confirmAction('Delete this account and its managed resources?', async () => { try { const result = await apiRequest(`/api/super-admin/users/${id}`, { method: 'DELETE', headers: authHeaders() }); alert(result.message); await loadDashboard(); } catch (error) { alert(error.message); } }); }
async function loadSuperAdmins() { const response = await apiRequest('/api/super-admin/admins', { headers: authHeaders() }); state.superAdmins = response.admins || []; if (state.page === 'users') renderAdmin(); }
async function loadOpenWrtRouters() { const response = await apiRequest('/api/openwrt/routers', { headers: authHeaders() }); state.routers = response.routers || []; const countEl = $('#routerCount'); if (countEl) countEl.textContent = state.routers.length; }
async function addOrUpdateRouter(e) { e.preventDefault(); const form = e.currentTarget; const values = Object.fromEntries(new FormData(form)); const routerId = form.dataset.editingRouter; try { const response = await apiRequest(routerId ? `/api/openwrt/routers/${routerId}` : '/api/openwrt/routers', { method: routerId ? 'PATCH' : 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(values) }); if (!routerId && response.agentToken) { alert(`Router Registered Successfully!\n\nRouter ID: ${response.routerId}\nSerial Number: ${response.serialNumber}\nAgent Token: ${response.agentToken}\n\nSAVE THIS AGENT TOKEN NOW! It is shown only once.`); } else { alert(response.message || 'Router updated.'); } state.routerFormTarget = null; await loadDashboard(); await loadOpenWrtRouters(); renderAdmin(); } catch (err) { alert(err.message); } }
async function deleteRouterItem(routerId) { confirmAction('Delete this OpenWrt router? Devices linked to this router will be unlinked.', async () => { try { const response = await apiRequest(`/api/openwrt/routers/${routerId}`, { method: 'DELETE', headers: authHeaders() }); alert(response.message); if (state.selected?.id === routerId) state.selected = null; await loadOpenWrtRouters(); renderAdmin(); } catch (err) { alert(err.message); } }); }
async function allowUser(e) { e.preventDefault(); const p = Object.fromEntries(new FormData(e.currentTarget)); try { await apiRequest(`/api/devices/${p.deviceId}/allow-user`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ userId: p.userId }) }); alert('Access granted.'); await loadDashboard(); } catch (err) { alert(err.message); } }
async function addLocation(e) { e.preventDefault(); const p = Object.fromEntries(new FormData(e.currentTarget)); const target = state.locationFormTarget; try { await apiRequest(target ? `/api/locations/${target.id}` : '/api/locations', { method: target ? 'PATCH' : 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(p) }); state.locationFormTarget = null; await loadDashboard(); navigate('locations'); } catch (err) { alert(err.message); } }
async function addDevice(e) { e.preventDefault(); const p = Object.fromEntries(new FormData(e.currentTarget)); const deviceId = e.currentTarget.dataset.editingDevice; try { const res = await apiRequest(deviceId ? `/api/devices/${deviceId}` : '/api/devices', { method: deviceId ? 'PATCH' : 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(p) }); if (!deviceId && res.routerId) { alert(`Device Registered Successfully!\n\nDevice Name: ${p.name}\nRouter ID: ${res.routerId}${res.agentToken ? `\nAgent Token: ${res.agentToken}\n\nSAVE THIS AGENT TOKEN NOW! It is shown only once.` : ''}`); } else { alert(res.message || (deviceId ? 'Device updated.' : 'Device added.')); } state.editingDevice = null; await loadDashboard(); navigate('devices'); } catch (err) { alert(err.message); } }
document.addEventListener('click', (event) => { const button = event.target.closest('[data-edit-device]'); if (!button) return; const device = state.data.devices.find((item) => item.id === button.dataset.editDevice); confirmAction('You are changing the device configurations which may cause the service disconnection. Are you sure?', async () => { state.editingDevice = device; state.page = 'add-device'; state.selected = null; renderAdmin(); }); });
document.addEventListener('input', (event) => {
	const input = event.target.closest('#deviceForm input[name="ipAddress"]');
	if (!input) return;
	const parts = input.value.replace(/[^\d.]/g, '').split('.');
	const normalized = [];
	let digitCount = 0;
	for (const part of parts) {
		if (normalized.length === 4 || digitCount === 12) break;
		let digits = part.slice(0, Math.min(3, 12 - digitCount));
		while (digits.length > 1 && Number(digits) > 255) digits = digits.slice(0, -1);
		normalized.push(digits);
		digitCount += digits.length;
	}
	let formatted = normalized.join('.');
	if (normalized.length < 4 && normalized.at(-1)?.length === 3 && digitCount < 12) formatted += '.';
	if (formatted !== input.value) input.value = formatted;
});
document.addEventListener('keydown', (event) => {
	const input = event.target.closest('#deviceForm input[name="ipAddress"]');
	if (!input || event.key !== 'ArrowRight') return;
	const parts = input.value.split('.');
	if (parts.length < 4 && parts.at(-1).length > 0 && parts.at(-1).length < 3) {
		event.preventDefault();
		input.value += '.';
	}
});
function navigate(page) { state.page = page; state.selected = null; state.showLocationForm = false; state.editingDevice = null; history.replaceState(null, '', `#${page}`); renderAdmin(); }
function renderUserDashboard(data) { state.userData = data; $('#authSection').classList.add('hidden'); $('#dashboard').classList.add('hidden'); $('#userDashboard').classList.remove('hidden'); state.userPage = location.hash.replace('#my-', '') || 'locations'; if (!['locations', 'devices', 'usage', 'account'].includes(state.userPage)) state.userPage = 'locations'; renderUserPage(); }
function renderUserPage() { const d = state.userData; const meta = { locations: ['My Locations', 'Locations where you have WiFi access.'], devices: ['My Devices', 'WiFi devices you are authorised to use.'], usage: ['My Usage', 'Your current and historical data consumption.'], account: ['My Account', 'Your SecMyNet account and access summary.'] }[state.userPage]; $('#userPageTitle').textContent = meta[0]; $('#userPageDescription').textContent = meta[1]; document.querySelectorAll('[data-user-page]').forEach((a) => a.classList.toggle('active', a.dataset.userPage === state.userPage)); const uniqueLocations = [...new Map(d.devices.map((device) => [device.location?.id || device.location_id, device.location])).values()].filter(Boolean); let content = ''; if (state.userPage === 'locations') content = `<div class="stats">${stat('Accessible locations', uniqueLocations.length)}${stat('Allowed devices', d.stats.totalDevices)}${stat('Connected now', d.stats.activeConnections)}</div><div class="location-grid">${uniqueLocations.map((l) => { const devices = d.devices.filter((device) => (device.location?.id || device.location_id) === l.id); return `<article class="location-card"><span class="card-kicker">${escapeHtml(l.city)}</span><h3>${escapeHtml(l.name)}</h3><div><strong>${devices.length}</strong> available WiFi devices</div><small>${devices.map((x) => escapeHtml(x.name)).join(', ')}</small></article>`; }).join('') || '<p class="empty">You do not have access to any locations yet.</p>'}</div>`; if (state.userPage === 'devices') content = table(['Device', 'Router ID', 'Location', 'WiFi', 'Access status'], d.devices.map((device) => `<tr><td>${escapeHtml(device.name)}</td><td><code style="background:#eef2f7;padding:3px 8px;border-radius:4px;font-family:monospace;font-weight:600;color:#0f172a;">${escapeHtml(device.router_id || device.routerId || 'N/A')}</code></td><td>${escapeHtml(device.location?.name || 'Unknown')}</td><td>${escapeHtml(device.wifi_name || device.wifiName)}</td><td><span class="status-badge allowed">Allowed</span></td></tr>`).join('')); if (state.userPage === 'usage') content = `<div class="stats">${stat('Data since start', mb(usage(d.connections)))}${stat('This month', mb(usage(d.connections, 'month')))}${stat('This week', mb(usage(d.connections, 'week')))}${stat('Today', mb(usage(d.connections, 'day')))}</div>${table(['Device', 'Location', 'Status', 'Data used'], d.connections.map((c) => `<tr><td>${escapeHtml(c.deviceName)}</td><td>${escapeHtml(c.locationName)}</td><td><span class="status-badge ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td><td>${mb(c.dataUsedMb)}</td></tr>`).join(''))}`; if (state.userPage === 'account') content = `<div class="stats">${stat('Allowed devices', d.stats.totalDevices)}${stat('Total connections', d.stats.totalConnections)}${stat('Active connections', d.stats.activeConnections)}</div><section class="content-card"><h3>${escapeHtml(d.user.name)}</h3><p>${escapeHtml(d.user.email)}</p><p>Your access is managed by your SecMyNet administrator.</p></section>`; $('#userPageContent').innerHTML = content; }
let modalCountdownTimer = null;
const shownPopupNotificationIds = new Set();
const shownPopupClientKeys = new Set();

async function loadNotifications(showPopup = true) {
  if (!state.token || !state.data) return;
  try {
    const response = await apiRequest('/api/notifications', { headers: authHeaders() });
    state.notifications = response.notifications || [];
    const pending = state.notifications.filter((n) => ['unread', 'quarantine', 'quarantine_wait', 'approved_holding'].includes(n.status));
    $('#notificationCount').textContent = pending.length;
    if (state.page === 'notifications') renderAdmin();

    // Show popup ONLY ONCE for a client's connection request
    // Never show another popup for the same client while pending or disallowed
    const modalEl = $('#notificationModal');
    const modalOpen = modalEl && !modalEl.classList.contains('hidden');

    if (showPopup && !modalOpen) {
      const now = Date.now();
      const freshRequest = pending.find((n) => {
        if (n.type !== 'connection_request') return false;
        const clientKey = n.user_id || n.id;
        if (shownPopupClientKeys.has(clientKey)) return false;
        if (shownPopupNotificationIds.has(n.id)) return false;
        const age = now - new Date(n.created_at).getTime();
        return age < 45000;
      });

      if (freshRequest) {
        const clientKey = freshRequest.user_id || freshRequest.id;
        shownPopupClientKeys.add(clientKey);
        shownPopupNotificationIds.add(freshRequest.id);
        showNotificationPopup(freshRequest);
      }
    }
  } catch (_) { }
}

function showNotificationPopup(notification) {
  if (modalCountdownTimer) { clearInterval(modalCountdownTimer); modalCountdownTimer = null; }
  const modal = $('#notificationModal');
  const overconsumption = notification.type === 'overconsumption';
  const badge = $('#notificationModalBadge');
  const timerBox = $('#notificationModalTimerBox');
  const waitBtn = $('#notificationWaitBtn');
  const histBtn = $('#notificationHistoryBtn');
  const allowBtn = $('#notificationAllowBtn');
  const denyBtn = $('#notificationDenyBtn');
  const closeXBtn = $('#notificationModalCloseXBtn');
  const closeBtn = $('#notificationModalCloseBtn');
  const titleEl = $('.modal-card h3');

  const closeModal = () => {
    if (modalCountdownTimer) { clearInterval(modalCountdownTimer); modalCountdownTimer = null; }
    modal.classList.add('hidden');
    if (state.page === 'notifications') renderAdmin();
  };

  if (closeXBtn) closeXBtn.onclick = closeModal;
  if (closeBtn) closeBtn.onclick = closeModal;

  if (histBtn) {
    if (notification.user_id) {
      histBtn.classList.remove('hidden');
      histBtn.onclick = () => { modal.classList.add('hidden'); showUserDetailsModal(notification.user_id); };
    } else {
      histBtn.classList.add('hidden');
    }
  }

  if (overconsumption) {
    if (titleEl) titleEl.textContent = 'Data Usage Alert';
    if (badge) badge.classList.add('hidden');
    if (timerBox) timerBox.classList.add('hidden');
    if (waitBtn) waitBtn.classList.add('hidden');
    $('#notificationModalText').textContent = notification.message;
    allowBtn.disabled = false;
    allowBtn.style.opacity = '1';
    allowBtn.style.cursor = 'pointer';
    allowBtn.textContent = 'Allow Further';
    allowBtn.style.background = '#2d5aa8';
    denyBtn.disabled = false;
    denyBtn.textContent = 'Disconnect';
    allowBtn.onclick = () => respondToNotification(notification.id, 'continue');
    denyBtn.onclick = () => respondToNotification(notification.id, 'disconnect');
  } else {
    const isReturning = (notification.message || '').includes('Returning user');
    if (titleEl) titleEl.textContent = isReturning ? '🛡️ Returning User Detected (Quarantined)' : '🛡️ New Connection Request (Quarantined)';
    if (badge) {
      badge.classList.remove('hidden');
      badge.className = `status-badge ${notification.status}`;
      badge.textContent = notification.status === 'quarantine_wait' ? 'Quarantine (Wait)' : (isReturning ? 'Returning (Quarantine)' : 'Quarantine');
    }
    if (timerBox) timerBox.classList.remove('hidden');
    if (waitBtn) {
      waitBtn.classList.remove('hidden');
      waitBtn.onclick = () => respondToNotification(notification.id, 'wait');
    }
    $('#notificationModalText').textContent = notification.message;
    denyBtn.disabled = false;
    denyBtn.textContent = 'Disallow / Block';
    denyBtn.style.background = '#b91c1c';
    denyBtn.onclick = () => respondToNotification(notification.id, 'deny');
    allowBtn.onclick = () => {
      if (allowBtn.disabled) return;
      respondToNotification(notification.id, 'allow');
    };

    function updateTimers() {
      const now = Date.now();
      const createdTime = new Date(notification.created_at).getTime();
      const expires = notification.expires_at ? new Date(notification.expires_at).getTime() : (createdTime + 300000);
      const elapsedSec = Math.floor((now - createdTime) / 1000);
      const reviewRemaining = Math.max(0, 45 - elapsedSec);
      const timeoutRemaining = Math.max(0, Math.ceil((expires - now) / 1000));
      const holdEl = $('#notificationHoldCountdown');
      const timeoutEl = $('#notificationTimeoutCountdown');

      if (timeoutRemaining === 0) {
        if (timeoutEl) {
          timeoutEl.textContent = '0m 00s — Expired (Auto-Disallowed & Disconnected)';
          timeoutEl.style.color = '#b91c1c';
        }
        if (badge) {
          badge.className = 'status-badge blocked';
          badge.textContent = 'Disallowed (5m Timeout)';
        }
        if (allowBtn) {
          allowBtn.disabled = true;
          allowBtn.style.opacity = '0.45';
          allowBtn.style.cursor = 'not-allowed';
          allowBtn.textContent = 'Disallowed (Timeout)';
          allowBtn.style.background = '#64748b';
        }
        if (waitBtn) waitBtn.classList.add('hidden');
        denyBtn.textContent = 'Close';
        denyBtn.onclick = closeModal;
      } else if (reviewRemaining === 0) {
        // 45s popup review window finished without response -> Move to Pending Approvals tab!
        if (modalCountdownTimer) { clearInterval(modalCountdownTimer); modalCountdownTimer = null; }
        modal.classList.add('hidden');
        if (state.page === 'notifications') {
          state.notificationTab = 'pending';
          renderAdmin();
        }
      } else {
        // Allow button is active and visible to owner
        if (allowBtn) {
          allowBtn.disabled = false;
          allowBtn.style.opacity = '1';
          allowBtn.style.cursor = 'pointer';
          allowBtn.textContent = 'Allow Access';
          allowBtn.style.background = '#166534';
          allowBtn.style.color = '#ffffff';
          allowBtn.title = 'Approve connection and grant internet access immediately';
        }

        if (holdEl) {
          holdEl.textContent = `${reviewRemaining}s left (closes to Pending Approvals tab)`;
          holdEl.style.color = '#0284c7';
        }

        if (timeoutEl) {
          const mins = Math.floor(timeoutRemaining / 60);
          const secs = String(timeoutRemaining % 60).padStart(2, '0');
          timeoutEl.textContent = `${mins}m ${secs}s`;
          timeoutEl.style.color = timeoutRemaining < 60 ? '#b91c1c' : '#334155';
        }
      }
    }
    updateTimers();
    modalCountdownTimer = setInterval(updateTimers, 1000);
  }
  modal.classList.remove('hidden');
}

async function clearNotification(id) {
  try {
    await apiRequest(`/api/notifications/${id}`, { method: 'DELETE', headers: authHeaders() });
    shownPopupNotificationIds.delete(id);
    await loadNotifications(false);
    if (state.page === 'notifications') renderAdmin();
  } catch (e) {
    alert(e.message);
  }
}

async function clearAllNotifications(tab = null) {
  const allCount = (state.notifications || []).length;
  if (allCount === 0) {
    alert('No notifications to clear.');
    return;
  }
  const tabLabel = tab === 'pending' ? 'Pending Approvals' : (tab === 'approved' ? 'Approved Requests' : (tab === 'disallowed' ? 'Disallowed / History' : ''));
  const promptText = tab
    ? `Are you sure you want to clear all ${tabLabel} notifications?`
    : 'Are you sure you want to clear ALL notifications across all categories?';
  if (!confirm(promptText)) return;
  try {
    const url = tab ? `/api/notifications?tab=${encodeURIComponent(tab)}` : '/api/notifications';
    await apiRequest(url, { method: 'DELETE', headers: authHeaders() });
    if (!tab) {
      shownPopupNotificationIds.clear();
      shownPopupClientKeys.clear();
    }
    await loadNotifications(false);
    if (state.page === 'notifications') renderAdmin();
  } catch (e) {
    alert(e.message);
  }
}

async function respondToNotification(id, action) {
  if (modalCountdownTimer) { clearInterval(modalCountdownTimer); modalCountdownTimer = null; }
  try {
    const res = await apiRequest(`/api/notifications/${id}/respond`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action, allow: action === 'allow' })
    });
    $('#notificationModal').classList.add('hidden');
    if (res && res.message) alert(res.message);
    await loadDashboard();
  } catch (e) {
    alert(e.message);
  }
}
async function loadDashboard() { try { const profile = await apiRequest('/api/profile', { headers: authHeaders() }); if (profile.user.role === 'user') return renderUserDashboard(await apiRequest('/api/user-dashboard', { headers: authHeaders() })); state.data = await apiRequest('/api/dashboard', { headers: authHeaders() }); $('#authSection').classList.add('hidden'); $('#dashboard').classList.remove('hidden'); $('#userDashboard').classList.add('hidden'); $('#locationCount').textContent = state.data.stats.totalLocations; $('#deviceCount').textContent = state.data.stats.totalDevices; await loadNotifications(); await loadOpenWrtRouters(); const extraClients = (state.routers || []).flatMap((r) => r.clients || []).filter((cl) => { const mac = (cl.mac || '').toLowerCase(); return !state.data.users.some((u) => (u.email || '').toLowerCase() === mac || u.id === 'user-mac-' + mac.replace(/[^a-z0-9]/g, '')); }); $('#userCount').textContent = state.data.users.filter((user) => user.role !== 'super_admin').length + extraClients.length; state.page = location.hash.slice(1) || (profile.user.role === 'super_admin' ? 'users' : 'overview'); if (!pageMeta(state.page) || (state.page === 'super-admin' && profile.user.role !== 'super_admin')) state.page = profile.user.role === 'super_admin' ? 'users' : 'overview'; if (state.page === 'super-admin') state.page = 'users'; if (profile.user.role === 'super_admin') await loadSuperAdmins(); renderAdmin(); } catch (e) { logout(); alert(e.message); } }
async function login(e, endpoint) { e.preventDefault(); try { const data = await apiRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) }); state.token = data.token; localStorage.setItem('secmynet-token', state.token); await loadDashboard(); } catch (err) { alert(err.message); } }
async function register(e) { e.preventDefault(); const form = e.currentTarget; const values = Object.fromEntries(new FormData(form)); const error = $('#passwordError'); if (values.password !== values.confirmPassword) { error.textContent = 'Passwords do not match.'; $('#confirmPassword').focus(); return; } error.textContent = ''; delete values.confirmPassword; try { const data = await apiRequest('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) }); state.token = data.token; localStorage.setItem('secmynet-token', state.token); await loadDashboard(); } catch (err) { alert(err.message); } }
function togglePassword(id, button) { const input = $(`#${id}`); const isVisible = input.type === 'text'; input.type = isVisible ? 'password' : 'text'; button.setAttribute('aria-label', `${isVisible ? 'Show' : 'Hide'} ${id === 'confirmPassword' ? 'confirm password' : 'password'}`); button.title = button.getAttribute('aria-label'); }
function showLoginCard() { $('#loginCard').classList.remove('hidden'); $('#registerCard').classList.add('hidden'); }
function showRegisterCard() { $('#loginCard').classList.add('hidden'); $('#registerCard').classList.remove('hidden'); }
function logout() { state.token = ''; state.data = null; localStorage.removeItem('secmynet-token'); sessionStorage.removeItem('secmynet-session-start'); $('#authSection').classList.remove('hidden'); $('#dashboard').classList.add('hidden'); $('#userDashboard').classList.add('hidden'); $('#adminIdentity').classList.add('hidden'); showLoginCard(); }
$('#registerForm').addEventListener('submit', register); $('#loginForm').addEventListener('submit', (e) => login(e, '/api/login')); $('#showRegisterLink').addEventListener('click', showRegisterCard); $('#showLoginLink').addEventListener('click', showLoginCard); document.querySelectorAll('[data-password-toggle]').forEach((button) => button.addEventListener('click', () => togglePassword(button.dataset.passwordToggle, button))); $('#confirmPassword').addEventListener('input', () => { const matches = $('#registerPassword').value === $('#confirmPassword').value; $('#passwordError').textContent = $('#confirmPassword').value && !matches ? 'Passwords do not match.' : ''; }); $('#userLogoutBtn').addEventListener('click', logout); $('#adminIdentityLogout').addEventListener('click', logout); $('#sidebarNav').addEventListener('click', (e) => { const a = e.target.closest('[data-page]'); if (a) { e.preventDefault(); navigate(a.dataset.page); } }); $('#userSidebarNav').addEventListener('click', (e) => { const a = e.target.closest('[data-user-page]'); if (a) { e.preventDefault(); state.userPage = a.dataset.userPage; history.replaceState(null, '', `#my-${state.userPage}`); renderUserPage(); } }); $('#backToListBtn').addEventListener('click', () => { state.selected = null; renderAdmin(); }); document.addEventListener('click', (e) => { const button = e.target.closest('[data-notification-response]'); if (button) { const [id, action] = button.dataset.notificationResponse.split('|'); respondToNotification(id, action); } const clearBtn = e.target.closest('[data-notification-clear]'); if (clearBtn) { clearNotification(clearBtn.dataset.notificationClear); } const clearTabBtn = e.target.closest('[data-notification-clear-tab]'); if (clearTabBtn) { clearAllNotifications(clearTabBtn.dataset.notificationClearTab); } const clearAllBtn = e.target.closest('[data-notification-clear-all]'); if (clearAllBtn) { clearAllNotifications(null); } const tabBtn = e.target.closest('[data-notif-tab]'); if (tabBtn) { state.notificationTab = tabBtn.dataset.notifTab; renderAdmin(); } }); if (state.token) { loadDashboard(); setInterval(() => loadNotifications(), 20000); }

const token = localStorage.getItem('secmynet-token');
const table = document.getElementById('detailsTable');
const message = document.getElementById('pageMessage');
const isLocationsPage = window.location.pathname.endsWith('locations.html');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function renderLocations(locations) {
  if (!locations.length) {
    table.innerHTML = '<tr><td colspan="5">No locations have been added yet.</td></tr>';
    return;
  }
  table.innerHTML = locations.map((location) => `
    <tr>
      <td>${escapeHtml(location.name)}</td>
      <td>${escapeHtml(location.city)}</td>
      <td><code>${escapeHtml(location.id)}</code></td>
      <td>${Number(location.devicesCount || 0)}</td>
      <td>${escapeHtml(formatDate(location.created_at || location.createdAt))}</td>
    </tr>
  `).join('');
}

function renderDevices(devices) {
  if (!devices.length) {
    table.innerHTML = '<tr><td colspan="6">No devices have been added yet.</td></tr>';
    return;
  }
  table.innerHTML = devices.map((device) => `
    <tr>
      <td>${escapeHtml(device.name)}</td>
      <td>${escapeHtml(device.wifi_name || device.wifiName || '—')}</td>
      <td>${escapeHtml(device.location?.name || 'Unknown location')}</td>
      <td><span class="status-badge ${escapeHtml(device.status || 'unknown')}">${escapeHtml(device.status || 'Unknown')}</span></td>
      <td>${Number(device.allowedUsers?.length || 0)}</td>
      <td><code>${escapeHtml(device.id)}</code></td>
    </tr>
  `).join('');
}

async function loadDetails() {
  if (!token) {
    window.location.replace('index.html');
    return;
  }

  try {
    const response = await fetch('/api/dashboard', { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Unable to load details.');

    if (isLocationsPage) renderLocations(data.locations || []);
    else renderDevices(data.devices || []);
    message.textContent = '';
  } catch (error) {
    message.textContent = error.message || 'Unable to load details.';
  }
}

loadDetails();

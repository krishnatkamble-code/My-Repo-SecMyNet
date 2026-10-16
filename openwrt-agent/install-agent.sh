#!/bin/sh
# SecMyNet OpenWrt Agent One-Step Installer
# Installs zero-latency quarantine firewall rules, dnsmasq DHCP hooks, and captive portal holding page.

set -e

echo "=== SecMyNet OpenWrt NAC Agent Installer ==="

# 1. Configuration parameters
SERVER_URL="${1:-${SERVER_URL}}"
ROUTER_ID="${2:-${ROUTER_ID}}"

# If not provided, inspect existing config or set smart defaults
if [ -f /etc/secmynet-agent.conf ]; then
  . /etc/secmynet-agent.conf
fi

SERVER_URL="${SERVER_URL:-http://192.168.1.144:3000}"
ROUTER_ID="${ROUTER_ID:-558971}"
TOKEN="${TOKEN:-pw9SafCxXCaLWQgIJA5NfIV2e4gORb3PWZgTV3i-ojI}"

echo "Using Server URL: $SERVER_URL"
echo "Using Router ID : $ROUTER_ID"

# 2. Create directories
mkdir -p /etc/secmynet-agent
mkdir -p /etc/hotplug.d/dhcp
mkdir -p /etc/nftables.d 2>/dev/null || true
mkdir -p /www/secmynet
mkdir -p /var/log

# Save configuration
cat << EOF > /etc/secmynet-agent.conf
SERVER_URL="$SERVER_URL"
ROUTER_ID="$ROUTER_ID"
TOKEN="$TOKEN"
INTERVAL=3
EOF
chmod 600 /etc/secmynet-agent.conf

download_file() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -s "$url" -o "$dest"
  elif command -v uclient-fetch >/dev/null 2>&1; then
    uclient-fetch -q "$url" -O "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$dest"
  fi
}

DIR="$(cd "$(dirname "$0")" && pwd)"

# 3. Copy or download agent and assets
if [ -f "$DIR/agent.sh" ]; then
  cp -f "$DIR/agent.sh" /etc/secmynet-agent/agent.sh
else
  download_file "$SERVER_URL/openwrt-agent/agent.sh" /etc/secmynet-agent/agent.sh
fi
chmod +x /etc/secmynet-agent/agent.sh
ln -sf /etc/secmynet-agent/agent.sh /usr/bin/secmynet-agent

if [ -f "$DIR/dhcp-script.sh" ]; then
  cp -f "$DIR/dhcp-script.sh" /etc/secmynet-agent/dhcp-script.sh
else
  download_file "$SERVER_URL/openwrt-agent/dhcp-script.sh" /etc/secmynet-agent/dhcp-script.sh
fi
chmod +x /etc/secmynet-agent/dhcp-script.sh
cp -f /etc/secmynet-agent/dhcp-script.sh /etc/hotplug.d/dhcp/99-secmynet 2>/dev/null || true

if [ -f "$DIR/holding.html" ]; then
  cp -f "$DIR/holding.html" /etc/secmynet-agent/holding.html
else
  download_file "$SERVER_URL/openwrt-agent/holding.html" /etc/secmynet-agent/holding.html
fi
cp -f /etc/secmynet-agent/holding.html /www/secmynet/holding.html 2>/dev/null || true
cp -f /etc/secmynet-agent/holding.html /www/holding.html 2>/dev/null || true

if [ -f "$DIR/quarantine-firewall.nft" ]; then
  cp -f "$DIR/quarantine-firewall.nft" /etc/nftables.d/secmynet-quarantine.nft 2>/dev/null || true
else
  download_file "$SERVER_URL/openwrt-agent/quarantine-firewall.nft" /etc/nftables.d/secmynet-quarantine.nft 2>/dev/null || true
fi

# 4. Configure OpenWrt dnsmasq to trigger instant quarantine on every DHCP lease
if command -v uci >/dev/null 2>&1 && [ -f /etc/config/dhcp ]; then
  uci set dhcp.@dnsmasq[0].dhcpscript='/etc/secmynet-agent/dhcp-script.sh'
  uci commit dhcp 2>/dev/null || true
  /etc/init.d/dnsmasq restart 2>/dev/null || true
  echo "✔ Configured dnsmasq dhcpscript for instant zero-latency quarantine on lease"
fi

# 5. Configure OpenWrt uhttpd captive holding server on port 8080
if command -v uci >/dev/null 2>&1 && [ -f /etc/config/uhttpd ]; then
  if ! uci get uhttpd.secmynet >/dev/null 2>&1; then
    uci set uhttpd.secmynet=uhttpd
    uci add_list uhttpd.secmynet.listen_http='0.0.0.0:8080'
    uci set uhttpd.secmynet.home='/www/secmynet'
    uci set uhttpd.secmynet.index_page='holding.html'
    uci set uhttpd.secmynet.error_page='/holding.html'
    uci commit uhttpd 2>/dev/null || true
    /etc/init.d/uhttpd restart 2>/dev/null || true
    echo "✔ Configured uhttpd captive portal server on port 8080"
  fi
fi

# 6. Initialize firewall rules and wipe stale allowed states
rm -f /etc/secmynet-agent/allowed_macs 2>/dev/null || true
touch /etc/secmynet-agent/allowed_macs
/bin/sh /etc/secmynet-agent/agent.sh --init
/etc/init.d/firewall restart 2>/dev/null || true
echo "✔ Initialized SecMyNet zero-trust firewall quarantine table and reloaded firewall"

# 7. Configure init.d service
cat << 'EOF' > /etc/init.d/secmynet-agent
#!/bin/sh /etc/rc.common
USE_PROCD=1
START=99
STOP=10

start_service() {
    procd_open_instance
    procd_set_param command /bin/sh /etc/secmynet-agent/agent.sh
    procd_set_param respawn 3600 5 0
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
}
EOF
chmod +x /etc/init.d/secmynet-agent
/etc/init.d/secmynet-agent enable 2>/dev/null || true
/etc/init.d/secmynet-agent restart 2>/dev/null || true

echo "✔ SecMyNet Agent background daemon started."
echo "=== Installation Complete! ==="
echo "All clients connecting to Wi-Fi will now be strictly quarantined from the Internet"
echo "and will see: 'Service Approval pending from owner of the Router' until approved."

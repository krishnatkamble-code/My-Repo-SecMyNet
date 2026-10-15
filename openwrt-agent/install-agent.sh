#!/bin/sh
# SecMyNet OpenWrt Agent One-Step Installer
# Installs zero-latency quarantine firewall rules, hotplug DHCP hooks, and captive portal holding page.

set -e

echo "=== SecMyNet OpenWrt NAC Agent Installer ==="

# 1. Create directories
mkdir -p /etc/secmynet-agent
mkdir -p /etc/hotplug.d/dhcp
mkdir -p /etc/nftables.d 2>/dev/null || true
mkdir -p /www/secmynet
mkdir -p /var/log

DIR="$(cd "$(dirname "$0")" && pwd)"

# 2. Copy agent and assets
if [ -f "$DIR/agent.sh" ]; then
  cp -f "$DIR/agent.sh" /etc/secmynet-agent/agent.sh
  chmod +x /etc/secmynet-agent/agent.sh
  ln -sf /etc/secmynet-agent/agent.sh /usr/bin/secmynet-agent
fi

if [ -f "$DIR/holding.html" ]; then
  cp -f "$DIR/holding.html" /etc/secmynet-agent/holding.html
  cp -f "$DIR/holding.html" /www/secmynet/holding.html
  cp -f "$DIR/holding.html" /www/holding.html
fi

if [ -f "$DIR/quarantine-firewall.nft" ]; then
  cp -f "$DIR/quarantine-firewall.nft" /etc/nftables.d/secmynet-quarantine.nft 2>/dev/null || true
fi

# 3. Install instant DHCP hotplug hook
if [ -f "$DIR/hotplug-dhcp.sh" ]; then
  cp -f "$DIR/hotplug-dhcp.sh" /etc/hotplug.d/dhcp/99-secmynet
  chmod +x /etc/hotplug.d/dhcp/99-secmynet
  echo "✔ Installed instant DHCP quarantine hotplug hook (/etc/hotplug.d/dhcp/99-secmynet)"
fi

# 4. Configure OpenWrt uhttpd captive holding server on port 8080
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

# 5. Initialize firewall rules
/bin/sh /etc/secmynet-agent/agent.sh --init
echo "✔ Initialized SecMyNet zero-trust firewall quarantine table"

# 6. Configure init.d service
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
echo "Clients connecting to Wi-Fi will now be strictly quarantined from the Internet"
echo "and will see: 'Service Approval pending from owner of the Router' until approved."

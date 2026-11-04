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

# 5. Initialize firewall rules, protect wired Ethernet connections, and wipe stale allowed states
rm -f /etc/secmynet-agent/allowed_macs 2>/dev/null || true
rm -f /etc/secmynet-agent/blocked_macs 2>/dev/null || true
touch /etc/secmynet-agent/allowed_macs
mkdir -p /etc/secmynet-agent
touch /etc/secmynet-agent/wired_macs

# PERMANENT WHITELIST FOR DESKTOP / ADMIN PC AND WAN GATEWAY
echo "d8:5e:d3:9b:2e:56" >> /etc/secmynet-agent/wired_macs
echo "04:f4:1c:03:fe:aa" >> /etc/secmynet-agent/wired_macs

# Remove any stale invalid tokens or gateway from quarantine lists
sed -i '/tywe/d;/type/d;/04:f4:1c:03:fe:aa/d;/d8:5e:d3:9b:2e:56/d' /etc/secmynet-agent/quarantined_macs 2>/dev/null || true

# Clean up any accumulated individual fw4 forward / dstnat drop rules from past bugs
if command -v nft >/dev/null 2>&1; then
  for h in $(nft -a list chain inet fw4 forward 2>/dev/null | grep -E 'drop' | sed -n 's/.*# handle \([0-9]*\)/\1/p'); do
    nft delete rule inet fw4 forward handle "$h" 2>/dev/null || true
  done
  for h in $(nft -a list chain inet fw4 dstnat 2>/dev/null | grep -E '8080' | sed -n 's/.*# handle \([0-9]*\)/\1/p'); do
    nft delete rule inet fw4 dstnat handle "$h" 2>/dev/null || true
  done
fi

# Detect current wired connections from brctl showmacs and whitelist them.
# Direct port-number check: LAN1=1, LAN2=2, LAN3=3, LAN4=4 are wired switch ports.
# WiFi phy ports are 5 and above on this router — never matched.
if command -v brctl >/dev/null 2>&1; then
  brctl showmacs br-lan 2>/dev/null | while read -r _port_no _bmac _rest; do
    [ -z "$_port_no" ] || [ "$_port_no" = "port" ] && continue
    # Direct port match: 1-4 = physical LAN switch ports (LAN1, LAN2, LAN3, LAN4)
    case "$_port_no" in
      1|2|3|4)
        echo "$_bmac" | tr '[:upper:]' '[:lower:]' >> /etc/secmynet-agent/wired_macs
        continue
        ;;
    esac
    # Fallback: resolve port number → interface name for non-standard layouts
    for _pdir in /sys/class/net/br-lan/brif/*; do
      if [ -f "$_pdir/port_no" ]; then
        _curr_port=$(cat "$_pdir/port_no" 2>/dev/null | sed 's/^0x//')
        _curr_port_dec=$(printf "%d" "0x$_curr_port" 2>/dev/null || echo "$_curr_port")
        if [ "$_curr_port_dec" = "$_port_no" ] || [ "$_curr_port" = "$_port_no" ]; then
          _if_name=$(basename "$_pdir")
          case "$_if_name" in
            eth*|lan*|en*|wan*)
              echo "$_bmac" | tr '[:upper:]' '[:lower:]' >> /etc/secmynet-agent/wired_macs
              ;;
          esac
        fi
      fi
    done
  done
fi

if command -v bridge >/dev/null 2>&1; then
  bridge fdb show 2>/dev/null | grep -v '00:00:00:00:00:00' | while read -r _wmac _rest; do
    _port=$(bridge fdb show 2>/dev/null | grep -i "$_wmac" | while read -r _a _b _p _rest2; do echo "$_p"; break; done)
    case "$_port" in
      eth*|lan*|en*|wan*)
        echo "$_wmac" | tr '[:upper:]' '[:lower:]' >> /etc/secmynet-agent/wired_macs
        ;;
    esac
  done
fi
sort -u /etc/secmynet-agent/wired_macs -o /etc/secmynet-agent/wired_macs 2>/dev/null || true

/bin/sh /etc/secmynet-agent/agent.sh --init
/etc/init.d/firewall restart 2>/dev/null || true
echo "✔ Initialized SecMyNet zero-trust firewall quarantine table and reloaded firewall"

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

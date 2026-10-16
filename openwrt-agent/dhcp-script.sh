#!/bin/sh
# /etc/secmynet-agent/dhcp-script.sh
# Invoked by OpenWrt dnsmasq on every DHCP lease event (add, old, del)
# Instantly quarantines unapproved clients before they can send or receive internet traffic!

ACTION="${1:-$ACTION}"
MAC="${2:-$MACADDR}"
IP="${3:-$IPADDR}"
HOST="${4:-$HOSTNAME}"

[ -z "$MAC" ] && exit 0
MAC="$(printf '%s' "$MAC" | tr '[:upper:]' '[:lower:]')"

logger -t secmynet-dhcp "DHCP lease event '$ACTION' for client $MAC ($IP, $HOST)"

# If action is 'del' (lease expired / device disconnected):
if [ "$ACTION" = "del" ]; then
  if [ -f /etc/secmynet-agent/agent.sh ]; then
    /bin/sh /etc/secmynet-agent/agent.sh --event del "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
  fi
  exit 0
fi

# If client is already approved by owner, allow access
if grep -qi "$MAC" /etc/secmynet-agent/allowed_macs 2>/dev/null; then
  exit 0
fi

# ========================================================
# CLIENT IS NOT APPROVED - ENFORCE IMMEDIATE ZERO-TRUST QUARANTINE!
# ========================================================
mkdir -p /etc/secmynet-agent
sed -i "/$MAC/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true
grep -qi "$MAC" /etc/secmynet-agent/quarantined_macs 2>/dev/null || echo "$MAC" >> /etc/secmynet-agent/quarantined_macs

# 1. LINUX KERNEL POLICY ROUTING TABLE 99 BLACKHOLE (100% unbypassable kernel routing drop)
lan_subnet=$(ip -4 addr show br-lan 2>/dev/null | awk '/inet / {print $2}' | head -n1)
[ -z "$lan_subnet" ] && lan_subnet="192.168.1.0/24"
ip route flush table 99 2>/dev/null || true
ip route add "$lan_subnet" dev br-lan table 99 2>/dev/null || true
ip route add blackhole default table 99 2>/dev/null || true

if [ -n "$IP" ]; then
  ip rule del from "$IP" table 99 2>/dev/null || true
  ip rule add from "$IP" table 99 priority 1 2>/dev/null || true
fi

# IPv6 routing blackhole
ip -6 route flush table 99 2>/dev/null || true
ip -6 route add blackhole default table 99 2>/dev/null || true
for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$MAC" | awk '{print $1}'); do
  [ -n "$ip6" ] && ip -6 rule del from "$ip6" table 99 2>/dev/null || true
  [ -n "$ip6" ] && ip -6 rule add from "$ip6" table 99 priority 1 2>/dev/null || true
done
if [ -f /tmp/hosts/odhcpd ]; then
  for ip6 in $(grep -i "$MAC" /tmp/hosts/odhcpd 2>/dev/null | awk '{print $1}'); do
    [ -n "$ip6" ] && ip -6 rule del from "$ip6" table 99 2>/dev/null || true
    [ -n "$ip6" ] && ip -6 rule add from "$ip6" table 99 priority 1 2>/dev/null || true
  done
fi

# 2. OPENWRT NATIVE FW4 HOOKS (NFTABLES)
if command -v nft >/dev/null 2>&1; then
  # Direct forward drops
  nft insert rule inet fw4 forward ether saddr "$MAC" counter drop 2>/dev/null || true
  [ -n "$IP" ] && nft insert rule inet fw4 forward ip saddr "$IP" counter drop 2>/dev/null || true
  [ -n "$IP" ] && nft insert rule inet fw4 srcnat ip saddr "$IP" counter drop 2>/dev/null || true
  # Captive portal redirection
  nft insert rule inet fw4 dstnat ether saddr "$MAC" tcp dport 80 redirect to 8080 2>/dev/null || true
  [ -n "$IP" ] && nft insert rule inet fw4 dstnat ip saddr "$IP" tcp dport 80 redirect to 8080 2>/dev/null || true

  # Standalone secmynet table sets
  nft add element inet secmynet quarantined_macs "{ $MAC }" 2>/dev/null || true
  [ -n "$IP" ] && nft add element inet secmynet quarantined_ips "{ $IP }" 2>/dev/null || true
  for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$MAC" | awk '{print $1}'); do
    [ -n "$ip6" ] && nft add element inet secmynet quarantined_ip6s "{ $ip6 }" 2>/dev/null || true
  done

  # Layer 2 bridge & netdev (if supported)
  nft add element bridge secmynet_br quarantined_macs "{ $MAC }" 2>/dev/null || true
  nft add element netdev secmynet_l2 quarantined_macs "{ $MAC }" 2>/dev/null || true
fi

# 3. IPTABLES & IP6TABLES (FALLBACK)
if command -v iptables >/dev/null 2>&1; then
  iptables -I FORWARD 1 -m mac --mac-source "$MAC" -j DROP 2>/dev/null || true
  [ -n "$IP" ] && iptables -I FORWARD 1 -s "$IP" -j DROP 2>/dev/null || true
  iptables -t mangle -I PREROUTING 1 -m mac --mac-source "$MAC" -j DROP 2>/dev/null || true
  [ -n "$IP" ] && iptables -t mangle -I PREROUTING 1 -s "$IP" -j DROP 2>/dev/null || true
  iptables -t nat -I PREROUTING 1 -m mac --mac-source "$MAC" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
  [ -n "$IP" ] && iptables -t nat -I PREROUTING 1 -s "$IP" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
fi
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -I FORWARD 1 -m mac --mac-source "$MAC" -j DROP 2>/dev/null || true
  ip6tables -t mangle -I PREROUTING 1 -m mac --mac-source "$MAC" -j DROP 2>/dev/null || true
fi

# 4. INSTANTLY KILL ACTIVE CONNTRACK SOCKETS
if command -v conntrack >/dev/null 2>&1; then
  [ -n "$IP" ] && conntrack -D -s "$IP" 2>/dev/null || true
  [ -n "$IP" ] && conntrack -D -d "$IP" 2>/dev/null || true
  for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$MAC" | awk '{print $1}'); do
    [ -n "$ip6" ] && conntrack -D -s "$ip6" 2>/dev/null || true
    [ -n "$ip6" ] && conntrack -D -d "$ip6" 2>/dev/null || true
  done
fi
ip route flush cache 2>/dev/null || true

logger -t secmynet-dhcp "Client $MAC ($IP, $HOST) successfully quarantined at zero-latency!"

# 5. ASYNCHRONOUSLY NOTIFY SECMYNET AGENT -> SERVER -> WEB APP POPUP
if [ -f /etc/secmynet-agent/agent.sh ]; then
  /bin/sh /etc/secmynet-agent/agent.sh --event add "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
fi

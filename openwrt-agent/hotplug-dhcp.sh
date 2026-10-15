#!/bin/sh
# /etc/hotplug.d/dhcp/99-secmynet
# Instantly quarantines newly connected devices and triggers SecMyNet agent on OpenWrt

[ "$ACTION" = "add" ] || [ "$ACTION" = "update" ] || exit 0

MAC="$(printf '%s' "$MACADDR" | tr '[:upper:]' '[:lower:]')"
IP="$IPADDR"
HOST="$HOSTNAME"

[ -z "$MAC" ] && exit 0

logger -t secmynet-hotplug "DHCP lease event: $ACTION for $MAC ($IP, $HOST)"

mkdir -p /etc/secmynet-agent

# Zero-Trust Quarantine-First: Any DHCP lease is a connection attempt.
# Clear any stale allow records and immediately enforce local zero-latency quarantine!
sed -i "/$MAC/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true
grep -qi "$MAC" /etc/secmynet-agent/quarantined_macs 2>/dev/null || echo "$MAC" >> /etc/secmynet-agent/quarantined_macs

# 1. LINUX KERNEL POLICY ROUTING BLACKHOLE (100% unbypassable kernel WAN drop)
lan_subnet=$(ip -4 addr show br-lan 2>/dev/null | awk '/inet / {print $2}' | head -n1)
[ -z "$lan_subnet" ] && lan_subnet="192.168.1.0/24"
ip route flush table 99 2>/dev/null || true
ip route add "$lan_subnet" dev br-lan table 99 2>/dev/null || true
ip route add blackhole default table 99 2>/dev/null || true

if [ -n "$IP" ]; then
  ip rule del from "$IP" table 99 2>/dev/null || true
  ip rule add from "$IP" table 99 priority 1 2>/dev/null || true
fi

ip -6 route flush table 99 2>/dev/null || true
ip -6 route add blackhole default table 99 2>/dev/null || true
for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$MAC" | awk '{print $1}'); do
  [ -n "$ip6" ] && ip -6 rule del from "$ip6" table 99 2>/dev/null || true
  [ -n "$ip6" ] && ip -6 rule add from "$ip6" table 99 priority 1 2>/dev/null || true
done

  # 2. Native fw4 injection (OpenWrt fw4)
  if command -v nft >/dev/null 2>&1; then
    nft insert rule inet fw4 forward ether saddr "$MAC" counter drop 2>/dev/null || true
    [ -n "$IP" ] && nft insert rule inet fw4 forward ip saddr "$IP" counter drop 2>/dev/null || true
    nft insert rule inet fw4 dstnat ether saddr "$MAC" tcp dport 80 redirect to 8080 2>/dev/null || true
    [ -n "$IP" ] && nft insert rule inet fw4 dstnat ip saddr "$IP" tcp dport 80 redirect to 8080 2>/dev/null || true

    # Standalone table inet secmynet
    nft add table inet secmynet 2>/dev/null || true
    nft add set inet secmynet quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
    nft add set inet secmynet quarantined_ips '{ type ipv4_addr; }' 2>/dev/null || true
    nft add set inet secmynet quarantined_ip6s '{ type ipv6_addr; }' 2>/dev/null || true
    nft add element inet secmynet quarantined_macs "{ $MAC }" 2>/dev/null || true
    [ -n "$IP" ] && nft add element inet secmynet quarantined_ips "{ $IP }" 2>/dev/null || true
  fi

  # 3. iptables & ip6tables fallback (Dual-stack forward and mangle drops)
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

  # 3. Flush conntrack sockets so existing sockets are severed
  if command -v conntrack >/dev/null 2>&1; then
    [ -n "$IP" ] && conntrack -D -s "$IP" 2>/dev/null || true
    [ -n "$IP" ] && conntrack -D -d "$IP" 2>/dev/null || true
    for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$MAC" | awk '{print $1}'); do
      [ -n "$ip6" ] && conntrack -D -s "$ip6" 2>/dev/null || true
      [ -n "$ip6" ] && conntrack -D -d "$ip6" 2>/dev/null || true
    done
  fi
  ip route flush cache 2>/dev/null || true

  logger -t secmynet-hotplug "Client $MAC ($IP) placed in immediate zero-latency local quarantine."

# 4. Trigger SecMyNet agent in background to notify cloud server and owner
if [ -f /etc/secmynet-agent/agent.sh ]; then
  /bin/sh /etc/secmynet-agent/agent.sh --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
elif [ -x /usr/bin/secmynet-agent ]; then
  /usr/bin/secmynet-agent --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
elif [ -f /root/agent.sh ]; then
  /bin/sh /root/agent.sh --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
fi


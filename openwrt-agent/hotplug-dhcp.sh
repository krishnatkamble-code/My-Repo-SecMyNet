#!/bin/sh
# /etc/hotplug.d/dhcp/99-secmynet
# Instantly quarantines newly connected devices and triggers SecMyNet agent on OpenWrt

[ "$ACTION" = "add" ] || [ "$ACTION" = "update" ] || exit 0

MAC="$(printf '%s' "$MACADDR" | tr '[:upper:]' '[:lower:]')"
IP="$IPADDR"
HOST="$HOSTNAME"

[ -z "$MAC" ] && exit 0

logger -t secmynet-hotplug "DHCP lease event: $ACTION for $MAC ($IP, $HOST)"

# 1. Zero-Trust Check: Is this client already explicitly approved?
mkdir -p /etc/secmynet-agent
if ! grep -qi "$MAC" /etc/secmynet-agent/allowed_macs 2>/dev/null; then
  # IMMEDIATELY apply local quarantine in milliseconds:
  # Block WAN forwarding and redirect HTTP port 80 to captive holding page
  grep -qi "$MAC" /etc/secmynet-agent/quarantined_macs 2>/dev/null || echo "$MAC" >> /etc/secmynet-agent/quarantined_macs

  if command -v nft >/dev/null 2>&1; then
    nft add table inet secmynet 2>/dev/null || true
    nft add set inet secmynet quarantined_macs '{ type ether_addr; flags interval; }' 2>/dev/null || true
    nft add set inet secmynet quarantined_ips '{ type ipv4_addr; flags interval; }' 2>/dev/null || true
    nft add element inet secmynet quarantined_macs "{ $MAC }" 2>/dev/null || true
    [ -n "$IP" ] && nft add element inet secmynet quarantined_ips "{ $IP }" 2>/dev/null || true
  fi

  if command -v iptables >/dev/null 2>&1; then
    iptables -I FORWARD 1 -m mac --mac-source "$MAC" -j DROP 2>/dev/null || true
    [ -n "$IP" ] && iptables -I FORWARD 1 -s "$IP" -j DROP 2>/dev/null || true
    iptables -t nat -I PREROUTING 1 -m mac --mac-source "$MAC" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
    [ -n "$IP" ] && iptables -t nat -I PREROUTING 1 -s "$IP" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
  fi

  if command -v conntrack >/dev/null 2>&1; then
    [ -n "$IP" ] && conntrack -D -s "$IP" 2>/dev/null || true
    [ -n "$IP" ] && conntrack -D -d "$IP" 2>/dev/null || true
  fi
  ip route flush cache 2>/dev/null || true

  logger -t secmynet-hotplug "Client $MAC ($IP) placed in immediate zero-latency local quarantine."
fi

# 2. Trigger SecMyNet agent in background to notify cloud server and owner
if [ -f /etc/secmynet-agent/agent.sh ]; then
  /bin/sh /etc/secmynet-agent/agent.sh --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
elif [ -x /usr/bin/secmynet-agent ]; then
  /usr/bin/secmynet-agent --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
elif [ -f /root/agent.sh ]; then
  /bin/sh /root/agent.sh --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
fi

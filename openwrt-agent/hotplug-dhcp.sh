#!/bin/sh
# /etc/hotplug.d/dhcp/99-secmynet
# Instantly quarantines newly connected devices and triggers SecMyNet agent on OpenWrt

[ "$ACTION" = "add" ] || [ "$ACTION" = "update" ] || exit 0

MAC="$(printf '%s' "$MACADDR" | tr '[:upper:]' '[:lower:]')"
IP="$IPADDR"
HOST="$HOSTNAME"

[ -z "$MAC" ] && exit 0

logger -t secmynet-hotplug "DHCP lease event: $ACTION for $MAC ($IP, $HOST)"

# -------------------------------------------------------------
# WIRED ETHERNET PROTECTION
# SecMyNet enforces Zero-Trust NAC EXCLUSIVELY on wireless (Wi-Fi) devices.
# Wired Ethernet connections must ALWAYS work and NEVER be blocked!
# -------------------------------------------------------------
"is_wired_client() {\n  _mac=\"$(printf '%s' \"$1\" | tr '[:upper:]' '[:lower:]' | tr '-' ':')\"\n  [ -z \"$_mac\" ] && return 1\n\n  # 1. PERMANENT HARDCODED WHITELIST FOR DESKTOP / ADMIN PC (D8:5E:D3:9B:2E:56)\n  case \"$_mac\" in\n    d8:5e:d3:9b:2e:56) return 0 ;;\n  esac\n\n  # 2. Check configured wired MACs whitelist file\n  if [ -f /etc/secmynet-agent/wired_macs ]; then\n    grep -qi \"$_mac\" /etc/secmynet-agent/wired_macs 2>/dev/null && return 0\n  fi\n\n  # 3. Check bridge FDB to see if MAC is attached to an Ethernet / LAN port\n  if command -v bridge >/dev/null 2>&1; then\n    _bdev=$(bridge fdb show 2>/dev/null | grep -i \"$_mac\" | while read -r _a _b _dev _rest; do echo \"$_dev\"; break; done)\n    if [ -n \"$_bdev\" ]; then\n      case \"$_bdev\" in\n        eth*|lan*|en*|wan*) return 0 ;;\n      esac\n      if [ -d \"/sys/class/net/$_bdev\" ] && [ ! -d \"/sys/class/net/$_bdev/wireless\" ] && [ ! -d \"/sys/class/net/$_bdev/phy80211\" ]; then\n        if ! iw dev 2>/dev/null | grep -qw \"$_bdev\"; then\n          return 0\n        fi\n      fi\n    fi\n  fi\n\n  # 4. Check brctl showmacs (Busybox OpenWrt)\n  if command -v brctl >/dev/null 2>&1; then\n    _port_no=$(brctl showmacs br-lan 2>/dev/null | grep -i \"$_mac\" | while read -r _p _m _rest; do [ \"$_p\" != \"port\" ] && echo \"$_p\"; break; done)\n    if [ -n \"$_port_no\" ] && [ \"$_port_no\" != \"port\" ]; then\n      for _pdir in /sys/class/net/br-lan/brif/*; do\n        if [ -f \"$_pdir/port_no\" ]; then\n          _curr_port=$(cat \"$_pdir/port_no\" 2>/dev/null | sed 's/^0x//')\n          _curr_port_dec=$(printf \"%d\" \"0x$_curr_port\" 2>/dev/null || echo \"$_curr_port\")\n          if [ \"$_curr_port_dec\" = \"$_port_no\" ] || [ \"$_curr_port\" = \"$_port_no\" ]; then\n            _if_name=$(basename \"$_pdir\")\n            case \"$_if_name\" in\n              eth*|lan*|en*|wan*) return 0 ;;\n            esac\n            if [ ! -d \"$_pdir/../wireless\" ] && [ ! -d \"$_pdir/../phy80211\" ]; then\n              if ! iw dev 2>/dev/null 
<truncated 160 bytes>

is_wireless_client() {
  _mac="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [ -z "$_mac" ] && return 1

  # Explicit wired check first
  if is_wired_client "$_mac"; then
    return 1
  fi

  # 1. Fast check via iw dev station get
  if command -v iw >/dev/null 2>&1; then
    for _wdev in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
      if iw dev "$_wdev" station get "$_mac" >/dev/null 2>&1; then
        return 0
      fi
    done
  fi

  # 2. Check via iwinfo assoclist
  if command -v iwinfo >/dev/null 2>&1; then
    for _wdev in $( (iwinfo 2>/dev/null | grep -E '^[a-zA-Z0-9]' | cut -d' ' -f1; iw dev 2>/dev/null | sed -n 's/.*Interface //p') | sort -u ); do
      if iwinfo "$_wdev" assoclist 2>/dev/null | grep -qi "$_mac"; then
        return 0
      fi
    done
  fi

  # 3. Check via ubus hostapd instances
  if command -v ubus >/dev/null 2>&1; then
    for _hp in $(ubus list 'hostapd.*' 2>/dev/null); do
      if ubus call "$_hp" get_clients 2>/dev/null | grep -qi "$_mac"; then
        return 0
      fi
    done
  fi

  # 4. Check bridge FDB interface
  if command -v bridge >/dev/null 2>&1; then
    _bdev=$(bridge fdb show 2>/dev/null | grep -i "$_mac" | awk '{print $3}' | head -n1)
    if [ -n "$_bdev" ]; then
      case "$_bdev" in
        wlan*|ath*|ra*|wl*) return 0 ;;
      esac
      if [ -d "/sys/class/net/$_bdev/wireless" ] || [ -d "/sys/class/net/$_bdev/phy80211" ]; then
        return 0
      fi
    fi
  fi

  return 1
}

# If the device is connected via wired Ethernet, bypass quarantine completely!
# FIXED: Use is_wired_client() directly — never invert the wireless check.
# Devices unknown to is_wired_client MUST be treated as wireless and quarantined.
if is_wired_client "$MAC"; then
  logger -t secmynet-hotplug "Ignoring wired Ethernet device: $MAC ($IP, $HOST). Internet remains active and unblocked."
  # Ensure any residual blackhole or drop rules for this wired client are cleaned up
  if [ -f /etc/secmynet-agent/agent.sh ]; then
    /bin/sh /etc/secmynet-agent/agent.sh --allow "$MAC" "$IP" >/dev/null 2>&1 || true
  fi
  exit 0
fi

# If the device has already been approved and allowed by the owner, KEEP IT ALLOWED!
# DHCP renewals (ACTION=update) must never re-quarantine active users.
if grep -qi "$MAC" /etc/secmynet-agent/allowed_macs 2>/dev/null; then
  logger -t secmynet-hotplug "Device $MAC is already allowed by owner — skipping quarantine."
  exit 0
fi

mkdir -p /etc/secmynet-agent

# Zero-Trust: Every new unapproved Wi-Fi client MUST start in quarantine
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
if [ -f /tmp/hosts/odhcpd ]; then
  for ip6 in $(grep -i "$MAC" /tmp/hosts/odhcpd 2>/dev/null | awk '{print $1}'); do
    [ -n "$ip6" ] && ip -6 rule del from "$ip6" table 99 2>/dev/null || true
    [ -n "$ip6" ] && ip -6 rule add from "$ip6" table 99 priority 1 2>/dev/null || true
  done
fi

# 2. nftables Bridge, Netdev Ingress, and Inet Quarantines (OpenWrt fw4)
if command -v nft >/dev/null 2>&1; then
  # Layer 2 Bridge table
  nft add table bridge secmynet_br 2>/dev/null || true
  nft add set bridge secmynet_br quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
  nft add element bridge secmynet_br quarantined_macs "{ $MAC }" 2>/dev/null || true

  # Layer 2 Netdev Ingress table
  nft add table netdev secmynet_l2 2>/dev/null || true
  nft add set netdev secmynet_l2 quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
  nft add element netdev secmynet_l2 quarantined_macs "{ $MAC }" 2>/dev/null || true

  # Layer 3 Inet table
  nft add table inet secmynet 2>/dev/null || true
  nft add set inet secmynet quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
  nft add set inet secmynet quarantined_ips '{ type ipv4_addr; }' 2>/dev/null || true
  nft add set inet secmynet quarantined_ip6s '{ type ipv6_addr; }' 2>/dev/null || true
  nft add element inet secmynet quarantined_macs "{ $MAC }" 2>/dev/null || true
  [ -n "$IP" ] && nft add element inet secmynet quarantined_ips "{ $IP }" 2>/dev/null || true

  for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$MAC" | awk '{print $1}'); do
    [ -n "$ip6" ] && nft add element inet secmynet quarantined_ip6s "{ $ip6 }" 2>/dev/null || true
  done
  if [ -f /tmp/hosts/odhcpd ]; then
    for ip6 in $(grep -i "$MAC" /tmp/hosts/odhcpd 2>/dev/null | awk '{print $1}'); do
      [ -n "$ip6" ] && nft add element inet secmynet quarantined_ip6s "{ $ip6 }" 2>/dev/null || true
    done
  fi

  # Elements in secmynet sets automatically handle drop and captive portal redirection
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

# 4. Flush conntrack sockets so existing connections die instantly
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

# 5. Trigger SecMyNet agent in background to notify cloud server and owner
if [ -f /etc/secmynet-agent/agent.sh ]; then
  /bin/sh /etc/secmynet-agent/agent.sh --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
elif [ -x /usr/bin/secmynet-agent ]; then
  /usr/bin/secmynet-agent --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
elif [ -f /root/agent.sh ]; then
  /bin/sh /root/agent.sh --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
fi

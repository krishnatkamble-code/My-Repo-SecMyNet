#!/bin/sh
# SecMyNet OpenWrt Agent
# Collects station info and telemetry, enforces Zero-Trust NAC quarantine, and posts to SecMyNet server

if [ -f /etc/secmynet-agent.conf ]; then
  . /etc/secmynet-agent.conf
elif [ -f /etc/secmynet-agent/agent.conf ]; then
  . /etc/secmynet-agent/agent.conf
fi

SERVER_URL=${SERVER_URL:-${SECMYNET_URL:-https://my-repo-sec-my-net.vercel.app}}
SERVER_URL="$(printf '%s' "${SERVER_URL%/}" | tr -d '\r\n ')"
ROUTER_ID=${ROUTER_ID:-${SECMYNET_ROUTER_ID:-931354}}
ROUTER_ID="$(printf '%s' "$ROUTER_ID" | tr -d '\r\n ')"
TOKEN_FILE=${TOKEN_FILE:-/etc/secmynet-agent/token}
STATE_FILE=${STATE_FILE:-/var/run/secmynet-agent/state.json}
LOG_FILE=${LOG_FILE:-/var/log/secmynet-agent.log}
INTERVAL=${INTERVAL:-5}

log() {
  echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') $*"
  echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') $*" >> "$LOG_FILE" 2>/dev/null || true
}

read_token() {
  tok=""
  if [ -n "$TOKEN" ]; then
    tok="$TOKEN"
  elif [ -n "$SECMYNET_AGENT_TOKEN" ]; then
    tok="$SECMYNET_AGENT_TOKEN"
  elif [ -f "$TOKEN_FILE" ]; then
    tok="$(cat "$TOKEN_FILE" 2>/dev/null)"
  else
    tok="pw9SafCxXCaLWQgIJA5NfIV2e4gORb3PWZgTV3i-ojI"
  fi
  printf '%s' "$tok" | tr -d '\r\n '
}

# -------------------------------------------------------------
# WIRED ETHERNET PROTECTION
# SecMyNet enforces Zero-Trust NAC EXCLUSIVELY on wireless (Wi-Fi) devices.
# Wired Ethernet connections must ALWAYS work and NEVER be blocked!
# -------------------------------------------------------------
is_wired_client() {
  _mac="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [ -z "$_mac" ] && return 1

  # 1. Check configured wired MACs whitelist file
  if [ -f /etc/secmynet-agent/wired_macs ]; then
    grep -qi "$_mac" /etc/secmynet-agent/wired_macs 2>/dev/null && return 0
  fi

  # 2. Check bridge FDB to see if MAC is attached to an Ethernet / LAN port
  if command -v bridge >/dev/null 2>&1; then
    _bdev=$(bridge fdb show 2>/dev/null | grep -i "$_mac" | awk '{print $3}' | head -n1)
    if [ -n "$_bdev" ]; then
      case "$_bdev" in
        eth*|lan*|en*|wan*) return 0 ;;
      esac
      if [ -d "/sys/class/net/$_bdev" ] && [ ! -d "/sys/class/net/$_bdev/wireless" ] && [ ! -d "/sys/class/net/$_bdev/phy80211" ]; then
        if ! iw dev 2>/dev/null | grep -qw "$_bdev"; then
          return 0
        fi
      fi
    fi
  fi

  # 3. Check brctl showmacs (older OpenWrt)
  if command -v brctl >/dev/null 2>&1; then
    _port_no=$(brctl showmacs br-lan 2>/dev/null | grep -i "$_mac" | awk '{print $1}' | head -n1)
    if [ -n "$_port_no" ] && [ "$_port_no" != "port" ]; then
      for _pdir in /sys/class/net/br-lan/brif/*; do
        if [ -f "$_pdir/port_no" ]; then
          _curr_port=$(cat "$_pdir/port_no" 2>/dev/null | sed 's/^0x//')
          _curr_port_dec=$(printf "%d" "0x$_curr_port" 2>/dev/null || echo "$_curr_port")
          if [ "$_curr_port_dec" = "$_port_no" ] || [ "$_curr_port" = "$_port_no" ]; then
            _if_name=$(basename "$_pdir")
            case "$_if_name" in
              eth*|lan*|en*|wan*) return 0 ;;
            esac
            if [ ! -d "$_pdir/../wireless" ] && [ ! -d "$_pdir/../phy80211" ]; then
              if ! iw dev 2>/dev/null | grep -qw "$_if_name"; then
                return 0
              fi
            fi
          fi
        fi
      done
    fi
  fi

  return 1
}

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

unquarantine_wired_devices() {
  # Actively unquarantine any wired Ethernet devices to guarantee uninterrupted internet access
  # Permanently guarantee Desktop PC (D8:5E:D3:9B:2E:56) is unquarantined and allowed
  apply_allow "d8:5e:d3:9b:2e:56" "192.168.1.144" 2>/dev/null || true
  sed -i "/d8:5e:d3:9b:2e:56/d" /etc/secmynet-agent/quarantined_macs 2>/dev/null || true
  sed -i "/d8:5e:d3:9b:2e:56/d" /etc/secmynet-agent/blocked_macs 2>/dev/null || true

  if [ -f /etc/secmynet-agent/quarantined_macs ]; then
    while read -r _qmac; do
      [ -z "$_qmac" ] && continue
      _qmac="$(printf '%s' "$_qmac" | tr '[:upper:]' '[:lower:]')"
      # FIXED: Only release if EXPLICITLY a known wired client (never invert wireless check!)
      if is_wired_client "$_qmac"; then
        log "Releasing accidental quarantine on wired Ethernet device: $_qmac"
        apply_allow "$_qmac" ""
        sed -i "/$_qmac/d" /etc/secmynet-agent/quarantined_macs 2>/dev/null || true
      fi
    done < /etc/secmynet-agent/quarantined_macs
  fi

  if [ -f /etc/secmynet-agent/blocked_macs ]; then
    while read -r _bmac; do
      [ -z "$_bmac" ] && continue
      _bmac="$(printf '%s' "$_bmac" | tr '[:upper:]' '[:lower:]')"
      # FIXED: Only release if EXPLICITLY a known wired client (never invert wireless check!)
      if is_wired_client "$_bmac"; then
        log "Releasing accidental block on wired Ethernet device: $_bmac"
        apply_allow "$_bmac" ""
        sed -i "/$_bmac/d" /etc/secmynet-agent/blocked_macs 2>/dev/null || true
      fi
    done < /etc/secmynet-agent/blocked_macs
  fi

  # Check all ip rules lookup 99: if an IP belongs to a wired MAC, remove it from table 99
  for _rip in $(ip rule show 2>/dev/null | grep "lookup 99" | awk '{print $3}'); do
    [ -z "$_rip" ] && continue
    _rip_mac=$(grep -i "$_rip" /tmp/dhcp.leases 2>/dev/null | awk '{print $2}' | head -n1)
    [ -z "$_rip_mac" ] && _rip_mac=$(awk -v ip="$_rip" '$1==ip {print $4; exit}' /proc/net/arp 2>/dev/null)
    # FIXED: Only remove blackhole if EXPLICITLY a known wired client
    if [ -n "$_rip_mac" ] && is_wired_client "$_rip_mac"; then
      log "Removing routing table 99 blackhole from wired Ethernet IP: $_rip ($_rip_mac)"
      apply_allow "$_rip_mac" "$_rip"
    fi
  done
}


init_firewall() {
  mkdir -p /etc/secmynet-agent

  # Setup Linux Policy Routing Table 99 (Blackhole default WAN route)
  lan_subnet=$(ip -4 addr show br-lan 2>/dev/null | awk '/inet / {print $2}' | head -n1)
  [ -z "$lan_subnet" ] && lan_subnet="192.168.1.0/24"
  ip route flush table 99 2>/dev/null || true
  ip route add "$lan_subnet" dev br-lan table 99 2>/dev/null || true
  ip route add blackhole default table 99 2>/dev/null || true

  ip -6 route flush table 99 2>/dev/null || true
  ip -6 route add blackhole default table 99 2>/dev/null || true

  # 1. nftables support (OpenWrt 22.03+, fw4)
  if command -v nft >/dev/null 2>&1; then
    # Load standalone nftables quarantine file if present
    if [ -f /etc/nftables.d/secmynet-quarantine.nft ]; then
      nft -f /etc/nftables.d/secmynet-quarantine.nft 2>/dev/null || true
    fi

    # Ensure table bridge secmynet_br exists
    nft add table bridge secmynet_br 2>/dev/null || true
    nft add set bridge secmynet_br quarantined_macs '{ type ether_addr; }' 2>/dev/null || true

    # Ensure table netdev secmynet_l2 exists
    nft add table netdev secmynet_l2 2>/dev/null || true
    nft add set netdev secmynet_l2 quarantined_macs '{ type ether_addr; }' 2>/dev/null || true

    # Ensure table inet secmynet exists with valid syntax (no flags interval on ether_addr)
    nft add table inet secmynet 2>/dev/null || true
    nft add set inet secmynet quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
    nft add set inet secmynet quarantined_ips '{ type ipv4_addr; }' 2>/dev/null || true
    nft add set inet secmynet quarantined_ip6s '{ type ipv6_addr; }' 2>/dev/null || true

    # NAT Prerouting: Redirect HTTP port 80 to captive portal on 8080
    nft add chain inet secmynet prerouting_nat '{ type nat hook prerouting priority -100; policy accept; }' 2>/dev/null || true
    nft flush chain inet secmynet prerouting_nat 2>/dev/null || true
    nft add rule inet secmynet prerouting_nat ether saddr @quarantined_macs tcp dport 80 redirect to 8080 2>/dev/null || true
    nft add rule inet secmynet prerouting_nat ip saddr @quarantined_ips tcp dport 80 redirect to 8080 2>/dev/null || true

    # Ingress Filter: Priority -150 (drops quarantined traffic before conntrack can accept it)
    nft add chain inet secmynet prerouting_filter '{ type filter hook prerouting priority -150; policy accept; }' 2>/dev/null || true
    nft flush chain inet secmynet prerouting_filter 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ether saddr @quarantined_macs udp dport 67 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ether saddr @quarantined_macs udp dport 68 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ether saddr @quarantined_macs udp dport 53 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ether saddr @quarantined_macs tcp dport 53 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ether saddr @quarantined_macs tcp dport 80 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip saddr @quarantined_ips udp dport 67 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip saddr @quarantined_ips udp dport 68 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip saddr @quarantined_ips udp dport 53 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip saddr @quarantined_ips tcp dport 53 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip saddr @quarantined_ips tcp dport 80 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip6 saddr @quarantined_ip6s udp dport 53 accept 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip6 saddr @quarantined_ip6s tcp dport 53 accept 2>/dev/null || true
    # Drop all other ingress traffic from quarantined clients
    nft add rule inet secmynet prerouting_filter ether saddr @quarantined_macs counter drop 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip saddr @quarantined_ips counter drop 2>/dev/null || true
    nft add rule inet secmynet prerouting_filter ip6 saddr @quarantined_ip6s counter drop 2>/dev/null || true

    # Forward Hook: priority -10 (evaluated before fw4 default forwarding rules)
    nft add chain inet secmynet forward '{ type filter hook forward priority -10; policy accept; }' 2>/dev/null || true
    nft flush chain inet secmynet forward 2>/dev/null || true
    nft add rule inet secmynet forward ether saddr @quarantined_macs udp dport 67 accept 2>/dev/null || true
    nft add rule inet secmynet forward ether saddr @quarantined_macs udp dport 68 accept 2>/dev/null || true
    nft add rule inet secmynet forward ether saddr @quarantined_macs counter drop 2>/dev/null || true
    nft add rule inet secmynet forward ip saddr @quarantined_ips counter drop 2>/dev/null || true
    nft add rule inet secmynet forward ip6 saddr @quarantined_ip6s counter drop 2>/dev/null || true

    log "Initialized standalone nftables secmynet quarantine table."
  fi

  # 2. iptables support: Clean up any legacy unconditional quarantine drop chains from FORWARD
  if command -v iptables >/dev/null 2>&1; then
    while iptables -D FORWARD -j SECMYNET_QUARANTINE 2>/dev/null; do :; done
    while iptables -t nat -D PREROUTING -j SECMYNET_REDIRECT 2>/dev/null; do :; done
    iptables -F SECMYNET_QUARANTINE 2>/dev/null || true
    iptables -X SECMYNET_QUARANTINE 2>/dev/null || true
    iptables -t nat -F SECMYNET_REDIRECT 2>/dev/null || true
    iptables -t nat -X SECMYNET_REDIRECT 2>/dev/null || true
  fi

  if command -v ip6tables >/dev/null 2>&1; then
    while ip6tables -D FORWARD -j SECMYNET_QUARANTINE6 2>/dev/null; do :; done
    ip6tables -F SECMYNET_QUARANTINE6 2>/dev/null || true
    ip6tables -X SECMYNET_QUARANTINE6 2>/dev/null || true
  fi

  # Always guarantee wired Ethernet connections are completely unquarantined
  unquarantine_wired_devices
}

setup_captive_portal() {
  mkdir -p /www/secmynet
  if [ -f /etc/secmynet-agent/holding.html ]; then
    cp -f /etc/secmynet-agent/holding.html /www/secmynet/holding.html 2>/dev/null || true
    cp -f /etc/secmynet-agent/holding.html /www/holding.html 2>/dev/null || true
  fi

  if command -v uci >/dev/null 2>&1 && [ -f /etc/config/uhttpd ]; then
    if ! uci get uhttpd.secmynet >/dev/null 2>&1; then
      uci set uhttpd.secmynet=uhttpd
      uci add_list uhttpd.secmynet.listen_http='0.0.0.0:8080'
      uci set uhttpd.secmynet.home='/www/secmynet'
      uci set uhttpd.secmynet.index_page='holding.html'
      uci set uhttpd.secmynet.error_page='/holding.html'
      uci commit uhttpd 2>/dev/null || true
      /etc/init.d/uhttpd restart 2>/dev/null || true
      log "Configured OpenWrt uhttpd captive portal instance on port 8080"
    fi
  fi
}

apply_quarantine() {
  mac="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  ip="$2"
  [ -z "$mac" ] && return

  # Reject invalid non-MAC addresses (e.g. table header strings)
  case "$mac" in
    [0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
    *)
      log "apply_quarantine rejected invalid MAC: $mac"
      return 0
      ;;
  esac

  # CRITICAL SAFETY: Never quarantine WAN gateway or default router gateway!
  case "$mac" in
    04:f4:1c:03:fe:aa) return 0 ;;
  esac
  case "$ip" in
    192.168.200.1) return 0 ;;
  esac
  _def_gw=$(ip route 2>/dev/null | awk '/default/ {print $3; exit}')
  if [ -n "$_def_gw" ] && [ "$ip" = "$_def_gw" ]; then
    log "apply_quarantine rejected WAN default gateway: $ip"
    return 0
  fi

  # WIRED ETHERNET PROTECTION: Never quarantine wired devices!
  if is_wired_client "$mac"; then
    log "apply_quarantine bypassed: $mac ($ip) is a wired Ethernet client. Internet kept active and unblocked."
    apply_allow "$mac" "$ip"
    return 0
  fi

  if [ -z "$ip" ]; then
    ip=$(grep -i "$mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3 | head -n1)
    [ -z "$ip" ] && ip=$(awk -v m="$mac" 'tolower($4)==tolower(m) {print $1; exit}' /proc/net/arp 2>/dev/null)
    [ -z "$ip" ] && ip=$(ip -4 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}' | head -n1)
  fi

  mkdir -p /etc/secmynet-agent
  grep -qi "$mac" /etc/secmynet-agent/quarantined_macs 2>/dev/null || echo "$mac" >> /etc/secmynet-agent/quarantined_macs
  sed -i "/$mac/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true

  # 1. LINUX KERNEL POLICY ROUTING BLACKHOLE (100% unbypassable kernel WAN drop)
  lan_subnet=$(ip -4 addr show br-lan 2>/dev/null | awk '/inet / {print $2}' | head -n1)
  [ -z "$lan_subnet" ] && lan_subnet="192.168.1.0/24"
  ip route flush table 99 2>/dev/null || true
  ip route add "$lan_subnet" dev br-lan table 99 2>/dev/null || true
  ip route add blackhole default table 99 2>/dev/null || true

  if [ -n "$ip" ]; then
    if ! ip rule show 2>/dev/null | grep -q "from $ip lookup 99"; then
      ip rule add from "$ip" table 99 priority 1 2>/dev/null || true
    fi
  fi

  # IPv6 policy routing blackhole
  ip -6 route flush table 99 2>/dev/null || true
  ip -6 route add blackhole default table 99 2>/dev/null || true
  for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}'); do
    if [ -n "$ip6" ] && ! ip -6 rule show 2>/dev/null | grep -q "from $ip6 lookup 99"; then
      ip -6 rule add from "$ip6" table 99 priority 1 2>/dev/null || true
    fi
  done

  # 2. OpenWrt nftables Zero-Trust sets (L2 bridge, netdev ingress, inet)
  if command -v nft >/dev/null 2>&1; then
    nft add table bridge secmynet_br 2>/dev/null || true
    nft add set bridge secmynet_br quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
    nft add element bridge secmynet_br quarantined_macs "{ $mac }" 2>/dev/null || true

    nft add table netdev secmynet_l2 2>/dev/null || true
    nft add set netdev secmynet_l2 quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
    nft add element netdev secmynet_l2 quarantined_macs "{ $mac }" 2>/dev/null || true

    nft add table inet secmynet 2>/dev/null || true
    nft add set inet secmynet quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
    nft add set inet secmynet quarantined_ips '{ type ipv4_addr; }' 2>/dev/null || true
    nft add set inet secmynet quarantined_ip6s '{ type ipv6_addr; }' 2>/dev/null || true

    nft add element inet secmynet quarantined_macs "{ $mac }" 2>/dev/null || true
    [ -n "$ip" ] && nft add element inet secmynet quarantined_ips "{ $ip }" 2>/dev/null || true

    for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}'); do
      [ -n "$ip6" ] && nft add element inet secmynet quarantined_ip6s "{ $ip6 }" 2>/dev/null || true
    done
    if [ -f /tmp/hosts/odhcpd ]; then
      for ip6 in $(grep -i "$mac" /tmp/hosts/odhcpd 2>/dev/null | awk '{print $1}'); do
        [ -n "$ip6" ] && nft add element inet secmynet quarantined_ip6s "{ $ip6 }" 2>/dev/null || true
      done
    fi
  fi

  # 3. iptables & ip6tables (Idempotent check before insert)
  if command -v iptables >/dev/null 2>&1; then
    if ! iptables -C FORWARD -m mac --mac-source "$mac" -j DROP 2>/dev/null; then
      iptables -I FORWARD 1 -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    fi
    if [ -n "$ip" ] && ! iptables -C FORWARD -s "$ip" -j DROP 2>/dev/null; then
      iptables -I FORWARD 1 -s "$ip" -j DROP 2>/dev/null || true
    fi
    if ! iptables -t mangle -C PREROUTING -m mac --mac-source "$mac" -j DROP 2>/dev/null; then
      iptables -t mangle -I PREROUTING 1 -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    fi
    if [ -n "$ip" ] && ! iptables -t mangle -C PREROUTING -s "$ip" -j DROP 2>/dev/null; then
      iptables -t mangle -I PREROUTING 1 -s "$ip" -j DROP 2>/dev/null || true
    fi
    if ! iptables -t nat -C PREROUTING -m mac --mac-source "$mac" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null; then
      iptables -t nat -I PREROUTING 1 -m mac --mac-source "$mac" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
    fi
  fi

  if command -v ip6tables >/dev/null 2>&1; then
    if ! ip6tables -C FORWARD -m mac --mac-source "$mac" -j DROP 2>/dev/null; then
      ip6tables -I FORWARD 1 -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    fi
  fi

  # Flush conntrack sockets so existing connections die instantly
  if command -v conntrack >/dev/null 2>&1; then
    [ -n "$ip" ] && conntrack -D -s "$ip" 2>/dev/null || true
    [ -n "$ip" ] && conntrack -D -d "$ip" 2>/dev/null || true
  fi
  ip route flush cache 2>/dev/null || true

  log "Zero-Trust Quarantine Enforced: $mac ($ip) - WAN forwarding blocked"
}

apply_allow() {
  mac="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  ip="$2"
  [ -z "$mac" ] && return

  if [ -z "$ip" ]; then
    ip=$(grep -i "$mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3 | head -n1)
    [ -z "$ip" ] && ip=$(ip -4 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}' | head -n1)
    [ -z "$ip" ] && ip=$(awk -v m="$mac" 'tolower($4)==tolower(m) {print $1; exit}' /proc/net/arp 2>/dev/null)
  fi

  mkdir -p /etc/secmynet-agent
  sed -i "/$mac/d" /etc/secmynet-agent/quarantined_macs 2>/dev/null || true
  sed -i "/$mac/d" /etc/secmynet-agent/blocked_macs 2>/dev/null || true
  grep -qi "$mac" /etc/secmynet-agent/allowed_macs 2>/dev/null || echo "$mac" >> /etc/secmynet-agent/allowed_macs

  # 1. Remove Linux Kernel Policy Routing blackholes completely
  if [ -n "$ip" ]; then
    while ip rule del from "$ip" table 99 2>/dev/null; do :; done
    while ip rule del from "$ip" 2>/dev/null; do :; done
  fi
  for found_ip in $(grep -i "$mac" /tmp/dhcp.leases 2>/dev/null | awk '{print $3}'); do
    while ip rule del from "$found_ip" table 99 2>/dev/null; do :; done
  done
  for found_ip in $(awk -v m="$mac" 'tolower($4)==tolower(m) {print $1}' /proc/net/arp 2>/dev/null); do
    while ip rule del from "$found_ip" table 99 2>/dev/null; do :; done
  done
  for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}'); do
    [ -n "$ip6" ] && while ip -6 rule del from "$ip6" table 99 2>/dev/null; do :; done
  done
  ip route flush cache 2>/dev/null || true

  # 2. Remove nftables rules and elements from all sets
  if command -v nft >/dev/null 2>&1; then
    nft delete element bridge secmynet_br quarantined_macs "{ $mac }" 2>/dev/null || true
    nft delete element netdev secmynet_l2 quarantined_macs "{ $mac }" 2>/dev/null || true
    nft delete element inet secmynet quarantined_macs "{ $mac }" 2>/dev/null || true
    [ -n "$ip" ] && nft delete element inet secmynet quarantined_ips "{ $ip }" 2>/dev/null || true
    for found_ip in $(grep -i "$mac" /tmp/dhcp.leases 2>/dev/null | awk '{print $3}'); do
      nft delete element inet secmynet quarantined_ips "{ $found_ip }" 2>/dev/null || true
    done
    for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}'); do
      [ -n "$ip6" ] && nft delete element inet secmynet quarantined_ip6s "{ $ip6 }" 2>/dev/null || true
    done
    # Delete any legacy fw4 inserted rules matching this MAC or IP
    for handle in $(nft -a list chain inet fw4 forward 2>/dev/null | grep -E -i "$mac|$ip" | sed -n 's/.*# handle \([0-9]*\)/\1/p'); do
      [ -n "$handle" ] && nft delete rule inet fw4 forward handle "$handle" 2>/dev/null || true
    done
    for handle in $(nft -a list chain inet fw4 dstnat 2>/dev/null | grep -E -i "$mac|$ip" | sed -n 's/.*# handle \([0-9]*\)/\1/p'); do
      [ -n "$handle" ] && nft delete rule inet fw4 dstnat handle "$handle" 2>/dev/null || true
    done
  fi

  # 3. Remove iptables & ip6tables rules (delete all duplicate instances)
  if command -v iptables >/dev/null 2>&1; then
    while iptables -D FORWARD -m mac --mac-source "$mac" -j DROP 2>/dev/null; do :; done
    [ -n "$ip" ] && while iptables -D FORWARD -s "$ip" -j DROP 2>/dev/null; do :; done
    while iptables -t mangle -D PREROUTING -m mac --mac-source "$mac" -j DROP 2>/dev/null; do :; done
    [ -n "$ip" ] && while iptables -t mangle -D PREROUTING -s "$ip" -j DROP 2>/dev/null; do :; done
    while iptables -t nat -D PREROUTING -m mac --mac-source "$mac" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null; do :; done
    [ -n "$ip" ] && while iptables -t nat -D PREROUTING -s "$ip" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null; do :; done
    while iptables -D FORWARD -j SECMYNET_QUARANTINE 2>/dev/null; do :; done
    while iptables -t nat -D PREROUTING -j SECMYNET_REDIRECT 2>/dev/null; do :; done
  fi

  if command -v ip6tables >/dev/null 2>&1; then
    while ip6tables -D FORWARD -m mac --mac-source "$mac" -j DROP 2>/dev/null; do :; done
    while ip6tables -t mangle -D PREROUTING -m mac --mac-source "$mac" -j DROP 2>/dev/null; do :; done
    while ip6tables -D FORWARD -j SECMYNET_QUARANTINE6 2>/dev/null; do :; done
  fi

  # 4. Flush conntrack sockets so new WAN traffic flows immediately
  if command -v conntrack >/dev/null 2>&1; then
    [ -n "$ip" ] && conntrack -D -s "$ip" 2>/dev/null || true
    [ -n "$ip" ] && conntrack -D -d "$ip" 2>/dev/null || true
  fi

  log "Quarantine Released: $mac ($ip) - WAN internet access granted by owner"
  echo "[secmynet-agent] Quarantine Released: $mac ($ip) - WAN internet access granted"
}

collect_clients() {
  tmp="/tmp/stations.$$"
  rm -f "$tmp"
  touch "$tmp"

  # 1. Discover all wireless interfaces (iw, iwinfo, sysfs)
  wl_ifaces=$( (iw dev 2>/dev/null | sed -n 's/.*Interface //p'; iwinfo 2>/dev/null | grep -E '^[a-zA-Z0-9]' | cut -d' ' -f1; ls /sys/class/net 2>/dev/null | grep -E '^(wlan|ra|ath|wl)') | sort -u )
  for iface in $wl_ifaces; do
    iw dev "$iface" station dump 2>/dev/null >> "$tmp"
    if command -v iwinfo >/dev/null 2>&1; then
      iwinfo "$iface" assoclist 2>/dev/null | grep -iE '^[0-9a-f]{2}:' | while read -r sta_mac rest; do
        [ -n "$sta_mac" ] && echo "Station $sta_mac" >> "$tmp"
      done
    fi
  done

  # 2. OpenWrt ubus hostapd clients fallback
  if command -v ubus >/dev/null 2>&1; then
    for hp in $(ubus list 'hostapd.*' 2>/dev/null); do
      ubus call "$hp" get_clients 2>/dev/null | grep -oE '"[0-9a-fA-F:]{17}"' | tr -d '"' | while read -r sta_mac; do
        [ -n "$sta_mac" ] && echo "Station $sta_mac" >> "$tmp"
      done
    done
  fi

  clients="["
  first=1
  cur_mac=""
  rx=0
  tx=0
  sig="null"
  seen_macs=" "

  while read -r w1 w2 w3 rest; do
    case "$w1" in
      Station)
        if [ -n "$cur_mac" ]; then
          ip=$(grep -i "$cur_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3 | head -n1)
          [ -z "$ip" ] && ip=$(ip neigh 2>/dev/null | grep -i "$cur_mac" | cut -d' ' -f1 | head -n1)
          [ -z "$ip" ] && ip=$(awk -v m="$cur_mac" 'tolower($4)==tolower(m) {print $1; exit}' /proc/net/arp 2>/dev/null)
          host=$(grep -i "$cur_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f4 | head -n1)
          [ "$first" = "0" ] && clients="$clients,"
          first=0
          clients="${clients}{\"mac\":\"$cur_mac\",\"ip\":\"${ip:-}\",\"hostname\":\"${host:-}\",\"wireless\":true,\"rx_bytes\":${rx:-0},\"tx_bytes\":${tx:-0},\"signal\":${sig:-null}}"
          seen_macs="${seen_macs}${cur_mac} "
        fi
        cur_mac="$(printf '%s' "$w2" | tr '[:upper:]' '[:lower:]')"
        rx=0
        tx=0
        sig="null"
        ;;
      rx)
        [ "$w2" = "bytes:" ] && rx="$w3"
        ;;
      tx)
        [ "$w2" = "bytes:" ] && tx="$w3"
        ;;
      signal:)
        sig=$(echo "$w2" | tr -dc '0-9-')
        [ -z "$sig" ] && sig="null"
        ;;
    esac
  done < "$tmp"

  if [ -n "$cur_mac" ]; then
    ip=$(grep -i "$cur_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3 | head -n1)
    [ -z "$ip" ] && ip=$(ip neigh 2>/dev/null | grep -i "$cur_mac" | cut -d' ' -f1 | head -n1)
    [ -z "$ip" ] && ip=$(awk -v m="$cur_mac" 'tolower($4)==tolower(m) {print $1; exit}' /proc/net/arp 2>/dev/null)
    host=$(grep -i "$cur_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f4 | head -n1)
    [ "$first" = "0" ] && clients="$clients,"
    first=0
    clients="${clients}{\"mac\":\"$cur_mac\",\"ip\":\"${ip:-}\",\"hostname\":\"${host:-}\",\"wireless\":true,\"rx_bytes\":${rx:-0},\"tx_bytes\":${tx:-0},\"signal\":${sig:-null}}"
    seen_macs="${seen_macs}${cur_mac} "
  fi

  # 3. Also inspect /tmp/dhcp.leases for active leased clients (e.g., mobile phones)
  if [ -f /tmp/dhcp.leases ]; then
    now_ts=$(date +%s 2>/dev/null || echo 0)
    while read -r l_ts l_mac l_ip l_host rest; do
      [ -z "$l_mac" ] && continue
      l_mac="$(printf '%s' "$l_mac" | tr '[:upper:]' '[:lower:]')"
      case "$seen_macs" in
        *" $l_mac "*) continue ;;
      esac
      # SECMYNET: Collect wireless devices ONLY. Skip ALL explicitly-known wired Ethernet devices!
      if is_wired_client "$l_mac"; then
        continue
      fi
      is_active=""
      # Check if client has non-stale ARP entry or valid DHCP lease timestamp
      if grep -i "$l_mac" /proc/net/arp 2>/dev/null | grep -vq '0x0'; then
        is_active="1"
      elif [ -n "$l_ts" ] && [ "$l_ts" -gt "$now_ts" ] 2>/dev/null; then
        is_active="1"
      elif grep -qi "$l_mac" /proc/net/arp 2>/dev/null; then
        is_active="1"
      fi
      if [ -n "$is_active" ]; then
        [ "$first" = "0" ] && clients="$clients,"
        first=0
        clients="${clients}{\"mac\":\"$l_mac\",\"ip\":\"${l_ip:-}\",\"hostname\":\"${l_host:-}\",\"wireless\":true,\"rx_bytes\":0,\"tx_bytes\":0,\"signal\":null}"
        seen_macs="${seen_macs}${l_mac} "
      fi
    done < /tmp/dhcp.leases
  fi

  # 4. Fallback inspection of /proc/net/arp
  if [ -f /proc/net/arp ]; then
    while read -r a_ip a_hw a_flags a_mac a_mask a_dev; do
      [ "$a_ip" = "IP" ] && continue
      [ "$a_mac" = "HW" ] || [ "$a_mac" = "type" ] && continue
      [ "$a_flags" = "0x0" ] && continue
      [ -z "$a_mac" ] || [ "$a_mac" = "00:00:00:00:00:00" ] && continue

      # Strictly validate 6-octet hex MAC address format (prevents header text like 'type' or 'tywe')
      case "$a_mac" in
        [0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]:[0-9a-fA-F][0-9a-fA-F]) ;;
        *) continue ;;
      esac

      # Strictly validate IPv4 address format
      case "$a_ip" in
        *.*.*.*) ;;
        *) continue ;;
      esac

      # Strictly ignore WAN or upstream interfaces (wan, pppoe, eth1) — only consider LAN bridge (br-lan)
      case "$a_dev" in
        br-lan|lan*|eth0) ;;
        *) continue ;;
      esac

      a_mac="$(printf '%s' "$a_mac" | tr '[:upper:]' '[:lower:]')"
      case "$seen_macs" in
        *" $a_mac "*) continue ;;
      esac
      # SECMYNET: Collect wireless devices ONLY. Skip ALL explicitly-known wired Ethernet devices!
      if is_wired_client "$a_mac"; then
        continue
      fi
      a_host=$(grep -i "$a_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f4 | head -n1)
      [ "$first" = "0" ] && clients="$clients,"
      first=0
      clients="${clients}{\"mac\":\"$a_mac\",\"ip\":\"${a_ip:-}\",\"hostname\":\"${a_host:-}\",\"wireless\":true,\"rx_bytes\":0,\"tx_bytes\":0,\"signal\":null}"
      seen_macs="${seen_macs}${a_mac} "
    done < /proc/net/arp
  fi

  # If a specific client was triggered via event ($1 = mac, $2 = ip, $3 = host), ensure it's included
  ev_mac="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  ev_ip="$2"
  ev_host="$3"
  if [ -n "$ev_mac" ]; then
    if is_wireless_client "$ev_mac"; then      case "$seen_macs" in
        *" $ev_mac "*) ;;
        *)
          [ "$first" = "0" ] && clients="$clients,"
          first=0
          clients="${clients}{\"mac\":\"$ev_mac\",\"ip\":\"${ev_ip:-}\",\"hostname\":\"${ev_host:-}\",\"wireless\":true,\"rx_bytes\":0,\"tx_bytes\":0,\"signal\":null}"
          seen_macs="${seen_macs}${ev_mac} "
          ;;
      esac
    fi
  fi

  rm -f "$tmp"
  clients="$clients]"
  echo "$clients"
}

post_telemetry() {
  token="$(read_token)"
  if [ -z "$ROUTER_ID" ] || [ -z "$token" ]; then
    log "Missing ROUTER_ID or token; cannot post telemetry"
    return 1
  fi

  clients=$(collect_clients "$1" "$2" "$3" 2>/dev/null)
  [ -z "$clients" ] && clients="[]"
  payload="{\"clients\":$clients,\"usage\":[]}"

  http_code=""
  body=""
  if command -v curl >/dev/null 2>&1; then
    res=$(curl -s -w "HTTPSTATUS:%{http_code}" -X POST "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/telemetry" \
      -H "Content-Type: application/json" \
      -H "x-secmynet-agent-token: $token" \
      -d "$payload" --max-time 15 2>/dev/null)
    http_code=$(echo "$res" | tr -d '\r' | sed -n 's/.*HTTPSTATUS:\([0-9][0-9][0-9]\)$/\1/p')
    body=$(echo "$res" | sed -e 's/HTTPSTATUS:.*//g')
  elif command -v uclient-fetch >/dev/null 2>&1; then
    body=$(uclient-fetch -q -O - \
      --header="Content-Type: application/json" \
      --header="x-secmynet-agent-token: $token" \
      --post-data="$payload" "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/telemetry" 2>/dev/null)
    [ $? -eq 0 ] && http_code="200" || http_code="500"
  elif command -v wget >/dev/null 2>&1; then
    body=$(wget -q -O - \
      --header="Content-Type: application/json" \
      --header="x-secmynet-agent-token: $token" \
      --post-data="$payload" "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/telemetry" 2>/dev/null)
    [ $? -eq 0 ] && http_code="200" || http_code="500"
  fi

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ] || echo "$body" | grep -q '"ok":true'; then
    count=$(echo "$clients" | grep -o '{"mac"' | wc -l)
    log "Telemetry posted successfully: $count clients"
    echo "[secmynet-agent] Telemetry sent successfully to $SERVER_URL (Router: $ROUTER_ID)"
    return 0
  else
    log "Telemetry post failed: code=$http_code body=$body"
    echo "[secmynet-agent] Telemetry post failed: code=$http_code body=$body"
    return 1
  fi
}

poll_commands() {
  token="$(read_token)"
  [ -z "$ROUTER_ID" ] && return 1

  res=""
  if command -v curl >/dev/null 2>&1; then
    res=$(curl -s -X GET "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands" \
      -H "x-secmynet-agent-token: $token" --max-time 15 2>/dev/null)
  elif command -v uclient-fetch >/dev/null 2>&1; then
    res=$(uclient-fetch -q -O - \
      --header="x-secmynet-agent-token: $token" \
      "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands" 2>/dev/null)
  elif command -v wget >/dev/null 2>&1; then
    res=$(wget -q -O - \
      --header="x-secmynet-agent-token: $token" \
      "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands" 2>/dev/null)
  fi
  [ -z "$res" ] && return 1

  # Robust commands parser: pure POSIX sed/tr line splitter
  cmd_lines=""
  if command -v jq >/dev/null 2>&1; then
    cmd_lines=$(printf '%s\n' "$res" | jq -c '.commands[]?' 2>/dev/null)
  fi
  if [ -z "$cmd_lines" ]; then
    cmd_lines=$(printf '%s\n' "$res" | tr '\r\n' ' ' | sed 's/{"id":/\n{"id":/g' | grep '"id":')
  fi

  [ -z "$cmd_lines" ] && return 0

  IFS='
'
  for cmd in $cmd_lines; do
    [ -z "$cmd" ] && continue
    id=""
    type=""
    mac=""
    ip=""
    key=""
    enc="psk2"

    if command -v jq >/dev/null 2>&1; then
      id=$(echo "$cmd" | jq -r '.id // empty' 2>/dev/null)
      type=$(echo "$cmd" | jq -r '.command_type // empty' 2>/dev/null)
      mac=$(echo "$cmd" | jq -r '.payload.mac // .payload_json.mac // empty' 2>/dev/null)
      ip=$(echo "$cmd" | jq -r '.payload.ip // .payload_json.ip // empty' 2>/dev/null)
      key=$(echo "$cmd" | jq -r '.payload.key // empty' 2>/dev/null)
      enc=$(echo "$cmd" | jq -r '.payload.encryption // "psk2"' 2>/dev/null)
    fi

    # Fallback regex extraction if jq not installed
    [ -z "$id" ] && id=$(printf '%s' "$cmd" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    [ -z "$type" ] && type=$(printf '%s' "$cmd" | sed -n 's/.*"command_type":"\([^"]*\)".*/\1/p')
    [ -z "$mac" ] && mac=$(printf '%s' "$cmd" | sed -n 's/.*"mac":"\([^"]*\)".*/\1/p')
    [ -z "$ip" ] && ip=$(printf '%s' "$cmd" | sed -n 's/.*"ip":"\([^"]*\)".*/\1/p')
    [ -z "$key" ] && key=$(printf '%s' "$cmd" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
    if [ -z "$enc" ] || [ "$enc" = "null" ]; then
      enc=$(printf '%s' "$cmd" | sed -n 's/.*"encryption":"\([^"]*\)".*/\1/p')
      [ -z "$enc" ] && enc="psk2"
    fi

    [ "$ip" = "null" ] && ip=""
    [ "$mac" = "null" ] && mac=""
    mac="$(printf '%s' "$mac" | tr '[:upper:]' '[:lower:]')"

    [ -z "$id" ] && continue

    log "Executing command: $type for $mac ($ip)"
    echo "[secmynet-agent] Executing command: $type for $mac ($ip)"

    case "$type" in
      disconnect)
        if is_wired_client "$mac"; then
          log "Ignoring disconnect command for wired Ethernet client: $mac"
          continue
        fi
        sed -i "/$mac/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true
        for iface in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
          iw dev "$iface" station del "$mac" 2>/dev/null || hostapd_cli -i "$iface" deauthenticate "$mac" 2>/dev/null || true
        done
        ;;
      block)
        if is_wired_client "$mac"; then
          log "Ignoring block command for wired Ethernet client: $mac"
          # Wired clients are NEVER blocked - ensure they stay allowed
          apply_allow "$mac" "$ip"
          continue
        fi
        mkdir -p /etc/secmynet-agent
        echo "$mac" >> /etc/secmynet-agent/blocked_macs
        sed -i "/$mac/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true
        apply_quarantine "$mac" "$ip"
        for iface in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
          iw dev "$iface" station del "$mac" 2>/dev/null || hostapd_cli -i "$iface" deauthenticate "$mac" 2>/dev/null || true
        done
        log "Client $mac blocked and quarantined by owner."
        ;;
      quarantine)
        if is_wired_client "$mac"; then
          log "Ignoring quarantine command for wired Ethernet client: $mac"
          apply_allow "$mac" "$ip"
          continue
        fi
        apply_quarantine "$mac" "$ip"
        ;;
      allow)
        apply_allow "$mac" "$ip"
        ;;
      restart)
        wifi reload 2>/dev/null || reboot 2>/dev/null || true
        ;;
      set_wifi_password)
        if [ -n "$key" ] && command -v uci >/dev/null 2>&1; then
          uci set wireless.@wifi-iface[0].encryption="$enc" 2>/dev/null || true
          uci set wireless.@wifi-iface[0].key="$key" 2>/dev/null || true
          uci commit wireless 2>/dev/null || true
          wifi reload 2>/dev/null || true
          log "Configured Wi-Fi password on router ($enc)"
        fi
        ;;
      *)
        log "Unknown command type: $type"
        ;;
    esac

    if command -v curl >/dev/null 2>&1; then
      curl -s -X POST "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands/$id/complete" \
        -H "x-secmynet-agent-token: $token" \
        -H "Content-Type: application/json" \
        -d '{"success":true}' --max-time 10 >/dev/null 2>&1 || true
    elif command -v uclient-fetch >/dev/null 2>&1; then
      uclient-fetch -q -O - \
        --header="Content-Type: application/json" \
        --header="x-secmynet-agent-token: $token" \
        --post-data='{"success":true}' \
        "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands/$id/complete" >/dev/null 2>&1 || true
    fi
    echo "[secmynet-agent] Command completed: $id ($type for $mac)"
  done
}

enforce_active_quarantines() {
  # 1. Unquarantine any wired Ethernet devices to guarantee uninterrupted internet access
  unquarantine_wired_devices

"  # Collect all currently-associated wireless station MACs from all interfaces\n  active_stations=\"\"\n  for iface in $(iw dev 2>/dev/null | while read -r _w1 _w2 _rest; do [ \"$_w1\" = \"Interface\" ] && echo \"$_w2\"; done); do\n    iw dev \"$iface\" station dump 2>/dev/null | while read -r _w1 _sta _rest; do\n      if [ \"$_w1\" = \"Station\" ]; then\n        sta_lc=\"$(printf '%s' \"$_sta\" | tr '[:upper:]' '[:lower:]')\"\n        active_stations=\"${active_stations}${sta_lc} \"\n      fi\n    done\n  done\n  # Also check iwinfo and ubus for associated stations\n  if command -v ubus >/dev/null 2>&1; then\n    for _hp in $(ubus list 'hostapd.*' 2>/dev/null); do\n      for _umac in $(ubus call \"$_hp\" get_clients 2>/dev/null | grep -oE '\"[0-9a-fA-F:]{17}\"' | tr -d '\"'); do\n        _ulc=\"$(printf '%s' \"$_umac\" | tr '[:upper:]' '[:lower:]')\"\n        active_stations=\"${active_stations}${_ulc} \"\n      done\n    done\n  fi\n\n  # 2. Revoke allowed_macs for any wireless client that has ACTUALLY disconnected.\n  #    Use a debounce counter so brief radio power-save or AP roaming does NOT disconnect them,\n  #    but full disconnection (>4 consecutive missed checks) revokes access as required.\n  if [ -f /etc/secmynet-agent/allowed_macs ]; then\n    while read -r _amac; do\n      [ -z \"$_amac\" ] && continue\n      _amac=\"$(printf '%s' \"$_amac\" | tr '[:upper:]' '[:lower:]' | tr -d '\\r\\n ')\"\n      # Keep wired clients always in allowed_macs\n      if is_wired_client \"$_amac\"; then\n        continue\n      fi\n      _cnt_file=\"/tmp/disconn_$(echo \"$_amac\" | tr -d ':')\"\n      case \"$active_stations\" in\n        *\"$_amac\"*)\n          rm -f \"$_cnt_file\" 2>/dev/null || true\n          ;;\n        *)\n          _cnt=$(cat \"$_cnt_file\" 2>/dev/null || echo 0)\n          _cnt=$((_cnt + 1))\n          echo \"$_cnt\" > \"$_cnt_file\"\n          if [ \"$_cnt\" -ge 4 ]; then\n            log \"Wireless client $_amac disconnected for $_cnt consecutive checks — revoking allowed status!\"\n     
<truncated 226 bytes>

  # 3. Continuously ensure every connected WIRELESS station NOT in allowed_macs is strictly quarantined
  for iface in $(iw dev 2>/dev/null | while read -r _w1 _w2 _rest; do [ "$_w1" = "Interface" ] && echo "$_w2"; done); do
    iw dev "$iface" station dump 2>/dev/null | while read -r _w1 _sta _rest; do
      [ "$_w1" != "Station" ] && continue
      sta_mac="$(printf '%s' "$_sta" | tr '[:upper:]' '[:lower:]')"
      [ -z "$sta_mac" ] && continue
      # Skip explicitly-known wired clients
      if is_wired_client "$sta_mac"; then
        continue
      fi
      sta_ip=$(grep -i "$sta_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3 | head -n1)
      [ -z "$sta_ip" ] && sta_ip=$(ip -4 neigh show 2>/dev/null | grep -i "$sta_mac" | awk '{print $1}' | head -n1)

      # If station is in blocked_macs, enforce quarantine
      if grep -qi "$sta_mac" /etc/secmynet-agent/blocked_macs 2>/dev/null; then
        apply_quarantine "$sta_mac" "$sta_ip"
        continue
      fi

      if ! grep -qi "$sta_mac" /etc/secmynet-agent/allowed_macs 2>/dev/null; then
        apply_quarantine "$sta_mac" "$sta_ip"
      fi
    done
  done
}

main() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  init_firewall
  setup_captive_portal
  unquarantine_wired_devices
  while true; do
    enforce_active_quarantines
    post_telemetry || true
    poll_commands || true
    sleep "$INTERVAL"
  done
}

if [ "$1" = "--init" ]; then
  init_firewall
  setup_captive_portal
  exit 0
fi

if [ "$1" = "--quarantine" ]; then
  apply_quarantine "$2" "$3"
  exit 0
fi

if [ "$1" = "--allow" ]; then
  apply_allow "$2" "$3"
  exit 0
fi

if [ "$1" = "--once" ]; then
  init_firewall
  enforce_active_quarantines
  post_telemetry
  poll_commands
  exit $?
fi

if [ "$1" = "--event" ]; then
  # Instant trigger from OpenWrt hotplug (e.g., DHCP lease or hostapd association)
  log "Hotplug event received: $2 $3 $4"
  evt_mac="$3"
  evt_ip="$4"
  evt_host="$5"
  # FIXED: Only bypass for EXPLICITLY known wired clients — never invert wireless check!
  if [ -n "$evt_mac" ] && is_wired_client "$evt_mac"; then
    log "Event received for wired Ethernet client: $evt_mac. Ensuring unquarantined and bypassing agent."
    apply_allow "$evt_mac" "$evt_ip"
    exit 0
  fi
  # For ALL other devices (wireless or unknown), enforce quarantine and notify server.
  # Remove from allowed_macs so every connection session starts fresh in quarantine!
  if [ -n "$evt_mac" ]; then
    sed -i "/$evt_mac/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true
    apply_quarantine "$evt_mac" "$evt_ip"
  fi
  post_telemetry "$evt_mac" "$evt_ip" "$evt_host"
  poll_commands
  exit $?
fi

main


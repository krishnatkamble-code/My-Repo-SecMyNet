#!/bin/sh
# SecMyNet OpenWrt Agent
# Collects station info and telemetry, enforces Zero-Trust NAC quarantine, and posts to SecMyNet server

if [ -f /etc/secmynet-agent.conf ]; then
  . /etc/secmynet-agent.conf
elif [ -f /etc/secmynet-agent/agent.conf ]; then
  . /etc/secmynet-agent/agent.conf
fi

SERVER_URL=${SERVER_URL:-${SECMYNET_URL:-http://192.168.1.144:3000}}
SERVER_URL="$(printf '%s' "${SERVER_URL%/}" | tr -d '\r\n ')"
ROUTER_ID=${ROUTER_ID:-${SECMYNET_ROUTER_ID:-558971}}
ROUTER_ID="$(printf '%s' "$ROUTER_ID" | tr -d '\r\n ')"
TOKEN_FILE=${TOKEN_FILE:-/etc/secmynet-agent/token}
STATE_FILE=${STATE_FILE:-/var/run/secmynet-agent/state.json}
LOG_FILE=${LOG_FILE:-/var/log/secmynet-agent.log}
INTERVAL=${INTERVAL:-3}

log() {
  echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') $*" >> "$LOG_FILE"
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
    nft add rule inet secmynet prerouting_nat ip daddr != 192.168.1.1 ether saddr @quarantined_macs tcp dport 80 redirect to 8080 2>/dev/null || true
    nft add rule inet secmynet prerouting_nat ip daddr != 192.168.1.1 ip saddr @quarantined_ips tcp dport 80 redirect to 8080 2>/dev/null || true

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

  # 2. iptables support (OpenWrt 21.02 and older, fw3)
  if command -v iptables >/dev/null 2>&1; then
    iptables -N SECMYNET_QUARANTINE 2>/dev/null || true
    iptables -F SECMYNET_QUARANTINE 2>/dev/null || true
    iptables -A SECMYNET_QUARANTINE -p udp --dport 67 -j ACCEPT 2>/dev/null || true
    iptables -A SECMYNET_QUARANTINE -p udp --dport 68 -j ACCEPT 2>/dev/null || true
    iptables -A SECMYNET_QUARANTINE -p udp --dport 53 -j ACCEPT 2>/dev/null || true
    iptables -A SECMYNET_QUARANTINE -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
    iptables -A SECMYNET_QUARANTINE -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    iptables -A SECMYNET_QUARANTINE -j DROP 2>/dev/null || true
    iptables -C FORWARD -j SECMYNET_QUARANTINE 2>/dev/null || iptables -I FORWARD 1 -j SECMYNET_QUARANTINE 2>/dev/null || true

    iptables -t nat -N SECMYNET_REDIRECT 2>/dev/null || true
    iptables -t nat -F SECMYNET_REDIRECT 2>/dev/null || true
    iptables -t nat -C PREROUTING -j SECMYNET_REDIRECT 2>/dev/null || iptables -t nat -I PREROUTING 1 -j SECMYNET_REDIRECT 2>/dev/null || true
    log "Initialized iptables SECMYNET_QUARANTINE chains."
  fi

  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -N SECMYNET_QUARANTINE6 2>/dev/null || true
    ip6tables -F SECMYNET_QUARANTINE6 2>/dev/null || true
    ip6tables -A SECMYNET_QUARANTINE6 -p udp --dport 53 -j ACCEPT 2>/dev/null || true
    ip6tables -A SECMYNET_QUARANTINE6 -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
    ip6tables -A SECMYNET_QUARANTINE6 -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    ip6tables -A SECMYNET_QUARANTINE6 -j DROP 2>/dev/null || true
    ip6tables -C FORWARD -j SECMYNET_QUARANTINE6 2>/dev/null || ip6tables -I FORWARD 1 -j SECMYNET_QUARANTINE6 2>/dev/null || true
  fi
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

  if [ -z "$ip" ]; then
    ip=$(grep -i "$mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3 | head -n1)
    [ -z "$ip" ] && ip=$(awk -v m="$mac" 'tolower($4)==tolower(m) {print $1; exit}' /proc/net/arp 2>/dev/null)
    [ -z "$ip" ] && ip=$(ip -4 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}' | head -n1)
  fi

  # NEVER quarantine SecMyNet server or management PC or router!
  if [ "$ip" = "192.168.1.144" ] || [ "$ip" = "192.168.1.1" ] || [ "$ip" = "127.0.0.1" ]; then
    log "Skipping quarantine for management/server host: $mac ($ip)"
    return
  fi
  if grep -qi "$mac" /etc/secmynet-agent/whitelisted_macs 2>/dev/null; then
    return
  fi

  mkdir -p /etc/secmynet-agent
  grep -qi "$mac" /etc/secmynet-agent/quarantined_macs 2>/dev/null || echo "$mac" >> /etc/secmynet-agent/quarantined_macs
  sed -i "/$mac/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true

  # 1. LINUX KERNEL POLICY ROUTING BLACKHOLE (100% unbypassable kernel WAN drop)
  # Local router subnet (e.g. 192.168.1.0/24) stays reachable; WAN default is blackholed!
  lan_subnet=$(ip -4 addr show br-lan 2>/dev/null | awk '/inet / {print $2}' | head -n1)
  [ -z "$lan_subnet" ] && lan_subnet="192.168.1.0/24"
  ip route flush table 99 2>/dev/null || true
  ip route add "$lan_subnet" dev br-lan table 99 2>/dev/null || true
  ip route add blackhole default table 99 2>/dev/null || true

  if [ -n "$ip" ]; then
    ip rule del from "$ip" table 99 2>/dev/null || true
    ip rule add from "$ip" table 99 priority 1 2>/dev/null || true
  fi

  # IPv6 policy routing blackhole
  ip -6 route flush table 99 2>/dev/null || true
  ip -6 route add blackhole default table 99 2>/dev/null || true
  for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}'); do
    [ -n "$ip6" ] && ip -6 rule del from "$ip6" table 99 2>/dev/null || true
    [ -n "$ip6" ] && ip -6 rule add from "$ip6" table 99 priority 1 2>/dev/null || true
  done

  # 2. OpenWrt Native fw4 injection (if fw4 exists)
  if command -v nft >/dev/null 2>&1; then
    nft insert rule inet fw4 forward ether saddr "$mac" counter drop 2>/dev/null || true
    [ -n "$ip" ] && nft insert rule inet fw4 forward ip saddr "$ip" counter drop 2>/dev/null || true
    nft insert rule inet fw4 dstnat ip daddr != 192.168.1.1 ether saddr "$mac" tcp dport 80 redirect to 8080 2>/dev/null || true
    [ -n "$ip" ] && nft insert rule inet fw4 dstnat ip daddr != 192.168.1.1 ip saddr "$ip" tcp dport 80 redirect to 8080 2>/dev/null || true

    # Layer 2 Bridge table (OpenWrt L2 filter)
    nft add table bridge secmynet_br 2>/dev/null || true
    nft add set bridge secmynet_br quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
    nft add element bridge secmynet_br quarantined_macs "{ $mac }" 2>/dev/null || true

    # Layer 2 Netdev Ingress table
    nft add table netdev secmynet_l2 2>/dev/null || true
    nft add set netdev secmynet_l2 quarantined_macs '{ type ether_addr; }' 2>/dev/null || true
    nft add element netdev secmynet_l2 quarantined_macs "{ $mac }" 2>/dev/null || true

    # Standalone table inet secmynet (clean set syntax without flags interval)
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

  # 3. iptables & ip6tables (Dual-stack drop)
  if command -v iptables >/dev/null 2>&1; then
    iptables -I FORWARD 1 -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    [ -n "$ip" ] && iptables -I FORWARD 1 -s "$ip" -j DROP 2>/dev/null || true
    iptables -t mangle -I PREROUTING 1 -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    [ -n "$ip" ] && iptables -t mangle -I PREROUTING 1 -s "$ip" -j DROP 2>/dev/null || true
    iptables -t nat -I PREROUTING 1 -m mac --mac-source "$mac" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
    [ -n "$ip" ] && iptables -t nat -I PREROUTING 1 -s "$ip" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
  fi

  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -I FORWARD 1 -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    ip6tables -t mangle -I PREROUTING 1 -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
  fi

  # 4. Flush conntrack sockets so existing active connections die instantly
  if command -v conntrack >/dev/null 2>&1; then
    [ -n "$ip" ] && conntrack -D -s "$ip" 2>/dev/null || true
    [ -n "$ip" ] && conntrack -D -d "$ip" 2>/dev/null || true
    for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}'); do
      [ -n "$ip6" ] && conntrack -D -s "$ip6" 2>/dev/null || true
      [ -n "$ip6" ] && conntrack -D -d "$ip6" 2>/dev/null || true
    done
  fi
  ip route flush cache 2>/dev/null || true

  log "Strict Zero-Trust Quarantine Enforced: $mac ($ip) - WAN forwarding blocked via Kernel Policy Routing, fw4, nftables, iptables"
}

apply_allow() {
  mac="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  ip="$2"
  [ -z "$mac" ] && return

  if [ -z "$ip" ]; then
    ip=$(grep -i "$mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3 | head -n1)
    [ -z "$ip" ] && ip=$(ip -4 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}' | head -n1)
  fi

  mkdir -p /etc/secmynet-agent
  sed -i "/$mac/d" /etc/secmynet-agent/quarantined_macs 2>/dev/null || true
  sed -i "/$mac/d" /etc/secmynet-agent/blocked_macs 2>/dev/null || true
  grep -qi "$mac" /etc/secmynet-agent/allowed_macs 2>/dev/null || echo "$mac" >> /etc/secmynet-agent/allowed_macs

  # 1. Remove Linux Kernel Policy Routing blackholes
  if [ -n "$ip" ]; then
    ip rule del from "$ip" table 99 2>/dev/null || true
  fi
  for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}'); do
    [ -n "$ip6" ] && ip -6 rule del from "$ip6" table 99 2>/dev/null || true
  done

  # 2. Remove nftables rules
  if command -v nft >/dev/null 2>&1; then
    nft delete element bridge secmynet_br quarantined_macs "{ $mac }" 2>/dev/null || true
    nft delete element netdev secmynet_l2 quarantined_macs "{ $mac }" 2>/dev/null || true
    nft delete element inet secmynet quarantined_macs "{ $mac }" 2>/dev/null || true
    [ -n "$ip" ] && nft delete element inet secmynet quarantined_ips "{ $ip }" 2>/dev/null || true
    for ip6 in $(ip -6 neigh show 2>/dev/null | grep -i "$mac" | awk '{print $1}'); do
      [ -n "$ip6" ] && nft delete element inet secmynet quarantined_ip6s "{ $ip6 }" 2>/dev/null || true
    done
    if [ -f /tmp/hosts/odhcpd ]; then
      for ip6 in $(grep -i "$mac" /tmp/hosts/odhcpd 2>/dev/null | awk '{print $1}'); do
        [ -n "$ip6" ] && nft delete element inet secmynet quarantined_ip6s "{ $ip6 }" 2>/dev/null || true
      done
    fi
    # Flush injected fw4 rules and restore standard fw4
    /etc/init.d/firewall reload 2>/dev/null || true
  fi

  # 3. Remove iptables & ip6tables rules
  if command -v iptables >/dev/null 2>&1; then
    iptables -D FORWARD -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    [ -n "$ip" ] && iptables -D FORWARD -s "$ip" -j DROP 2>/dev/null || true
    iptables -t mangle -D PREROUTING -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    [ -n "$ip" ] && iptables -t mangle -D PREROUTING -s "$ip" -j DROP 2>/dev/null || true
    iptables -t nat -D PREROUTING -m mac --mac-source "$mac" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
    [ -n "$ip" ] && iptables -t nat -D PREROUTING -s "$ip" -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null || true
  fi

  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -D FORWARD -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
    ip6tables -t mangle -D PREROUTING -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
  fi

  log "Quarantine Released: $mac ($ip) - WAN internet access granted by owner"
}

collect_clients() {
  tmp="/tmp/stations.$$"
  rm -f "$tmp"
  touch "$tmp"

  for iface in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
    iw dev "$iface" station dump 2>/dev/null >> "$tmp"
  done

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
          ip=$(grep -i "$cur_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3)
          [ -z "$ip" ] && ip=$(ip neigh 2>/dev/null | grep -i "$cur_mac" | cut -d' ' -f1)
          host=$(grep -i "$cur_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f4)
          [ "$first" = "0" ] && clients="$clients,"
          first=0
          clients="${clients}{\"mac\":\"$cur_mac\",\"ip\":\"${ip:-}\",\"hostname\":\"${host:-}\",\"rx_bytes\":${rx:-0},\"tx_bytes\":${tx:-0},\"signal\":${sig:-null}}"
          seen_macs="${seen_macs}${cur_mac} "
        fi
        cur_mac="$w2"
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
    ip=$(grep -i "$cur_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3)
    [ -z "$ip" ] && ip=$(ip neigh 2>/dev/null | grep -i "$cur_mac" | cut -d' ' -f1)
    host=$(grep -i "$cur_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f4)
    [ "$first" = "0" ] && clients="$clients,"
    first=0
    clients="${clients}{\"mac\":\"$cur_mac\",\"ip\":\"${ip:-}\",\"hostname\":\"${host:-}\",\"rx_bytes\":${rx:-0},\"tx_bytes\":${tx:-0},\"signal\":${sig:-null}}"
    seen_macs="${seen_macs}${cur_mac} "
  fi

  # Also inspect /tmp/dhcp.leases for recently leased clients (e.g., mobile phones)
  if [ -f /tmp/dhcp.leases ]; then
    while read -r l_ts l_mac l_ip l_host rest; do
      [ -z "$l_mac" ] && continue
      [ "$l_ip" = "192.168.1.144" ] || [ "$l_ip" = "192.168.1.1" ] && continue
      case "$(printf '%s' "$l_host" | tr '[:upper:]' '[:lower:]')" in
        *nhitm*|*admin*|*server*) continue ;;
      esac
      case "$seen_macs" in
        *" $l_mac "*) continue ;;
      esac
      is_active=$(grep -i "$l_mac" /proc/net/arp 2>/dev/null | grep -v '0x0')
      if [ -n "$is_active" ] || ip neigh 2>/dev/null | grep -qi "$l_mac"; then
        [ "$first" = "0" ] && clients="$clients,"
        first=0
        clients="${clients}{\"mac\":\"$l_mac\",\"ip\":\"${l_ip:-}\",\"hostname\":\"${l_host:-}\",\"rx_bytes\":0,\"tx_bytes\":0,\"signal\":null}"
        seen_macs="${seen_macs}${l_mac} "
      fi
    done < /tmp/dhcp.leases
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

  clients=$(collect_clients 2>/dev/null)
  [ -z "$clients" ] && clients="[]"
  payload="{\"clients\":$clients,\"usage\":[]}"

  res=$(curl -s -w "HTTPSTATUS:%{http_code}" -X POST "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/telemetry" \
    -H "Content-Type: application/json" \
    -H "x-secmynet-agent-token: $token" \
    -d "$payload" --max-time 15)

  http_code=$(echo "$res" | tr -d '\r' | sed -n 's/.*HTTPSTATUS:\([0-9][0-9][0-9]\)$/\1/p')
  body=$(echo "$res" | sed -e 's/HTTPSTATUS:.*//g')

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    count=$(echo "$clients" | grep -o '{"mac"' | wc -l)
    log "Telemetry posted successfully: $count clients"
    return 0
  else
    log "Telemetry post failed: code=$http_code body=$body"
    return 1
  fi
}

poll_commands() {
  token="$(read_token)"
  [ -z "$ROUTER_ID" ] && return 1

  res=$(curl -s -X GET "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands" \
    -H "x-secmynet-agent-token: $token" --max-time 15)
  [ -z "$res" ] && return 1

  commands=$(echo "$res" | jq -c '.commands[]?' 2>/dev/null)
  for cmd in $commands; do
    id=$(echo "$cmd" | jq -r '.id' 2>/dev/null)
    type=$(echo "$cmd" | jq -r '.command_type' 2>/dev/null)
    payload=$(echo "$cmd" | jq -r '.payload_json' 2>/dev/null)

    case "$type" in
      disconnect)
        mac=$(echo "$payload" | jq -r '.mac' 2>/dev/null)
        sed -i "/$mac/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true
        for iface in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
          iw dev "$iface" station del "$mac" 2>/dev/null || hostapd_cli -i "$iface" deauthenticate "$mac" 2>/dev/null || true
        done
        ;;
      block)
        mac=$(echo "$payload" | jq -r '.mac // .MAC' 2>/dev/null)
        ip=$(echo "$payload" | jq -r '.ip // .IP' 2>/dev/null)
        [ "$ip" = "null" ] && ip=""
        [ "$mac" = "null" ] && mac=""
        mac="$(printf '%s' "$mac" | tr '[:upper:]' '[:lower:]')"
        mkdir -p /etc/secmynet-agent
        echo "$mac" >> /etc/secmynet-agent/blocked_macs
        sed -i "/$mac/d" /etc/secmynet-agent/allowed_macs 2>/dev/null || true
        # Strictly enforce firewall and kernel policy routing quarantine
        apply_quarantine "$mac" "$ip"
        # Deauthenticate station from wifi interfaces without bouncing radio (avoids resetting firewall rules)
        for iface in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
          iw dev "$iface" station del "$mac" 2>/dev/null || hostapd_cli -i "$iface" deauthenticate "$mac" 2>/dev/null || true
        done
        log "Client $mac blocked and quarantined by owner."
        ;;
      quarantine)
        mac=$(echo "$payload" | jq -r '.mac' 2>/dev/null)
        ip=$(echo "$payload" | jq -r '.ip' 2>/dev/null)
        apply_quarantine "$mac" "$ip"
        ;;
      allow)
        mac=$(echo "$payload" | jq -r '.mac' 2>/dev/null)
        ip=$(echo "$payload" | jq -r '.ip' 2>/dev/null)
        apply_allow "$mac" "$ip"
        ;;
      restart)
        wifi reload 2>/dev/null || reboot 2>/dev/null || true
        ;;
      set_wifi_password)
        key=$(echo "$payload" | jq -r '.key' 2>/dev/null)
        enc=$(echo "$payload" | jq -r '.encryption // "psk2"' 2>/dev/null)
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

    curl -s -X POST "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands/$id/complete" \
      -H "x-secmynet-agent-token: $token" \
      -H "Content-Type: application/json" \
      -d '{"success":true}' --max-time 10 >/dev/null 2>&1 || true
  done
}

enforce_active_quarantines() {
  tmp_sta="/tmp/secmynet_stations.$$"
  rm -f "$tmp_sta"
  touch "$tmp_sta"

  # 1. From wireless interfaces (iw dev)
  for iface in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
    iw dev "$iface" station dump 2>/dev/null | awk '/Station/ {print $2}' >> "$tmp_sta"
  done

  # 2. From iwinfo (Broadcom, Atheros, MediaTek, generic OpenWrt)
  if command -v iwinfo >/dev/null 2>&1; then
    for iface in $(iwinfo 2>/dev/null | awk '/ESSID/ {print $1}'); do
      iwinfo "$iface" assoclist 2>/dev/null | awk '/^[0-9a-fA-F:]/ {print $1}' >> "$tmp_sta"
    done
  fi

  # 3. From hostapd_cli
  for ctrl in $(ls -d /var/run/hostapd/* 2>/dev/null); do
    if [ -S "$ctrl" ]; then
      hostapd_cli -p /var/run/hostapd -i "$(basename "$ctrl")" all_sta 2>/dev/null | grep -E '^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$' >> "$tmp_sta"
    fi
  done

  # 4. From /tmp/dhcp.leases (EVERY LEASED CLIENT, INCLUDING SLEEPING PHONES)
  if [ -f /tmp/dhcp.leases ]; then
    awk '{print $2}' /tmp/dhcp.leases 2>/dev/null >> "$tmp_sta"
  fi

  # 5. From /proc/net/arp (ACTIVE IP/MAC NEIGHBORS)
  if [ -f /proc/net/arp ]; then
    awk '$4 != "00:00:00:00:00:00" && $4 ~ /^[0-9a-fA-F:]/ {print $4}' /proc/net/arp 2>/dev/null >> "$tmp_sta"
  fi

  seen_sta=" "
  for raw_mac in $(cat "$tmp_sta" 2>/dev/null); do
    sta_mac="$(printf '%s' "$raw_mac" | tr '[:upper:]' '[:lower:]')"
    [ -z "$sta_mac" ] && continue
    case "$seen_sta" in
      *" $sta_mac "*) continue ;;
    esac
    seen_sta="${seen_sta}${sta_mac} "

    sta_ip=$(grep -i "$sta_mac" /tmp/dhcp.leases 2>/dev/null | cut -d' ' -f3 | head -n1)
    [ -z "$sta_ip" ] && sta_ip=$(awk -v m="$sta_mac" 'tolower($4)==tolower(m) {print $1; exit}' /proc/net/arp 2>/dev/null)
    [ -z "$sta_ip" ] && sta_ip=$(ip -4 neigh show 2>/dev/null | grep -i "$sta_mac" | awk '{print $1}' | head -n1)

    # If station is in blocked_macs, immediately enforce quarantine and deauthenticate
    if grep -qi "$sta_mac" /etc/secmynet-agent/blocked_macs 2>/dev/null; then
      apply_quarantine "$sta_mac" "$sta_ip"
      for iface in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
        iw dev "$iface" station del "$sta_mac" 2>/dev/null || hostapd_cli -i "$iface" deauthenticate "$sta_mac" 2>/dev/null || true
      done
      continue
    fi

    # If station is NOT approved by owner, enforce quarantine!
    if ! grep -qi "$sta_mac" /etc/secmynet-agent/allowed_macs 2>/dev/null; then
      apply_quarantine "$sta_mac" "$sta_ip"
    fi
  done

  rm -f "$tmp_sta"
}

main() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  init_firewall
  setup_captive_portal
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
  # Instant trigger from OpenWrt dnsmasq or hotplug (e.g., DHCP lease)
  evt_action="$2"
  evt_mac="$3"
  evt_ip="$4"
  # If called with: --event <MAC> <IP> (without action)
  if echo "$evt_action" | grep -qE '^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$'; then
    evt_mac="$2"
    evt_ip="$3"
    evt_action="add"
  fi
  log "Event received: action=$evt_action mac=$evt_mac ip=$evt_ip"
  if [ -n "$evt_mac" ] && ! grep -qi "$evt_mac" /etc/secmynet-agent/allowed_macs 2>/dev/null; then
    apply_quarantine "$evt_mac" "$evt_ip"
  fi
  post_telemetry
  poll_commands
  exit $?
fi

main


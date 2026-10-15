#!/bin/sh
# SecMyNet OpenWrt Agent
# Collects station info and telemetry and posts to SecMyNet server

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
INTERVAL=${INTERVAL:-5}

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
    echo "Telemetry posted successfully: $count clients"
    return 0
  else
    log "Telemetry post failed: code=$http_code body=$body"
    echo "Telemetry post failed: code=$http_code body=$body"
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
        for iface in $(iw dev 2>/dev/null | sed -n 's/.*Interface //p'); do
          iw dev "$iface" station del "$mac" 2>/dev/null || hostapd_cli -i "$iface" deauthenticate "$mac" 2>/dev/null || true
        done
        ;;
      block)
        mac=$(echo "$payload" | jq -r '.mac' 2>/dev/null)
        mkdir -p /etc/secmynet-agent
        echo "$mac" >> /etc/secmynet-agent/blocked_macs
        if command -v uci >/dev/null 2>&1; then
          for ifname in $(uci show wireless | grep "\.maclist" | sed -E "s/.*\['?(.*)'?\].*/\\1/" | cut -d '.' -f1); do
            uci add_list wireless.@wifi-iface[0].maclist="$mac" 2>/dev/null || true
          done
          uci commit wireless 2>/dev/null || true
          wifi reload 2>/dev/null || true
        fi
        ;;
      quarantine)
        mac=$(echo "$payload" | jq -r '.mac' 2>/dev/null)
        mkdir -p /etc/secmynet-agent
        [ -n "$mac" ] && echo "$mac" >> /etc/secmynet-agent/quarantined_macs
        # Apply nftables/iptables quarantine rule to drop forwarding to WAN
        if command -v nft >/dev/null 2>&1 && [ -n "$mac" ]; then
          nft add element inet fw4 secmynet_quarantine "{ $mac }" 2>/dev/null || true
        fi
        if command -v iptables >/dev/null 2>&1 && [ -n "$mac" ]; then
          iptables -I FORWARD -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
        fi
        log "Quarantined client: $mac"
        ;;
      allow)
        mac=$(echo "$payload" | jq -r '.mac' 2>/dev/null)
        sed -i "/$mac/d" /etc/secmynet-agent/quarantined_macs 2>/dev/null || true
        sed -i "/$mac/d" /etc/secmynet-agent/blocked_macs 2>/dev/null || true
        if command -v nft >/dev/null 2>&1 && [ -n "$mac" ]; then
          nft delete element inet fw4 secmynet_quarantine "{ $mac }" 2>/dev/null || true
        fi
        if command -v iptables >/dev/null 2>&1 && [ -n "$mac" ]; then
          iptables -D FORWARD -m mac --mac-source "$mac" -j DROP 2>/dev/null || true
        fi
        if command -v uci >/dev/null 2>&1; then
          uci del_list wireless.@wifi-iface[0].maclist="$mac" 2>/dev/null || true
          uci commit wireless 2>/dev/null || true
          wifi reload 2>/dev/null || true
        fi
        log "Released from quarantine and allowed: $mac"
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

main() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  while true; do
    post_telemetry || true
    poll_commands || true
    sleep "$INTERVAL"
  done
}

if [ "$1" = "--once" ]; then
  post_telemetry
  poll_commands
  exit $?
fi

if [ "$1" = "--event" ]; then
  # Instant trigger from OpenWrt hotplug (e.g., DHCP lease or hostapd association)
  log "Hotplug event received: $2 $3 $4"
  post_telemetry
  poll_commands
  exit $?
fi

main

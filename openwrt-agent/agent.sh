#!/bin/sh
# Simple OpenWrt agent for SecMyNet
# - Collects station info via `iw`/`iwinfo`/`hostapd_cli` where available
# - Posts telemetry to SecMyNet server and polls for commands
# - Minimal, best-effort implementation intended for OpenWrt builds

# Configuration (can be overridden via environment)
SERVER_URL=${SERVER_URL:-http://localhost:3000}
ROUTER_ID=${ROUTER_ID:-}
TOKEN_FILE=${TOKEN_FILE:-/etc/secmynet-agent/token}
STATE_FILE=${STATE_FILE:-/var/run/secmynet-agent/state.json}
LOG_FILE=${LOG_FILE:-/var/log/secmynet-agent.log}
INTERVAL=${INTERVAL:-60} # seconds between telemetry posts

# Helpers
log() {
  echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') $*" >> "$LOG_FILE"
}

read_token() {
  if [ -n "$ROUTER_ID" ] && [ -f "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE" 2>/dev/null
  else
    echo ""
  fi
}

# Discover wireless interfaces using `iw` output
list_wlan_ifaces() {
  iw dev 2>/dev/null | awk '/Interface/ {print $2}'
}

# Collect clients for a single interface using `iw` station dump
collect_clients_for_iface() {
  iface="$1"
  out="$(iw dev "$iface" station dump 2>/dev/null)"
  if [ -z "$out" ]; then
    # fallback to iwinfo assoclist which gives MAC list
    iwinfo "$iface" assoclist 2>/dev/null | awk '{print $1}' | while read -r mac; do
      echo "{"$"\"mac\":\"$mac\"""}
    done
    return
  fi

  # Parse station dump blocks
  echo "$out" | awk -v RS="\n\n" 'NF{print $0"\n"RS}' | while IFS= read -r block; do
    mac=""
    rx=0
    tx=0
    signal=null
    hostname=null
    echo "$block" | while IFS= read -r line; do
      case "$line" in
        Station*)
          mac=$(echo "$line" | awk '{print $2}') ;;
        *"rx bytes:"*)
          rx=$(echo "$line" | awk -F":" '{gsub(/ /,"",$2); print $2}');;
        *"tx bytes:"*)
          tx=$(echo "$line" | awk -F":" '{gsub(/ /,"",$2); print $2}');;
        *signal:*)
          signal=$(echo "$line" | awk '{print $2}');;
      esac
    done
    # Try to resolve IP via ip neigh
    ip_addr=$(ip neigh | grep -i "$mac" | awk '{print $1}' | head -n1)
    # Emit JSON line
    printf '%s\n' "{\"mac\":\"${mac}\",\"ip\":\"${ip_addr}\",\"rx_bytes\":${rx},\"tx_bytes\":${tx},\"signal\":${signal}}"
  done
}

collect_clients() {
  tmpfile="/tmp/secmynet-clients-$$.json"
  echo "[]" > "$tmpfile"
  for iface in $(list_wlan_ifaces); do
    collect_clients_for_iface "$iface" 2>/dev/null | jq -s '.[ ]' 2>/dev/null | jq -s '.[0]' >/dev/null 2>&1 || true
    # build array by merging
    for line in $(collect_clients_for_iface "$iface" 2>/dev/null | sed 's/"/\\\"/g'); do
      # avoid using complex quoting in POSIX shell — use jq to merge
      :
    done
  done

  # Simpler: build clients array by calling collect for each iface and using jq to merge
  clients_json="[]"
  for iface in $(list_wlan_ifaces); do
    data=$(collect_clients_for_iface "$iface" | jq -s '.')
    clients_json=$(jq -n --argjson a "$clients_json" --argjson b "$data" '$a + $b')
  done
  echo "$clients_json"
}

post_telemetry() {
  token="$(read_token)"
  if [ -z "$ROUTER_ID" ] || [ -z "$token" ]; then
    log "Missing ROUTER_ID or token; cannot post telemetry"
    return 1
  fi

  clients=$(collect_clients 2>/dev/null)
  totals=$(jq -n '{rx_bytes: (reduce .[] as $c (0; . + ($c.rx_bytes // 0)), tx_bytes: (reduce .[] as $c (0; . + ($c.tx_bytes // 0)))}' <<< "$clients")
  payload=$(jq -n --argjson clients "$clients" --argjson totals "$totals" --arg ts "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" '{interfaces: [], clients: $clients, totals: $totals, timestamp: $ts}')

  res=$(curl -s -w "HTTPSTATUS:%{http_code}" -X POST "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/telemetry" -H "Content-Type: application/json" -H "x-secmynet-agent-token: $token" -d "$payload" --max-time 15)
  http_code=$(echo "$res" | tr -d '\r' | sed -n 's/.*HTTPSTATUS:\([0-9][0-9][0-9]\)$/\1/p')
  body=$(echo "$res" | sed -e 's/HTTPSTATUS:.*//g')
  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    log "Telemetry posted successfully: clients=$(echo "$clients" | jq 'length')"
    return 0
  else
    log "Telemetry post failed: code=$http_code body=$body"
    return 1
  fi
}

# Poll for commands and attempt to execute them
poll_commands() {
  token="$(read_token)"
  [ -z "$ROUTER_ID" ] && return 1
  res=$(curl -s -X GET "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands" -H "x-secmynet-agent-token: $token" --max-time 15)
  if [ -z "$res" ]; then return 1; fi
  commands=$(echo "$res" | jq -c '.commands[]?')
  for cmd in $commands; do
    id=$(echo "$cmd" | jq -r '.id')
    type=$(echo "$cmd" | jq -r '.command_type')
    payload=$(echo "$cmd" | jq -r '.payload_json')

    case "$type" in
      disconnect)
        mac=$(echo "$payload" | jq -r '.mac')
        # try to remove station from all wlan ifaces
        for iface in $(list_wlan_ifaces); do
          iw dev "$iface" station del "$mac" 2>/dev/null || hostapd_cli -i "$iface" deauthenticate "$mac" 2>/dev/null || true
        done
        ;;
      block)
        mac=$(echo "$payload" | jq -r '.mac')
        mkdir -p /etc/secmynet-agent
        echo "$mac" >> /etc/secmynet-agent/blocked_macs
        # try to add to wireless maclist if UCI available
        if command -v uci >/dev/null 2>&1; then
          for ifname in $(uci show wireless | grep "\.maclist" | sed -E "s/.*\['?(.*)'?\].*/\\1/" | cut -d '.' -f1); do
            uci add_list wireless.@wifi-iface[0].maclist="$mac" 2>/dev/null || true
          done
          uci commit wireless 2>/dev/null || true
          wifi reload 2>/dev/null || true
        fi
        ;;
      allow)
        mac=$(echo "$payload" | jq -r '.mac')
        # remove from blocked_macs
        sed -i "/$mac/d" /etc/secmynet-agent/blocked_macs 2>/dev/null || true
        if command -v uci >/dev/null 2>&1; then
          uci del_list wireless.@wifi-iface[0].maclist="$mac" 2>/dev/null || true
          uci commit wireless 2>/dev/null || true
          wifi reload 2>/dev/null || true
        fi
        ;;
      restart)
        # restart wifi only
        wifi reload 2>/dev/null || reboot 2>/dev/null || true
        ;;
      *)
        log "Unknown command type: $type"
        ;;
    esac

    # Notify server command completed (best-effort, mark as success)
    curl -s -X POST "$SERVER_URL/api/openwrt/routers/$ROUTER_ID/commands/$id/complete" -H "x-secmynet-agent-token: $token" -H "Content-Type: application/json" -d '{"success":true}' --max-time 10 >/dev/null 2>&1 || true
  done
}

# Main loop
main() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  while true; do
    post_telemetry || true
    poll_commands || true
    sleep "$INTERVAL"
  done
}

# If run directly, start main
if [ "$(basename "$0")" = "agent.sh" ]; then
  main
fi

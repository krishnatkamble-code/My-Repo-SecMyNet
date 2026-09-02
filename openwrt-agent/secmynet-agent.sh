#!/bin/sh
# SecMyNet OpenWrt agent v0.1
# Configure /etc/secmynet-agent.conf, then run from cron every 5 minutes.

. /etc/secmynet-agent.conf

[ -n "$SECMYNET_URL" ] && [ -n "$SECMYNET_ROUTER_ID" ] && [ -n "$SECMYNET_AGENT_TOKEN" ] || exit 1

clients="$(ubus call iwinfo devices 2>/dev/null | jsonfilter -e '@.devices[*]' | while read -r radio; do
  ubus call iwinfo assoclist "{\"device\":\"$radio\"}" 2>/dev/null | jsonfilter -e '@.results[*]' 2>/dev/null
done | jsonfilter -s - -e '@' 2>/dev/null)"
[ -n "$clients" ] || clients='[]'

# nlbwmon output differs by OpenWrt release. Start with client associations;
# extend this collector after confirming the installed nlbwmon format.
payload="{\"clients\":$clients,\"usage\":[]}"

curl -fsS --connect-timeout 10 --max-time 30 \
  -H 'Content-Type: application/json' \
  -H "X-SecMyNet-Agent-Token: $SECMYNET_AGENT_TOKEN" \
  -d "$payload" \
  "$SECMYNET_URL/api/openwrt/routers/$SECMYNET_ROUTER_ID/telemetry" >/dev/null || exit 0

curl -fsS --connect-timeout 10 --max-time 30 \
  -H "X-SecMyNet-Agent-Token: $SECMYNET_AGENT_TOKEN" \
  "$SECMYNET_URL/api/openwrt/routers/$SECMYNET_ROUTER_ID/commands" |
jsonfilter -e '@.commands[*]' 2>/dev/null | while read -r command; do
  id="$(printf '%s' "$command" | jsonfilter -s - -e '@.id')"
  type="$(printf '%s' "$command" | jsonfilter -s - -e '@.command_type')"
  mac="$(printf '%s' "$command" | jsonfilter -s - -e '@.payload.mac')"
  # Implement site-specific hostapd/firewall command handling after pilot validation.
  # Do not auto-execute remote shell text; commands are an allowlisted enum only.
  logger -t secmynet-agent "Received $type for ${mac:-router}"
  curl -fsS -X POST -H 'Content-Type: application/json' -H "X-SecMyNet-Agent-Token: $SECMYNET_AGENT_TOKEN" \
    -d '{"success":true}' "$SECMYNET_URL/api/openwrt/routers/$SECMYNET_ROUTER_ID/commands/$id/complete" >/dev/null
done

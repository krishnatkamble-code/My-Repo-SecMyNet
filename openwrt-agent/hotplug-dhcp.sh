#!/bin/sh
# /etc/hotplug.d/dhcp/99-secmynet
# Hotplug DHCP trigger for SecMyNet zero-trust quarantine

ACTION="${1:-$ACTION}"
MAC="${2:-$MACADDR}"
IP="${3:-$IPADDR}"
HOST="${4:-$HOSTNAME}"

[ -z "$MAC" ] && exit 0
MAC="$(printf '%s' "$MAC" | tr '[:upper:]' '[:lower:]')"

if [ -f /etc/secmynet-agent/dhcp-script.sh ]; then
  exec /bin/sh /etc/secmynet-agent/dhcp-script.sh "$ACTION" "$MAC" "$IP" "$HOST"
fi

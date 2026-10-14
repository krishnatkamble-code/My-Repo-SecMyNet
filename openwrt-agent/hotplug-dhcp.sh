#!/bin/sh
# /etc/hotplug.d/dhcp/99-secmynet
# Instantly triggers SecMyNet agent when any device requests or renews a DHCP lease on OpenWrt

[ "$ACTION" = "add" ] || [ "$ACTION" = "update" ] || exit 0

MAC="$MACADDR"
IP="$IPADDR"
HOST="$HOSTNAME"

logger -t secmynet-hotplug "DHCP lease event: $ACTION for $MAC ($IP, $HOST)"

# Invoke SecMyNet agent in background with event trigger
if [ -x /usr/bin/secmynet-agent ]; then
  /usr/bin/secmynet-agent --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
elif [ -f /root/agent.sh ]; then
  /bin/sh /root/agent.sh --event "$ACTION" "$MAC" "$IP" "$HOST" >/dev/null 2>&1 &
fi

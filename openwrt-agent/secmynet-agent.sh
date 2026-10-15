#!/bin/sh
# SecMyNet OpenWrt agent wrapper
# Calls the full NAC quarantine agent

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$DIR/agent.sh" ]; then
  exec /bin/sh "$DIR/agent.sh" "$@"
elif [ -f /etc/secmynet-agent/agent.sh ]; then
  exec /bin/sh /etc/secmynet-agent/agent.sh "$@"
elif [ -f /root/agent.sh ]; then
  exec /bin/sh /root/agent.sh "$@"
else
  logger -t secmynet-agent "Error: agent.sh not found."
  exit 1
fi

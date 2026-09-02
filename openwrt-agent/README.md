# SecMyNet OpenWrt agent pilot

This is an outbound-only integration starter for OpenWrt. It reports associated Wi-Fi clients and polls a small allowlisted command queue. It does not expose LuCI, SSH, ubus, or router credentials to the public internet.

## Router prerequisites

- Official supported OpenWrt release, with sufficient free storage/RAM.
- `curl`, `jsonfilter`, `rpcd-mod-iwinfo`, and `iwinfo` installed.
- Use `luci-app-nlbwmon`/`nlbwmon` for per-MAC historical usage; its output format must be validated on the router before enabling production usage reporting.
- An outbound HTTPS route to SecMyNet, ideally over WireGuard.

## Install for pilot

```sh
opkg update
opkg install curl jsonfilter rpcd-mod-iwinfo iwinfo nlbwmon luci-app-nlbwmon
scp secmynet-agent.sh root@ROUTER:/usr/bin/secmynet-agent
scp secmynet-agent.conf.example root@ROUTER:/etc/secmynet-agent.conf
chmod 700 /usr/bin/secmynet-agent
chmod 600 /etc/secmynet-agent.conf
```

Fill in `/etc/secmynet-agent.conf` from the portal's one-time onboarding token. Test manually with `/usr/bin/secmynet-agent`, then add a cron entry such as `*/5 * * * * /usr/bin/secmynet-agent`.

## Security

Do not expose the agent route without TLS. Do not expose OpenWrt's SSH, LuCI, or ubus HTTP service to the internet. The current pilot receives only fixed command types; it never executes arbitrary remote shell commands.

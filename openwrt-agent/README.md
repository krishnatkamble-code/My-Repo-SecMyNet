# SecMyNet OpenWrt Zero-Trust NAC Agent

This agent enforces strict Zero-Trust Network Access Control (NAC) on OpenWrt routers.
Any client (new or returning) who connects using Wi-Fi credentials is kept in **strict quarantine**:
- **Zero Internet (WAN) Access**: All WAN forwarding is dropped by nftables/iptables until approved by the owner.
- **Client Notification via Captive Portal**: When the client connects, their device automatically receives a network notification: **"Sign in to network"** / **"Action required on Wi-Fi"** which displays:
  > **"Service Approval pending from owner of the Router"**
  with a live status checker that unlocks WAN traffic the exact moment the owner approves.
- **Mandatory 45s Hold & 5m Timeout**: Approval is locked for at least 45s, and if no approval arrives within 5 minutes, the client is automatically disallowed.

---

## 1. Quick One-Step Installation on Router

From your PC (with router reachable at `192.168.1.1`):

```sh
# Copy agent files to OpenWrt router
scp openwrt-agent/* root@192.168.1.1:/tmp/

# SSH into router and run installer
ssh root@192.168.1.1
cd /tmp
sh install-agent.sh
```

The installer automatically:
1. Configures `/etc/secmynet-agent/agent.sh` and `/etc/secmynet-agent/holding.html`.
2. Installs `/etc/hotplug.d/dhcp/99-secmynet` for **zero-latency local quarantine** the millisecond DHCP assigns an IP.
3. Sets up `table inet secmynet` in nftables (priority -10, blocking WAN forwarding).
4. Configures OpenWrt `uhttpd` on port 8080 to serve the holding page when clients probe for internet connectivity.
5. Starts `secmynet-agent` as a background procd daemon.

---

## 2. Router Configuration (`/etc/secmynet-agent.conf`)

Ensure `/etc/secmynet-agent.conf` has your router credentials:

```sh
SECMYNET_URL="https://my-repo-sec-my-net.vercel.app"
SECMYNET_ROUTER_ID="931354"
SECMYNET_AGENT_TOKEN="xMhPB3WAq2_Ys-BOeBdjFqSf27Z2xAtksJj-KXkD0zE"
```

---

## 3. How the Client Device Notification Works

1. **Association**: The client inputs the Wi-Fi password and connects.
2. **Instant Quarantine**: In 5 milliseconds, `/etc/hotplug.d/dhcp/99-secmynet` blocks WAN forwarding and flushes conntrack sockets. The client cannot reach the internet.
3. **Captive Probe Redirection**: The smartphone's OS (Android, OneUI, MIUI, iOS) sends an HTTP probe (`generate_204` / `hotspot-detect.html`).
4. **Phone Notification**: The router redirects port 80 to port 8080, triggering the phone's native prompt:
   - System notification: **"Sign in to Wi-Fi network"**
   - Screen displays: **"🛡️ Service Approval Pending from Owner of the Router"**
5. **Live Polling**: The page polls `/api/client/status`. Once the owner clicks "Allow Access" in the dashboard, the page turns green:
   - **"✅ Access Approved by Owner! You are now connected to the Internet."**
   - Captive screen dismisses and internet traffic is fully unlocked.

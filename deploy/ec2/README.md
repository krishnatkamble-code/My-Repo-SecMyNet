# AWS EC2 deployment

This profile targets an Ubuntu AWS EC2 `t3.medium` running Node.js 20+, PostgreSQL, and InfluxDB v2.7. FCM delivery is performed by the Node.js process through Firebase Admin SDK.

## Server setup

1. Provision the instance in a private subnet where possible. Allow inbound TCP 3000 only from the reverse proxy or the test device network. Keep PostgreSQL 5432 and InfluxDB 8086 private to the instance/VPC.
2. Install Node.js 20+, Docker, and Docker Compose, then create the service account:

```bash
sudo useradd --system --home /opt/secmynet --shell /usr/sbin/nologin secmynet
sudo mkdir -p /opt/secmynet /etc/secmynet
sudo chown -R secmynet:secmynet /opt/secmynet
```

3. Copy the repository to `/opt/secmynet`, run `npm ci`, and run PostgreSQL plus InfluxDB 2.7. Create the `router-telemetry` bucket and copy `secmynet.env.example` to `/etc/secmynet/secmynet.env`.
4. Create a Firebase service account in Firebase Console, enable Cloud Messaging, and copy its JSON to `/etc/secmynet/firebase-service-account.json` with mode `600`. Set the matching path in the env file.
5. Install and start the service:

```bash
sudo cp deploy/ec2/secmynet.service /etc/systemd/system/secmynet.service
sudo systemctl daemon-reload
sudo systemctl enable --now secmynet
sudo systemctl status secmynet
```

Check `http://127.0.0.1:3000/api/health` from the instance before putting the API behind HTTPS.

## InfluxDB measurement

OpenWrt telemetry is retained in PostgreSQL and also written to the `router_client_usage` measurement when all four Influx settings are present. Tags are `router_id`, `client_mac`, `ip`, and `hostname`; fields include `rx_bytes`, `tx_bytes`, `delta_rx`, and `delta_tx`.

## Android 14 cellular test

Set the Android remote flavor to the public HTTPS endpoint, not the EC2 private address:

```properties
API_BASE_URL_REMOTE=https://api.example.com
```

Build and install the Android 14 package:

```bash
cd android-app
gradlew.bat :app:assembleRemoteDebug
adb install -r app/build/outputs/apk/remoteDebug/app-remote-debug.apk
```

Use mobile data with Wi-Fi disabled on the test device. Register the FCM token after login through `POST /api/me/push-token`; connection requests then reach admin devices through FCM even when the phone is outside the EC2 network. Use HTTPS and a valid certificate because Android cellular testing must not rely on cleartext HTTP.

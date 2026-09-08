# SecMyNet Portal MVP

This project contains a web portal and an Android app skeleton for managing WiFi device access and usage.

## Features

- User registration and login
- Admin login with seeded account
- Add locations
- Add WiFi devices
- Allow or deny user access to a device
- Disconnect connected users
- Track MB data usage per active connection
- Browser-based admin dashboard

## Default admin

- Email: admin@secmynet.com
- Password: Admin@123

## Super Admin

The first server start seeds a separate Super Admin account. It can create admins,
review each admin's devices and locations, add or delete users, and block admin
portal access.

- Email: superadmin@secmynet.com
- Password: SuperAdmin@123

Change this password immediately in a production deployment.

## Run locally

1. Install dependencies
   ```bash
   npm install
   ```
2. Copy the Postgres deployment settings
   ```bash
   copy .env.example .env
   ```
3. Start the API
   ```bash
   npm start
   ```
4. Open the web portal at
   ```text
   http://localhost:3000
   ```

## Run with dummy PostgreSQL (Windows)

If you have Docker Desktop installed on Windows, use the `run-dev.ps1` helper script:

```powershell
cd "C:\Users\NHITM-ADMIN\Desktop\Project M.tech\SecMyNet"
.\run-dev.ps1
```

Or use the npm script for Android emulator development:

```powershell
cd "C:\Users\NHITM-ADMIN\Desktop\Project M.tech\SecMyNet"
npm run dev:android
```

This will:
- start the `postgres:16-alpine` container from `docker-compose.yml`
- create `.env` from `.env.example` if missing
- install npm dependencies
- launch the backend

For Android emulator testing, use the `local` flavor in Android Studio or the `localDebug` build variant. The app will connect to the host machine via `10.0.2.2:3000`.

If Docker is not installed, install Docker Desktop first or use the SQLite fallback with `npm start`.

## Production Postgres deployment

Use a hosted PostgreSQL service by copying the production environment template and updating the managed database values.

For Azure App Service deployment steps, see [azure-app-service/README.md](azure-app-service/README.md).

## AWS EC2, InfluxDB, and FCM deployment

The backend supports an AWS EC2 deployment profile for a `t3.medium`. It keeps PostgreSQL as the relational store, writes OpenWrt client telemetry to InfluxDB v2.7 when configured, and delivers connection/quarantine notifications with Firebase Cloud Messaging. Follow [deploy/ec2/README.md](deploy/ec2/README.md) for the systemd service, environment variables, and Android 14 cellular test procedure.

FCM is optional for local development. Set `FIREBASE_SERVICE_ACCOUNT_PATH` or
`FIREBASE_SERVICE_ACCOUNT_JSON` in production. InfluxDB is enabled only when
`INFLUXDB_URL`, `INFLUXDB_TOKEN`, `INFLUXDB_ORG`, and `INFLUXDB_BUCKET` are all set.

## Remote server deployment

To run the backend on another computer as a dedicated server:

1. Copy or clone the repository onto the remote server machine.
2. Install Node.js 20+ and npm on that machine.
3. Create a `.env` file inside the project root on the server. Example:
   ```env
   PORT=3000
   JWT_SECRET=replace-with-a-long-secret
   DATABASE_URL=postgres://secmynet:secmynet@localhost:5432/secmynet
   NODE_ENV=production
   ```
4. Install dependencies:
   ```bash
   npm install
   ```
5. Start the backend server:
   ```bash
   npm start
   ```
6. Open your server firewall or network settings so the chosen port is reachable from your other devices. Use the server IP or DNS address for web and mobile access.

### Android app configuration for a remote backend

- This project now supports Android build flavors for local and remote servers.
- Open `android-app/gradle.properties` and update `API_BASE_URL_REMOTE` to your server address, for example:
  ```properties
  API_BASE_URL_REMOTE=http://192.168.1.100:3000
  ```
- Build the local flavor for emulator development:
  ```bash
  ./gradlew :app:assembleLocalDebug
  ```
- Build the remote flavor for a real server:
  ```bash
  ./gradlew :app:assembleRemoteDebug
  ```
- In Android Studio, select the `localDebug` or `remoteDebug` variant to switch between backend targets.

### Notes

- The website UI served by the backend uses relative API routes, so if the frontend is loaded from the same server host, it will work automatically.
- The server now listens on `0.0.0.0` so external machines can connect to it.

### Azure Database for PostgreSQL

1. Copy the Azure production env template
   ```bash
   copy .env.production.example .env.production
   ```
2. Replace the Azure placeholders with your real Flexible Server details.
3. Start the API with the production environment loaded.
   ```bash
   set NODE_ENV=production
   npm start
   ```

Example Azure connection pattern:
```env
DATABASE_URL=postgresql://secmynet@your-server.postgres.database.azure.com:5432/secmynet?sslmode=require
```

The backend now resolves a managed Postgres URL from either `DATABASE_URL` directly or the explicit Azure variables:
- `AZURE_POSTGRES_HOST`
- `AZURE_POSTGRES_PORT`
- `AZURE_POSTGRES_DB`
- `AZURE_POSTGRES_USER`
- `AZURE_POSTGRES_PASSWORD`
- `AZURE_POSTGRES_SSLMODE`

## API endpoints

- `POST /api/register`
- `POST /api/login`
- `GET /api/dashboard`
- `POST /api/locations`
- `POST /api/devices`
- `POST /api/devices/:deviceId/allow-user`
- `POST /api/devices/:deviceId/disallow-user`
- `POST /api/devices/:deviceId/disconnect-user`
- `POST /api/connections/request`
- `POST /api/connections/:connectionId/usage`

## Project structure

```text
server.js                 Express API and web portal server
db.js                     PostgreSQL/SQLite database access
static/                   Browser portal files
android-app/              Android client and build flavors
database/postgres/        PostgreSQL initialization scripts
deploy/ec2/               AWS EC2 systemd deployment files
azure-app-service/        Azure App Service startup files
openwrt-agent/            OpenWrt router telemetry agent
tests/                    Node.js API tests
```

## Requirements

- Node.js 20 or newer and npm
- Git
- Docker Desktop for local PostgreSQL development, if desired
- Android Studio and Android SDK for Android builds
- A PostgreSQL database for production
- A domain name and HTTPS certificate for public access

Check the installed versions:

```bash
node --version
npm --version
git --version
```

## Clone and run the project

Clone the repository on a new computer:

```bash
git clone https://github.com/krishnatkamble-code/My-Repo-SecMyNet.git
cd My-Repo-SecMyNet
npm ci
```

Create the local environment file. On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

On Linux or macOS:

```bash
cp .env.example .env
```

Start the portal:

```bash
npm start
```

Open `http://localhost:3000` in a browser. The health check is available at
`http://localhost:3000/api/health`.

Run the automated tests with:

```bash
npm test
```

## Local PostgreSQL with Docker

Docker Desktop must be running. Start the database and API together on Windows:

```powershell
.\run-dev.ps1
```

Or start the database first and then the API:

```bash
npm run db:up
npm start
```

Stop and remove the development database container with:

```bash
npm run db:down
```

The SQLite fallback can be used for a quick local test when PostgreSQL is not
available. Do not use the fallback as the production database.

## Environment variables

Copy `.env.example` for local development and set production values outside
the repository. At minimum, production should define:

```env
NODE_ENV=production
PORT=3000
SERVER_HOST=0.0.0.0
JWT_SECRET=replace-with-a-long-random-secret
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
```

Optional Firebase Cloud Messaging settings:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=/etc/secmynet/firebase-service-account.json
```

Optional InfluxDB settings are enabled only when all four values are present:

```env
INFLUXDB_URL=http://127.0.0.1:8086
INFLUXDB_TOKEN=replace-with-influx-token
INFLUXDB_ORG=secmynet
INFLUXDB_BUCKET=router-telemetry
```

Never commit `.env`, Firebase JSON keys, passwords, private keys, or SSH
`.pem` files. Rotate any credential that was accidentally published.

## Publish with AWS EC2

The supported EC2 profile uses Ubuntu, Node.js 20+, PostgreSQL, and optional
InfluxDB. The detailed deployment files are in [deploy/ec2/README.md](deploy/ec2/README.md).

### 1. Create the instance

In AWS EC2, create an Ubuntu instance and save its key-pair `.pem` file. A
`t3.medium` is the documented starting size. Configure the security group as
follows:

| Port | Source | Purpose |
| --- | --- | --- |
| 22 | Your IP only | SSH administration |
| 80 | Anywhere | HTTP redirect to HTTPS |
| 443 | Anywhere | Public portal and API |
| 3000 | Private/test network only | Direct Node.js access, if needed |
| 5432 | Private only | PostgreSQL |
| 8086 | Private only | InfluxDB |

Do not expose PostgreSQL or InfluxDB to the public internet.

### 2. Connect over SSH

From Windows PowerShell, use the public IPv4 address from the EC2 console:

```powershell
ssh -i "C:\path\to\secmynet.pem" ubuntu@EC2_PUBLIC_IP
```

For Amazon Linux, use `ec2-user` instead of `ubuntu`.

### 3. Install the application

Run these commands on the EC2 instance:

```bash
sudo apt update
sudo apt install -y git nginx docker.io docker-compose-plugin
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

sudo useradd --system --home /opt/secmynet --shell /usr/sbin/nologin secmynet || true
sudo mkdir -p /opt/secmynet /etc/secmynet
sudo chown -R secmynet:secmynet /opt/secmynet

sudo git clone https://github.com/krishnatkamble-code/My-Repo-SecMyNet.git /opt/secmynet
cd /opt/secmynet
sudo -u secmynet npm ci --omit=dev
```

Create the production environment file:

```bash
sudo nano /etc/secmynet/secmynet.env
sudo chmod 600 /etc/secmynet/secmynet.env
```

Use real production values; do not copy the example secret unchanged.

### 4. Start Node.js with systemd

Install the included service:

```bash
cd /opt/secmynet
sudo cp deploy/ec2/secmynet.service /etc/systemd/system/secmynet.service
sudo systemctl daemon-reload
sudo systemctl enable --now secmynet
sudo systemctl status secmynet
```

Verify the application locally on the server:

```bash
curl http://127.0.0.1:3000/api/health
sudo journalctl -u secmynet -f
```

### 5. Add HTTPS with Nginx

Point a DNS record such as `portal.example.com` to the EC2 Elastic IP. Then
configure Nginx to proxy HTTPS traffic to Node.js on port 3000. Install a
certificate with Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d portal.example.com
sudo systemctl reload nginx
```

The public portal URL is then:

```text
https://portal.example.com
```

Use HTTPS for every real device and mobile test. Do not use the EC2 private IP
in the Android remote configuration.

## Azure App Service

Azure deployment instructions are in [azure-app-service/README.md](azure-app-service/README.md).
The required settings are Node 20 LTS, HTTPS-only, a production `JWT_SECRET`,
and either `DATABASE_URL` or the explicit Azure PostgreSQL variables. Keep
`package-lock.json` so Azure can install the exact dependency tree.

After deployment, open the App Service URL and verify:

```text
https://YOUR_APP_NAME.azurewebsites.net/api/health
```

## Android remote build

Set the public HTTPS backend URL in `android-app/gradle.properties`:

```properties
API_BASE_URL_REMOTE=https://portal.example.com
```

Build the remote variant from the `android-app` directory:

```powershell
cd android-app
.\gradlew.bat :app:assembleRemoteDebug
```

The APK is generated under:

```text
android-app/app/build/outputs/apk/remoteDebug/
```

For an Android emulator using the local computer, use the local flavor and
`10.0.2.2:3000`. For cellular testing, disable Wi-Fi and use the public HTTPS
URL.

## Git workflow

Review changes before publishing them:

```bash
git status
git diff
```

Commit and push application changes:

```bash
git add .
git commit -m "Describe the change"
git push origin main
```

Do not use `git add .` without checking for secrets and machine-specific files
such as `local.properties`.

## Troubleshooting

### The portal is not reachable externally

Check that the Node service is running, the EC2 security group allows the
required port, the server firewall allows Nginx, and DNS points to the correct
Elastic IP. Prefer checking HTTPS through Nginx rather than exposing port 3000.

### The service repeatedly stops

Inspect the logs and environment file:

```bash
sudo systemctl status secmynet
sudo journalctl -u secmynet -n 100 --no-pager
sudo systemctl cat secmynet
```

### Database connection errors

Confirm `DATABASE_URL`, PostgreSQL availability, credentials, firewall rules,
and SSL requirements for managed PostgreSQL. Never place database passwords in
source files.

### Android cannot connect

Confirm that `API_BASE_URL_REMOTE` uses the public HTTPS hostname, the
certificate is valid, the backend health endpoint responds, and the APK was
built from the `remoteDebug` or release flavor.

## Production checklist

- Replace the seeded admin and super-admin passwords.
- Generate a long random `JWT_SECRET`.
- Use managed or private PostgreSQL with backups enabled.
- Keep Firebase keys, database credentials, and SSH keys outside Git.
- Use HTTPS and redirect HTTP to HTTPS.
- Restrict SSH to your own IP address.
- Keep ports 5432 and 8086 private.
- Test `/api/health`, login, device access, and Android connectivity.
- Configure monitoring, log rotation, and database backups.

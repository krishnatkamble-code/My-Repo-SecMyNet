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

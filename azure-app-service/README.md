# Azure App Service deployment

This folder contains the App Service startup configuration for deploying the SecMyNet Node API to Azure App Service.

## App Service settings

In the Azure Portal, configure the following:

- Runtime stack: Node 20 LTS
- Startup command: `bash azure-app-service/startup.sh`
- HTTPS only: enabled
- App settings:
  - `NODE_ENV=production`
  - `PORT=8080`
  - `JWT_SECRET=<your-long-secret>`
  - `DATABASE_URL=postgresql://<user>@<server>.postgres.database.azure.com:5432/<db>?sslmode=require`
  - `AZURE_POSTGRES_HOST=<server>.postgres.database.azure.com`
  - `AZURE_POSTGRES_PORT=5432`
  - `AZURE_POSTGRES_DB=<db-name>`
  - `AZURE_POSTGRES_USER=<user>`
  - `AZURE_POSTGRES_PASSWORD=<password>`
  - `AZURE_POSTGRES_SSLMODE=require`

## Deployment flow

1. Create a new Azure App Service on Linux.
2. Set the runtime stack to Node 20 LTS.
3. Set the startup command to `bash azure-app-service/startup.sh`.
4. Set the environment variables listed above.
5. Deploy the repository zip or use a GitHub Action with Oryx.
6. Restart the App Service after the first deploy.

## Notes

- The app will use the SQLite fallback locally.
- In Azure, set `DATABASE_URL` or the Azure Postgres app settings so the app uses PostgreSQL.
- If the App Service uses the Node build process automatically, keep `package-lock.json` in the repo.

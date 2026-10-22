@echo off
chcp 65001 >nul
cd /d "%~dp0services\api"
set "DATABASE_URL=postgres://atelier:atelier_local_only@127.0.0.1:5432/atelier"
set "REDIS_URL=redis://:atelier_local_redis@127.0.0.1:6379"
set "BIND_ADDRESS=127.0.0.1:8080"
set "PUBLIC_BASE_URL=http://127.0.0.1:5173"
echo M1 Google login and TOTP. Configure real server-side OAuth credentials first.
for %%K in (GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET MASTER_KEY BOOTSTRAP_ADMIN_EMAILS) do (
  if not defined %%K (
    echo Missing required environment variable: %%K
    exit /b 1
  )
)
echo Start PostgreSQL and Redis separately: docker compose -f ..\..\infra\compose.yaml up -d
cargo run -p atelier-app
pause

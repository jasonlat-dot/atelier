@echo off
chcp 65001 >nul
cd /d "%~dp0services\api"
set "DATABASE_URL=postgres://atelier:atelier_local_only@127.0.0.1:5432/atelier"
set "DEV_AUTH=true"
set "BIND_ADDRESS=127.0.0.1:8080"
echo Please start Docker PostgreSQL first:
echo docker compose -f infra\compose.yaml up -d
echo DEV_AUTH is LOCAL DEVELOPMENT ONLY. Do NOT publish this server.
cargo run
pause

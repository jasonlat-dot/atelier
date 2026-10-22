@echo off
chcp 65001 >nul
cd /d "%~dp0services\api"
set "DATABASE_URL=postgres://atelier:atelier_local_only@127.0.0.1:5432/atelier"
set "REDIS_URL=redis://:atelier_local_redis@127.0.0.1:6379"
set "BIND_ADDRESS=127.0.0.1:8080"
echo M0 foundation only. Authentication arrives in M1.
echo Start PostgreSQL and Redis separately: docker compose -f infra\compose.yaml up -d
cargo run -p atelier-app
pause

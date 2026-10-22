@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Configure services\api\.env with server-side OAuth credentials before starting.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\api.ps1 -Action run
pause

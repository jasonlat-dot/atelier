@echo off
chcp 65001 >nul
cd /d "%~dp0apps\web"
if not exist ".env" copy ".env.example" ".env" >nul
if not exist "node_modules" (
  echo [Atelier] First launch: installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed. Please check npm network access.
    pause
    exit /b 1
  )
)
echo [Atelier] Open http://127.0.0.1:5173
call npm run dev
pause

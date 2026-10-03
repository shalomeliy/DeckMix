@echo off
rem One double-click: bring the app up to date from main and start it on port 5173.
rem Port 5173 on purpose, and --strictPort: the browser keeps the owner's tags per address (port included), so a server that
rem quietly moved to 5174 would open an empty library. If 5173 is busy this stops and says so instead.
cd /d "%~dp0.."
git checkout main
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo Could not update from main. Nothing was started. Send this window to Claude.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
start "" cmd /c "timeout /t 6 >nul & start http://localhost:5173/"
call npm run dev -- --port 5173 --strictPort
echo.
echo The server stopped. If it says port 5173 is in use, close the other window that runs "npm run dev" and double-click again.
pause

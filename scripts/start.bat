@echo off
rem One double-click: bring the app up to date from main, build it, and start it on port 5173.
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
rem v0.9.58: the finished (built) app, not the development server. Measured 07/10 with 16 of the owner's songs analysing while a
rem deck played: the development server's extra React checks and unbundled files left 17 waveform frames over 50 ms in a minute,
rem the built app 1. Same address and port, so the library, tags and settings are the same ones.
call npx vite build
if errorlevel 1 (
  echo.
  echo The app could not be built. Nothing was started. Send this window to Claude.
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 4 >nul & start http://localhost:5173/"
call npx vite preview --port 5173 --strictPort
echo.
echo The server stopped. If it says port 5173 is in use, close the other window that runs the app and double-click again.
pause

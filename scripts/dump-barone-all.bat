@echo off
rem v0.9.72 experiment: dump features for every song whose "1" Shalom marked, so a learned "1" finder can be tested.
rem Close the DeckMix window (start.bat) first: this needs port 5173 for the development server.
cd /d "%~dp0.."
git checkout main
git pull --ff-only origin main
if errorlevel 1 (
  echo Could not update from main. Send this window to Claude.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
start "DeckMix dev server - close me when done" cmd /c "npx vite --port 5173 --strictPort"
timeout /t 10 >nul
node scripts\dump-barone-all.mjs
if errorlevel 1 (
  echo The measurement stopped with an error. Send this window to Claude.
  pause
  exit /b 1
)
explorer /select,"%TEMP%\barone-all.json"
echo.
echo Done. Send the file barone-all.json (the folder just opened) to Claude, then close the dev server window.
pause

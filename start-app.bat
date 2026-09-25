@echo off
cd /d "%~dp0"

echo Stopping any existing backend (3006) / frontend (3005) processes...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\restart-servers.ps1" -Mode stop

echo Starting backend on port 3006...
start "Backend (3006)" cmd /k "node server\server.js"

echo Starting frontend on port 3005...
start "Frontend (3005)" cmd /k "set PORT=3005 && npx react-scripts start"

echo Waiting for both servers to come up...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\restart-servers.ps1" -Mode wait-up

echo Done. Backend and Frontend are running in their own windows.

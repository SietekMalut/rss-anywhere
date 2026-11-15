@echo off
setlocal
cd /d "%~dp0"
title RSS Anywhere - lokal

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js belum terpasang.
  echo   Install dulu dari https://nodejs.org  ^(pilih versi LTS^).
  echo.
  pause
  exit /b 1
)

echo.
echo   Menyalakan server lokal di http://localhost:8787 ...
echo   Tutup jendela ini (atau Ctrl+C) untuk berhenti.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8787/'"

node src/server.js
if errorlevel 1 (
  echo.
  echo   Server berhenti dengan error. Baca pesan di atas.
  echo.
  pause
)
endlocal

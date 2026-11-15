@echo off
setlocal
cd /d "%~dp0"
title RSS Anywhere - deploy Cloudflare Workers

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js belum terpasang. Install dulu dari https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   Deploy ke Cloudflare Workers ^(paket gratis, batas CPU 10 ms/request^).
echo   Kalau sering kena "Error 1102", pakai deploy-vercel.cmd.
echo.
echo   Browser akan terbuka untuk login Cloudflare sekali saja.
echo.
pause

echo.
echo   [1/2] npm install ^(wrangler^) ...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo   npm install gagal.
  pause
  exit /b 1
)

echo.
echo   [2/2] wrangler deploy ...
call npx wrangler deploy
if errorlevel 1 (
  echo.
  echo   Deploy gagal. Kalau belum login, jalankan: npx wrangler login
  echo.
  pause
  exit /b 1
)

echo.
echo   Selesai. URL workers.dev muncul di atas.
echo.
pause
endlocal

@echo off
setlocal
cd /d "%~dp0"
title RSS Anywhere - deploy Vercel

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js belum terpasang. Install dulu dari https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   Deploy ke Vercel ^(paket gratis^).
echo.
echo   1. Browser akan terbuka untuk login - pakai GitHub / Google / email.
echo   2. Kalau ditanya "Link to existing project?" jawab N.
echo   3. Project name: rss-anywhere ^(atau nama lain yang belum dipakai^).
echo   4. Setelah selesai, URL produksi muncul di bawah.
echo.
pause

call npx --yes vercel@latest deploy --prod
if errorlevel 1 (
  echo.
  echo   Deploy gagal. Cek pesan di atas, lalu coba lagi.
  echo   Alternatif manual: npx vercel login  ^&^&  npx vercel deploy --prod
  echo.
  pause
  exit /b 1
)

echo.
echo   Selesai. Buka URL di atas, lalu tambahkan /healthz untuk memastikan hidup.
echo.
pause
endlocal

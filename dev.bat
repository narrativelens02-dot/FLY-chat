@echo off
title FLYchat Dev Server
echo.
echo  =========================================
echo   FLYchat ^^ Dev Server
echo   http://localhost:3000
echo  =========================================
echo.

REM Kill semua proses di port 3000 (Node.js maupun lainnya)
echo Membersihkan port 3000...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000 "') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

REM Jalankan server
echo Menjalankan server...
echo.
node server\index.js

@echo off
title FLYchat Dev Server
echo.
echo  =========================================
echo   FLYchat ^^ Dev Server
echo   http://localhost:3000
echo  =========================================
echo.

REM Kill proses lama di port 3000 jika ada
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)

REM Jalankan server
node server\index.js

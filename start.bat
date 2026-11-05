@echo off
title File Online Manager - DEBUG

echo.
echo ============================================
echo   STEP 1: Current directory
echo ============================================
cd /d "%~dp0"
echo   CD: %CD%
echo.

echo ============================================
echo   STEP 2: Who am I (admin check)
echo ============================================
whoami /groups | findstr /C:"S-1-16-12288" >nul
if %errorlevel% equ 0 (
    echo   [OK] Running as ADMIN
) else (
    echo   [WARN] NOT admin - port 80 may fail
)
echo.

echo ============================================
echo   STEP 3: Where is node?
echo ============================================
where node
if errorlevel 1 (
    echo   [ERROR] node NOT FOUND in PATH
    echo   Try full path: "C:\Program Files\nodejs\node.exe"
) else (
    echo   [OK] node found
)
echo.

echo ============================================
echo   STEP 4: Node version
echo ============================================
node --version
echo.

echo ============================================
echo   STEP 5: Files in current dir
echo ============================================
dir /b server.js index.html .env package.json 2>nul
echo.

echo ============================================
echo   STEP 6: Killing old node
echo ============================================
taskkill /F /IM node.exe 2>nul
echo   Done
echo.

echo ============================================
echo   STEP 7: STARTING SERVER
echo ============================================
echo.
node server.js

echo.
echo ============================================
echo   SERVER STOPPED (exit code %errorlevel%)
echo ============================================
pause
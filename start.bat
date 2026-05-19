@echo off
chcp 65001 >nul
title ChatGPT Auto Login Pipeline

echo ==========================================
echo   ChatGPT Auto Login ^& Plus Activation
echo ==========================================
echo.

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found! Please install Node.js first.
    pause
    exit /b 1
)

:: Check node_modules
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    npm install
    echo.
)

:: Check config.json
if not exist "config.json" (
    echo [ERROR] config.json not found!
    echo [INFO] Copy config.example.json to config.json and fill in your values.
    copy config.example.json config.json >nul 2>&1
    echo [INFO] Template created. Please edit config.json first.
    pause
    exit /b 1
)

:: Check accounts.csv
if not exist "accounts.csv" (
    echo [ERROR] accounts.csv not found!
    echo [INFO] Copy accounts.example.csv to accounts.csv and add your accounts.
    copy accounts.example.csv accounts.csv >nul 2>&1
    echo [INFO] Template created. Please edit accounts.csv first.
    pause
    exit /b 1
)

:: Create output directories
if not exist "screenshots" mkdir screenshots
if not exist "sessions" mkdir sessions

:: Parse arguments
set START_ARG=
if not "%~1"=="" set START_ARG=--start %~1

echo [INFO] Starting pipeline...
echo.

node index.js %START_ARG%

echo.
echo ==========================================
echo   Done! Press any key to exit.
echo ==========================================
pause >nul

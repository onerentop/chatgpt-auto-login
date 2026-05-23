@echo off
chcp 65001 >nul
title ChatGPT Auto Login - Web Dashboard (v3.0.0)
cd /d "%~dp0"

echo ==========================================
echo   ChatGPT Auto Login ^& Plus Activation
echo   v3.0.0 Protocol Expansion + PayPal RPA
echo ==========================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found! Please install from https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js %%v

:: Check Python (for protocol mode + v3 HTTP modules)
where py >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Python not found - protocol mode will not work
    echo        Install from https://www.python.org/downloads/
) else (
    for /f "tokens=*" %%v in ('py -3 --version 2^>nul') do echo [OK] %%v
    py -3 -c "import curl_cffi" >nul 2>&1
    if %errorlevel% neq 0 (
        echo [WARN] curl_cffi not installed - required for protocol mode + v3 HTTP modules
        echo        Run: py -3 -m pip install curl_cffi
    ) else (
        echo [OK] curl_cffi installed
    )
)

:: Check Chrome (PipelineEngine fallback when protocolMode=false)
set CHROME_FOUND=0
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if %CHROME_FOUND%==0 (
    echo [WARN] Google Chrome not found - PipelineEngine ^(protocolMode=false^) needs it
)
if %CHROME_FOUND%==1 echo [OK] Chrome found

:: Install backend dependencies
if not exist "node_modules" (
    echo.
    echo [INFO] Installing backend dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
)

:: Check playwright-core Chromium ^(v3 PayPal RPA subprocess^)
set PW_CHROMIUM=%LOCALAPPDATA%\ms-playwright\chromium-1223
if not exist "%PW_CHROMIUM%" (
    echo.
    echo [INFO] playwright-core Chromium ^(v1223^) not found, downloading ^(~300MB, 1-3 min^)...
    call npx playwright install chromium
    if %errorlevel% neq 0 (
        echo [ERROR] playwright install failed - paypal_rpa.js will not work
        pause
        exit /b 1
    )
) else (
    echo [OK] playwright-core Chromium v1223 installed
)

:: Install and build frontend
if not exist "web\dist\index.html" (
    echo.
    echo [INFO] Building frontend...
    cd web
    if not exist "node_modules" (
        call npm install
    )
    call npm run build
    cd ..
    if not exist "web\dist\index.html" (
        echo [ERROR] Frontend build failed!
        pause
        exit /b 1
    )
)

:: Create output directory
if not exist "cpa-auth" mkdir cpa-auth

:: Create default config if missing
if not exist "config.json" (
    echo.
    echo [INFO] Creating default config.json...
    (
        echo {
        echo   "protocolMode": true,
        echo   "paymentLinkSource": "api",
        echo   "phoneSlots": [{"phone": "", "smsApiUrl": ""}],
        echo   "phone": "",
        echo   "smsApiUrl": "",
        echo   "enableOAuth": false,
        echo   "enableCPA": false,
        echo   "cpaUrl": "",
        echo   "cpaKey": "",
        echo   "discordToken": "",
        echo   "discordChannelId": "",
        echo   "discordMessageId": "",
        echo   "discordGuildId": "",
        echo   "discordAppId": "",
        echo   "proxy": {
        echo     "enabled": false,
        echo     "subscriptionUrl": "",
        echo     "regionFilter": "US",
        echo     "rotationStrategy": "sequential",
        echo     "jpCheckout": {
        echo       "enabled": true,
        echo       "keyword": "KDDI",
        echo       "whitelist": []
        echo     }
        echo   }
        echo }
    ) > config.json
    echo [INFO] Please configure via web dashboard after startup.
    echo        v3.0.0 requires proxy.subscriptionUrl + proxy.jpCheckout for the
    echo        protocol path ^(Phase 2 uses JP-KDDI to obtain $0 PayPal link^).
)

echo.
echo ==========================================
echo   Starting v3.0.0 server...
echo   Dashboard: http://localhost:3000
echo.
echo   Active engine:
echo     protocolMode=true  - 99%% HTTP + isolated PayPal RPA ^(v3 default^)
echo     protocolMode=false - Full Playwright Chrome ^(PipelineEngine^)
echo ==========================================
echo.

:: Open browser after 3 seconds
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"

:: Start server
node server/index.js

echo.
echo [INFO] Server stopped.
pause

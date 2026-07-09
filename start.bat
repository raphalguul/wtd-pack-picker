@echo off
title WTD Pack Picker
echo Starting WTD Pack Picker...
echo.
echo   npm run dev  -  run as browser app (needs Node.js)
echo   npm start    -  run as Electron app (needs Electron)
echo.
IF EXIST "node_modules\electron\dist\electron.exe" (
    echo Starting Electron...
    npx electron .
) ELSE (
    echo Electron not installed. Starting as browser app...
    start http://localhost:4500
    node server.js
)
pause

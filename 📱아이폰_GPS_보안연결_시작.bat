@echo off
title iPhone HTTPS Server
cls
echo ====================================================
echo iPhone Safari Real-time GPS Secure Tunnel
echo ====================================================
echo.
echo Starting secure HTTPS tunnel...
echo Please copy and open the https://...loca.lt URL in iPhone Safari!
echo.
echo ====================================================
echo.

npx localtunnel --port 8080

pause

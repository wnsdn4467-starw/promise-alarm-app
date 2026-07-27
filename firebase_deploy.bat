@echo off
cd /d "%~dp0"
echo === Firebase Login ===
call "C:\Users\A\AppData\Roaming\npm\firebase.cmd" login
echo.
echo === Setting Project ===
call "C:\Users\A\AppData\Roaming\npm\firebase.cmd" use promise-alarm-app
echo.
echo === Deploying (1-2 min) ===
call "C:\Users\A\AppData\Roaming\npm\firebase.cmd" deploy --only hosting
echo.
echo === DONE ===
pause

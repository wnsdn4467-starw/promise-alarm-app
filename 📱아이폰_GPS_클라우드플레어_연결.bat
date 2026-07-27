@echo off
chcp 65001 > nul
title iPhone Safari HTTPS Cloudflare Server

echo ====================================================
echo  아이폰 Safari 전용 보안 HTTPS 서버 시작 중...
echo ====================================================
echo.
echo  1. 로컬 웹 서버 확인 및 가동...
start /b node server.js > nul 2>&1

echo.
echo  2. 클라우드플레어 보안 터널 연결 중입니다.
echo     아래 출력되는 "https://...trycloudflare.com" 주소를
echo     아이폰 사파리 주소창에 복사해서 접속해 주세요!
echo.
echo ====================================================
echo.

npx --yes cloudflared tunnel --url http://localhost:8080

pause

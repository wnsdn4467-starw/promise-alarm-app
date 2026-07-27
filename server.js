const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8080;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

const server = http.createServer((req, res) => {
  let cleanUrl = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(PUBLIC_DIR, cleanUrl === '/' ? 'index.html' : cleanUrl);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  let ext = path.extname(filePath).toLowerCase();

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 Not Found</h1>');
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        return res.end(`Server Error: ${err.code}`);
      }

      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      res.end(content, 'utf-8');
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIpAddresses();
  console.log('\n====================================================');
  console.log('📱 세이피 (Safey) 모바일 서버 가동 완료!');
  console.log('====================================================');
  console.log('\n[ 1. 와이파이 연결 주소 (같은 Wi-Fi 접속 시) ]');
  if (localIps.length > 0) {
    localIps.forEach(ip => {
      console.log(`👉 http://${ip}:${PORT}`);
    });
  }
  console.log(`👉 http://localhost:${PORT}`);

  console.log('\n[ 2. 아이폰 Safari 접속 불가 해결 방법 ]');
  console.log('💡 사파리에서 "페이지를 열 수 없음" 에러가 뜨는 경우:');
  console.log('   ① 아이폰과 컴퓨터가 같은 Wi-Fi에 연결되어 있는지 확인하세요.');
  console.log('   ② LTE/5G 환경이거나 와이파이 차단 시, [ 📱아이폰_GPS_클라우드플레어_연결.bat ] 파일을 실행해 주세요!');
  console.log('      -> 발급되는 https://...trycloudflare.com 주소를 사파리에 입력하면 어디서든 접속됩니다.');
  console.log('====================================================\n');
});

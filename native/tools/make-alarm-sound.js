// 지각 알람용 사이렌 WAV 를 안드로이드 res/raw 에 생성한다.
// 실행: node tools/make-alarm-sound.js
const fs = require('fs');
const path = require('path');

const rate = 22050;
const dur = 8;                       // 알림 1회 재생 길이(초)
const total = Math.floor(rate * dur);
const buf = Buffer.alloc(44 + total * 2);

buf.write('RIFF', 0);
buf.writeUInt32LE(36 + total * 2, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);            // PCM
buf.writeUInt16LE(1, 22);            // mono
buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(total * 2, 40);

const sweep = 0.7;                   // 한 방향 스윕 시간(초)
let phase = 0;
for (let i = 0; i < total; i += 1) {
  const t = i / rate;
  const pos = (t % (sweep * 2)) / sweep;         // 0 → 2
  const k = pos <= 1 ? pos : 2 - pos;            // 0 → 1 → 0
  const freq = 560 + (1180 - 560) * k;
  phase += freq / rate;
  const saw = 2 * (phase % 1) - 1;
  const fade = Math.min(1, t / 0.01, (dur - t) / 0.01);
  const v = Math.max(-1, Math.min(1, saw * 0.95 * fade));
  buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
}

const out = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'raw', 'late_alarm.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
console.log('written', out, buf.length, 'bytes');

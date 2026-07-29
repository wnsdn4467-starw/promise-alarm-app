/**
 * 기프티콘 벌칙 백엔드
 *
 *  1) verifyGifticon      : 브랜드 + PIN 으로 실제 사용 여부를 조회한다. (실시간 조회 API / 크롤러)
 *  2) submitGifticonOriginal : 원본 이미지를 클라이언트가 읽을 수 없는 경로에 보관한다.
 *  3) revealGifticon      : 지각이 확인된 본인의 원본만 공개 노드로 옮긴다.
 *
 *  원본은 gifticon_private/{promiseId}/{uid} 에 저장되고 이 경로는 보안 규칙에서
 *  read/write 가 모두 false 다. (Admin SDK 인 함수만 접근 가능)
 */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

const REGION = 'asia-southeast1';

// ------------------------------------------------------------------
// 브랜드별 실시간 조회 제공자
//  - 공개된 무료 조회 API 가 있는 브랜드는 여기에 등록한다.
//  - 파트너 API(기프티쇼 등)는 환경변수로 키를 넣으면 활성화된다.
//    firebase functions:config 대신 런타임 환경변수를 쓴다:
//      GIFTISHOW_API_URL, GIFTISHOW_API_KEY, GIFTISHOW_USER_ID
//  - 일반 조회 웹훅(자체 크롤러 서버)을 쓰려면 GIFTICON_CHECK_URL 을 설정한다.
// ------------------------------------------------------------------
function normalizePin(pin) {
  return String(pin || '').replace(/[^0-9A-Za-z]/g, '');
}

function normalizeBrand(brand) {
  return String(brand || '').trim().toLowerCase();
}

/** 기프티쇼(파트너 API) 조회 */
async function checkGiftishow(pin) {
  const url = process.env.GIFTISHOW_API_URL;
  const key = process.env.GIFTISHOW_API_KEY;
  const userId = process.env.GIFTISHOW_USER_ID;
  if (!url || !key || !userId) return null;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_code: '0203', custom_auth_code: key, custom_auth_token: userId, pinNo: pin }),
  });
  if (!res.ok) throw new Error(`기프티쇼 조회 실패 (${res.status})`);
  const json = await res.json();
  // 기프티쇼 응답의 pinStatus: 01=미사용, 02=사용완료, 03=기간만료
  const status = String(((json.result || {}).pinStatus) || ((json.result || {}).status) || '');
  if (status === '01') return { status: 'unused', provider: 'giftishow' };
  if (status === '02') return { status: 'used', provider: 'giftishow' };
  if (status === '03') return { status: 'expired', provider: 'giftishow' };
  return { status: 'unknown', provider: 'giftishow', raw: status };
}

/** 자체 크롤러/조회 서버 웹훅 */
async function checkViaWebhook(brand, pin) {
  const url = process.env.GIFTICON_CHECK_URL;
  if (!url) return null;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.GIFTICON_CHECK_TOKEN ? { Authorization: `Bearer ${process.env.GIFTICON_CHECK_TOKEN}` } : {}),
    },
    body: JSON.stringify({ brand, pin }),
  });
  if (!res.ok) throw new Error(`조회 서버 오류 (${res.status})`);
  const json = await res.json();
  const status = String(json.status || '').toLowerCase();
  if (['unused', 'used', 'expired', 'unknown'].includes(status)) {
    return { status, provider: json.provider || 'webhook', message: json.message || '' };
  }
  return { status: 'unknown', provider: 'webhook' };
}

const PROVIDERS = [
  { name: 'giftishow', match: (brand) => /기프티쇼|giftishow|gs25|cu|스타벅스|starbucks|배스킨|baskin/.test(brand), run: checkGiftishow },
  { name: 'webhook', match: () => true, run: checkViaWebhook },
];

async function lookupPinStatus(brand, pin) {
  const b = normalizeBrand(brand);
  const p = normalizePin(pin);
  if (!p || p.length < 8) {
    return { status: 'unknown', provider: 'none', message: 'PIN(교환) 번호를 읽지 못해 실시간 조회를 건너뛰었습니다.' };
  }

  for (const provider of PROVIDERS) {
    if (!provider.match(b)) continue;
    try {
      const out = await provider.run(p);
      if (out) return out;
    } catch (err) {
      return { status: 'unknown', provider: provider.name, message: err.message || String(err) };
    }
  }

  return {
    status: 'unknown',
    provider: 'none',
    message: '이 브랜드의 실시간 조회처가 연결되지 않았습니다. (조회 제공자 미설정)',
  };
}

// ------------------------------------------------------------------
// 공통 검사
// ------------------------------------------------------------------
async function requireMember(promiseId, uid) {
  if (!uid) throw new functions.https.HttpsError('unauthenticated', '로그인이 필요합니다.');
  if (!promiseId) throw new functions.https.HttpsError('invalid-argument', 'promiseId 가 필요합니다.');
  const snap = await db.ref(`promises/${promiseId}`).get();
  if (!snap.exists()) throw new functions.https.HttpsError('not-found', '약속을 찾을 수 없습니다.');
  const promise = snap.val();
  if (!promise.members || !promise.members[uid]) {
    throw new functions.https.HttpsError('permission-denied', '이 약속의 참가자가 아닙니다.');
  }
  return promise;
}

// ------------------------------------------------------------------
// 0) 기프티콘 이미지 AI 검증 (Gemini 프록시)
//    - Gemini 키를 서버에만 두어 클라이언트에 노출되지 않게 한다.
//    - functions/.env 에 GEMINI_API_KEY 를 넣으면 활성화된다.
//    - 남용을 막기 위해 사용자당 하루 호출 수를 제한한다.
// ------------------------------------------------------------------
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const DAILY_LIMIT_PER_USER = Number(process.env.GEMINI_DAILY_LIMIT || 40);

async function consumeDailyQuota(uid) {
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.ref(`ai_usage/${day}/${uid}`);
  const res = await ref.transaction((cur) => (Number(cur) || 0) + 1);
  const used = res.snapshot.val() || 0;
  if (used > DAILY_LIMIT_PER_USER) {
    throw new functions.https.HttpsError('resource-exhausted', `하루 검증 횟수(${DAILY_LIMIT_PER_USER}회)를 초과했습니다.`);
  }
}

exports.verifyGifticonImage = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 60, memory: '512MB' })
  .https.onCall(async (data, context) => {
    const uid = context.auth && context.auth.uid;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', '로그인이 필요합니다.');

    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new functions.https.HttpsError('failed-precondition', '서버에 AI 키가 설정되지 않았습니다.');

    const imageBase64 = data && data.imageBase64;
    const mimeType = (data && data.mimeType) || 'image/jpeg';
    if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
      throw new functions.https.HttpsError('invalid-argument', '이미지 데이터가 올바르지 않습니다.');
    }
    if (imageBase64.length > 4 * 1024 * 1024) {
      throw new functions.https.HttpsError('invalid-argument', '이미지가 너무 큽니다. (4MB 제한)');
    }

    await consumeDailyQuota(uid);

    const today = new Date().toISOString().slice(0, 10);
    const promptText = [
      '이 이미지가 실제 사용 가능한 모바일 상품권(기프티콘) 캡처인지 판정해라.',
      '판정 기준: 브랜드/상품명, 유효기간, 교환용 바코드 또는 QR 코드가 함께 보이면 기프티콘이다.',
      '단순 상품 사진, 스크린샷이 아닌 합성/그림, 코드가 없는 이미지는 기프티콘이 아니다.',
      '"사용완료", "사용됨", "USED", "교환완료", "기간만료" 같은 도장/워터마크/문구가 보이면 used=true 로 판정해라.',
      `유효기간이 오늘보다 과거면 expired=true 로 판정해라. 오늘 날짜는 ${today} 이다.`,
      '교환번호(PIN, 바코드 아래 숫자)를 읽을 수 있으면 숫자/영문만 남겨 pin 에 넣어라. 못 읽으면 빈 문자열.',
      '바코드/QR 코드 영역의 위치를 이미지 크기에 대한 0~1 비율로 알려줘라.',
      'JSON 만 출력: {"isGifticon":true/false,"used":true/false,"expired":true/false,"confidence":0~1,"brand":"","item":"","expiry":"","pin":"","codeType":"barcode|qr|none","codeBox":{"x":0,"y":0,"w":0,"h":0},"reason":""}',
    ].join('\n');

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new functions.https.HttpsError('internal', `AI 검증 실패 (${res.status}) ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    const raw = parts.map((p) => p.text || '').join('').replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new functions.https.HttpsError('internal', 'AI 응답을 해석할 수 없습니다.');
    }
  });

// ------------------------------------------------------------------
// 1) 실시간 PIN 조회
// ------------------------------------------------------------------
exports.verifyGifticon = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const uid = context.auth && context.auth.uid;
    const promiseId = data && data.promiseId;
    await requireMember(promiseId, uid);

    const brand = (data && data.brand) || '';
    const pin = (data && data.pin) || '';
    const result = await lookupPinStatus(brand, pin);

    const record = {
      status: result.status,
      provider: result.provider || 'none',
      message: result.message || '',
      checkedAt: admin.database.ServerValue.TIMESTAMP,
    };
    await db.ref(`promises/${promiseId}/gifticons/${uid}/pinCheck`).set(record);

    return { ok: true, ...result };
  });

// ------------------------------------------------------------------
// 2) 원본 보관 (클라이언트가 읽을 수 없는 경로)
// ------------------------------------------------------------------
exports.submitGifticonOriginal = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const uid = context.auth && context.auth.uid;
    const promiseId = data && data.promiseId;
    await requireMember(promiseId, uid);

    const imageFull = data && data.imageFull;
    if (typeof imageFull !== 'string' || !imageFull.startsWith('data:image/')) {
      throw new functions.https.HttpsError('invalid-argument', '이미지 형식이 올바르지 않습니다.');
    }
    if (imageFull.length > 4 * 1024 * 1024) {
      throw new functions.https.HttpsError('invalid-argument', '이미지가 너무 큽니다. (4MB 제한)');
    }

    await db.ref(`gifticon_private/${promiseId}/${uid}`).set({
      uid,
      imageFull,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });
    return { ok: true };
  });

// ------------------------------------------------------------------
// 3) 지각 확인 후 원본 공개
//    - 호출자 본인의 기프티콘만 공개할 수 있다.
//    - 서버 시각으로 약속 시간이 지났고, 도착 기록이 없어야 한다.
// ------------------------------------------------------------------
exports.revealGifticon = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const uid = context.auth && context.auth.uid;
    const promiseId = data && data.promiseId;
    const promise = await requireMember(promiseId, uid);

    const target = Number(promise.targetTimestamp);
    if (!Number.isFinite(target)) {
      throw new functions.https.HttpsError('failed-precondition', '약속 시간이 없습니다.');
    }
    if (Date.now() < target) {
      throw new functions.https.HttpsError('failed-precondition', '아직 약속 시간이 지나지 않았습니다.');
    }
    const me = (promise.attendees || {})[uid];
    if (me && me.arrived === true) {
      throw new functions.https.HttpsError('failed-precondition', '이미 도착 처리되어 공개 대상이 아닙니다.');
    }

    const privSnap = await db.ref(`gifticon_private/${promiseId}/${uid}`).get();
    if (!privSnap.exists()) {
      throw new functions.https.HttpsError('not-found', '보관된 원본이 없습니다.');
    }

    await db.ref(`promises/${promiseId}/gifticons/${uid}`).update({
      imageFull: privSnap.val().imageFull,
      revealed: true,
      revealedAt: admin.database.ServerValue.TIMESTAMP,
    });
    return { ok: true };
  });

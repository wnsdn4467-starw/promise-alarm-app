/* ==========================================================================
   Clean & Simple Promise & Penalty Application Controller
   Instant Multi-Fallback Mobile GPS & IP Geolocation Engine
   ========================================================================== */

const DEFAULT_AVATAR = 'images/default_profile.jpg';

// Firebase Config (Auth + Realtime DB)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDoE4PJ7auGCWdd90fUySSoZ9U5NoX4nys",
  authDomain: "promise-alarm-app.firebaseapp.com",
  projectId: "promise-alarm-app",
  storageBucket: "promise-alarm-app.firebasestorage.app",
  messagingSenderId: "763190011276",
  appId: "1:763190011276:web:ffccf248c761a515c562a9",
  databaseURL: "https://promise-alarm-app-default-rtdb.asia-southeast1.firebasedatabase.app"
};

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) window.lucide.createIcons();

  // Storage Helpers (상단에 배치 - 초기화 시 필요)
  function loadStorage(key, defVal) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defVal;
    } catch (e) { return defVal; }
  }

  function saveStorage(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  // ==========================================
  // XSS Guard - innerHTML 삽입 전 반드시 통과시킬 것
  // 클라우드(Firebase)로 오가는 닉네임/약속명/주소는 모두 신뢰할 수 없는 입력이다.
  // ==========================================
  const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPE_MAP[ch]);
  }

  // 이미지 src 등 URL 속성용: 위험한 스킴을 차단한 뒤 이스케이프
  function safeImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return DEFAULT_AVATAR;
    if (/^(https?:|data:image\/)/i.test(raw) || /^[\w./\-]+$/.test(raw)) return escapeHtml(raw);
    return DEFAULT_AVATAR;
  }

  // ==========================================
  // 친구 코드 정규화 (단일 소스)
  //  core      : 8자리 영숫자 (DB 키로 쓰는 정규 키)
  //  clean     : USR + core
  //  formatted : USR-XXXX-XXXX (화면 표시용)
  // ==========================================
  function normalizeCode(raw) {
    const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const core = clean.startsWith('USR') ? clean.slice(3) : clean;
    const formatted = core.length === 8 ? `USR-${core.slice(0, 4)}-${core.slice(4)}` : clean;
    return { core, clean, formatted };
  }

  // DB 경로에 사용하는 정규 키
  function codeKey(raw) {
    return normalizeCode(raw).core;
  }

  function emailKey(raw) {
    return String(raw || '').toLowerCase().trim().replace(/[.#$[\]/]/g, '_');
  }

  // ==========================================
  // Firebase Auth uid
  //   DB 보안 규칙이 "노드의 주인"을 증명하는 유일한 수단이다.
  //   프로필/위치/친구 데이터에 uid 를 함께 저장한다.
  // ==========================================
  function currentAuthUid() {
    try {
      if (window.firebase && firebase.auth && firebase.auth().currentUser) {
        return firebase.auth().currentUser.uid || null;
      }
    } catch (e) {}
    return null;
  }

  // 로그인된 uid 를 프로필에 채워 넣는다. (기존 사용자 마이그레이션 포함)
  function ensureProfileUid() {
    if (!userProfile) return null;
    const liveUid = currentAuthUid();
    if (liveUid && userProfile.uid !== liveUid) {
      userProfile.uid = liveUid;
      saveStorage('pa_user_profile', userProfile);
    }
    return userProfile.uid || liveUid || null;
  }

  // 쓰기 실패(주로 규칙 위반)를 조용히 삼키지 않고 원인을 남긴다.
  function dbWrite(path, value) {
    if (!dbRef) return Promise.resolve(false);
    const ref = dbRef.ref(path);
    const op = value === null ? ref.remove() : ref.set(value);
    return op.then(() => true).catch((err) => {
      console.warn(`[DB] 쓰기 실패 ${path}:`, err && err.message ? err.message : err);
      return false;
    });
  }

  // User Profile & Pure Dynamic GPS State
  let userProfile = loadStorage('pa_user_profile', null);
  let customUploadedAvatar = userProfile ? (userProfile.avatar || DEFAULT_AVATAR) : DEFAULT_AVATAR;
  // 위치 상태 (단일 소스). 실측값을 받기 전까지는 null 이며 임의의 좌표를 쓰지 않는다.
  let userRealGpsLat = null;
  let userRealGpsLng = null;
  let gpsAccuracy = null;
  let gpsSource = 'none';        // 'none' | 'ip' | 'gps'
  let gpsFixTs = 0;
  let gpsStatusMsg = '📍 위치 확인 중...';
  let currentAddressText = '';
  let isGpsConnected = false;
  let gpsWatchId = null;

  let leafletMapInstance = null;
  let pickerMapInstance = null;
  let pickedMarker = null;
  let selectedPickedAddress = '';
  let selectedPickedLat = null;
  let selectedPickedLng = null;

  // Automatic cache migration / cleanup for app updates (v5)
  const currentAppVer = localStorage.getItem('pa_app_version');
  if (currentAppVer !== 'v5') {
    localStorage.removeItem('pa_fine_history');
    localStorage.removeItem('pa_bank_total');
    localStorage.removeItem('pa_promises_list');
    localStorage.setItem('pa_app_version', 'v5');
  }

  // Load saved data or use clean initial state
  let friendsList = loadStorage('pa_friends_list', []);
  let friendRequestsList = [];
  let promisesList = loadStorage('pa_promises_list', []);

  let activePromiseForLeave = null;
  let activePromiseForMap = null;
  let selectedMapParticipant = null;
  let dbRef = null;

  // 약속 구독 상태 (user_promises 색인 + promises/{id} 개별 리스너)
  let promiseIndexRef = null;
  let promiseNodeRefs = {};
  let cloudPromisesMap = {};
  let subscribedPromiseUid = null;
  let pendingSocialAuth = null;

  // 초기화 순서와 무관하게 접근되므로(초기화 중 콜백 등) 최상단에서 선언한다.
  let isCloudDataListening = false;
  let lastSyncedProfileJson = '';
  let arrivedNotified = loadStorage('pa_arrived_promises', []);
  let declinedPromiseIds = loadStorage('pa_declined_promises', []);

  // ==========================================
  // 0. 위치 엔진
  //    - 상태는 한 곳에서만 갱신한다 (applyLocationFix)
  //    - 실측 GPS(gps) > IP 추정(ip). 낮은 등급이 높은 등급을 덮어쓰지 못한다.
  //    - 역지오코딩은 캐시 + 직렬화 + 최소 간격으로 Nominatim 이용약관을 지킨다.
  // ==========================================
  const GPS_RANK = { none: 0, ip: 1, gps: 2 };
  const IP_ASSUMED_ACCURACY = 5000;   // IP 위치는 도시 단위(수 km) 오차
  const PRECISE_ACCURACY_LIMIT = 200; // 도착 판정에 쓸 수 있는 최소 정확도
  const FIX_VALID_MS = 10 * 60 * 1000;

  function hasLocationFix() {
    return typeof userRealGpsLat === 'number' && typeof userRealGpsLng === 'number';
  }

  // 도착 판정처럼 신뢰가 필요한 곳에서만 true
  function isPreciseFix() {
    return gpsSource === 'gps' && typeof gpsAccuracy === 'number' && gpsAccuracy <= PRECISE_ACCURACY_LIMIT;
  }

  function setGpsStatus(msg) {
    gpsStatusMsg = msg;
    renderLocationBar();
  }

  function gpsErrorMessage(err) {
    if (!err) return '⚠️ 위치를 확인할 수 없습니다.';
    if (err.code === 1) return '❌ 위치 권한이 거부되었습니다. 브라우저 설정에서 위치 접근을 허용해 주세요.';
    if (err.code === 2) return '⚠️ GPS 신호를 받을 수 없습니다. (실내이거나 기기 위치 설정이 꺼져 있음)';
    if (err.code === 3) return '⏱ 위치 확인 시간이 초과되었습니다.';
    return '⚠️ 위치를 확인할 수 없습니다.';
  }

  function applyLocationFix(lat, lng, accuracy, source) {
    const nLat = Number(lat);
    const nLng = Number(lng);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return false;
    if (Math.abs(nLat) > 90 || Math.abs(nLng) > 180) return false;
    if (nLat === 0 && nLng === 0) return false; // 응답 누락 시 흔한 쓰레기 값

    const incomingRank = GPS_RANK[source] || 0;
    const currentRank = GPS_RANK[gpsSource] || 0;
    if (incomingRank < currentRank && Date.now() - gpsFixTs < FIX_VALID_MS) {
      return false; // 실측 GPS를 IP 추정치로 덮어쓰지 않음
    }

    const moved = !hasLocationFix()
      || calculateHaversineDistance(userRealGpsLat, userRealGpsLng, nLat, nLng) > 10;

    userRealGpsLat = nLat;
    userRealGpsLng = nLng;
    gpsAccuracy = Number.isFinite(Number(accuracy)) ? Math.round(Number(accuracy)) : null;
    gpsSource = source;
    gpsFixTs = Date.now();
    isGpsConnected = source === 'gps';
    gpsStatusMsg = '';

    renderLocationBar();
    queueReverseGeocode(nLat, nLng);
    if (moved) schedulePromisesRerender();
    publishMyLocation();
    return true;
  }

  function initInstantGpsTracking() {
    renderLocationBar();

    if (!navigator.geolocation) {
      setGpsStatus('⚠️ 이 브라우저는 위치 기능을 지원하지 않습니다.');
      fetchIpLocation();
      return;
    }

    // 브라우저는 보안 컨텍스트(HTTPS 또는 localhost)에서만 GPS를 허용한다.
    // http://192.168.x.x 같은 LAN 주소로 접속하면 GPS 자체가 차단된다.
    if (!window.isSecureContext) {
      setGpsStatus('⚠️ HTTPS 접속이 아니어서 정확한 GPS를 쓸 수 없습니다. IP 기반 대략 위치로 표시합니다.');
      fetchIpLocation();
      return;
    }

    requestPreciseLocation();
    startContinuousGpsWatch();
  }

  function requestPreciseLocation() {
    if (!navigator.geolocation || !window.isSecureContext) {
      fetchIpLocation();
      return;
    }

    if (!hasLocationFix()) setGpsStatus('📡 GPS 위치 확인 중...');

    navigator.geolocation.getCurrentPosition(
      (pos) => applyLocationFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, 'gps'),
      (err) => {
        if (err && err.code === 1) {
          setGpsStatus(gpsErrorMessage(err));
          fetchIpLocation();
          return;
        }
        // 2차: 정확도를 낮춰 Wi-Fi/기지국 기반으로 재시도
        navigator.geolocation.getCurrentPosition(
          (pos) => applyLocationFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, 'gps'),
          (err2) => {
            if (!hasLocationFix()) setGpsStatus(gpsErrorMessage(err2));
            fetchIpLocation();
          },
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  function startContinuousGpsWatch() {
    if (!navigator.geolocation || !window.isSecureContext || gpsWatchId !== null) return;

    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => applyLocationFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, 'gps'),
      (err) => {
        if (err && err.code === 1) {
          // 권한 거부는 재시도해도 의미가 없으므로 감시를 중단한다.
          navigator.geolocation.clearWatch(gpsWatchId);
          gpsWatchId = null;
          isGpsConnected = false;
          setGpsStatus(gpsErrorMessage(err));
          fetchIpLocation();
        } else if (!hasLocationFix()) {
          setGpsStatus(gpsErrorMessage(err));
        }
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
  }

  let ipLookupInFlight = false;
  function fetchIpLocation() {
    if (ipLookupInFlight) return;
    if (gpsSource === 'gps' && Date.now() - gpsFixTs < FIX_VALID_MS) return;
    ipLookupInFlight = true;

    const done = () => { ipLookupInFlight = false; };

    fetch('https://ip-api.com/json/?fields=status,lat,lon&lang=ko')
      .then(res => res.json())
      .then(data => {
        if (data && data.status === 'success' && applyLocationFix(data.lat, data.lon, IP_ASSUMED_ACCURACY, 'ip')) {
          done();
          return null;
        }
        return ipFallback().finally(done);
      })
      .catch(() => ipFallback().finally(done));
  }

  function ipFallback() {
    return fetch('https://geolocation-db.com/json/')
      .then(res => res.json())
      .then(data => {
        if (!data || !applyLocationFix(data.latitude, data.longitude, IP_ASSUMED_ACCURACY, 'ip')) {
          if (!hasLocationFix()) setGpsStatus('⚠️ 위치를 확인할 수 없습니다. 위치 새로고침을 눌러 다시 시도해 주세요.');
        }
      })
      .catch(() => {
        if (!hasLocationFix()) setGpsStatus('⚠️ 위치를 확인할 수 없습니다. 위치 새로고침을 눌러 다시 시도해 주세요.');
      });
  }

  // 위치 변화에 따른 목록 재렌더는 과도한 DOM 재생성을 막기 위해 묶어서 처리
  let rerenderTimer = null;
  function schedulePromisesRerender() {
    if (rerenderTimer) return;
    rerenderTimer = setTimeout(() => {
      rerenderTimer = null;
      renderPromises();
    }, 1500);
  }

  // ---------- 역지오코딩 (캐시 + 직렬화 + 최소 간격) ----------
  const geocodeCache = new Map();
  const GEOCODE_MIN_INTERVAL_MS = 5000;
  let geocodeQueued = null;
  let geocodeInFlight = false;
  let geocodeTimer = null;
  let lastGeocodeTs = 0;

  function coordKey(lat, lng) {
    return `${lat.toFixed(4)},${lng.toFixed(4)}`; // 약 11m 단위로 캐시
  }

  function queueReverseGeocode(lat, lng) {
    const key = coordKey(lat, lng);
    if (geocodeCache.has(key)) {
      applyAddress(geocodeCache.get(key));
      return;
    }
    geocodeQueued = { lat, lng, key };
    pumpGeocodeQueue();
  }

  function pumpGeocodeQueue() {
    if (!geocodeQueued || geocodeInFlight || geocodeTimer) return;

    const waitMs = Math.max(0, GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastGeocodeTs));
    if (waitMs > 0) {
      geocodeTimer = setTimeout(() => { geocodeTimer = null; pumpGeocodeQueue(); }, waitMs);
      return;
    }

    const job = geocodeQueued;
    geocodeQueued = null;
    geocodeInFlight = true;
    lastGeocodeTs = Date.now();

    reverseGeocode(job.lat, job.lng)
      .then((addr) => {
        if (!addr) return;
        geocodeCache.set(job.key, addr);
        if (geocodeCache.size > 60) geocodeCache.delete(geocodeCache.keys().next().value);
        applyAddress(addr);
      })
      .catch(() => {})
      .finally(() => {
        geocodeInFlight = false;
        pumpGeocodeQueue();
      });
  }

  function reverseGeocode(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`
      + '&accept-language=ko&addressdetails=1&zoom=18';
    return fetch(url)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
      .then(data => formatNominatimAddress(data));
  }

  function applyAddress(addrStr) {
    if (!addrStr || addrStr === currentAddressText) return;
    currentAddressText = addrStr;

    // 위치는 로컬에만 저장한다. (매 갱신마다 클라우드에 쓰면 트래픽/프라이버시 낭비)
    if (userProfile && userProfile.location !== addrStr) {
      userProfile.location = addrStr;
      saveStorage('pa_user_profile', userProfile);
    }
    renderLocationBar();
  }

  function locationQualityLabel() {
    if (!hasLocationFix()) return '';

    // 비보안 컨텍스트(HTTP + LAN IP 등)에서는 브라우저가 GPS 자체를 막으므로
    // 주소가 표시된 뒤에도 이유를 계속 보여준다.
    const insecureNote = (!window.isSecureContext && navigator.geolocation)
      ? ' · HTTPS 접속이 아니어서 GPS 사용 불가'
      : '';

    if (gpsSource === 'gps') {
      const base = gpsAccuracy != null ? `GPS · 정확도 ±${gpsAccuracy}m` : 'GPS 수신 중';
      return base + insecureNote;
    }
    return 'IP 기반 대략 위치 (정확도 낮음)' + insecureNote;
  }

  function renderLocationBar() {
    const addrEl = document.getElementById('liveGpsAddrText');
    const coordEl = document.getElementById('liveGpsCoordsText');
    const metaEl = document.getElementById('liveGpsMetaText');
    const inputEl = document.getElementById('inputOnboardLocation');
    const settingsLocEl = document.getElementById('settingsLocText');

    const displayText = currentAddressText
      ? `📍 ${currentAddressText}`
      : (gpsStatusMsg || '📍 위치 확인 중...');

    if (addrEl) addrEl.textContent = displayText;
    if (coordEl) {
      coordEl.textContent = hasLocationFix()
        ? `${userRealGpsLat.toFixed(6)}, ${userRealGpsLng.toFixed(6)}`
        : '좌표 없음';
    }
    if (metaEl) metaEl.textContent = locationQualityLabel();
    if (inputEl) inputEl.value = currentAddressText || (gpsStatusMsg || '위치 확인 중...');
    if (settingsLocEl && currentAddressText) settingsLocEl.textContent = currentAddressText;
  }

  // 내 위치를 약속 참가자에게 공유 (친구 코드 기준, 이동/시간 조건 충족 시에만 전송)
  let lastPublishedTs = 0;
  let lastPublishedLat = null;
  let lastPublishedLng = null;
  function publishMyLocation() {
    if (!dbRef || !userProfile || !hasLocationFix()) return;
    const myKey = codeKey(userProfile.code);
    const myUid = ensureProfileUid();
    if (!myKey || !myUid) return;

    const now = Date.now();
    const movedEnough = lastPublishedLat === null
      || calculateHaversineDistance(lastPublishedLat, lastPublishedLng, userRealGpsLat, userRealGpsLng) > 30;
    if (!movedEnough && now - lastPublishedTs < 60 * 1000) return;

    lastPublishedTs = now;
    lastPublishedLat = userRealGpsLat;
    lastPublishedLng = userRealGpsLng;

    dbWrite('user_locations/' + myKey, {
      uid: myUid,
      name: userProfile.name || '',
      avatar: userProfile.avatar || DEFAULT_AVATAR,
      lat: userRealGpsLat,
      lng: userRealGpsLng,
      accuracy: gpsAccuracy,
      source: gpsSource,
      address: currentAddressText || '',
      updatedAt: now
    });
  }

  function formatNominatimAddress(data) {
    const addr = data.address || {};
    // 한국 상세 주소: 시/도 → 구/군 → 동/읍/면 → 도로명 → 번지
    const province = addr.province || addr.state || '';
    const city = addr.city || addr.county || addr.town || '';
    const district = addr.borough || addr.city_district || addr.suburb || '';
    const dong = addr.neighbourhood || addr.quarter || addr.village || '';
    const road = addr.road || '';
    const houseNum = addr.house_number || '';
    const building = addr.building || '';
    const postcode = addr.postcode || '';

    // 도로명 주소 형식: 서울특별시 강남구 테헤란로 123
    const roadAddr = [city || province, district, road, houseNum].filter(Boolean);
    // 지번 주소 형식: 서울특별시 강남구 역삼동 123-45
    const jibunAddr = [city || province, district, dong, houseNum].filter(Boolean);

    // 도로명이 있으면 도로명 주소 우선, 없으면 지번 주소
    let mainAddr = road ? roadAddr.join(' ') : jibunAddr.join(' ');
    if (building) mainAddr += ` (${building})`;

    return mainAddr || '실시간 내 위치';
  }

  // Firebase Realtime DB Connection
  function initFirebaseRealtimeDB() {
    try {
      if (window.firebase && !firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
        dbRef = firebase.database();

        // 약속은 promises/{promiseId} 단위로 분리 저장한다.
        // (과거 shared_promises 전역 배열 방식은 동시 사용 시 last-write-wins 로 유실됨)
        // promises 전체 구독은 금지: 규칙상 내가 members 에 포함된 약속만 읽을 수 있으므로
        // user_promises/{uid} 색인을 구독한 뒤 약속 노드를 개별 구독한다.
        if (currentAuthUid()) subscribeMyPromises(currentAuthUid());

        // DB 연결 즉시 내 프로필 클라우드 동기화 (친구 코드 등록 보장)
        if (userProfile && userProfile.name) {
          syncUserProfileToCloud();
          publishMyLocation();
        }

        if (firebase.auth) {
          firebase.auth().onAuthStateChanged((authUser) => {
            if (!authUser) {
              detachPromiseSubscriptions();
              return;
            }
            subscribeMyPromises(authUser.uid);
            if (authUser && userProfile && userProfile.name) {
              // 로그인이 확인되면 uid 를 프로필에 채우고 규칙이 요구하는 형태로 재동기화
              if (userProfile.uid !== authUser.uid) {
                userProfile.uid = authUser.uid;
                saveStorage('pa_user_profile', userProfile);
                lastSyncedProfileJson = '';
                syncUserProfileToCloud();
                publishMyLocation();
              }
              return;
            }
            if (authUser && authUser.email && (!userProfile || !userProfile.name)) {
              handleSocialLoginSuccess('google', authUser.displayName || 'Google 사용자', authUser.email, authUser.photoURL || DEFAULT_AVATAR);
            }
          });
        }
      } else if (window.firebase && firebase.apps.length && !dbRef) {
        dbRef = firebase.database();
        if (userProfile && userProfile.name) {
          syncUserProfileToCloud();
        }
      }
    } catch (e) {
      console.warn('Firebase DB init warning:', e);
    }
  }

  // ==========================================
  // 약속 구독 (내가 참여/초대된 약속만)
  //   보안 규칙상 promises 전체 읽기는 차단되어 있다.
  //   user_promises/{uid} 색인 → promises/{id} 개별 구독 순서로 접근한다.
  // ==========================================
  function rebuildPromisesListFromCloud() {
    const arr = Object.values(cloudPromisesMap).filter(Boolean);
    arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    promisesList = arr;
    saveStorage('pa_promises_list', promisesList);
    renderPromises();
  }

  function detachPromiseSubscriptions() {
    if (promiseIndexRef) {
      promiseIndexRef.off();
      promiseIndexRef = null;
    }
    Object.keys(promiseNodeRefs).forEach((id) => promiseNodeRefs[id].off());
    promiseNodeRefs = {};
    cloudPromisesMap = {};
    subscribedPromiseUid = null;
  }

  function subscribeMyPromises(uid) {
    if (!dbRef || !uid) return;
    if (subscribedPromiseUid === uid) return;

    detachPromiseSubscriptions();
    subscribedPromiseUid = uid;
    promiseIndexRef = dbRef.ref('user_promises/' + uid);

    promiseIndexRef.on('value', (snapshot) => {
      const ids = Object.keys(snapshot.val() || {});

      // 색인에서 빠진 약속은 구독 해제
      Object.keys(promiseNodeRefs).forEach((id) => {
        if (ids.indexOf(id) !== -1) return;
        promiseNodeRefs[id].off();
        delete promiseNodeRefs[id];
        delete cloudPromisesMap[id];
      });

      ids.forEach((id) => {
        if (promiseNodeRefs[id]) return;
        const ref = dbRef.ref('promises/' + id);
        promiseNodeRefs[id] = ref;
        ref.on('value', (pSnap) => {
          const val = pSnap.val();
          if (val) cloudPromisesMap[id] = val;
          else delete cloudPromisesMap[id];
          rebuildPromisesListFromCloud();
        }, (err) => {
          // 읽기 거부(멤버 아님) 등: 목록에서 제외
          console.warn('[DB] 약속 읽기 실패 ' + id + ':', err && err.message ? err.message : err);
          delete cloudPromisesMap[id];
          rebuildPromisesListFromCloud();
        });
      });

      rebuildPromisesListFromCloud();
    }, (err) => {
      console.warn('[DB] 약속 색인 구독 실패:', err && err.message ? err.message : err);
    });
  }

  // 약속의 멤버 uid 목록 (읽기 권한의 유일한 기준)
  function promiseMemberUids(promiseObj) {
    return Object.keys((promiseObj && promiseObj.members) || {});
  }

  // ==========================================
  // 참가 상태(attendees) 헬퍼
  //   보안 규칙: 약속 내용/members 는 호스트만, attendees/{uid} 는 본인만 쓸 수 있다.
  //   따라서 "참가자"는 attendees 맵이 단일 소스다. (participants 배열은 구버전 호환용)
  // ==========================================
  function promiseAttendees(promiseObj) {
    const map = (promiseObj && promiseObj.attendees) || {};
    return Object.keys(map)
      .map((uid) => Object.assign({ uid: uid }, map[uid] || {}))
      .filter((a) => a && a.name);
  }

  function promiseParticipantNames(promiseObj) {
    const names = promiseAttendees(promiseObj).map((a) => a.name);
    if (names.length > 0) return names;
    return Array.isArray(promiseObj && promiseObj.participants) ? promiseObj.participants : [];
  }

  function amIHostOf(promiseObj) {
    const myUid = ensureProfileUid();
    return !!(myUid && promiseObj && promiseObj.hostUid === myUid);
  }

  function amIAttendeeOf(promiseObj) {
    const myUid = ensureProfileUid();
    if (myUid && promiseObj && promiseObj.attendees && promiseObj.attendees[myUid]) return true;
    // 구버전 약속(attendees 없음) 호환
    if (promiseObj && !promiseObj.attendees && Array.isArray(promiseObj.participants)) {
      const myName = userProfile ? userProfile.name : '나';
      return promiseObj.participants.includes(myName);
    }
    return false;
  }

  function amIMemberOf(promiseObj) {
    const myUid = ensureProfileUid();
    return !!(myUid && promiseObj && promiseObj.members && promiseObj.members[myUid]);
  }

  function myAttendeeRecord(promiseObj) {
    const myUid = ensureProfileUid();
    if (!myUid || !promiseObj || !promiseObj.attendees) return null;
    return promiseObj.attendees[myUid] || null;
  }

  // 내 참가/도착 상태만 기록한다. (약속 본문은 건드리지 않음)
  function writeMyAttendance(promiseObj, extra) {
    const myUid = ensureProfileUid();
    if (!promiseObj || !promiseObj.id || !myUid) return;

    const prev = (promiseObj.attendees && promiseObj.attendees[myUid]) || {};
    const record = {
      uid: myUid,
      name: userProfile ? userProfile.name : '나',
      avatar: (userProfile && userProfile.avatar) || DEFAULT_AVATAR,
      joinedAt: prev.joinedAt || Date.now(),
      arrived: !!prev.arrived
    };
    Object.keys(extra || {}).forEach((k) => { record[k] = extra[k]; });

    promiseObj.attendees = promiseObj.attendees || {};
    promiseObj.attendees[myUid] = record;
    saveStorage('pa_promises_list', promisesList);

    if (!dbRef) return;
    dbWrite('promises/' + promiseObj.id + '/attendees/' + myUid, record).then((ok) => {
      if (ok) dbWrite('user_promises/' + myUid + '/' + promiseObj.id, true);
    });
  }

  // 초대할 친구들의 uid 로 members 맵을 만든다. (uid 없는 친구는 클라우드 공유 불가)
  function buildMembersMap(hostUid, friendObjs) {
    const members = {};
    if (hostUid) members[hostUid] = true;
    (friendObjs || []).forEach((f) => {
      if (f && f.uid) members[f.uid] = true;
    });
    return members;
  }

  // 변경된 약속 1건만 클라우드에 반영 (전역 덮어쓰기 금지)
  // 약속 본문 쓰기는 호스트만 허용된다. (규칙과 동일한 제약을 클라이언트에도 적용)
  function syncPromisesToCloud(changedPromise) {
    saveStorage('pa_promises_list', promisesList);
    if (!dbRef) return;
    if (!changedPromise || !changedPromise.id) return;

    const myUid = ensureProfileUid();
    if (!myUid) {
      console.warn('[DB] 로그인 uid 가 없어 약속을 공유하지 않습니다.');
      return;
    }
    if (changedPromise.hostUid && changedPromise.hostUid !== myUid) {
      console.warn('[DB] 호스트가 아니므로 약속 본문을 수정하지 않습니다:', changedPromise.id);
      return;
    }
    if (!changedPromise.members) changedPromise.members = {};
    changedPromise.members[myUid] = true;

    // 약속 노드를 먼저 쓴 뒤 색인을 갱신한다.
    // (색인 쓰기 규칙이 promises/{id}/hostUid 를 참조하므로 순서가 중요)
    dbWrite('promises/' + changedPromise.id, changedPromise).then((ok) => {
      if (!ok) return;
      promiseMemberUids(changedPromise).forEach((uid) => {
        dbWrite('user_promises/' + uid + '/' + changedPromise.id, true);
      });
    });
  }

  function removePromiseFromCloud(promiseId, promiseObj) {
    saveStorage('pa_promises_list', promisesList);
    if (!dbRef || !promiseId) return;

    const myUid = ensureProfileUid();
    const isHost = !!(myUid && promiseObj && promiseObj.hostUid === myUid);

    if (!isHost) {
      // 호스트가 아니면 약속을 지울 수 없다. 내 색인만 정리한다.
      if (myUid) dbWrite('user_promises/' + myUid + '/' + promiseId, null);
      return;
    }

    // 색인을 먼저 지운다 (약속 노드가 사라지면 호스트 검증을 할 수 없다)
    promiseMemberUids(promiseObj).forEach((uid) => {
      dbWrite('user_promises/' + uid + '/' + promiseId, null);
    });
    if (myUid) dbWrite('user_promises/' + myUid + '/' + promiseId, null);

    dbWrite('promises/' + promiseId, null);
  }

  // 약속에서 나가기/초대 거절: 내 참가 기록과 색인만 제거한다.
  // (members 는 호스트 전용이라 건드리지 않는다)
  function detachMyselfFromPromise(promiseObj) {
    if (!promiseObj || !promiseObj.id) return;
    const myUid = ensureProfileUid();

    if (promiseObj.attendees && myUid) delete promiseObj.attendees[myUid];
    if (!declinedPromiseIds.includes(promiseObj.id)) {
      declinedPromiseIds.push(promiseObj.id);
      saveStorage('pa_declined_promises', declinedPromiseIds);
    }
    saveStorage('pa_promises_list', promisesList);

    if (!dbRef || !myUid) return;
    dbWrite('promises/' + promiseObj.id + '/attendees/' + myUid, null).then(() => {
      dbWrite('user_promises/' + myUid + '/' + promiseObj.id, null);
    });
  }

  // 약속 나가기: 호스트이고 남은 참가자가 없으면 약속을 삭제하고,
  // 그 외에는 내 참가 기록/색인만 제거한다.
  function leavePromise(promiseObj) {
    if (!promiseObj || !promiseObj.id) return;
    const myUid = ensureProfileUid();
    const others = promiseAttendees(promiseObj).filter(a => a.uid !== myUid);

    if (amIHostOf(promiseObj) && others.length === 0) {
      promisesList = promisesList.filter(p => p.id !== promiseObj.id);
      removePromiseFromCloud(promiseObj.id, promiseObj);
      return;
    }

    detachMyselfFromPromise(promiseObj);
    promisesList = promisesList.filter(p => p.id !== promiseObj.id);
  }

  // ==========================================
  // 테마 (다크 / 라이트) - 기본값: 다크
  // ==========================================
  const THEME_META = {
    dark: { label: '다크 모드', themeColor: '#000000' },
    light: { label: '라이트 모드', themeColor: '#ffffff' }
  };

  function loadTheme() {
    return localStorage.getItem('pa_theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('pa_theme', next);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_META[next].themeColor);

    const label = document.getElementById('themeCurrentLabel');
    if (label) label.textContent = THEME_META[next].label;

    document.querySelectorAll('.theme-option').forEach((btn) => {
      const isOn = btn.getAttribute('data-theme-value') === next;
      btn.classList.toggle('selected', isOn);
      btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    });
  }

  applyTheme(loadTheme());

  const themeModal = document.getElementById('themeModal');
  const btnOpenThemeSettings = document.getElementById('btnOpenThemeSettings');
  const btnCloseTheme = document.getElementById('btnCloseTheme');

  if (btnOpenThemeSettings && themeModal) {
    btnOpenThemeSettings.addEventListener('click', () => {
      if (settingsModal) settingsModal.classList.remove('active');
      themeModal.classList.add('active');
      applyTheme(loadTheme());
      if (window.lucide) window.lucide.createIcons();
    });
  }

  if (btnCloseTheme && themeModal) {
    btnCloseTheme.addEventListener('click', () => {
      themeModal.classList.remove('active');
      if (settingsModal) settingsModal.classList.add('active');
    });
  }

  document.querySelectorAll('.theme-option').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.getAttribute('data-theme-value')));
  });

  // 벌칙 표시 문구 (종류 + 지속 시간)
  function penaltyLabel(promiseObj) {
    const type = promiseObj && promiseObj.penaltyType;
    if (type !== 'alarm' && type !== 'vibrate') return '없음';
    const min = Number(promiseObj.penaltyDurationMin) || 0;
    const dur = min > 0 ? `${min}분간` : '도착할 때까지';
    return type === 'vibrate' ? `${dur} 진동` : `${dur} 알람 소리`;
  }

  // ==========================================
  // 받은 알림 플로팅 버튼 + 바텀 시트
  //   초대받은 약속 / 받은 친구 요청 개수를 원형 버튼 대각선 아래 배지로 표시한다.
  // ==========================================
  let invitedCount = 0;

  function setFabBadge(btnId, badgeId, count) {
    const btn = document.getElementById(btnId);
    const badge = document.getElementById(badgeId);
    if (!btn || !badge) return;

    if (count > 0) {
      badge.hidden = false;
      badge.textContent = count > 99 ? '99+' : String(count);
      btn.classList.add('has-items');
    } else {
      badge.hidden = true;
      btn.classList.remove('has-items');
    }
  }

  function updateInboxBadges() {
    setFabBadge('fabInvites', 'fabInvitesBadge', invitedCount);
    setFabBadge('fabFriendReqs', 'fabFriendReqsBadge', (friendRequestsList || []).length);
  }

  function openSheet(id) {
    const sheet = document.getElementById(id);
    if (!sheet) return;
    sheet.classList.add('active');
    if (window.lucide) window.lucide.createIcons();
  }

  function closeSheet(id) {
    const sheet = document.getElementById(id);
    if (sheet) sheet.classList.remove('active');
  }

  [
    ['fabInvites', 'inviteSheet', 'btnCloseInviteSheet'],
    ['fabFriendReqs', 'friendReqSheet', 'btnCloseFriendReqSheet']
  ].forEach(([fabId, sheetId, closeId]) => {
    const fab = document.getElementById(fabId);
    const closeBtn = document.getElementById(closeId);
    const sheet = document.getElementById(sheetId);

    if (fab) fab.addEventListener('click', () => openSheet(sheetId));
    if (closeBtn) closeBtn.addEventListener('click', () => closeSheet(sheetId));
    // 바깥(딤 영역) 탭으로 닫기
    if (sheet) sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(sheetId); });
  });

  // ==========================================
  // 약속 기록 캘린더 (월 단위 + 종이 넘김 애니메이션)
  // ==========================================
  let calViewYear = new Date().getFullYear();
  let calViewMonth = new Date().getMonth();   // 0-11

  // 해당 약속의 지각(벌칙) 대상자 이름 목록
  function latePenaltyNames(promiseObj) {
    const target = Number(promiseObj && promiseObj.targetTimestamp);
    if (!Number.isFinite(target)) return [];
    if (Date.now() < target) return [];

    return promiseAttendees(promiseObj)
      .filter((a) => !a.arrived || (Number(a.arrivedAt) || 0) > target)
      .map((a) => a.name);
  }

  function promisesOnDate(year, month, day) {
    return promisesList.filter((p) => {
      if (!amIAttendeeOf(p)) return false;
      const ts = Number(p.targetTimestamp);
      if (!Number.isFinite(ts)) return false;
      const d = new Date(ts);
      return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
    });
  }

  function renderCalendar(flipDirection) {
    const grid = document.getElementById('calendarGrid');
    const label = document.getElementById('calMonthLabel');
    const summary = document.getElementById('calMonthSummary');
    const sheet = document.getElementById('calendarSheet');
    if (!grid) return;

    if (label) label.textContent = `${calViewYear}년 ${calViewMonth + 1}월`;

    // 넘김 애니메이션: 현재 페이지를 세로 조각으로 복제해 시차를 두고 접듯이 넘긴다.
    // (직사각형이 통째로 도는 대신 바람에 휘날리는 종이처럼 보이게 한다)
    if (sheet && flipDirection) playCalendarFlip(sheet, flipDirection);

    const firstWeekday = new Date(calViewYear, calViewMonth, 1).getDay();
    const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    const today = new Date();

    grid.innerHTML = '';
    let monthCount = 0;
    let upcomingCount = 0;
    let doneCount = 0;
    let lateCount = 0;

    for (let i = 0; i < firstWeekday; i++) {
      const pad = document.createElement('div');
      pad.className = 'cal-cell empty';
      grid.appendChild(pad);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dayPromises = promisesOnDate(calViewYear, calViewMonth, day);
      monthCount += dayPromises.length;

      const weekday = new Date(calViewYear, calViewMonth, day).getDay();
      const isToday = today.getFullYear() === calViewYear && today.getMonth() === calViewMonth && today.getDate() === day;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-cell';
      if (weekday === 0) cell.classList.add('sun');
      if (weekday === 6) cell.classList.add('sat');
      if (dayPromises.length > 0) cell.classList.add('has-promise');
      if (isToday) {
        cell.classList.add('today');
        cell.setAttribute('aria-current', 'date');
      }

      // 예정 = 체크(✓), 완료 = 동그라미(○), 지각자 있던 완료 = 빨간 동그라미
      // 완료는 "종료 시간이 지난" 약속만 해당한다.
      const marks = dayPromises.slice(0, 3).map((p) => {
        if (promiseStatus(p) !== 'done') {
          upcomingCount += 1;
          return '<span class="cal-mark-check">✓</span>';
        }
        doneCount += 1;
        if (latePenaltyNames(p).length > 0) {
          lateCount += 1;
          return '<span class="cal-mark-late">○</span>';
        }
        return '<span class="cal-mark-done">○</span>';
      }).join('');

      cell.innerHTML = `<span class="cal-daynum">${day}</span><span class="cal-marks">${marks}</span>`;

      if (dayPromises.length > 0) {
        cell.addEventListener('click', () => openDaySheet(calViewYear, calViewMonth, day));
      } else {
        cell.disabled = true;
      }

      grid.appendChild(cell);
    }

    if (summary) summary.textContent = `${calViewYear}년 ${calViewMonth + 1}월 약속 ${monthCount}건`;

    // 오늘 날짜를 연한 회색으로 알려준다.
    const todayLabelEl = document.getElementById('calTodayLabel');
    if (todayLabelEl) {
      const weekNames = ['일', '월', '화', '수', '목', '금', '토'];
      todayLabelEl.textContent = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일 (${weekNames[today.getDay()]})`;
    }

    const legend = document.getElementById('calLegend');
    if (legend) {
      legend.innerHTML = `
        <span><span class="cal-mark-check">✓</span> 예정 ${upcomingCount}건</span>
        <span><span class="cal-mark-done">○</span> 완료 ${doneCount}건</span>
        <span><span class="cal-mark-late">○</span> 지각 ${lateCount}건</span>
      `;
    }

    if (window.lucide) window.lucide.createIcons();
  }

  // ------------------------------------------
  // 달력 넘김 (한 장이 부드럽게 넘어간다)
  //  - 이전 달 페이지를 그대로 복제해 한 덩어리로 회전
  //  - 후반부에 서서히 사라져 끝에서 툭 끊기지 않는다
  // ------------------------------------------
  const FLIP_DURATION = 900;

  function playCalendarFlip(sheet, direction) {
    const stage = sheet.parentElement;
    if (!stage || typeof sheet.animate !== 'function') return;

    stage.querySelectorAll('.flip-ghost').forEach((g) => g.remove());

    const height = sheet.offsetHeight;
    if (!height) return;

    const next = direction === 'next';
    const sign = next ? -1 : 1;

    const ghost = sheet.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.className = 'flip-ghost';
    ghost.style.height = `${height}px`;
    ghost.style.transformOrigin = next ? 'left center' : 'right center';
    stage.appendChild(ghost);

    const ghostAnim = ghost.animate([
      {
        transform: 'perspective(1500px) rotateY(0deg)',
        boxShadow: '0 0 0 rgba(0, 0, 0, 0)',
        filter: 'brightness(1)',
        opacity: 1,
        offset: 0
      },
      {
        transform: `perspective(1500px) rotateY(${sign * 55}deg)`,
        boxShadow: `${next ? 22 : -22}px 12px 34px rgba(0, 0, 0, 0.32)`,
        filter: 'brightness(0.9)',
        opacity: 1,
        offset: 0.42
      },
      {
        transform: `perspective(1500px) rotateY(${sign * 110}deg)`,
        boxShadow: `${next ? 16 : -16}px 10px 26px rgba(0, 0, 0, 0.2)`,
        filter: 'brightness(0.8)',
        opacity: 0.72,
        offset: 0.72
      },
      {
        transform: `perspective(1500px) rotateY(${sign * 152}deg)`,
        boxShadow: '0 0 0 rgba(0, 0, 0, 0)',
        filter: 'brightness(0.72)',
        opacity: 0,
        offset: 1
      }
    ], {
      duration: FLIP_DURATION,
      easing: 'cubic-bezier(0.36, 0.04, 0.28, 1)',
      fill: 'both'
    });

    // 아래에서 드러나는 새 페이지도 같은 리듬으로 부드럽게 자리를 잡는다
    const sheetAnim = sheet.animate([
      { transform: `perspective(1500px) rotateY(${next ? 8 : -8}deg) scale(0.99)`, filter: 'brightness(0.74)', offset: 0 },
      { transform: `perspective(1500px) rotateY(${next ? 3 : -3}deg) scale(0.996)`, filter: 'brightness(0.9)', offset: 0.45 },
      { transform: 'perspective(1500px) rotateY(0deg) scale(1)', filter: 'brightness(1)', offset: 1 }
    ], {
      duration: FLIP_DURATION,
      easing: 'cubic-bezier(0.22, 0.7, 0.24, 1)',
      fill: 'none'
    });

    const cleanup = () => {
      if (ghost.parentElement) ghost.remove();
      try { sheetAnim.cancel(); } catch (e) {}
    };
    ghostAnim.finished.then(cleanup).catch(() => cleanup());
    setTimeout(cleanup, FLIP_DURATION + 400);
  }
  function shiftCalendarMonth(delta) {
    calViewMonth += delta;
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear -= 1; }
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear += 1; }
    renderCalendar(delta > 0 ? 'next' : 'prev');
  }

  const btnCalPrev = document.getElementById('btnCalPrev');
  const btnCalNext = document.getElementById('btnCalNext');
  if (btnCalPrev) btnCalPrev.addEventListener('click', () => shiftCalendarMonth(-1));
  if (btnCalNext) btnCalNext.addEventListener('click', () => shiftCalendarMonth(1));

  // 년/월 직접 입력 (라벨은 항상 중앙에 두고, 클릭하면 입력 창이 뜬다)
  const calMonthLabel = document.getElementById('calMonthLabel');
  const calMonthModal = document.getElementById('calMonthModal');
  const btnCloseCalMonth = document.getElementById('btnCloseCalMonth');
  const inputCalYear = document.getElementById('inputCalYear');
  const inputCalMonth = document.getElementById('inputCalMonth');
  const btnCalMonthApply = document.getElementById('btnCalMonthApply');
  const btnCalMonthToday = document.getElementById('btnCalMonthToday');

  function openMonthEditor() {
    if (!calMonthModal) return;
    if (inputCalYear) inputCalYear.value = String(calViewYear);
    if (inputCalMonth) inputCalMonth.value = String(calViewMonth + 1);
    calMonthModal.classList.add('active');
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => { if (inputCalYear) inputCalYear.select(); }, 60);
  }

  function closeMonthEditor() {
    if (calMonthModal) calMonthModal.classList.remove('active');
  }

  function goToMonth(y, m0) {
    const forward = (y * 12 + m0) > (calViewYear * 12 + calViewMonth);
    const same = (y === calViewYear && m0 === calViewMonth);
    calViewYear = y;
    calViewMonth = m0;
    closeMonthEditor();
    renderCalendar(same ? undefined : (forward ? 'next' : 'prev'));
  }

  function applyMonthEditor() {
    const y = parseInt(inputCalYear && inputCalYear.value, 10);
    const m = parseInt(inputCalMonth && inputCalMonth.value, 10);

    if (!Number.isFinite(y) || y < 1970 || y > 2999 || !Number.isFinite(m) || m < 1 || m > 12) {
      alert('년도(1970~2999)와 월(1~12)을 숫자로 입력해 주세요.');
      return;
    }

    goToMonth(y, m - 1);
  }

  if (calMonthLabel) calMonthLabel.addEventListener('click', openMonthEditor);
  if (btnCloseCalMonth) btnCloseCalMonth.addEventListener('click', closeMonthEditor);
  if (calMonthModal) calMonthModal.addEventListener('click', (e) => { if (e.target === calMonthModal) closeMonthEditor(); });
  if (btnCalMonthApply) btnCalMonthApply.addEventListener('click', applyMonthEditor);
  if (btnCalMonthToday) {
    btnCalMonthToday.addEventListener('click', () => {
      const now = new Date();
      goToMonth(now.getFullYear(), now.getMonth());
    });
  }

  [inputCalYear, inputCalMonth].forEach((el) => {
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyMonthEditor(); }
      if (e.key === 'Escape') closeMonthEditor();
    });
  });

  const btnCloseDaySheet = document.getElementById('btnCloseDaySheet');
  if (btnCloseDaySheet) btnCloseDaySheet.addEventListener('click', () => closeSheet('daySheet'));
  const daySheetEl = document.getElementById('daySheet');
  if (daySheetEl) daySheetEl.addEventListener('click', (e) => { if (e.target === daySheetEl) closeSheet('daySheet'); });

  function openDaySheet(year, month, day) {
    const titleEl = document.getElementById('daySheetTitle');
    const listEl = document.getElementById('daySheetList');
    if (!listEl) return;

    if (titleEl) titleEl.textContent = `${year}년 ${month + 1}월 ${day}일 약속`;

    const items = promisesOnDate(year, month, day)
      .sort((a, b) => (a.targetTimestamp || 0) - (b.targetTimestamp || 0));

    listEl.innerHTML = '';
    items.forEach((p) => {
      const status = promiseStatus(p);
      const timeStr = promiseTimeRangeLabel(p);
      const names = promiseParticipantNames(p);
      const lateNames = status !== 'done' ? [] : latePenaltyNames(p);
      const locationDisplay = p.venueName
        ? `${p.venueName} (${p.location || ''})`
        : (p.location || '장소 미정');

      const statusBadge = status !== 'done'
        ? '<span class="badge wait">예정</span>'
        : (lateNames.length > 0 ? '<span class="badge late">지각 발생</span>' : '<span class="badge done">정시 완료</span>');

      const card = document.createElement('div');
      card.className = 'card-item';
      card.innerHTML = `
        <div class="card-header-row">
          <h3 class="card-title">${escapeHtml(p.title || '약속')}</h3>
          ${statusBadge}
        </div>
        <div class="card-info">
          <div class="card-info-item"><i data-lucide="clock"></i> <span class="ci-label">시간</span> <span class="ci-value">${escapeHtml(timeStr)}</span></div>
          <div class="card-info-item"><i data-lucide="map-pin"></i> <span class="ci-label">장소</span> <span class="ci-value">${escapeHtml(locationDisplay)}</span></div>
          <div class="card-info-item"><i data-lucide="users"></i> <span class="ci-label">인원</span> <span class="ci-value">${names.length}명 · ${escapeHtml(names.join(', ') || '-')}</span></div>
          <div class="card-info-item"><i data-lucide="bell-ring"></i> <span class="ci-label">벌칙</span> <span class="ci-value">${lateNames.length > 0 ? escapeHtml(lateNames.join(', ')) : '없음'}</span></div>
        </div>
      `;
      listEl.appendChild(card);
    });

    openSheet('daySheet');
  }

  // DOM Elements
  const onboardingModal = document.getElementById('onboardingModal');
  const settingsModal = document.getElementById('settingsModal');
  const liveMapModal = document.getElementById('liveMapModal');
  const locationPickerModal = document.getElementById('locationPickerModal');
  const leaveConsentModal = document.getElementById('leaveConsentModal');
  const createPromiseModal = document.getElementById('createPromiseModal');

  // Header & Settings Buttons
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnCloseLiveMap = document.getElementById('btnCloseLiveMap');

  // Location Picker Buttons
  const btnOpenMapPicker = document.getElementById('btnOpenMapPicker');
  const btnCloseLocationPicker = document.getElementById('btnCloseLocationPicker');
  const btnConfirmPickLocation = document.getElementById('btnConfirmPickLocation');

  // Leave Consent Buttons
  const btnCloseLeaveConsent = document.getElementById('btnCloseLeaveConsent');
  const btnCancelLeave = document.getElementById('btnCancelLeave');
  const btnConfirmLeave = document.getElementById('btnConfirmLeave');

  // Photo Input File Elements
  const inputOnboardPhoto = document.getElementById('inputOnboardPhoto');
  const onboardPhotoPreview = document.getElementById('onboardPhotoPreview');
  const inputSettingsPhoto = document.getElementById('inputSettingsPhoto');

  // Promise Modals
  const btnOpenCreatePromise = document.getElementById('btnOpenCreatePromise');
  const btnCloseCreatePromise = document.getElementById('btnCloseCreatePromise');
  const btnCancelCreatePromise = document.getElementById('btnCancelCreatePromise');
  const formCreatePromise = document.getElementById('formCreatePromise');

  const btnFetchGPSHome = document.getElementById('btnFetchGPSHome');
  const formOnboarding = document.getElementById('formOnboarding');

  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPages = document.querySelectorAll('.tab-page');


  // ==========================================
  // 1. Photo File Reader Logic
  // ==========================================
  if (inputOnboardPhoto) {
    inputOnboardPhoto.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          customUploadedAvatar = event.target.result;
          if (onboardPhotoPreview) onboardPhotoPreview.src = customUploadedAvatar;
        };
        reader.readAsDataURL(file);
      }
    });
  }

  if (inputSettingsPhoto) {
    inputSettingsPhoto.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const newAvatar = event.target.result;
          if (userProfile) {
            userProfile.avatar = newAvatar;
            saveStorage('pa_user_profile', userProfile);
            updateHeaderProfile();
          }
        };
        reader.readAsDataURL(file);
      }
    });
  }


  // ==========================================
  // 2. Google & Apple Social Auth & Onboarding Account Creation
  // ==========================================
  const btnGoogleAuth = document.getElementById('btnGoogleAuth');
  const btnAppleAuth = document.getElementById('btnAppleAuth');

  if (btnGoogleAuth) {
    let lastHandled = 0;
    const handleGoogleAuth = (e) => {
      const now = Date.now();
      if (now - lastHandled < 400) return;
      lastHandled = now;
      if (e && e.type === 'touchend') e.preventDefault();
      triggerGoogleOAuth();
    };
    btnGoogleAuth.addEventListener('click', handleGoogleAuth);
    btnGoogleAuth.addEventListener('touchend', handleGoogleAuth, { passive: false });
  }

  if (btnAppleAuth) {
    let lastHandled = 0;
    const handleAppleAuth = (e) => {
      const now = Date.now();
      if (now - lastHandled < 400) return;
      lastHandled = now;
      if (e && e.type === 'touchend') e.preventDefault();
      triggerAppleOAuth();
    };
    btnAppleAuth.addEventListener('click', handleAppleAuth);
    btnAppleAuth.addEventListener('touchend', handleAppleAuth, { passive: false });
  }

  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || ('ontouchstart' in window);

  // ── Firebase 초기화를 getRedirectResult 전에 수행 ──────────────────────────
  initFirebaseRealtimeDB();

  // ── 페이지 로드 시 Redirect 결과 수신 (모바일 Safari 지원) ──────────────────
  try {
    if (window.firebase && firebase.auth) {
      firebase.auth().getRedirectResult()
        .then((result) => {
          if (result && result.user) {
            const u = result.user;
            const providerStr = result.credential?.providerId?.includes('apple') ? 'apple' : 'google';
            handleSocialLoginSuccess(providerStr, u.displayName || '사용자', u.email, u.photoURL || DEFAULT_AVATAR);
          }
        })
        .catch((err) => { console.warn("getRedirectResult error:", err); });
    }
  } catch (e) {
    console.warn("Firebase redirect result check failed:", e);
  }

  // ── 소셜 인증 성공 → Firebase에서 기존 계정 탐색 후 분기 ─────────────────
  function handleSocialLoginSuccess(providerStr, oauthName, oauthEmail, oauthAvatar) {
    if (!oauthEmail) {
      goToStep2ProfileSetup(providerStr, oauthName, '', oauthAvatar);
      return;
    }

    const safeEmail = (oauthEmail || '').toLowerCase().trim();
    const safeKey = emailKey(safeEmail);

    const restoreExistingProfile = (foundUser) => {
      userProfile = foundUser;
      // 다른 기기/재설치 후 복구 시에도 현재 로그인 uid 로 갱신한다.
      const liveUid = currentAuthUid();
      if (liveUid) userProfile.uid = liveUid;
      customUploadedAvatar = userProfile.avatar || DEFAULT_AVATAR;
      saveStorage('pa_user_profile', userProfile);
      lastSyncedProfileJson = '';
      syncUserProfileToCloud();
      if (onboardingModal) onboardingModal.classList.remove('active');
      updateHeaderProfile();
      renderAll();
      alert(`🎉 ${userProfile.name} 님, 오신 것을 환영합니다!`);
    };

    if (dbRef) {
      let isHandled = false;
      const finishAsNewUser = () => {
        if (isHandled) return;
        isHandled = true;
        clearTimeout(dbTimeout);
        goToStep2ProfileSetup(providerStr, oauthName, oauthEmail, oauthAvatar);
      };

      const dbTimeout = setTimeout(finishAsNewUser, 2500);

      // 이메일 인덱스 → 사용자 노드 직접 조회 (전체 노드 스캔 금지)
      dbRef.ref('users_by_email/' + safeKey).once('value', (snapshot) => {
        if (isHandled) return;
        const idx = snapshot.val();
        const foundKey = idx && (idx.key || codeKey(idx.code));

        if (!foundKey) {
          finishAsNewUser();
          return;
        }

        dbRef.ref('shared_users/' + foundKey).once('value', (userSnap) => {
          if (isHandled) return;
          const found = userSnap.val();
          if (found && found.name) {
            isHandled = true;
            clearTimeout(dbTimeout);
            restoreExistingProfile(found);
          } else {
            finishAsNewUser();
          }
        }, finishAsNewUser);
      }, finishAsNewUser);
    } else {
      goToStep2ProfileSetup(providerStr, oauthName, oauthEmail, oauthAvatar);
    }
  }

  function formatFirebaseAuthError(err) {
    if (!err) return '알 수 없는 오류가 발생했습니다.';
    const code = err.code || '';
    if (code === 'auth/user-cancelled') {
      return 'Google 로그인 선택이 취소되었거나 Firebase 설정이 미완료 상태입니다.\n\n👉 해결 방법: Firebase Console -> Authentication -> Sign-in method -> Google 클릭 -> [프로젝트 지원 이메일] 항목에 본인 이메일이 선택되어 있는지 확인 후 [저장]을 눌러주세요!';
    }
    if (code === 'auth/operation-not-allowed') {
      return 'Firebase Console에서 로그인 제공업체(Google/Apple)가 활성화되지 않았습니다.\n\n👉 해결 방법: Firebase Console -> Authentication -> Sign-in method 메뉴에서 Google 및 Apple 항목을 [사용 설정]으로 변경해 주세요.';
    }
    if (code === 'auth/unauthorized-domain') {
      return '현재 접속 주소가 Firebase 승인 도메인에 등록되어 있지 않습니다.\n\n👉 해결 방법: Firebase Console -> Authentication -> Settings -> Authorized domains에 현재 접속 주소를 추가해 주세요.';
    }
    if (code === 'auth/popup-blocked') {
      return '브라우저 팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.';
    }
    return err.message || code || '소셜 로그인 실패';
  }

  // ── Google 로그인 버튼 ──────────────────────────────────────────────────────
  function triggerGoogleOAuth() {
    if (!window.firebase || !firebase.auth) {
      alert('Firebase 인증 SDK가 로드되지 않았습니다.');
      return;
    }

    const btn = document.getElementById('btnGoogleAuth');
    if (!btn) return;
    if (!btn.getAttribute('data-orig-html')) {
      btn.setAttribute('data-orig-html', btn.innerHTML);
    }
    const origHTML = btn.getAttribute('data-orig-html');
    btn.innerHTML = '<span style="pointer-events:none;">Google 계정 선택 중...</span>';

    const provider = new firebase.auth.GoogleAuthProvider();
    provider.addScope('email');
    provider.addScope('profile');
    provider.setCustomParameters({ prompt: 'select_account' });

    // 자동 복구 타임아웃 (6초 동안 반응 없으면 버튼 원복)
    const timeoutId = setTimeout(() => {
      if (btn.innerHTML.includes('선택 중') || btn.innerHTML.includes('이동 중')) {
        btn.innerHTML = origHTML;
      }
    }, 6000);

    // 1차 시도: signInWithPopup (모바일 Safari & 데스크탑 공통으로 가장 안정적)
    firebase.auth().signInWithPopup(provider)
      .then((result) => {
        clearTimeout(timeoutId);
        btn.innerHTML = origHTML;
        const u = result.user;
        if (u) handleSocialLoginSuccess('google', u.displayName || 'Google 사용자', u.email, u.photoURL || DEFAULT_AVATAR);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        btn.innerHTML = origHTML;
        if (err.code === 'auth/popup-closed-by-user') return;

        if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
          // 2차 시도: signInWithRedirect
          btn.innerHTML = '<span style="pointer-events:none;">Google 계정으로 이동 중...</span>';
          const rTimeout = setTimeout(() => { btn.innerHTML = origHTML; }, 6000);
          firebase.auth().signInWithRedirect(provider).catch((rErr) => {
            clearTimeout(rTimeout);
            btn.innerHTML = origHTML;
            alert('Google 로그인 오류:\n\n' + formatFirebaseAuthError(rErr));
          });
        } else {
          alert('Google 로그인 오류:\n\n' + formatFirebaseAuthError(err));
        }
      });
  }

  // ── Apple 로그인 버튼 ───────────────────────────────────────────────────────
  function triggerAppleOAuth() {
    if (!window.firebase || !firebase.auth) {
      alert('Firebase 인증 SDK가 로드되지 않았습니다.');
      return;
    }

    const btn = document.getElementById('btnAppleAuth');
    if (!btn) return;
    if (!btn.getAttribute('data-orig-html')) {
      btn.setAttribute('data-orig-html', btn.innerHTML);
    }
    const origHTML = btn.getAttribute('data-orig-html');
    btn.innerHTML = '<span style="pointer-events:none;">Apple 계정 선택 중...</span>';

    const provider = new firebase.auth.OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');

    const timeoutId = setTimeout(() => {
      if (btn.innerHTML.includes('선택 중') || btn.innerHTML.includes('이동 중')) {
        btn.innerHTML = origHTML;
      }
    }, 6000);

    firebase.auth().signInWithPopup(provider)
      .then((result) => {
        clearTimeout(timeoutId);
        btn.innerHTML = origHTML;
        const u = result.user;
        if (u) handleSocialLoginSuccess('apple', u.displayName || 'Apple 사용자', u.email, u.photoURL || DEFAULT_AVATAR);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        btn.innerHTML = origHTML;
        if (err.code === 'auth/popup-closed-by-user') return;

        if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
          btn.innerHTML = '<span style="pointer-events:none;">Apple 계정으로 이동 중...</span>';
          const rTimeout = setTimeout(() => { btn.innerHTML = origHTML; }, 6000);
          firebase.auth().signInWithRedirect(provider).catch((rErr) => {
            clearTimeout(rTimeout);
            btn.innerHTML = origHTML;
            alert('Apple 로그인 오류:\n\n' + formatFirebaseAuthError(rErr));
          });
        } else {
          alert('Apple 로그인 오류:\n\n' + formatFirebaseAuthError(err));
        }
      });
  }

  // ── Step 2: 신규 계정 전용 프로필 설정 화면 ────────────────────────────────
  function goToStep2ProfileSetup(providerStr, defaultName, defaultEmail, avatarUrl) {
    pendingSocialAuth = { provider: providerStr, defaultName, defaultEmail, avatarUrl };

    const step1El = document.getElementById('onboardStep1');
    const formStep2El = document.getElementById('formOnboarding');
    const titleEl = document.getElementById('onboardModalTitle');

    if (titleEl) titleEl.textContent = '프로필 설정 & 약관 동의';
    if (step1El) step1El.style.display = 'none';
    if (formStep2El) formStep2El.style.display = 'block';

    const inputName = document.getElementById('inputOnboardName');
    const photoPreview = document.getElementById('onboardPhotoPreview');

    if (inputName) inputName.value = (defaultName && !['Google 사용자', 'Apple 사용자', '사용자'].includes(defaultName)) ? defaultName : '';
    if (photoPreview) photoPreview.src = avatarUrl || DEFAULT_AVATAR;
    customUploadedAvatar = avatarUrl || DEFAULT_AVATAR;

    if (onboardingModal) onboardingModal.classList.add('active');
    if (window.lucide) window.lucide.createIcons();
  }

  function checkOnboarding() {
    if (userProfile && userProfile.name) {
      // 이미 로컬에 프로필 있으면 Step 1 화면도 안 보이고 바로 메인
      updateHeaderProfile();
      syncUserProfileToCloud();
      return;
    }

    // 소셜 로그인 선택 화면(Step 1)만 표시
    const step1El = document.getElementById('onboardStep1');
    const formStep2El = document.getElementById('formOnboarding');
    const titleEl = document.getElementById('onboardModalTitle');

    if (titleEl) titleEl.textContent = '회원가입';
    if (step1El) step1El.style.display = 'block';
    if (formStep2El) formStep2El.style.display = 'none';

    if (onboardingModal) onboardingModal.classList.add('active');
  }

  // 위치 새로고침 (사용자 제스처 → 권한 재요청 기회)
  function refreshLocation() {
    ipLookupInFlight = false;
    setGpsStatus('📡 위치 다시 확인 중...');
    if (navigator.geolocation && window.isSecureContext) {
      requestPreciseLocation();
      startContinuousGpsWatch();
    } else {
      fetchIpLocation();
    }
  }

  if (btnFetchGPSHome) {
    btnFetchGPSHome.addEventListener('click', refreshLocation);
  }

  function generateUserCode() {
    const chars = '0123456789ABCDEF';
    let code = 'USR-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    code += '-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  if (formOnboarding) {
    formOnboarding.addEventListener('submit', (e) => {
      e.preventDefault();

      const gpsTerms = document.getElementById('checkGpsTerms');
      const privacyTerms = document.getElementById('checkPrivacyTerms');

      if (!gpsTerms?.checked || !privacyTerms?.checked) {
        alert('필수 서비스 이용 약관에 동의해 주세요.');
        return;
      }

      const name = document.getElementById('inputOnboardName').value.trim();
      if (!name) { alert('닉네임을 입력해 주세요.'); return; }

      // 이메일은 OAuth에서 받은 것만 사용 (inputOnboardEmail 없음)
      const email = pendingSocialAuth?.defaultEmail || '';
      const location = '실시간 내 위치';
      const providerStr = pendingSocialAuth?.provider || 'social';
      const userCode = generateUserCode();

      userProfile = {
        name: name,
        email: email,
        avatar: customUploadedAvatar || pendingSocialAuth?.avatarUrl || DEFAULT_AVATAR,
        location: currentAddressText || location,
        code: userCode,
        uid: currentAuthUid() || '',
        authProvider: providerStr,
        termsAgreedAt: new Date().toISOString()
      };

      saveStorage('pa_user_profile', userProfile);
      syncUserProfileToCloud();
      if (onboardingModal) onboardingModal.classList.remove('active');
      updateHeaderProfile();
      renderAll();

      alert(`가입 완료!\n\n닉네임: ${name}`);
    });
  }

  function ensureUserCode() {
    if (!userProfile) return null;
    if (!userProfile.code || typeof userProfile.code !== 'string' || !userProfile.code.trim()) {
      userProfile.code = generateUserCode();
      saveStorage('pa_user_profile', userProfile);
    }
    return userProfile.code;
  }

  function listenToMyCloudData() {
    if (!dbRef || !userProfile) return;
    const myKey = codeKey(ensureUserCode());
    if (!myKey || isCloudDataListening) return;
    isCloudDataListening = true;

    // 1. 나에게 온 친구 요청 감시 (정규 키 단일 경로)
    dbRef.ref('friend_requests/' + myKey).on('value', (snapshot) => {
      const cloudReqs = snapshot.val();
      friendRequestsList = cloudReqs
        ? Object.values(cloudReqs).filter(r => r && r.fromCode)
        : [];
      renderFriendRequests();
    });

    // 2. 수락된 내 친구 목록 실시간 감시 (아이폰 <-> 갤럭시 동기화)
    dbRef.ref('user_friends/' + myKey).on('value', (snapshot) => {
      const cloudFriends = snapshot.val();
      if (cloudFriends) {
        friendsList = Object.values(cloudFriends).filter(Boolean);
        saveStorage('pa_friends_list', friendsList);
      }
      renderFriends();
      populateFriendSelector();
    });
  }

  function syncUserProfileToCloud() {
    if (!userProfile) return;
    const myCode = ensureUserCode();
    if (!myCode) return;

    ensureProfileUid();
    saveStorage('pa_user_profile', userProfile);

    if (dbRef) {
      const myKey = codeKey(myCode);
      if (!myKey) return;

      // uid 가 없으면 보안 규칙에 막힌다. 로그인 완료 후 다시 시도된다.
      if (!userProfile.uid) {
        console.warn('[DB] 로그인 uid 를 아직 확인하지 못해 프로필 동기화를 보류합니다.');
        return;
      }

      // 초기화 경로가 여러 개라 동일 프로필이 반복 write 되는 것을 막는다.
      const payload = JSON.stringify(userProfile);
      if (payload !== lastSyncedProfileJson) {
        lastSyncedProfileJson = payload;

        // 정규 키(core) 하나만 사용한다. 과거처럼 3중 키로 중복 저장하지 않는다.
        dbWrite('shared_users/' + myKey, userProfile);

        // uid -> 친구코드 역인덱스. 보안 규칙이 "이 사람이 내 친구인가"를 판단하는 데 쓴다.
        dbWrite('uid_to_code/' + userProfile.uid, myKey);

        // 계정 복구용 이메일 인덱스 (전체 노드 스캔 대체)
        if (userProfile.email) {
          dbWrite('users_by_email/' + emailKey(userProfile.email), {
            code: userProfile.code,
            key: myKey,
            uid: userProfile.uid
          });
        }
      }
      listenToMyCloudData();
    }
  }

  function syncFriendsToCloud() {
    saveStorage('pa_friends_list', friendsList);
    const myKey = codeKey(ensureUserCode());
    if (dbRef && myKey) {
      const friendsObj = {};
      friendsList.forEach(f => {
        const fKey = codeKey(f && f.code);
        if (fKey) friendsObj[fKey] = f;
      });
      dbWrite('user_friends/' + myKey, friendsObj);
    }
  }

  function updateHeaderProfile() {
    if (!userProfile) return;
    const myCode = ensureUserCode();

    const headerNameEl = document.getElementById('headerUserName');
    if (headerNameEl) headerNameEl.textContent = userProfile.name;
    const headerAvatar = document.getElementById('headerUserAvatar');
    if (headerAvatar) headerAvatar.src = userProfile.avatar || DEFAULT_AVATAR;

    const settingsAvatar = document.getElementById('settingsAvatarImg');
    if (settingsAvatar) settingsAvatar.src = userProfile.avatar || DEFAULT_AVATAR;
    const settingsNameEl = document.getElementById('settingsNameText');
    if (settingsNameEl) settingsNameEl.textContent = userProfile.name;
    const settingsLocEl = document.getElementById('settingsLocText');
    if (settingsLocEl) settingsLocEl.textContent = userProfile.location || '실시간 내 위치';

    // 친구 코드/친구 추가 UI 는 [친구 관리] 탭에만 둔다.
    const tabCodeEl = document.getElementById('tabMyCodeText');
    if (tabCodeEl) tabCodeEl.textContent = myCode;

    syncUserProfileToCloud();
    listenToMyCloudData();
  }


  // ==========================================
  // 3. Map Location Picker Modal
  // ==========================================
  if (btnOpenMapPicker) {
    btnOpenMapPicker.addEventListener('click', () => {
      createPromiseModal.classList.remove('active');
      locationPickerModal.classList.add('active');
      
      document.getElementById('pickedVenueName').value = '';

      const defaultLat = userRealGpsLat || 37.5665;
      const defaultLng = userRealGpsLng || 126.9780;

      setTimeout(() => {
        if (!pickerMapInstance) {
          pickerMapInstance = L.map('pickerMapContainer').setView([defaultLat, defaultLng], 16);
          
          L.tileLayer('https://mt1.google.com/vt/lyrs=m&hl=ko&gl=kr&x={x}&y={y}&z={z}', {
            maxZoom: 20,
            attribution: '© Naver Style Map'
          }).addTo(pickerMapInstance);

          pickedMarker = L.marker([defaultLat, defaultLng], { draggable: true }).addTo(pickerMapInstance);
          selectedPickedLat = defaultLat;
          selectedPickedLng = defaultLng;

          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => {
              const uLat = pos.coords.latitude;
              const uLng = pos.coords.longitude;
              pickerMapInstance.setView([uLat, uLng], 16);
              pickedMarker.setLatLng([uLat, uLng]);
              selectedPickedLat = uLat;
              selectedPickedLng = uLng;
              reverseGeocodePicker(uLat, uLng);
            });
          }

          pickerMapInstance.on('click', (e) => {
            const lat = e.latlng.lat;
            const lng = e.latlng.lng;
            pickedMarker.setLatLng([lat, lng]);
            selectedPickedLat = lat;
            selectedPickedLng = lng;
            reverseGeocodePicker(lat, lng);
          });

          pickedMarker.on('dragend', () => {
            const pos = pickedMarker.getLatLng();
            selectedPickedLat = pos.lat;
            selectedPickedLng = pos.lng;
            reverseGeocodePicker(pos.lat, pos.lng);
          });

          reverseGeocodePicker(defaultLat, defaultLng);
        } else {
          pickerMapInstance.invalidateSize();
          if (userRealGpsLat && userRealGpsLng) {
            pickerMapInstance.setView([userRealGpsLat, userRealGpsLng], 16);
            pickedMarker.setLatLng([userRealGpsLat, userRealGpsLng]);
          }
        }
      }, 100);
    });
  }

  function reverseGeocodePicker(lat, lng) {
    document.getElementById('pickedAddressResult').value = '주소 찾는 중...';
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=ko&addressdetails=1&zoom=18`)
      .then(res => res.json())
      .then(data => {
        selectedPickedAddress = formatNominatimAddress(data);
        document.getElementById('pickedAddressResult').value = `${selectedPickedAddress} [${lat.toFixed(5)}, ${lng.toFixed(5)}]`;
      })
      .catch(() => {
        selectedPickedAddress = `선택된 위치 [${lat.toFixed(5)}, ${lng.toFixed(5)}]`;
        document.getElementById('pickedAddressResult').value = selectedPickedAddress;
      });
  }

  // 선택한 약속 장소를 숨은 입력값과 화면 표시 텍스트에 함께 반영한다.
  function setPromiseLocationValue(address) {
    const input = document.getElementById('inputPromiseLocation');
    const textEl = document.getElementById('promiseLocationText');
    const value = String(address || '');
    if (input) input.value = value;
    if (textEl) textEl.textContent = value;
  }

  function closeLocationPickerAndRestorePromiseModal() {
    locationPickerModal.classList.remove('active');
    createPromiseModal.classList.add('active');
  }

  if (btnCloseLocationPicker) {
    btnCloseLocationPicker.addEventListener('click', closeLocationPickerAndRestorePromiseModal);
  }

  if (btnConfirmPickLocation) {
    btnConfirmPickLocation.addEventListener('click', () => {
      if (selectedPickedAddress) {
        setPromiseLocationValue(selectedPickedAddress);
      }
      const customVenue = document.getElementById('pickedVenueName').value.trim();
      if (customVenue) {
        document.getElementById('inputPromiseVenueName').value = customVenue;
      } else {
        document.getElementById('inputPromiseVenueName').value = '';
      }
      closeLocationPickerAndRestorePromiseModal();
    });
  }


  // ==========================================
  // 4. Settings Gear Modal (프로필 수정 & 로그아웃 기능)
  // ==========================================
  if (btnOpenSettings) {
    btnOpenSettings.addEventListener('click', () => {
      updateHeaderProfile();
      if (userProfile) {
        const nameInput = document.getElementById('inputSettingsName');
        if (nameInput) nameInput.value = userProfile.name || '';
      }
      settingsModal.classList.add('active');
      if (window.lucide) window.lucide.createIcons();
    });
  }
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', () => settingsModal.classList.remove('active'));

  // 프로필 저장 버튼 (닉네임 수정)
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', () => {
      if (!userProfile) return;
      const newName = document.getElementById('inputSettingsName').value.trim();
      if (newName) userProfile.name = newName;

      saveStorage('pa_user_profile', userProfile);
      syncUserProfileToCloud();
      updateHeaderProfile();
      renderAll();
      settingsModal.classList.remove('active');
      alert('프로필이 저장되었습니다.');
    });
  }

  // 로그아웃 버튼
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      if (confirm('로그아웃 하시겠습니까?')) {
        // Firebase 세션도 종료
        if (window.firebase && firebase.auth) {
          firebase.auth().signOut().catch(() => {});
        }
        localStorage.removeItem('pa_user_profile');
        userProfile = null;
        settingsModal.classList.remove('active');
        const headerNameEl = document.getElementById('headerUserName');
        if (headerNameEl) headerNameEl.textContent = '내 프로필';
        document.getElementById('headerUserAvatar').src = DEFAULT_AVATAR;
        // checkOnboarding()으로 Step 1 (Google/Apple 선택 화면) 정상 표시
        checkOnboarding();
      }
    });
  }

  const btnCopyTabCode = document.getElementById('btnCopyTabCode');
  if (btnCopyTabCode) btnCopyTabCode.addEventListener('click', () => copyCodeToClipboard(userProfile?.code));

  function copyCodeToClipboard(codeText) {
    const code = codeText || userProfile?.code;
    if (!code) return;
    syncUserProfileToCloud();
    navigator.clipboard.writeText(code).then(() => {
      alert(`📋 내 친구 코드 ${code} 가 복사되었습니다!\n(서버 등록 완료 - 친구에게 코드를 전달해 주세요)`);
    }).catch(() => {
      alert(`📋 내 친구 코드: ${code}`);
    });
  }

  function processAddFriend(codeInputEl) {
    if (!codeInputEl) return;
    const rawVal = codeInputEl.value.trim();
    if (!rawVal) {
      alert('친구 코드를 입력해 주세요.');
      return;
    }

    if (!userProfile) {
      alert('프로필 등록 후 친구를 추가할 수 있습니다.');
      return;
    }

    const myCode = ensureUserCode();
    // 1. 입력 문자열 정규화 (공백, 하이픈, 유니코드 대시 제거 및 대문자 변환)
    const target = normalizeCode(rawVal);
    if (!target.core) {
      alert('올바른 형식의 친구 코드를 입력해 주세요.');
      return;
    }

    // 2. 본인 코드 입력 방지 검사
    const mine = normalizeCode(myCode);
    if (target.core === mine.core) {
      alert('자기 자신의 코드는 등록할 수 없습니다.');
      return;
    }

    // 3. 이미 등록된 친구 검사
    const existing = friendsList.find(f => {
      if (!f) return false;
      return codeKey(f.code) === target.core
        || (f.email && f.email.toLowerCase() === rawVal.toLowerCase());
    });

    if (existing) {
      alert(`이미 등록된 친구입니다 (${existing.name}).`);
      return;
    }

    // 4. 버튼 로딩 상태 표시
    const submitBtn = codeInputEl.nextElementSibling || document.getElementById('btnTabAddFriendByCode') || document.getElementById('btnAddFriendByCode');
    const origBtnHTML = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i data-lucide="loader" class="spin"></i> 검색 중...';
      if (window.lucide) window.lucide.createIcons();
    }

    const restoreBtn = () => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = origBtnHTML;
        if (window.lucide) window.lucide.createIcons();
      }
    };

    if (!dbRef) {
      restoreBtn();
      alert('서버 연결 중입니다. 잠시 후 다시 시도해 주세요.');
      return;
    }

    let isHandled = false;
    const timeoutId = setTimeout(() => {
      if (!isHandled) {
        isHandled = true;
        restoreBtn();
        alert('❌ 존재하지 않는 친구 코드이거나 서버 응답 시간이 초과되었습니다.\n\n💡 상대방 스마트폰 화면에서 내 친구 코드 복사를 누른 후 다시 시도해 보세요!');
      }
    }, 12000);

    const failNotFound = () => {
      if (isHandled) return;
      isHandled = true;
      clearTimeout(timeoutId);
      restoreBtn();
      alert(`❌ ${rawVal} 친구 코드를 찾을 수 없습니다.\n\n💡 상대방 스마트폰 앱에서 내 친구 코드가 정상적으로 화면에 떠있는지 확인해 주세요!`);
    };

    // 정규 키 단일 조회. 이메일 입력인 경우 이메일 인덱스로 우회 조회한다.
    function lookupByCode() {
      dbRef.ref('shared_users/' + target.core).once('value', (snap) => {
        if (isHandled) return;
        const found = snap.val();
        if (found && found.name && found.code) {
          onUserFound(found);
        } else if (rawVal.includes('@')) {
          lookupByEmail();
        } else {
          failNotFound();
        }
      }, () => {
        if (isHandled) return;
        isHandled = true;
        clearTimeout(timeoutId);
        restoreBtn();
        alert('❌ 서버 연결 실패. 인터넷 연결 상태를 확인해 주세요.');
      });
    }

    function lookupByEmail() {
      dbRef.ref('users_by_email/' + emailKey(rawVal)).once('value', (idxSnap) => {
        if (isHandled) return;
        const idx = idxSnap.val();
        const foundKey = idx && (idx.key || codeKey(idx.code));
        if (!foundKey) { failNotFound(); return; }

        dbRef.ref('shared_users/' + foundKey).once('value', (uSnap) => {
          if (isHandled) return;
          const found = uSnap.val();
          if (found && found.name && found.code) onUserFound(found);
          else failNotFound();
        }, failNotFound);
      }, failNotFound);
    }

    function onUserFound(targetUser) {
      if (isHandled) return;
      isHandled = true;
      clearTimeout(timeoutId);
      restoreBtn();

      const reqData = {
        fromCode: myCode,
        fromUid: ensureProfileUid() || '',
        fromName: userProfile ? userProfile.name : '친구',
        fromEmail: userProfile ? (userProfile.email || '') : '',
        fromAvatar: userProfile ? (userProfile.avatar || DEFAULT_AVATAR) : DEFAULT_AVATAR,
        fromLoc: userProfile ? (userProfile.location || '친구 요청') : '친구 요청',
        toCode: targetUser.code,
        timestamp: Date.now()
      };

      // 상대방의 정규 키 노드로 친구 요청 전송
      const targetKey = codeKey(targetUser.code);
      if (targetKey) {
        dbWrite('friend_requests/' + targetKey + '/' + mine.core, reqData);
      }

      codeInputEl.value = '';
      if (settingsModal) settingsModal.classList.remove('active');
      alert(`📩 ${targetUser.name} 님에게 친구 요청을 보냈습니다!\n\n상대방 스마트폰 화면의 받은 친구 요청에서 수락을 누르면 바로 연결됩니다.`);
    }

    if (rawVal.includes('@')) lookupByEmail();
    else lookupByCode();
  }

  const btnTabAddFriendByCode = document.getElementById('btnTabAddFriendByCode');
  if (btnTabAddFriendByCode) {
    btnTabAddFriendByCode.addEventListener('click', () => {
      processAddFriend(document.getElementById('inputTabAddFriendCode'));
    });
  }


  // ==========================================
  // 5. Tab Navigation & Promise Rendering
  // ==========================================
  let activeTabIndex = 0;

  // 초대받은 약속 버튼은 약속 목록 탭에서만, 친구 요청 버튼은 친구 관리 탭에서만 보인다.
  function updateFabVisibility(tabId) {
    const fabInvites = document.getElementById('fabInvites');
    const fabFriendReqs = document.getElementById('fabFriendReqs');
    if (fabInvites) fabInvites.style.display = tabId === 'tabPromises' ? 'flex' : 'none';
    if (fabFriendReqs) fabFriendReqs.style.display = tabId === 'tabFriends' ? 'flex' : 'none';
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      const nextIndex = Array.prototype.indexOf.call(tabBtns, btn);
      if (nextIndex === activeTabIndex && btn.classList.contains('active')) return;

      // 탭 순서 기준으로 슬라이드 방향 결정
      const fromRight = nextIndex > activeTabIndex;
      activeTabIndex = nextIndex;

      tabBtns.forEach(b => b.classList.remove('active'));
      tabPages.forEach(p => p.classList.remove('active', 'slide-from-right', 'slide-from-left'));

      btn.classList.add('active');
      const targetEl = document.getElementById(targetTab);
      if (targetEl) {
        targetEl.classList.add('active', fromRight ? 'slide-from-right' : 'slide-from-left');
        const main = document.querySelector('.app-main');
        if (main) main.scrollTop = 0;
      }

      updateFabVisibility(targetTab);
      if (targetTab === 'tabHistory') renderCalendar();
    });
  });

  updateFabVisibility('tabPromises');

  function renderAll() {
    renderPromises();
    renderFriendRequests();
    renderFriends();
    const historyTab = document.getElementById('tabHistory');
    if (historyTab && historyTab.classList.contains('active')) renderCalendar();
  }

  function renderFriendRequests() {
    const section = document.getElementById('friendRequestsSection');
    const container = document.getElementById('friendRequestsList');
    if (!section || !container) return;

    updateInboxBadges();

    if (!friendRequestsList || friendRequestsList.length === 0) {
      container.innerHTML = `<p style="color:var(--text-dim); text-align:center; padding:24px 12px; font-size:0.84rem;">받은 친구 요청이 없습니다.</p>`;
      return;
    }

    container.innerHTML = '';

    friendRequestsList.forEach(req => {
      const card = document.createElement('div');
      card.className = 'card-item';
      card.style.background = 'var(--yellow-soft)';
      card.style.borderColor = 'var(--yellow)';
      card.style.padding = '12px 14px';

      card.innerHTML = `
        <div class="card-header-row" style="display:flex; align-items:center; gap:10px;">
          <img src="${safeImageUrl(req.fromAvatar)}" style="width:38px; height:38px; border-radius:50%; border:2px solid var(--primary); object-fit:cover;">
          <div>
            <div style="font-weight:700; color: var(--text-main); font-size:0.9rem;">${escapeHtml(req.fromName || '친구')}</div>
            <div style="font-size:0.75rem; color: var(--text-muted);">코드: ${escapeHtml(req.fromCode || '')}</div>
          </div>
          <span class="badge wait" style="margin-left:auto; background:var(--yellow-soft); color:var(--yellow); border:1px solid var(--yellow); font-size:0.72rem; padding:3px 8px;">친구요청 도착</span>
        </div>
        <div class="card-action-row" style="margin-top:10px; display:flex; gap:8px;">
          <button class="btn-primary btn-accept-friend-req" data-code="${escapeHtml(req.fromCode)}" style="flex:1; background:var(--green); font-weight:700; padding:8px; font-size:0.82rem;">
            <i data-lucide="check"></i> 수락
          </button>
          <button class="btn-secondary btn-reject-friend-req" data-code="${escapeHtml(req.fromCode)}" style="flex:1; color:var(--red); border-color:var(--border-color); background:var(--border-color); font-weight:700; padding:8px; font-size:0.82rem;">
            <i data-lucide="x"></i> 거절
          </button>
        </div>
      `;

      container.appendChild(card);
    });

    if (window.lucide) window.lucide.createIcons();

    document.querySelectorAll('.btn-accept-friend-req').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fromCode = e.currentTarget.getAttribute('data-code');
        acceptFriendRequest(fromCode);
      });
    });

    document.querySelectorAll('.btn-reject-friend-req').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fromCode = e.currentTarget.getAttribute('data-code');
        rejectFriendRequest(fromCode);
      });
    });
  }

  function acceptFriendRequest(fromCode) {
    const req = friendRequestsList.find(r => r.fromCode === fromCode);
    if (!req) return;

    const myCode = ensureUserCode();
    if (!myCode) return;

    const friendForMe = {
      id: 'f_' + Date.now(),
      name: req.fromName || '친구',
      code: req.fromCode,
      uid: req.fromUid || '',
      email: req.fromEmail || '',
      avatar: req.fromAvatar || DEFAULT_AVATAR,
      homeLoc: req.fromLoc || '내 친구'
    };

    const friendForThem = {
      id: 'f_' + Date.now(),
      name: userProfile.name,
      code: myCode,
      uid: ensureProfileUid() || '',
      email: userProfile.email || '',
      avatar: userProfile.avatar || DEFAULT_AVATAR,
      homeLoc: userProfile.location || '내 친구'
    };

    if (!friendsList.find(f => f.code === req.fromCode)) {
      friendsList.push(friendForMe);
    }

    if (dbRef) {
      const myKey = codeKey(myCode);
      const fromKey = codeKey(req.fromCode);

      if (myKey && fromKey) {
        dbWrite('user_friends/' + myKey + '/' + fromKey, friendForMe);
        // 상대방 목록에는 "내 uid 가 담긴 내 정보"만 쓸 수 있다 (규칙에서 검사)
        dbWrite('user_friends/' + fromKey + '/' + myKey, friendForThem);
        dbWrite('friend_requests/' + myKey + '/' + fromKey, null);
      }
    }

    syncFriendsToCloud();
    friendRequestsList = friendRequestsList.filter(r => r.fromCode !== fromCode);
    renderAll();
    alert(`🎉 ${req.fromName} 님의 친구 요청을 수락했습니다! 상호 친구로 등록되었습니다.`);
  }

  function rejectFriendRequest(fromCode) {
    const myKey = codeKey(ensureUserCode());
    if (!myKey) return;

    if (dbRef) {
      const fromKey = codeKey(fromCode);
      if (fromKey) dbWrite('friend_requests/' + myKey + '/' + fromKey, null);
    }

    friendRequestsList = friendRequestsList.filter(r => r.fromCode !== fromCode);
    renderAll();
  }

  function renderPromises() {
    const listContainer = document.getElementById('promisesList');
    const invitationsList = document.getElementById('invitationsList');

    if (!listContainer) return;
    listContainer.innerHTML = '';
    if (invitationsList) invitationsList.innerHTML = '';

    const myName = userProfile ? userProfile.name : '나';

    // Separate My Promises vs Invited Promises
    // 초대장 = members 에는 있지만 아직 참가(attendees) 하지 않은 약속
    const invitedPromises = promisesList.filter(p => amIMemberOf(p) && !amIAttendeeOf(p) && !declinedPromiseIds.includes(p.id) && !isPromiseDone(p));
    // 종료 시간이 지난 약속은 목록에서 내려가고 캘린더 기록으로만 남는다.
    const joinedPromises = promisesList.filter(p => amIAttendeeOf(p) && !isPromiseDone(p));
    const doneCount = promisesList.filter(p => amIAttendeeOf(p) && isPromiseDone(p)).length;

    invitedCount = invitedPromises.length;
    updateInboxBadges();

    // Render Invitations Section (바텀 시트 안에 렌더)
    if (invitationsList) {
      if (invitedPromises.length === 0) {
        invitationsList.innerHTML = `<p style="color:var(--text-dim); text-align:center; padding:24px 12px; font-size:0.84rem;">초대받은 약속이 없습니다.</p>`;
      }

      invitedPromises.forEach(p => {
        const invCard = document.createElement('div');
        invCard.className = 'card-item';
        invCard.style.borderColor = 'var(--yellow)';
        invCard.style.background = 'var(--yellow-soft)';

        const locationDisplay = p.venueName
          ? `<strong>${escapeHtml(p.venueName)}</strong> (${escapeHtml(p.location)})`
          : escapeHtml(p.location);

        invCard.innerHTML = `
          <div class="card-header-row">
            <h3 class="card-title" style="color:var(--yellow);">📩 ${escapeHtml(p.title)} (초대장)</h3>
            <span class="badge wait">초대 대기중</span>
          </div>
          <div class="card-info">
            <div class="card-info-item"><i data-lucide="user"></i> <span class="ci-label">주최자</span> <span class="ci-value">${escapeHtml(p.hostName || '친구')}</span></div>
            <div class="card-info-item"><i data-lucide="map-pin"></i> <span class="ci-label">위치</span> <span class="ci-value">${locationDisplay}</span></div>
            <div class="card-info-item"><i data-lucide="clock"></i> <span class="ci-label">시간</span> <span class="ci-value">${escapeHtml(promiseTimeRangeLabel(p))}</span></div>
            <div class="card-info-item"><i data-lucide="${p.penaltyType === 'vibrate' ? 'vibrate' : 'bell-ring'}"></i> <span class="ci-label">지각 벌칙</span> <span class="ci-value">${escapeHtml(penaltyLabel(p))}</span></div>
          </div>
          <div class="card-action-row" style="margin-top:10px;">
            <button class="btn-primary btn-join-invite" data-id="${escapeHtml(p.id)}" style="flex:1; background:var(--green);">
              <i data-lucide="check"></i> ✅ 약속 참가하기
            </button>
            <button class="btn-secondary btn-decline-invite" data-id="${escapeHtml(p.id)}" style="flex:1; color:var(--red);">
              <i data-lucide="x"></i> ❌ 거절하기
            </button>
          </div>
        `;

        invitationsList.appendChild(invCard);
      });

      document.querySelectorAll('.btn-join-invite').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const pId = e.currentTarget.getAttribute('data-id');
          const found = promisesList.find(item => item.id === pId);
          if (found) {
            writeMyAttendance(found);
            declinedPromiseIds = declinedPromiseIds.filter(id => id !== pId);
            saveStorage('pa_declined_promises', declinedPromiseIds);
            renderAll();
            alert(`🎉 "${found.title}" 약속 참가가 완료되었습니다!`);
          }
        });
      });

      document.querySelectorAll('.btn-decline-invite').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const pId = e.currentTarget.getAttribute('data-id');
          const found = promisesList.find(item => item.id === pId);
          if (found) {
            detachMyselfFromPromise(found);
            promisesList = promisesList.filter(item => item.id !== pId);
            renderAll();
          }
        });
      });
    }


    // Render Joined Promises
    if (joinedPromises.length === 0) {
      listContainer.innerHTML = `<p style="color: var(--text-dim); text-align:center; padding:40px 20px;">예정된 약속이 없습니다.${doneCount > 0 ? `<br><span style="font-size:0.8rem;">완료된 약속 ${doneCount}건은 캘린더 탭에서 볼 수 있습니다.</span>` : ''}</p>`;
      return;
    }

    joinedPromises.forEach(p => {
      const card = document.createElement('div');
      card.className = 'card-item';

      const participantsList = promiseParticipantNames(p).length > 0 ? promiseParticipantNames(p) : [myName];
      const friendPills = participantsList.map(name => `<span class="friend-pill">${escapeHtml(name)}</span>`).join('');
      const isHostOfThis = amIHostOf(p);


      const mapButtonHtml = `
        <button class="btn-map-view btn-open-map" data-id="${escapeHtml(p.id)}">
          <i data-lucide="map-pin"></i> 실시간 위치보기
        </button>
      `;

      let distStr = '위치 확인 중';
      let isCurrentlyWithinRadius = false;
      const arrivalRadius = p.arrivalRadiusMeters || 300;

      if (hasLocationFix() && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        const distMeters = calculateHaversineDistance(userRealGpsLat, userRealGpsLng, p.lat, p.lng);
        distStr = distMeters > 1000 ? `${(distMeters / 1000).toFixed(1)} km` : `${Math.round(distMeters)} m`;
        // IP 추정 위치는 오차가 수 km 라서 거리값을 단정하지 않는다.
        if (gpsSource === 'ip') distStr += ' (대략)';
        // 도착 처리는 정확도가 확보된 실측 GPS 에서만 인정한다.
        isCurrentlyWithinRadius = distMeters <= arrivalRadius && isPreciseFix();
      }

      // 반경 진입 시 1회만 도착 처리
      if (isCurrentlyWithinRadius) markArrival(p);

      const leaveBtnHtml = `<button class="btn-leave-promise btn-leave-trigger" data-id="${escapeHtml(p.id)}">
        <i data-lucide="log-out"></i> 약속 나가기
      </button>`;

      const locationDisplay = p.venueName
        ? `<strong>${escapeHtml(p.venueName)}</strong> (${escapeHtml(p.location)})`
        : escapeHtml(p.location);

      card.innerHTML = `
        <div class="card-header-row">
          <h3 class="card-title">${escapeHtml(p.title)}</h3>
          <div class="card-header-right">
            ${countdownBadgeHtml(p)}
            ${isHostOfThis ? `<button class="btn-delete-promise btn-delete-trigger" data-id="${escapeHtml(p.id)}" title="약속 삭제 (호스트 전용)">
              <i data-lucide="trash-2"></i>
            </button>` : ''}
          </div>
        </div>
        <div class="card-info">
          <div class="card-info-item"><i data-lucide="map-pin"></i> <span class="ci-label">위치</span> <span class="ci-value">${locationDisplay}</span> <span class="ci-tail">${escapeHtml(distStr)}</span></div>
          <div class="card-info-item"><i data-lucide="clock"></i> <span class="ci-label">시간</span> <span class="ci-value">${escapeHtml(promiseTimeRangeLabel(p))}</span></div>
          <div class="card-info-item"><i data-lucide="${p.penaltyType === 'vibrate' ? 'vibrate' : 'bell-ring'}"></i> <span class="ci-label">지각 벌칙</span> <span class="ci-value">${escapeHtml(penaltyLabel(p))}</span></div>
          <div class="card-info-item"><i data-lucide="eye"></i> <span class="ci-label">위치 공개</span> <span class="ci-value">${escapeHtml(locationRevealLabel(p))}</span></div>
          <div style="margin-top:6px;">
            <span style="font-size:0.75rem; color: var(--text-dim);">참가자:</span>
            <div class="friends-tags">${friendPills}</div>
          </div>
        </div>
        ${mapButtonHtml}
        <div class="card-action-row" style="margin-top:6px;">
          ${leaveBtnHtml}
        </div>
      `;

      listContainer.appendChild(card);
    });

    if (window.lucide) window.lucide.createIcons();

    // Event Handlers
    document.querySelectorAll('.btn-open-map').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const pId = e.currentTarget.getAttribute('data-id');
        const found = promisesList.find(item => item.id === pId);
        if (found) openLiveMapModal(found);
      });
    });

    document.querySelectorAll('.btn-delete-trigger').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const promiseId = e.currentTarget.getAttribute('data-id');
        if (confirm('이 약속을 삭제하시겠습니까?')) {
          const target = promisesList.find(item => item.id === promiseId);
          promisesList = promisesList.filter(item => item.id !== promiseId);
          removePromiseFromCloud(promiseId, target);
          renderAll();
        }
      });
    });

    document.querySelectorAll('.btn-leave-trigger').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const promiseId = e.currentTarget.getAttribute('data-id');
        const found = promisesList.find(item => item.id === promiseId);
        if (found) {
          if (found.leaveRule === 'free') {
            if (confirm(`"${found.title}" 약속에서 즉시 나가시겠습니까?`)) {
              leavePromise(found);
              renderAll();
              alert(`🚪 "${found.title}" 약속에서 나갔습니다.`);
            }
          } else {
            openLeaveConsentModal(found);
          }
        }
      });
    });
  }

  // ==========================================
  // INTERACTIVE CONSENT-BASED LEAVE SYSTEM
  // ==========================================
  function openLeaveConsentModal(promiseObj) {
    activePromiseForLeave = promiseObj;
    document.getElementById('leaveModalTitle').textContent = `"${promiseObj.title}" 약속에서 나가시겠습니까?`;

    const consentContainer = document.getElementById('consentStatusList');
    consentContainer.innerHTML = '';

    const otherParticipants = promiseParticipantNames(promiseObj).filter(name => name !== (userProfile?.name || '나'));

    if (otherParticipants.length === 0) {
      consentContainer.innerHTML = `<div class="distance-item near"><span>다른 참가자가 없어 즉시 나갈 수 있습니다.</span><span style="color:var(--green);">✓ 승인됨</span></div>`;
    } else {
      otherParticipants.forEach(name => {
        const row = document.createElement('div');
        row.className = 'part-item';
        row.innerHTML = `
          <span>👥 <strong>${escapeHtml(name)}</strong></span>
          <select class="status-select consent-select">
            <option value="approved">✓ 허락함 (동의 승인)</option>
            <option value="pending">⏳ 동의 대기 중</option>
            <option value="rejected">❌ 거절 (나가기 불가)</option>
          </select>
        `;
        consentContainer.appendChild(row);
      });
    }

    leaveConsentModal.classList.add('active');
  }

  if (btnCloseLeaveConsent) btnCloseLeaveConsent.addEventListener('click', () => leaveConsentModal.classList.remove('active'));
  if (btnCancelLeave) btnCancelLeave.addEventListener('click', () => leaveConsentModal.classList.remove('active'));

  if (btnConfirmLeave) {
    btnConfirmLeave.addEventListener('click', () => {
      if (!activePromiseForLeave) return;

      const consentSelects = document.querySelectorAll('.consent-select');
      let allApproved = true;

      consentSelects.forEach(sel => {
        if (sel.value !== 'approved') allApproved = false;
      });

      if (!allApproved && consentSelects.length > 0) {
        alert('⚠️ 다른 참가자의 동의 허락(승인)이 있어야 약속에서 나갈 수 있습니다.');
        return;
      }

      const myName = userProfile ? userProfile.name : '나';
      leavePromise(activePromiseForLeave);

      leaveConsentModal.classList.remove('active');
      renderAll();
      alert(`🚪 다른 참가자들의 동의 허락을 받아 "${activePromiseForLeave.title}" 약속에서 나갔습니다.`);
    });
  }


  // ==========================================
  // NAVER MAP TILE LIVE ENGINE
  // ==========================================
  function openLiveMapModal(promiseObj) {
    activePromiseForMap = promiseObj;
    const targetTitle = promiseObj.venueName ? `${promiseObj.venueName} (${promiseObj.location})` : promiseObj.location;
    document.getElementById('mapTargetLocText').textContent = targetTitle;
    liveMapModal.classList.add('active');

    // 약속 좌표는 생성 시 지도에서 찍은 값이 정답이다. 주소 재검색으로 덮어쓰지 않는다.
    if (Number.isFinite(promiseObj.lat) && Number.isFinite(promiseObj.lng)) {
      renderZenlyLiveMap(promiseObj, promiseObj.lat, promiseObj.lng);
      return;
    }

    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(promiseObj.location)}&limit=1`)
      .then(res => res.json())
      .then(data => {
        let venueLat = promiseObj.lat;
        let venueLng = promiseObj.lng;

        if (data && data.length > 0) {
          venueLat = parseFloat(data[0].lat);
          venueLng = parseFloat(data[0].lon);
          promiseObj.lat = venueLat;
          promiseObj.lng = venueLng;
        }

        renderZenlyLiveMap(promiseObj, venueLat, venueLng);
      })
      .catch(() => {
        renderZenlyLiveMap(promiseObj, promiseObj.lat || userRealGpsLat || 37.5665, promiseObj.lng || userRealGpsLng || 126.9780);
      });
  }

  function renderZenlyLiveMap(promiseObj, venueLat, venueLng) {
    setTimeout(() => {
      if (!leafletMapInstance) {
        leafletMapInstance = L.map('mapViewContainer').setView([venueLat, venueLng], 16);
        
        L.tileLayer('https://mt1.google.com/vt/lyrs=m&hl=ko&gl=kr&x={x}&y={y}&z={z}', {
          maxZoom: 20,
          attribution: '© Naver Style Map'
        }).addTo(leafletMapInstance);
      } else {
        leafletMapInstance.invalidateSize();
        leafletMapInstance.setView([venueLat, venueLng], 16);
      }

      leafletMapInstance.eachLayer((layer) => {
        if (layer instanceof L.Marker || layer instanceof L.Circle || layer instanceof L.CircleMarker) {
          leafletMapInstance.removeLayer(layer);
        }
      });

      // 도착 인정 반경: 옅은 초록 원
      const arrivalRadius = promiseObj.arrivalRadiusMeters || 200;
      L.circle([venueLat, venueLng], {
        radius: arrivalRadius,
        color: '#22c55e',
        fillColor: '#22c55e',
        fillOpacity: 0.12,
        weight: 1.5,
        opacity: 0.5
      }).addTo(leafletMapInstance);

      // 약속 장소: 깔끔한 깃발 마커
      addVenueFlagMarker(promiseObj, venueLat, venueLng);

      // 공개 시점 전에는 장소만 보여주고 참가자 개인정보(위치·GPS·거리)는 노출하지 않는다.
      if (!isLocationRevealed(promiseObj)) {
        renderLocationHiddenPanel(promiseObj);
        return;
      }

      const myName = userProfile ? userProfile.name : '나';
      const myAvatar = userProfile ? userProfile.avatar : DEFAULT_AVATAR;

      // 내 위치는 위치 엔진의 현재 상태를 그대로 쓴다. (지도에서 별도 GPS 호출을 하지 않음)
      const meParticipantObj = {
        name: myName,
        avatar: myAvatar || DEFAULT_AVATAR,
        isMe: true,
        address: currentAddressText || (hasLocationFix() ? '주소 확인 중' : '위치 확인 중'),
        lat: hasLocationFix() ? userRealGpsLat : null,
        lng: hasLocationFix() ? userRealGpsLng : null,
        accuracy: gpsAccuracy,
        source: gpsSource,
        isGpsConnected: hasLocationFix(),
        lastGpsConnectedTs: gpsFixTs || null,
        venueLat: venueLat,
        venueLng: venueLng
      };

      const allParticipants = [meParticipantObj];
      if (meParticipantObj.lat !== null) addCustomAvatarMarkerToMap(meParticipantObj);

      // 참가자(나 제외)는 클라우드에 공유된 실제 위치를 읽어온다.
      // 공유 데이터가 없으면 좌표를 꾸며내지 않고 '위치 공유 안 함'으로 표시한다.
      const friendNames = promiseParticipantNames(promiseObj).filter(n => n !== myName);

      friendNames.forEach((fName) => {
        const friendMeta = friendsList.find(f => f && f.name === fName);
        const friendObj = {
          name: fName,
          avatar: (friendMeta && friendMeta.avatar) || DEFAULT_AVATAR,
          isMe: false,
          address: '위치 공유 안 함',
          lat: null,
          lng: null,
          accuracy: null,
          source: 'none',
          isGpsConnected: false,
          lastGpsConnectedTs: null,
          venueLat: venueLat,
          venueLng: venueLng
        };
        allParticipants.push(friendObj);

        const friendKey = codeKey(friendMeta && friendMeta.code);
        if (!dbRef || !friendKey) return;

        dbRef.ref('user_locations/' + friendKey).once('value', (snap) => {
          const loc = snap.val();
          if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lng))) return;

          friendObj.lat = Number(loc.lat);
          friendObj.lng = Number(loc.lng);
          friendObj.accuracy = loc.accuracy ?? null;
          friendObj.source = loc.source || 'gps';
          friendObj.address = loc.address || '실시간 위치';
          friendObj.lastGpsConnectedTs = loc.updatedAt || null;
          // 5분 이상 갱신이 없으면 오프라인으로 본다.
          friendObj.isGpsConnected = !!loc.updatedAt && (Date.now() - loc.updatedAt) < 5 * 60 * 1000;

          addCustomAvatarMarkerToMap(friendObj);
          renderMapParticipants(promiseObj, allParticipants);
        }, () => {});
      });

      renderMapParticipants(promiseObj, allParticipants);
      selectMapParticipant(meParticipantObj);

    }, 100);
  }

  // 실시간 위치 공개 시점 판정
  //   locationRevealMin === 0 이면 항상 공개, 그 외에는 약속 시간 N분 전부터 공개.
  function isLocationRevealed(promiseObj) {
    const min = Number(promiseObj && promiseObj.locationRevealMin) || 0;
    if (min <= 0) return true;
    const target = Number(promiseObj && promiseObj.targetTimestamp);
    if (!Number.isFinite(target)) return true;
    return Date.now() >= target - min * 60 * 1000;
  }

  function locationRevealLabel(promiseObj) {
    const min = Number(promiseObj && promiseObj.locationRevealMin) || 0;
    if (min <= 0) return '항상 공개';
    if (min % 1440 === 0) return `약속 ${min / 1440}일 전부터`;
    if (min % 60 === 0) return `약속 ${min / 60}시간 전부터`;
    return `약속 ${min}분 전부터`;
  }

  // 테마 CSS 변수의 실제 색상값 (Leaflet 은 SVG 속성이라 var() 를 못 쓴다)
  function themeColorValue(varName, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  // 약속 장소 깃발 마커 (빨간 깃발, 이모지 없이 SVG)
  function addVenueFlagMarker(promiseObj, lat, lng) {
    const flagColor = '#ef4444';
    const poleColor = themeColorValue('--text-main', '#ffffff');
    const label = promiseObj.venueName || promiseObj.location || '약속 장소';

    const html = `
      <div class="venue-flag-marker">
        <svg width="26" height="34" viewBox="0 0 26 34" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M6 2.5V32" stroke="${poleColor}" stroke-width="2.4" stroke-linecap="round"/>
          <path d="M6 3.5H20.5L16.5 9.5L20.5 15.5H6V3.5Z" fill="${flagColor}"/>
          <circle cx="6" cy="32" r="2.4" fill="${flagColor}"/>
        </svg>
        <span class="venue-flag-label">${escapeHtml(label)}</span>
      </div>
    `;

    const icon = L.divIcon({
      html: html,
      className: '',
      // 아바타 마커와 같은 방식으로 "깃대 밑동"을 좌표에 고정한다.
      iconSize: [140, 56],
      iconAnchor: [63, 34]
    });

    L.marker([lat, lng], { icon: icon, interactive: false, zIndexOffset: -100 }).addTo(leafletMapInstance);
  }

  // 위치 공개 전 화면: 장소만 표시하고 참가자 정보는 감춘다.
  function renderLocationHiddenPanel(promiseObj) {
    const listEl = document.getElementById('mapParticipantList');
    const countEl = document.getElementById('mapArrivalCount');
    const infoEl = document.getElementById('mapSelectedInfo');

    if (countEl) countEl.textContent = '위치 공개 전';
    if (listEl) {
      listEl.innerHTML = `
        <div style="text-align:center; padding:22px 12px;">
          <div style="font-size:0.86rem; font-weight:700; color:var(--text-main);">🔒 참가자 위치는 아직 공개되지 않았습니다</div>
          <div style="font-size:0.76rem; color:var(--text-muted); margin-top:6px;">${escapeHtml(locationRevealLabel(promiseObj))} 실시간 위치·거리·GPS 상태가 표시됩니다.</div>
        </div>
      `;
    }
    if (infoEl) infoEl.textContent = '약속 장소만 표시 중입니다.';
  }

  // 참가자 목록 + 도착 요약 (하단 패널 단일 소스)
  function renderMapParticipants(promiseObj, participants) {
    const listEl = document.getElementById('mapParticipantList');
    const countEl = document.getElementById('mapArrivalCount');
    if (!listEl) return;

    const radius = promiseObj.arrivalRadiusMeters || 300;

    const rows = participants.map((p) => {
      const hasCoords = Number.isFinite(p.lat) && Number.isFinite(p.lng);
      let distMeters = null;
      if (hasCoords && Number.isFinite(p.venueLat) && Number.isFinite(p.venueLng)) {
        distMeters = calculateHaversineDistance(p.lat, p.lng, p.venueLat, p.venueLng);
      }

      const arrived = distMeters != null && p.isGpsConnected && distMeters <= radius;
      let distStr = '-';
      if (distMeters != null) {
        distStr = distMeters > 1000 ? `${(distMeters / 1000).toFixed(1)}km` : `${Math.round(distMeters)}m`;
      }

      // 간략 표기: 도착 / 이동 중 / 꺼짐 / 위치 없음
      let state;
      let stateClass;
      if (!hasCoords) {
        state = '위치 없음';
        stateClass = 'state-offline';
      } else if (!p.isGpsConnected) {
        state = '꺼짐';
        stateClass = 'state-offline';
      } else if (arrived) {
        state = '도착';
        stateClass = 'state-online';
      } else {
        state = '이동 중';
        stateClass = 'state-online';
      }

      return { p, arrived, distStr, state, stateClass };
    });

    // 도착한 사람을 위로
    rows.sort((a, b) => (b.arrived ? 1 : 0) - (a.arrived ? 1 : 0));

    if (countEl) {
      const arrivedCount = rows.filter(r => r.arrived).length;
      countEl.textContent = `${arrivedCount}/${rows.length} 도착`;
    }

    listEl.innerHTML = '';
    rows.forEach(({ p, arrived, distStr, state, stateClass }) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `map-participant-row ${arrived ? 'arrived' : ''}`;
      row.setAttribute('data-name', p.name);
      if (selectedMapParticipant && selectedMapParticipant.name === p.name) row.classList.add('selected');

      row.innerHTML = `
        <img src="${safeImageUrl(p.avatar)}" alt="">
        <span class="mp-main">
          <span class="mp-name">${escapeHtml(p.name)}${p.isMe ? ' (나)' : ''}</span>
        </span>
        <span class="mp-right">
          <span class="mp-dist">${escapeHtml(distStr)}</span>
          <span class="mp-state ${stateClass}">${escapeHtml(state)}</span>
        </span>
      `;

      row.addEventListener('click', () => {
        listEl.querySelectorAll('.map-participant-row').forEach(el => el.classList.remove('selected'));
        row.classList.add('selected');
        selectMapParticipant(p);
      });

      listEl.appendChild(row);
    });

    if (window.lucide) window.lucide.createIcons();
  }

  // 참가자 아바타 마커 (연결됨=초록 테두리 / 꺼짐=빨강 테두리 + 마지막 위치)
  function addCustomAvatarMarkerToMap(participantObj) {
    const online = !!participantObj.isGpsConnected;
    const ringColor = online ? '#22c55e' : '#ef4444';

    const avatarHtml = `
      <div class="custom-map-avatar-container">
        <div class="custom-map-avatar-ring" style="background:${ringColor}; border:2px solid ${ringColor};">
          <img src="${safeImageUrl(participantObj.avatar)}" class="custom-map-avatar-img" style="${online ? '' : 'filter:grayscale(90%);'}">
        </div>
        <div class="custom-map-avatar-badge" style="border-color:${ringColor};">${escapeHtml(participantObj.name)}${online ? '' : ' · 꺼짐'}</div>
      </div>
    `;

    const icon = L.divIcon({
      html: avatarHtml,
      className: '',
      iconSize: [58, 72],
      iconAnchor: [29, 72]
    });

    const marker = L.marker([participantObj.lat, participantObj.lng], { icon: icon }).addTo(leafletMapInstance);
    marker.on('click', () => {
      if (leafletMapInstance) leafletMapInstance.panTo([participantObj.lat, participantObj.lng]);
      selectMapParticipant(participantObj);
    });
  }

  function selectMapParticipant(pObj) {
    selectedMapParticipant = pObj;
    if (leafletMapInstance && Number.isFinite(pObj.lat) && Number.isFinite(pObj.lng)) {
      leafletMapInstance.panTo([pObj.lat, pObj.lng]);
    }
    updateGpsStatusView(pObj);
  }

  // 선택한 참가자 상세: 한 줄 요약으로 표시 (GPS 상태 · 수신 시각 · 목적지 거리)
  function updateGpsStatusView(pObj) {
    const infoEl = document.getElementById('mapSelectedInfo');
    if (!infoEl || !pObj) return;

    const hasCoords = Number.isFinite(pObj.lat) && Number.isFinite(pObj.lng);

    // GPS 표기는 연결됨 / 연결 안됨만 (오차범위 표기 없음)
    const gpsHtml = (hasCoords && pObj.isGpsConnected)
      ? '<span class="state-online">연결됨</span>'
      : '<span class="state-offline">연결 안됨</span>';

    let updatedText = '수신 기록 없음';
    if (pObj.lastGpsConnectedTs) {
      const diffMins = Math.floor((Date.now() - pObj.lastGpsConnectedTs) / 60000);
      if (diffMins < 1) updatedText = '방금 전 수신';
      else if (diffMins < 60) updatedText = `${diffMins}분 전 수신`;
      else updatedText = `${Math.floor(diffMins / 60)}시간 전 수신`;
    }

    let distText = '거리 -';
    if (hasCoords && Number.isFinite(pObj.venueLat) && Number.isFinite(pObj.venueLng)) {
      const d = calculateHaversineDistance(pObj.lat, pObj.lng, pObj.venueLat, pObj.venueLng);
      distText = d > 1000 ? `약속 장소까지 ${(d / 1000).toFixed(1)}km` : `약속 장소까지 ${Math.round(d)}m`;
    }

    infoEl.innerHTML = `${escapeHtml(pObj.name)}${pObj.isMe ? ' (나)' : ''} · ${gpsHtml} · ${escapeHtml(updatedText)} · ${escapeHtml(distText)}`;
  }


  // Haversine Distance Helper Formula
  // gps.js(GPSEngine)가 로드되어 있으면 그 구현을 사용하고, 없으면 로컬 폴백.
  function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    if (window.gpsEngine && typeof window.gpsEngine.calculateDistanceMeters === 'function') {
      return window.gpsEngine.calculateDistanceMeters(lat1, lon1, lat2, lon2);
    }

    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  }

  if (btnCloseLiveMap) btnCloseLiveMap.addEventListener('click', () => liveMapModal.classList.remove('active'));

  function renderFriends() {
    const listContainer = document.getElementById('friendsList');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    if (friendsList.length === 0) {
      listContainer.innerHTML = `<p style="color: var(--text-dim); text-align:center; padding:40px 20px;">등록된 친구가 없습니다.</p>`;
      return;
    }

    friendsList.forEach(f => {
      const card = document.createElement('div');
      card.className = 'friend-card';

      card.innerHTML = `
        <div class="friend-left">
          <img src="${safeImageUrl(f.avatar)}" class="avatar-circle">
          <div>
            <div class="friend-name">${escapeHtml(f.name)}</div>
          </div>
        </div>
        <button class="btn-delete-promise btn-delete-friend" data-code="${escapeHtml(f.code || '')}" title="친구 삭제" aria-label="${escapeHtml(f.name)} 친구 삭제">
          <i data-lucide="user-minus"></i>
        </button>
      `;
      listContainer.appendChild(card);
    });

    listContainer.querySelectorAll('.btn-delete-friend').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const code = e.currentTarget.getAttribute('data-code');
        const target = friendsList.find(f => (f.code || '') === code);
        if (!target) return;
        if (!confirm(`${target.name} 님을 친구 목록에서 삭제하시겠습니까?\n\n서로의 친구 목록에서 모두 사라지며, 상대방에게는 별도 알림이 가지 않습니다.`)) return;
        deleteFriend(target);
      });
    });

    if (window.lucide) window.lucide.createIcons();
  }

  // 친구 삭제: 양쪽 목록에서 동시에 제거한다.
  //   - 내 목록: user_friends/{내키}/{친구키}
  //   - 상대 목록: user_friends/{친구키}/{내키}  (규칙상 "내 항목 삭제"만 허용)
  //   상대방에게 알림은 보내지 않는다.
  function deleteFriend(friendObj) {
    if (!friendObj) return;
    const fKey = codeKey(friendObj.code);
    friendsList = friendsList.filter(f => codeKey(f && f.code) !== fKey);
    saveStorage('pa_friends_list', friendsList);

    const myKey = codeKey(ensureUserCode());
    if (dbRef && myKey && fKey) {
      dbWrite('user_friends/' + myKey + '/' + fKey, null);
      dbWrite('user_friends/' + fKey + '/' + myKey, null);
      // 남아 있던 친구 요청 흔적도 함께 정리
      dbWrite('friend_requests/' + myKey + '/' + fKey, null);
      dbWrite('friend_requests/' + fKey + '/' + myKey, null);
    }

    renderFriends();
    populateFriendSelector();
    alert(`🗑️ ${friendObj.name} 님을 친구 목록에서 삭제했습니다.`);
  }




  // ==========================================
  // 6. Create Promise Modal
  // ==========================================
  const timeInput = document.getElementById('inputPromiseTime');
  // 날짜/시간 피커는 브라우저 기본 동작에 맡긴다.
  // (직접 showPicker()/blur() 를 호출하면 피커가 열린 뒤 스스로 닫히는 문제가 있었다)

  if (btnOpenCreatePromise) {
    btnOpenCreatePromise.addEventListener('click', () => {
      populateFriendSelector();
      createPromiseModal.classList.add('active');

      // 시작 시간 제한 없음: 기본값만 현재 시각으로 채워 둔다.
      if (timeInput) {
        timeInput.removeAttribute('min');
        if (!timeInput.value) timeInput.value = toLocalInputValue(new Date());
      }
    });
  }

  const closeCreateModalHandler = () => {
    if (document.activeElement) document.activeElement.blur();
    if (createPromiseModal) createPromiseModal.classList.remove('active');
  };
  if (btnCloseCreatePromise) btnCloseCreatePromise.addEventListener('click', closeCreateModalHandler);
  if (btnCancelCreatePromise) btnCancelCreatePromise.addEventListener('click', closeCreateModalHandler);

  // ==========================================
  // 참가 친구 선택 (별도 모달 + 검색 + 스크롤)
  //   선택 상태는 친구 코드 기준으로 보관한다.
  // ==========================================
  let selectedInviteCodes = [];
  let friendPickerQuery = '';

  const friendPickerModal = document.getElementById('friendPickerModal');
  const btnOpenFriendPicker = document.getElementById('btnOpenFriendPicker');
  const btnCloseFriendPicker = document.getElementById('btnCloseFriendPicker');
  const btnConfirmFriendPicker = document.getElementById('btnConfirmFriendPicker');
  const btnFriendPickerSelectAll = document.getElementById('btnFriendPickerSelectAll');
  const btnFriendPickerClearAll = document.getElementById('btnFriendPickerClearAll');
  const inputFriendPickerSearch = document.getElementById('inputFriendPickerSearch');

  function friendByCode(code) {
    return friendsList.find(f => (f.code || '') === code) || null;
  }

  // 삭제된 친구가 선택 목록에 남지 않도록 정리
  function pruneSelectedInviteCodes() {
    selectedInviteCodes = selectedInviteCodes.filter(c => !!friendByCode(c));
  }

  // 약속 만들기 화면의 요약(선택 인원 + 칩 미리보기)
  function populateFriendSelector() {
    pruneSelectedInviteCodes();

    const badge = document.getElementById('friendPickerCountBadge');
    if (badge) badge.textContent = `${selectedInviteCodes.length}명`;

    const preview = document.getElementById('selectedFriendsPreview');
    if (preview) {
      preview.innerHTML = '';
      if (friendsList.length === 0) {
        preview.innerHTML = `<span style="font-size:0.76rem; color:var(--text-muted);">등록된 친구가 없습니다. 친구 관리 탭에서 먼저 추가해 주세요.</span>`;
      } else if (selectedInviteCodes.length === 0) {
        preview.innerHTML = `<span style="font-size:0.76rem; color:var(--text-muted);">선택된 친구가 없습니다.</span>`;
      } else {
        selectedInviteCodes.forEach(code => {
          const f = friendByCode(code);
          if (!f) return;
          const chip = document.createElement('span');
          chip.className = 'friend-chip selected';
          chip.textContent = `✓ ${f.name}`;
          preview.appendChild(chip);
        });
      }
    }

    if (friendPickerModal && friendPickerModal.classList.contains('active')) renderFriendPickerList();
  }

  function renderFriendPickerList() {
    const container = document.getElementById('friendPickerList');
    const countEl = document.getElementById('friendPickerSelectedCount');
    if (countEl) countEl.textContent = `${selectedInviteCodes.length}명 선택됨`;
    if (!container) return;

    container.innerHTML = '';

    if (friendsList.length === 0) {
      container.innerHTML = `<p style="color: var(--text-dim); text-align:center; padding:24px 12px; font-size:0.82rem;">등록된 친구가 없습니다.<br>친구 관리 탭에서 친구를 먼저 추가해 주세요.</p>`;
      return;
    }

    const q = friendPickerQuery.trim().toLowerCase();
    const visible = q
      ? friendsList.filter(f => String(f.name || '').toLowerCase().includes(q))
      : friendsList;

    if (visible.length === 0) {
      container.innerHTML = `<p style="color: var(--text-dim); text-align:center; padding:24px 12px; font-size:0.82rem;">"${escapeHtml(friendPickerQuery)}" 검색 결과가 없습니다.</p>`;
      return;
    }

    visible.forEach(f => {
      const code = f.code || '';
      const isSelected = selectedInviteCodes.includes(code);

      const row = document.createElement('button');
      row.type = 'button';
      row.className = `friend-picker-row ${isSelected ? 'selected' : ''}`;
      row.setAttribute('data-code', code);
      row.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      row.innerHTML = `
        <img src="${safeImageUrl(f.avatar)}" alt="">
        <span>
          <span class="picker-name" style="display:block;">${escapeHtml(f.name)}</span>
          ${f.uid ? '' : `<span class="picker-sub">계정 정보 없음 (초대 불가)</span>`}
        </span>
        <span class="picker-check" aria-hidden="true">✓</span>
      `;

      row.addEventListener('click', () => {
        if (selectedInviteCodes.includes(code)) {
          selectedInviteCodes = selectedInviteCodes.filter(c => c !== code);
        } else {
          selectedInviteCodes.push(code);
        }
        renderFriendPickerList();
      });

      container.appendChild(row);
    });
  }

  function openFriendPicker() {
    if (!friendPickerModal) return;
    friendPickerQuery = '';
    if (inputFriendPickerSearch) inputFriendPickerSearch.value = '';
    createPromiseModal.classList.remove('active');
    friendPickerModal.classList.add('active');
    renderFriendPickerList();
    if (window.lucide) window.lucide.createIcons();
  }

  function closeFriendPicker() {
    if (friendPickerModal) friendPickerModal.classList.remove('active');
    createPromiseModal.classList.add('active');
    populateFriendSelector();
    if (window.lucide) window.lucide.createIcons();
  }

  if (btnOpenFriendPicker) btnOpenFriendPicker.addEventListener('click', openFriendPicker);
  if (btnCloseFriendPicker) btnCloseFriendPicker.addEventListener('click', closeFriendPicker);
  if (btnConfirmFriendPicker) btnConfirmFriendPicker.addEventListener('click', closeFriendPicker);

  if (btnFriendPickerSelectAll) {
    btnFriendPickerSelectAll.addEventListener('click', () => {
      selectedInviteCodes = friendsList.map(f => f.code || '').filter(Boolean);
      renderFriendPickerList();
    });
  }

  if (btnFriendPickerClearAll) {
    btnFriendPickerClearAll.addEventListener('click', () => {
      selectedInviteCodes = [];
      renderFriendPickerList();
    });
  }

  if (inputFriendPickerSearch) {
    inputFriendPickerSearch.addEventListener('input', (e) => {
      friendPickerQuery = e.target.value || '';
      renderFriendPickerList();
    });
  }

  // 벌칙 종류/지속 시간 선택에 따른 안내 문구
  function updatePenaltyHint() {
    const hintEl = document.getElementById('penaltyHintText');
    const typeEl = document.getElementById('selectPenaltyType');
    const durEl = document.getElementById('selectPenaltyDuration');
    if (!hintEl || !typeEl || !durEl) return;

    const isVibrate = typeEl.value === 'vibrate';
    const min = parseInt(durEl.value, 10) || 0;
    const what = isVibrate ? '진동' : '알람 소리';
    const when = min > 0
      ? `약속 시간 후 ${min}분간 ${what}가 반복됩니다.`
      : `도착할 때까지 ${what}가 계속 반복됩니다.`;

    hintEl.textContent = `${when} 도착 반경에 들어오면 즉시 멈춥니다.${isVibrate ? ' (아이폰 사파리는 진동을 지원하지 않아 화면 경고만 표시됩니다)' : ''}`;
  }

  ['selectPenaltyType', 'selectPenaltyDuration'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updatePenaltyHint);
  });
  updatePenaltyHint();

  // ------------------------------------------
  // 약속 시작/종료 시간 입력 연동
  //  - 시작을 정하면 종료를 기본 +1시간으로 채운다.
  //  - 진행 시간 칩(30분/1시간/…)을 누르면 종료 시간을 계산해 넣는다.
  // ------------------------------------------
  const inputPromiseStartEl = document.getElementById('inputPromiseTime');
  const inputPromiseEndEl = document.getElementById('inputPromiseEndTime');
  const durationChipsEl = document.getElementById('promiseDurationChips');
  const DEFAULT_PROMISE_DURATION_MIN = 60;

  function toLocalInputValue(date) {
    const p2 = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}T${p2(date.getHours())}:${p2(date.getMinutes())}`;
  }

  function selectedStartDate() {
    const raw = inputPromiseStartEl ? inputPromiseStartEl.value : '';
    const ts = new Date(raw).getTime();
    return Number.isFinite(ts) ? new Date(ts) : null;
  }

  function markActiveDurationChip(minutes) {
    if (!durationChipsEl) return;
    durationChipsEl.querySelectorAll('.duration-chip').forEach((chip) => {
      chip.classList.toggle('selected', Number(chip.getAttribute('data-min')) === minutes);
    });
  }

  function applyPromiseDuration(minutes) {
    const start = selectedStartDate();
    if (!start) {
      alert('먼저 약속 시작 시간을 선택해 주세요.');
      if (inputPromiseStartEl) inputPromiseStartEl.focus();
      return;
    }
    if (inputPromiseEndEl) inputPromiseEndEl.value = toLocalInputValue(new Date(start.getTime() + minutes * 60000));
    markActiveDurationChip(minutes);
  }

  if (inputPromiseStartEl) {
    inputPromiseStartEl.addEventListener('change', () => {
      const start = selectedStartDate();
      if (!start) return;
      // 종료가 비었거나 시작보다 앞이면 기본 진행 시간으로 맞춘다.
      const endTsNow = inputPromiseEndEl ? new Date(inputPromiseEndEl.value).getTime() : NaN;
      if (!Number.isFinite(endTsNow) || endTsNow <= start.getTime()) {
        applyPromiseDuration(DEFAULT_PROMISE_DURATION_MIN);
      } else {
        markActiveDurationChip(Math.round((endTsNow - start.getTime()) / 60000));
      }
    });
  }

  if (inputPromiseEndEl) {
    inputPromiseEndEl.addEventListener('change', () => {
      const start = selectedStartDate();
      const endTsNow = new Date(inputPromiseEndEl.value).getTime();
      if (!start || !Number.isFinite(endTsNow)) return;
      markActiveDurationChip(Math.round((endTsNow - start.getTime()) / 60000));
    });
  }

  if (durationChipsEl) {
    durationChipsEl.querySelectorAll('.duration-chip').forEach((chip) => {
      chip.addEventListener('click', () => applyPromiseDuration(Number(chip.getAttribute('data-min')) || DEFAULT_PROMISE_DURATION_MIN));
    });
  }

  if (formCreatePromise) {
    formCreatePromise.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('inputPromiseTitle').value.trim();
      const location = document.getElementById('inputPromiseLocation').value.trim();
      const venueName = document.getElementById('inputPromiseVenueName').value.trim();
      const dateTimeVal = document.getElementById('inputPromiseTime').value;
      const endTimeEl = document.getElementById('inputPromiseEndTime');
      const endTimeVal = endTimeEl ? endTimeEl.value : '';
      const leaveRule = 'consent';   // 약속 나가기는 항상 '동의 필요'
      const revealEl = document.getElementById('selectLocationReveal');
      const locationRevealMin = revealEl ? (parseInt(revealEl.value, 10) || 0) : 0;
      const penaltySelectEl = document.getElementById('selectPenaltyType');
      const penaltyType = penaltySelectEl && penaltySelectEl.value === 'vibrate' ? 'vibrate' : 'alarm';
      const penaltyDurationEl = document.getElementById('selectPenaltyDuration');
      const penaltyDurationMin = penaltyDurationEl ? (parseInt(penaltyDurationEl.value, 10) || 0) : 0;
      const arrivalRadiusMeters = parseInt(document.getElementById('inputAutoArrivalDist').value) || 200;

      if (!title || !location || !dateTimeVal) {
        alert('약속 이름, 위치, 시간을 모두 입력해 주세요.');
        return;
      }

      // 약속 장소는 지도에서 직접 찍은 좌표만 인정한다. (주소 검색 오차로 엉뚱한 곳이 잡히는 문제 방지)
      if (!Number.isFinite(selectedPickedLat) || !Number.isFinite(selectedPickedLng)) {
        alert('📍 약속 장소는 지도에서 직접 선택해야 합니다.\n\n[지도 선택] 버튼을 눌러 위치를 찍어주세요.');
        return;
      }

      const selectedTs = new Date(dateTimeVal).getTime();
      if (!Number.isFinite(selectedTs)) {
        alert('⏱️ 약속 시작 시간을 입력해 주세요.');
        document.getElementById('inputPromiseTime').focus();
        return;
      }

      // 종료 시간 검증: 시작보다 뒤여야 하고 최대 24시간까지 허용
      const endTs = new Date(endTimeVal).getTime();
      if (!endTimeVal || !Number.isFinite(endTs)) {
        alert('⏱️ 약속 종료 시간을 입력해 주세요.');
        if (endTimeEl) endTimeEl.focus();
        return;
      }
      if (endTs <= selectedTs) {
        alert('⏱️ 종료 시간은 시작 시간보다 뒤여야 합니다.');
        if (endTimeEl) endTimeEl.focus();
        return;
      }
      if (endTs - selectedTs > 24 * 60 * 60 * 1000) {
        alert('⏱️ 약속 진행 시간은 최대 24시간까지 설정할 수 있습니다.');
        if (endTimeEl) endTimeEl.focus();
        return;
      }

      pruneSelectedInviteCodes();
      const selectedFriendCodes = selectedInviteCodes.slice();
      const invitedFriendObjs = friendsList.filter(f => selectedFriendCodes.indexOf(f.code || '') !== -1);
      const selectedFriendNames = invitedFriendObjs.map(f => f.name);

      const myName = userProfile ? userProfile.name : '나';
      const invitedList = selectedFriendNames.filter(n => n !== myName);
      const myUidForPromise = ensureProfileUid() || '';
      const missingUidNames = invitedFriendObjs.filter(f => !f.uid).map(f => f.name);

      const dateObj = new Date(dateTimeVal);
      const targetTs = dateObj.getTime();
      const endObj = new Date(endTs);
      const formatAmPm = (d) => {
        let h = d.getHours();
        const m = String(d.getMinutes()).padStart(2, '0');
        const ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return `${ap} ${String(h).padStart(2, '0')}:${m}`;
      };
      const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()} ${formatAmPm(dateObj)}`;
      const sameDay = endObj.getFullYear() === dateObj.getFullYear()
        && endObj.getMonth() === dateObj.getMonth()
        && endObj.getDate() === dateObj.getDate();
      const endDateTimeStr = sameDay ? formatAmPm(endObj) : `${endObj.getMonth() + 1}/${endObj.getDate()} ${formatAmPm(endObj)}`;
      const durationMin = Math.round((endTs - targetTs) / 60000);

      // 지도에서 직접 찍은 좌표가 최우선. 없으면 아래 지오코딩 결과로 채운다.
      // (내 현재 위치를 약속 장소로 오인하지 않도록 임의 대입하지 않는다)
      const venueLat = Number.isFinite(selectedPickedLat) ? selectedPickedLat : null;
      const venueLng = Number.isFinite(selectedPickedLng) ? selectedPickedLng : null;

      const newPromise = {
        id: 'p_' + Date.now(),
        title: title,
        location: location,
        venueName: venueName,
        targetTimestamp: targetTs,
        endTimestamp: endTs,
        durationMin: durationMin,
        dateTime: dateStr,
        endDateTime: endDateTimeStr,
        leaveRule: leaveRule,
        locationRevealMin: locationRevealMin,
        penaltyType: penaltyType,
        penaltyDurationMin: penaltyDurationMin,
        hostName: myName,
        hostUid: myUidForPromise,
        arrivalRadiusMeters: arrivalRadiusMeters,
        lat: venueLat,
        lng: venueLng,
        invitedUsers: invitedList,
        // 참가 상태는 uid 별 노드로 관리한다. (본인만 자기 노드를 쓸 수 있음)
        attendees: myUidForPromise ? {
          [myUidForPromise]: {
            uid: myUidForPromise,
            name: myName,
            avatar: (userProfile && userProfile.avatar) || DEFAULT_AVATAR,
            joinedAt: Date.now(),
            arrived: false
          }
        } : {},
        // 읽기 권한의 기준: 여기 uid 가 있는 사람만 이 약속을 볼 수 있다.
        members: buildMembersMap(myUidForPromise, invitedFriendObjs),
        createdAt: Date.now()
      };

      if (missingUidNames.length > 0) {
        alert(`⚠️ 다음 친구는 계정 정보(uid)가 없어 약속을 공유할 수 없습니다: ${missingUidNames.join(', ')}\n\n해당 친구가 로그인 후 친구 추가를 다시 진행하면 초대할 수 있습니다.`);
      }

      selectedPickedLat = null;
      selectedPickedLng = null;

      promisesList.unshift(newPromise);
      syncPromisesToCloud(newPromise);
      document.getElementById('inputPromiseTitle').value = '';
      setPromiseLocationValue('');
      document.getElementById('inputPromiseVenueName').value = '';
      if (inputPromiseEndEl) inputPromiseEndEl.value = '';
      markActiveDurationChip(-1);
      selectedInviteCodes = [];
      populateFriendSelector();
      createPromiseModal.classList.remove('active');
      renderAll();
      alert(`🎉 "${title}" 약속이 등록되었으며, 선택한 친구들에게 초대가 전송되었습니다!`);
    });
  }




  // ==========================================
  // 7. 약속 반경 진입 시 도착 처리 (알람/사운드 없음)
  // ==========================================
  function markArrival(promiseObj) {
    if (!promiseObj || !promiseObj.id) return;
    if (arrivedNotified.includes(promiseObj.id)) return;

    arrivedNotified.push(promiseObj.id);
    saveStorage('pa_arrived_promises', arrivedNotified);

    // 도착 상태는 내 attendees 노드에만 기록한다. (약속 본문은 호스트 전용)
    writeMyAttendance(promiseObj, { arrived: true, arrivedAt: Date.now() });

    // 도착하면 지각 벌칙(알람/진동)을 즉시 중지
    evaluatePenaltyState();
  }

  // ==========================================
  // 8. 지각 벌칙 엔진
  //    약속 정각이 지났는데 아직 도착하지 않은 참가자의 "본인 기기"에서
  //    도착 반경에 들어올 때까지 알람 소리 또는 진동을 반복한다.
  //    - 벌칙 종류는 약속 생성 시 penaltyType 으로 저장 ('alarm' | 'vibrate')
  //    - 브라우저 정책상 소리/진동은 사용자 조작(터치) 이후에만 시작할 수 있다.
  // ==========================================
  const PENALTY_MAX_DURATION_MS = 6 * 60 * 60 * 1000;  // 정각 후 6시간이면 자동 종료
  const PENALTY_SNOOZE_MS = 5 * 60 * 1000;

  let penaltySnoozeMap = loadStorage('pa_penalty_snooze', {});
  let penaltyActiveId = null;
  let penaltyActiveType = null;
  let penaltyAudioCtx = null;
  let penaltyBeepTimer = null;
  let penaltyVibrateTimer = null;
  let penaltyBannerEl = null;
  let penaltyAudioUnlocked = false;

  function isPenaltyDueFor(p) {
    if (!p || !p.id) return false;
    const type = p.penaltyType;
    if (type !== 'alarm' && type !== 'vibrate') return false;

    const myName = userProfile ? userProfile.name : '나';
    if (!amIAttendeeOf(p)) return false;
    if (arrivedNotified.includes(p.id)) return false;

    const target = Number(p.targetTimestamp);
    if (!Number.isFinite(target)) return false;

    const now = Date.now();
    if (now < target) return false;

    // 종료 시간이 지난(완료된) 약속은 더 이상 울리지 않는다.
    const endTs = promiseEndTs(p);
    if (Number.isFinite(endTs) && now >= endTs) return false;

    // 지속 시간: 0 이면 "도착할 때까지" (최대 6시간 안전장치)
    const durationMin = Number(p.penaltyDurationMin) || 0;
    const limitMs = durationMin > 0
      ? Math.min(durationMin * 60 * 1000, PENALTY_MAX_DURATION_MS)
      : PENALTY_MAX_DURATION_MS;
    if (now > target + limitMs) return false;

    if (Number(penaltySnoozeMap[p.id] || 0) > now) return false;

    return true;
  }

  function evaluatePenaltyState() {
    // 정각이 가장 먼저 지난 약속 1건만 울린다.
    const due = promisesList
      .filter(isPenaltyDueFor)
      .sort((a, b) => (a.targetTimestamp || 0) - (b.targetTimestamp || 0))[0];

    if (!due) {
      stopPenalty();
      return;
    }

    if (penaltyActiveId === due.id && penaltyActiveType === due.penaltyType) {
      showPenaltyBanner(due);
      return;
    }

    stopPenalty();
    penaltyActiveId = due.id;
    penaltyActiveType = due.penaltyType;
    showPenaltyBanner(due);

    if (due.penaltyType === 'vibrate') startPenaltyVibration();
    else startPenaltyAlarm();
  }

  function stopPenalty() {
    penaltyActiveId = null;
    penaltyActiveType = null;

    if (penaltyBeepTimer) { clearInterval(penaltyBeepTimer); penaltyBeepTimer = null; }
    if (penaltyVibrateTimer) { clearInterval(penaltyVibrateTimer); penaltyVibrateTimer = null; }
    if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
    hidePenaltyBanner();
  }

  // 오디오는 사용자 제스처 후에만 재생 가능하다. 첫 터치에서 컨텍스트를 깨워둔다.
  function unlockPenaltyAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      if (!penaltyAudioCtx) penaltyAudioCtx = new Ctx();
      if (penaltyAudioCtx.state === 'suspended') penaltyAudioCtx.resume();
      penaltyAudioUnlocked = penaltyAudioCtx.state === 'running';
      return penaltyAudioUnlocked;
    } catch (e) {
      return false;
    }
  }

  function playPenaltyBeep() {
    if (!penaltyAudioCtx || penaltyAudioCtx.state !== 'running') return;
    const ctx = penaltyAudioCtx;
    const now = ctx.currentTime;

    // 삐- 삐- 두 번 (알람 느낌)
    [0, 0.35].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.3);
    });
  }

  function startPenaltyAlarm() {
    if (!unlockPenaltyAudio()) return;   // 배너의 [소리 켜기] 버튼으로 다시 시도
    playPenaltyBeep();
    if (penaltyBeepTimer) clearInterval(penaltyBeepTimer);
    penaltyBeepTimer = setInterval(playPenaltyBeep, 1500);
  }

  function startPenaltyVibration() {
    if (!navigator.vibrate) return;      // iOS Safari 미지원
    const buzz = () => { try { navigator.vibrate([600, 400]); } catch (e) {} };
    buzz();
    if (penaltyVibrateTimer) clearInterval(penaltyVibrateTimer);
    penaltyVibrateTimer = setInterval(buzz, 1200);
  }

  function snoozePenalty(promiseId) {
    penaltySnoozeMap[promiseId] = Date.now() + PENALTY_SNOOZE_MS;
    saveStorage('pa_penalty_snooze', penaltySnoozeMap);
    stopPenalty();
  }

  function hidePenaltyBanner() {
    if (penaltyBannerEl) {
      penaltyBannerEl.remove();
      penaltyBannerEl = null;
    }
  }

  function showPenaltyBanner(promiseObj) {
    const isVibrate = promiseObj.penaltyType === 'vibrate';
    const lateMin = Math.max(0, Math.floor((Date.now() - promiseObj.targetTimestamp) / 60000));

    let needSoundBtn = false;
    let notice = '';
    if (isVibrate && !navigator.vibrate) {
      notice = '이 기기(브라우저)는 진동을 지원하지 않아 화면 경고만 표시됩니다.';
    } else if (!isVibrate && (!penaltyAudioCtx || penaltyAudioCtx.state !== 'running')) {
      needSoundBtn = true;
      notice = '브라우저 정책상 화면을 한 번 눌러야 알람 소리가 시작됩니다.';
    }

    if (!penaltyBannerEl) {
      penaltyBannerEl = document.createElement('div');
      penaltyBannerEl.id = 'penaltyBanner';
      penaltyBannerEl.setAttribute('role', 'alert');
      penaltyBannerEl.setAttribute('aria-live', 'assertive');
      penaltyBannerEl.style.cssText = 'position:fixed; left:0; right:0; bottom:0; z-index:9999; background:var(--danger-strong); color: var(--text-main); padding:14px 16px calc(14px + env(safe-area-inset-bottom)); box-shadow:0 -6px 20px rgba(0,0,0,0.35);';
      document.body.appendChild(penaltyBannerEl);
    }

    penaltyBannerEl.innerHTML = `
      <div style="font-weight:800; font-size:0.92rem;">${isVibrate ? '📳' : '🔔'} 지각 벌칙 작동 중 - ${escapeHtml(promiseObj.title)}</div>
      <div style="font-size:0.78rem; margin-top:4px; opacity:0.92;">약속 시간에서 ${lateMin}분 지났습니다. ${(Number(promiseObj.penaltyDurationMin) || 0) > 0 ? `약속 시간 후 ${Number(promiseObj.penaltyDurationMin)}분간 울리며, 그 전에 도착하면 바로 멈춥니다.` : '약속 장소 반경에 도착하면 자동으로 멈춥니다.'}</div>
      ${notice ? `<div style="font-size:0.74rem; margin-top:4px; opacity:0.85;">${escapeHtml(notice)}</div>` : ''}
      <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
        ${needSoundBtn ? `<button type="button" id="btnPenaltyEnableSound" style="flex:1; min-width:110px; padding:9px 10px; border:0; border-radius:10px; background:#fff; color:var(--danger-strong); font-weight:800; cursor:pointer;">소리 켜기</button>` : ''}
        <button type="button" id="btnPenaltySnooze" style="flex:1; min-width:110px; padding:9px 10px; border:1px solid rgba(255,255,255,0.6); border-radius:10px; background:transparent; color: var(--text-main); font-weight:700; cursor:pointer;">5분 미루기</button>
      </div>
    `;

    const soundBtn = document.getElementById('btnPenaltyEnableSound');
    if (soundBtn) {
      soundBtn.addEventListener('click', () => {
        if (unlockPenaltyAudio()) startPenaltyAlarm();
        evaluatePenaltyState();
      });
    }

    const snoozeBtn = document.getElementById('btnPenaltySnooze');
    if (snoozeBtn) {
      snoozeBtn.addEventListener('click', () => snoozePenalty(promiseObj.id));
    }
  }

  // ==========================================
  // 9. 남은 시간 카운트다운 + 사전 알림 (1시간/30분/10분/5분/1분 전)
  //    - 카드 제목 오른쪽 배지에 남은 시간을 표시하고 1초마다 갱신한다.
  //    - 임계 시점마다 알림(브라우저 알림 + 인앱 토스트 + 짧은 소리/진동)을 1회씩 보낸다.
  // ==========================================
  const REMINDER_STEPS = [60, 30, 10, 5, 1];   // 분 단위 (내림차순)
  const REMINDER_WINDOW_MS = 3 * 60 * 1000;    // 임계 시점을 이 시간보다 늦게 발견하면 조용히 소진 처리
  const REMINDER_KEEP_MS = 6 * 60 * 60 * 1000; // 정각 후 6시간이 지난 기록은 정리

  let reminderFiredMap = loadStorage('pa_reminder_fired', {});
  let completedNotified = loadStorage('pa_completed_promises', []);
  let notificationAsked = false;
  let toastStackEl = null;

  // ------------------------------------------
  // 약속 진행 상태 (종료 시간 기준)
  //  upcoming : 아직 끝나지 않음
  //  done     : 종료 시간이 지남 → 완료 (캘린더 기록)
  // ------------------------------------------
  const LEGACY_DURATION_MIN = 60;   // 종료 시간이 없던 예전 약속의 기본 진행 시간

  function promiseStartTs(promiseObj) {
    const ts = Number(promiseObj && promiseObj.targetTimestamp);
    return Number.isFinite(ts) ? ts : NaN;
  }

  function promiseEndTs(promiseObj) {
    const start = promiseStartTs(promiseObj);
    if (!Number.isFinite(start)) return NaN;
    const end = Number(promiseObj && promiseObj.endTimestamp);
    if (Number.isFinite(end) && end > start) return end;
    const dur = Number(promiseObj && promiseObj.durationMin);
    return start + (Number.isFinite(dur) && dur > 0 ? dur : LEGACY_DURATION_MIN) * 60000;
  }

  function promiseStatus(promiseObj) {
    const start = promiseStartTs(promiseObj);
    if (!Number.isFinite(start)) return 'upcoming';
    // 종료 시간이 지나면 완료, 그 전은 모두 예정으로 본다.
    return Date.now() >= promiseEndTs(promiseObj) ? 'done' : 'upcoming';
  }

  function isPromiseDone(promiseObj) {
    return promiseStatus(promiseObj) === 'done';
  }

  function formatAmPmDate(d) {
    if (!d) return '';
    const obj = typeof d === 'number' ? new Date(d) : (d instanceof Date ? d : new Date(d));
    if (isNaN(obj.getTime())) return '';
    let h = obj.getHours();
    const m = String(obj.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${ap} ${String(h).padStart(2, '0')}:${m}`;
  }

  function convert24hStringToAmPm(str) {
    if (!str) return '';
    if (/AM|PM|오전|오후/i.test(str)) return str;
    return str.replace(/\b([0-1]?[0-9]|2[0-3]):([0-5][0-9])\b/g, (match, hStr, mStr) => {
      let h = parseInt(hStr, 10);
      const ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${ap} ${String(h).padStart(2, '0')}:${mStr}`;
    });
  }

  // "7/28 PM 07:00 ~ PM 09:00" 형태의 표시 문자열
  function promiseTimeRangeLabel(promiseObj) {
    if (!promiseObj) return '';
    const ts = Number(promiseObj.targetTimestamp);
    const end = promiseEndTs(promiseObj);

    if (Number.isFinite(ts)) {
      const startObj = new Date(ts);
      const datePart = `${startObj.getMonth() + 1}/${startObj.getDate()}`;
      const startStr = `${datePart} ${formatAmPmDate(startObj)}`;

      if (Number.isFinite(end)) {
        const endObj = new Date(end);
        const sameDay = endObj.getFullYear() === startObj.getFullYear()
          && endObj.getMonth() === startObj.getMonth()
          && endObj.getDate() === startObj.getDate();
        const endStr = sameDay ? formatAmPmDate(endObj) : `${endObj.getMonth() + 1}/${endObj.getDate()} ${formatAmPmDate(endObj)}`;
        return `${startStr} ~ ${endStr}`;
      }
      return startStr;
    }

    const startLabel = promiseObj.dateTime ? convert24hStringToAmPm(promiseObj.dateTime) : '';
    let endLabel = promiseObj.endDateTime ? convert24hStringToAmPm(promiseObj.endDateTime) : '';
    return endLabel ? `${startLabel} ~ ${endLabel}` : startLabel;
  }

  // 남은 시간 → 표시 문자열 + 색상 등급
  function getCountdownInfo(promiseObj) {
    const ts = Number(promiseObj && promiseObj.targetTimestamp);
    if (!Number.isFinite(ts)) return null;

    const diff = ts - Date.now();
    const pad2 = (n) => String(n).padStart(2, '0');

    if (diff <= 0) {
      // 종료 시간이 지났으면 완료
      if (isPromiseDone(promiseObj)) return { tier: 'done', main: '완료', suffix: '' };

      // 약속 시간이 지난 뒤: 도착했으면 '도착', 아직이면 지각 경과 시간
      if (arrivedNotified.includes(promiseObj.id)) return { tier: 'done', main: '도착', suffix: '' };

      const lateMin = Math.floor(-diff / 60000);
      if (lateMin <= 0) return { tier: 'now', main: '지금', suffix: '시작' };
      if (lateMin >= 60) return { tier: 'late', main: `${Math.floor(lateMin / 60)}시간 ${lateMin % 60}분`, suffix: '지남' };
      return { tier: 'late', main: `${lateMin}분`, suffix: '지남' };
    }

    // 남은 시간은 올림 처리한다. (5시간 약속이 4시간 59분으로 보이지 않도록)
    const totalSec = Math.ceil(diff / 1000);
    const minCeil = Math.ceil(totalSec / 60);

    if (totalSec < 60) return { tier: 'now', main: `${totalSec}초`, suffix: '남음' };
    if (totalSec < 600) {
      const m = Math.floor(totalSec / 60);
      return { tier: m < 5 ? 'm5' : 'm10', main: `${m}:${pad2(totalSec % 60)}`, suffix: '남음' };
    }
    if (minCeil <= 30) return { tier: 'm30', main: `${minCeil}분`, suffix: '남음' };
    if (minCeil <= 60) return { tier: 'h1', main: `${minCeil}분`, suffix: '남음' };

    const hour = Math.floor(minCeil / 60);
    if (hour < 24) return { tier: 'today', main: hour + '시간' + (minCeil % 60 ? ` ${minCeil % 60}분` : ''), suffix: '남음' };

    const day = Math.floor(hour / 24);
    return { tier: 'far', main: day + '일' + (hour % 24 ? ` ${hour % 24}시간` : ''), suffix: '남음' };
  }

  function countdownBadgeHtml(promiseObj) {
    const info = getCountdownInfo(promiseObj);
    if (!info) return '';
    return `<span class="countdown-badge cd-${info.tier}" role="timer" aria-live="off"
      data-cd-id="${escapeHtml(promiseObj.id)}"
      aria-label="약속까지 ${escapeHtml(info.main)} ${escapeHtml(info.suffix)}">
      <span class="cd-dot" aria-hidden="true"></span>
      <span class="cd-main">${escapeHtml(info.main)}</span>
      <span class="cd-suffix">${escapeHtml(info.suffix)}</span>
    </span>`;
  }

  // 전체 재렌더 없이 배지 텍스트/색상만 1초마다 갱신
  function tickCountdownBadges() {
    const badges = document.querySelectorAll('.countdown-badge[data-cd-id]');
    if (!badges.length) return;

    badges.forEach((el) => {
      const target = promisesList.find(p => p.id === el.getAttribute('data-cd-id'));
      const info = target ? getCountdownInfo(target) : null;
      if (!info) return;

      const mainEl = el.querySelector('.cd-main');
      const suffixEl = el.querySelector('.cd-suffix');
      if (mainEl && mainEl.textContent !== info.main) mainEl.textContent = info.main;
      if (suffixEl && suffixEl.textContent !== info.suffix) suffixEl.textContent = info.suffix;

      const cls = `countdown-badge cd-${info.tier}`;
      if (el.className !== cls) el.className = cls;
      el.setAttribute('aria-label', `약속까지 ${info.main} ${info.suffix}`);
    });
  }

  // ---------- 알림 채널 ----------
  function ensureNotificationPermission() {
    if (notificationAsked) return;
    if (!('Notification' in window)) { notificationAsked = true; return; }
    if (Notification.permission !== 'default') { notificationAsked = true; return; }
    notificationAsked = true;
    try {
      const res = Notification.requestPermission();
      if (res && typeof res.catch === 'function') res.catch(() => {});
    } catch (e) {}
  }

  function showSystemNotification(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const options = {
      body: body,
      tag: tag,
      renotify: true,
      icon: 'images/icon-192.png',
      badge: 'images/icon-192.png',
      vibrate: [200, 100, 200]
    };
    try {
      // 모바일(특히 안드로이드)에서는 서비스워커 알림이 더 안정적이다.
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready
          .then((reg) => reg.showNotification(title, options))
          .catch(() => { try { new Notification(title, options); } catch (e) {} });
        return true;
      }
      new Notification(title, options);
      return true;
    } catch (e) {
      return false;
    }
  }

  function showReminderToast(headline, detail, tier) {
    if (!toastStackEl) {
      toastStackEl = document.createElement('div');
      toastStackEl.className = 'toast-stack';
      toastStackEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastStackEl);
    }

    const toast = document.createElement('div');
    toast.className = `toast-item cd-${tier || 'today'}`;
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
      <span class="toast-icon" aria-hidden="true">⏰</span>
      <div class="toast-text">
        <strong>${escapeHtml(headline)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>
      <button type="button" class="toast-close" aria-label="알림 닫기">×</button>
    `;

    const remove = () => {
      toast.classList.add('is-out');
      setTimeout(() => toast.remove(), 260);
    };
    toast.querySelector('.toast-close').addEventListener('click', remove);
    toastStackEl.appendChild(toast);
    setTimeout(remove, 8000);
  }

  // 사전 알림용 짧은 차임 (지각 벌칙 알람과 구분되는 2음)
  function playReminderChime() {
    if (!penaltyAudioCtx || penaltyAudioCtx.state !== 'running') return;
    const ctx = penaltyAudioCtx;
    const now = ctx.currentTime;
    [[880, 0], [1174, 0.16]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.2, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.32);
    });
  }

  function reminderStepLabel(minutes) {
    return minutes >= 60 ? `${Math.floor(minutes / 60)}시간` : `${minutes}분`;
  }

  function fireReminder(promiseObj, minutes) {
    const tier = minutes <= 1 ? 'now' : minutes <= 5 ? 'm5' : minutes <= 10 ? 'm10' : minutes <= 30 ? 'm30' : 'h1';
    const headline = `${reminderStepLabel(minutes)} 후 약속 - ${promiseObj.title}`;
    const place = promiseObj.venueName || promiseObj.location || '';
    const detail = `${promiseObj.dateTime || ''}${place ? ` · ${place}` : ''}`.trim() || '지금 출발할 시간이에요.';

    showReminderToast(headline, detail, tier);
    showSystemNotification(`⏰ ${headline}`, detail, `promise-${promiseObj.id}-${minutes}`);
    playReminderChime();
    if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (e) {} }
  }

  function checkPromiseReminders() {
    const now = Date.now();
    let changed = false;

    promisesList.forEach((p) => {
      if (!p || !p.id) return;
      if (!amIAttendeeOf(p)) return;

      const ts = Number(p.targetTimestamp);
      if (!Number.isFinite(ts)) return;

      const fired = Array.isArray(reminderFiredMap[p.id]) ? reminderFiredMap[p.id] : [];
      const diff = ts - now;

      REMINDER_STEPS.forEach((minutes) => {
        if (fired.includes(minutes)) return;

        const stepAt = ts - minutes * 60 * 1000;
        if (now < stepAt) return;          // 아직 시점 전
        if (diff <= 0) { fired.push(minutes); changed = true; return; }  // 이미 정각 지남 → 조용히 소진

        fired.push(minutes);
        changed = true;

        // 앱을 늦게 켠 경우(임계 시점을 한참 지나 발견) 지난 알림은 울리지 않는다.
        if (now - stepAt <= REMINDER_WINDOW_MS) fireReminder(p, minutes);
      });

      if (fired.length) reminderFiredMap[p.id] = fired;
    });

    // 오래된 기록 정리
    Object.keys(reminderFiredMap).forEach((id) => {
      const found = promisesList.find(p => p.id === id);
      const ts = found ? Number(found.targetTimestamp) : NaN;
      if (!found || (Number.isFinite(ts) && now > ts + REMINDER_KEEP_MS)) {
        delete reminderFiredMap[id];
        changed = true;
      }
    });

    if (changed) saveStorage('pa_reminder_fired', reminderFiredMap);
  }

  // 약속이 끝났을 때 "완료" 요약 카드를 톡 튀어나오게 보여주고 2초 뒤 사라진다.
  function showPromiseCompleteCard(promiseObj) {
    const existing = document.getElementById('promiseCompleteOverlay');
    if (existing) existing.remove();

    const names = promiseParticipantNames(promiseObj);
    const place = promiseObj.venueName
      ? `${promiseObj.venueName}${promiseObj.location ? ` (${promiseObj.location})` : ''}`
      : (promiseObj.location || '장소 미정');

    const overlay = document.createElement('div');
    overlay.id = 'promiseCompleteOverlay';
    overlay.className = 'complete-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = `
      <div class="complete-card">
        <div class="complete-check" aria-hidden="true">
          <i data-lucide="check"></i>
        </div>
        <strong class="complete-title">완료</strong>
        <span class="complete-subtitle">오늘의 약속</span>
        <div class="complete-info">
          <div class="complete-row"><span class="complete-key">약속</span><span class="complete-val">${escapeHtml(promiseObj.title || '약속')}</span></div>
          <div class="complete-row"><span class="complete-key">시간</span><span class="complete-val">${escapeHtml(promiseTimeRangeLabel(promiseObj))}</span></div>
          <div class="complete-row"><span class="complete-key">장소</span><span class="complete-val">${escapeHtml(place)}</span></div>
          <div class="complete-row"><span class="complete-key">인원</span><span class="complete-val">${names.length}명${names.length ? ` · ${escapeHtml(names.join(', '))}` : ''}</span></div>
        </div>
        <p class="complete-wish">좋은 만남이였길 바래요!</p>
      </div>
    `;

    document.body.appendChild(overlay);
    if (window.lucide) window.lucide.createIcons();

    const close = () => {
      overlay.classList.add('is-out');
      setTimeout(() => overlay.remove(), 420);
    };
    overlay.addEventListener('click', close);
    setTimeout(close, 2600);   // 팝업 애니메이션 후 약 2초 유지
  }

  // 종료 시간이 지난 약속을 완료 처리하고 캘린더 기록으로 넘긴다.
  function checkPromiseCompletion() {
    const now = Date.now();
    let changed = false;
    let needRender = false;

    promisesList.forEach((p) => {
      if (!p || !p.id) return;
      if (!amIAttendeeOf(p)) return;
      if (completedNotified.includes(p.id)) return;

      const end = promiseEndTs(p);
      if (!Number.isFinite(end) || now < end) return;

      completedNotified.push(p.id);
      changed = true;
      needRender = true;

      // 완료 상태를 내 참석 노드에 기록 (약속 본문은 호스트 전용)
      writeMyAttendance(p, { completed: true, completedAt: now });

      // 방금 끝난 약속만 알린다. (예전 약속을 열었을 때 몰아서 알리지 않도록)
      if (now - end <= REMINDER_WINDOW_MS) {
        const lateNames = latePenaltyNames(p);
        const detail = lateNames.length > 0
          ? `지각: ${lateNames.join(', ')} · 캘린더에 기록했습니다.`
          : '정시 완료로 캘린더에 기록했습니다.';
        showPromiseCompleteCard(p);
        showSystemNotification(`✅ 약속 완료 - ${p.title}`, detail, `promise-done-${p.id}`);
      }
    });

    if (changed) {
      if (completedNotified.length > 300) completedNotified = completedNotified.slice(-300);
      saveStorage('pa_completed_promises', completedNotified);
    }
    if (needRender) {
      renderPromises();
      renderCalendar();
    }
  }

  function tickPromiseTimers() {
    tickCountdownBadges();
    checkPromiseReminders();
    checkPromiseCompletion();
  }

  // 첫 사용자 조작에서 오디오 잠금 해제 (알람 벌칙 대비)
  ['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, () => {
      if (!penaltyAudioUnlocked) {
        unlockPenaltyAudio();
        if (penaltyActiveId && penaltyActiveType === 'alarm' && !penaltyBeepTimer) startPenaltyAlarm();
      }
      // 알림 권한도 사용자 조작 시점에 요청해야 iOS/Safari 에서 허용된다.
      ensureNotificationPermission();
    }, { once: false, passive: true });
  });

  setInterval(evaluatePenaltyState, 5000);
  setInterval(tickPromiseTimers, 1000);

  // 백그라운드에서 돌아오면 즉시 동기화 (모바일은 타이머가 멈춘다)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tickPromiseTimers();
  });

  function hideSplashScreen() {
    const splash = document.getElementById('appSplashScreen');
    if (splash) {
      setTimeout(() => {
        splash.classList.add('fade-out');
        setTimeout(() => {
          if (splash.parentElement) splash.remove();
          document.documentElement.style.backgroundColor = '';
          if (document.body) document.body.style.backgroundColor = '';
        }, 350);
      }, 600);
    }
  }

  // Initialize App
  initInstantGpsTracking();
  // initFirebaseRealtimeDB() is now called earlier (before getRedirectResult)
  checkOnboarding();
  renderAll();
  evaluatePenaltyState();
  tickPromiseTimers();
  hideSplashScreen();
});

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
  let pendingSocialAuth = null;

  // 초기화 순서와 무관하게 접근되므로(초기화 중 콜백 등) 최상단에서 선언한다.
  let isCloudDataListening = false;
  let lastSyncedProfileJson = '';
  let arrivedNotified = loadStorage('pa_arrived_promises', []);

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
        // 프로필 동기화보다 먼저 등록해야, 프로필 단계에서 오류가 나도 약속 구독이 유지된다.
        dbRef.ref('promises').on('value', (snapshot) => {
          const cloudData = snapshot.val();
          const arr = cloudData ? Object.values(cloudData).filter(Boolean) : [];
          arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          promisesList = arr;
          saveStorage('pa_promises_list', promisesList);
          renderPromises();
        });

        // DB 연결 즉시 내 프로필 클라우드 동기화 (친구 코드 등록 보장)
        if (userProfile && userProfile.name) {
          syncUserProfileToCloud();
          publishMyLocation();
        }

        if (firebase.auth) {
          firebase.auth().onAuthStateChanged((authUser) => {
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

  // 변경된 약속 1건만 클라우드에 반영 (전역 덮어쓰기 금지)
  function syncPromisesToCloud(changedPromise) {
    saveStorage('pa_promises_list', promisesList);
    if (!dbRef) return;
    if (changedPromise && changedPromise.id) {
      dbWrite('promises/' + changedPromise.id, changedPromise);
    }
  }

  function removePromiseFromCloud(promiseId) {
    saveStorage('pa_promises_list', promisesList);
    if (dbRef && promiseId) dbWrite('promises/' + promiseId, null);
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
  const btnCopySettingsCode = document.getElementById('btnCopySettingsCode');
  const btnAddFriendByCode = document.getElementById('btnAddFriendByCode');
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
      alert(`🎉 [ ${userProfile.name} ] 님, 오신 것을 환영합니다!`);
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

      alert(`가입 완료!\n\n닉네임: ${name}\n친구 코드: ${userCode}`);
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
    const settingsCodeEl = document.getElementById('settingsCodeText');
    if (settingsCodeEl) settingsCodeEl.textContent = myCode;

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
        document.getElementById('inputPromiseLocation').value = selectedPickedAddress;
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
  if (btnCopySettingsCode) btnCopySettingsCode.addEventListener('click', () => copyCodeToClipboard(userProfile?.code));
  if (btnCopyTabCode) btnCopyTabCode.addEventListener('click', () => copyCodeToClipboard(userProfile?.code));

  function copyCodeToClipboard(codeText) {
    const code = codeText || userProfile?.code;
    if (!code) return;
    syncUserProfileToCloud();
    navigator.clipboard.writeText(code).then(() => {
      alert(`📋 내 친구 코드 [ ${code} ] 가 복사되었습니다!\n(서버 등록 완료 - 친구에게 코드를 전달해 주세요)`);
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
        alert('❌ 존재하지 않는 친구 코드이거나 서버 응답 시간이 초과되었습니다.\n\n💡 상대방 스마트폰 화면의 [내 친구 코드 복사]를 누른 후 다시 시도해 보세요!');
      }
    }, 12000);

    const failNotFound = () => {
      if (isHandled) return;
      isHandled = true;
      clearTimeout(timeoutId);
      restoreBtn();
      alert(`❌ [ ${rawVal} ] 친구 코드를 찾을 수 없습니다.\n\n💡 상대방 스마트폰 앱에서 [내 친구 코드]가 정상적으로 화면에 떠있는지 확인해 주세요!`);
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
      alert(`📩 [ ${targetUser.name} ] 님에게 친구 요청을 보냈습니다!\n\n상대방 스마트폰 화면의 [받은 친구 요청]에서 [수락]을 누르면 바로 연결됩니다.`);
    }

    if (rawVal.includes('@')) lookupByEmail();
    else lookupByCode();
  }

  if (btnAddFriendByCode) {
    btnAddFriendByCode.addEventListener('click', () => {
      processAddFriend(document.getElementById('inputAddFriendCode'));
    });
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
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPages.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetEl = document.getElementById(targetTab);
      if (targetEl) targetEl.classList.add('active');
    });
  });

  function renderAll() {
    renderPromises();
    renderFriendRequests();
    renderFriends();
  }

  function renderFriendRequests() {
    const section = document.getElementById('friendRequestsSection');
    const container = document.getElementById('friendRequestsList');
    if (!section || !container) return;

    if (!friendRequestsList || friendRequestsList.length === 0) {
      section.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    section.style.display = 'block';
    container.innerHTML = '';

    friendRequestsList.forEach(req => {
      const card = document.createElement('div');
      card.className = 'card-item';
      card.style.background = 'rgba(253, 203, 110, 0.08)';
      card.style.borderColor = '#fdcb6e';
      card.style.padding = '12px 14px';

      card.innerHTML = `
        <div class="card-header-row" style="display:flex; align-items:center; gap:10px;">
          <img src="${safeImageUrl(req.fromAvatar)}" style="width:38px; height:38px; border-radius:50%; border:2px solid var(--primary); object-fit:cover;">
          <div>
            <div style="font-weight:700; color:#fff; font-size:0.9rem;">${escapeHtml(req.fromName || '친구')}</div>
            <div style="font-size:0.75rem; color:#a0a7b5;">코드: ${escapeHtml(req.fromCode || '')}</div>
          </div>
          <span class="badge wait" style="margin-left:auto; background:rgba(253,203,110,0.2); color:#fdcb6e; border:1px solid #fdcb6e; font-size:0.72rem; padding:3px 8px;">친구요청 도착</span>
        </div>
        <div class="card-action-row" style="margin-top:10px; display:flex; gap:8px;">
          <button class="btn-primary btn-accept-friend-req" data-code="${escapeHtml(req.fromCode)}" style="flex:1; background:var(--green); font-weight:700; padding:8px; font-size:0.82rem;">
            <i data-lucide="check"></i> 수락
          </button>
          <button class="btn-secondary btn-reject-friend-req" data-code="${escapeHtml(req.fromCode)}" style="flex:1; color:#ff7675; border-color:rgba(255,118,117,0.4); background:rgba(255,118,117,0.1); font-weight:700; padding:8px; font-size:0.82rem;">
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
    alert(`🎉 [ ${req.fromName} ] 님의 친구 요청을 수락했습니다! 상호 친구로 등록되었습니다.`);
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
    const invitationSection = document.getElementById('invitationSection');
    const invitationsList = document.getElementById('invitationsList');

    if (!listContainer) return;
    listContainer.innerHTML = '';
    if (invitationsList) invitationsList.innerHTML = '';

    const myName = userProfile ? userProfile.name : '나';

    // Separate My Promises vs Invited Promises
    const invitedPromises = promisesList.filter(p => p.invitedUsers && p.invitedUsers.includes(myName) && !p.participants.includes(myName));
    const joinedPromises = promisesList.filter(p => p.participants && p.participants.includes(myName));

    // Render Invitations Section
    if (invitedPromises.length > 0 && invitationSection && invitationsList) {
      invitationSection.style.display = 'block';

      invitedPromises.forEach(p => {
        const invCard = document.createElement('div');
        invCard.className = 'card-item';
        invCard.style.borderColor = 'var(--yellow)';
        invCard.style.background = 'rgba(253, 203, 110, 0.08)';

        const locationDisplay = p.venueName
          ? `<strong>${escapeHtml(p.venueName)}</strong> (${escapeHtml(p.location)})`
          : escapeHtml(p.location);

        invCard.innerHTML = `
          <div class="card-header-row">
            <h3 class="card-title" style="color:#fdcb6e;">📩 ${escapeHtml(p.title)} (초대장)</h3>
            <span class="badge wait">초대 대기중</span>
          </div>
          <div class="card-info">
            <div class="card-info-item"><i data-lucide="user"></i> <strong>주최자:</strong> ${escapeHtml(p.hostName || '친구')}</div>
            <div class="card-info-item"><i data-lucide="map-pin"></i> <strong>위치:</strong> ${locationDisplay}</div>
            <div class="card-info-item"><i data-lucide="clock"></i> <strong>시간:</strong> ${escapeHtml(p.dateTime)}</div>
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
            if (!found.participants.includes(myName)) found.participants.push(myName);
            found.invitedUsers = (found.invitedUsers || []).filter(u => u !== myName);
            syncPromisesToCloud(found);
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
            found.invitedUsers = (found.invitedUsers || []).filter(u => u !== myName);
            syncPromisesToCloud(found);
            renderAll();
          }
        });
      });
    } else if (invitationSection) {
      invitationSection.style.display = 'none';
    }


    // Render Joined Promises
    if (joinedPromises.length === 0) {
      listContainer.innerHTML = `<p style="color:#888; text-align:center; padding:40px 20px;">등록된 약속이 없습니다.</p>`;
      return;
    }

    joinedPromises.forEach(p => {
      const card = document.createElement('div');
      card.className = 'card-item';

      const participantsList = (p.participants && p.participants.length > 0) ? p.participants : [myName];
      const friendPills = participantsList.map(name => `<span class="friend-pill">${escapeHtml(name)}</span>`).join('');


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
            <button class="btn-delete-promise btn-delete-trigger" data-id="${escapeHtml(p.id)}" title="약속 삭제">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>
        <div class="card-info">
          <div class="card-info-item"><i data-lucide="map-pin"></i> <strong>위치:</strong> ${locationDisplay} <span style="color:#a0a7b5;">(${escapeHtml(distStr)})</span></div>
          <div class="card-info-item"><i data-lucide="clock"></i> <strong>시간:</strong> ${escapeHtml(p.dateTime)}</div>
          <div style="margin-top:6px;">
            <span style="font-size:0.75rem; color:#888;">참가자:</span>
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
          promisesList = promisesList.filter(item => item.id !== promiseId);
          removePromiseFromCloud(promiseId);
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
              found.participants = (found.participants || []).filter(n => n !== myName);
              if (found.participants.length === 0) {
                promisesList = promisesList.filter(p => p.id !== found.id);
                removePromiseFromCloud(found.id);
              } else {
                syncPromisesToCloud(found);
              }
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

    const otherParticipants = (promiseObj.participants || []).filter(name => name !== (userProfile?.name || '나'));

    if (otherParticipants.length === 0) {
      consentContainer.innerHTML = `<div class="distance-item near"><span>다른 참가자가 없어 즉시 나갈 수 있습니다.</span><span style="color:#00b894;">✓ 승인됨</span></div>`;
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
      activePromiseForLeave.participants = (activePromiseForLeave.participants || []).filter(n => n !== myName);

      if (activePromiseForLeave.participants.length === 0) {
        promisesList = promisesList.filter(p => p.id !== activePromiseForLeave.id);
        removePromiseFromCloud(activePromiseForLeave.id);
      } else {
        syncPromisesToCloud(activePromiseForLeave);
      }

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

      // Draw light green translucent circle for arrival radius
      const arrivalRadius = promiseObj.arrivalRadiusMeters || 300;
      L.circle([venueLat, venueLng], {
        radius: arrivalRadius,
        color: '#10b981',
        fillColor: '#10b981',
        fillOpacity: 0.18,
        weight: 2
      }).addTo(leafletMapInstance);

      const labelText = promiseObj.venueName
        ? `<b>${escapeHtml(promiseObj.venueName)}</b><br>${escapeHtml(promiseObj.location)}`
        : `<b>${escapeHtml(promiseObj.location)}</b><br>약속 장소`;

      L.marker([venueLat, venueLng])
        .addTo(leafletMapInstance)
        .bindPopup(labelText)
        .openPopup();

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
      const friendNames = (promiseObj.participants || []).filter(n => n !== myName);

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
          renderArrivalGroupSplit(promiseObj, allParticipants);
        }, () => {});
      });

      renderMapCarousel(allParticipants);
      renderArrivalGroupSplit(promiseObj, allParticipants);
      selectMapParticipant(meParticipantObj);

    }, 100);
  }

  // RENDER ARRIVAL SPLIT
  function renderArrivalGroupSplit(promiseObj, participants) {
    const container = document.getElementById('arrivalGroupSection');
    if (!container) return;
    container.innerHTML = '';

    const radius = promiseObj.arrivalRadiusMeters || 300;
    const arrivedList = [];
    const unarrivedList = [];

    participants.forEach(p => {
      // 공유된 좌표가 없으면 거리를 추정하지 않는다.
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
        unarrivedList.push({ ...p, distStr: p.isMe ? '위치 확인 중' : '위치 공유 안 함' });
        return;
      }

      const dist = calculateHaversineDistance(p.lat, p.lng, p.venueLat, p.venueLng);
      const distStr = dist > 1000 ? `${(dist / 1000).toFixed(1)}km` : `${Math.round(dist)}m`;

      if (p.isGpsConnected && dist <= radius) {
        arrivedList.push({ ...p, distStr });
      } else {
        unarrivedList.push({ ...p, distStr: p.isGpsConnected ? distStr : `${distStr} · 오프라인` });
      }
    });

    const box = document.createElement('div');
    box.style.display = 'grid';
    box.style.gridTemplateColumns = '1fr 1fr';
    box.style.gap = '8px';

    const arrivedItemsHtml = arrivedList.length > 0 
      ? arrivedList.map(a => `
          <div style="display:flex; align-items:center; gap:6px; background:rgba(0,184,148,0.12); border:1px solid rgba(0,184,148,0.3); padding:5px 8px; border-radius:8px;">
            <img src="${safeImageUrl(a.avatar)}" style="width:22px; height:22px; border-radius:50%;">
            <span style="font-size:0.75rem; color:#fff; font-weight:600;">${escapeHtml(a.name)}</span>
            <span style="font-size:0.68rem; color:#00b894; margin-left:auto;">${escapeHtml(a.distStr)}</span>
          </div>
        `).join('')
      : `<p style="font-size:0.72rem; color:#888; margin:2px 0;">아직 도착자 없음</p>`;

    const unarrivedItemsHtml = unarrivedList.length > 0
      ? unarrivedList.map(u => `
          <div style="display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); padding:5px 8px; border-radius:8px;">
            <img src="${safeImageUrl(u.avatar)}" style="width:22px; height:22px; border-radius:50%;">
            <span style="font-size:0.75rem; color:#fff; font-weight:600;">${escapeHtml(u.name)}</span>
            <span style="font-size:0.68rem; color:#ff7675; margin-left:auto;">${escapeHtml(u.distStr)}</span>
          </div>
        `).join('')
      : `<p style="font-size:0.72rem; color:#00b894; margin:2px 0;">모두 도착 완료</p>`;

    box.innerHTML = `
      <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:10px; border:1px solid rgba(0,184,148,0.2);">
        <span style="font-size:0.75rem; color:#00b894; font-weight:bold; display:block; margin-bottom:6px;">
          도착함 (${arrivedList.length}명)
        </span>
        <div style="display:flex; flex-direction:column; gap:4px;">${arrivedItemsHtml}</div>
      </div>

      <div style="background:rgba(0,0,0,0.25); padding:8px; border-radius:10px; border:1px solid rgba(255,118,117,0.2);">
        <span style="font-size:0.75rem; color:#ff7675; font-weight:bold; display:block; margin-bottom:6px;">
          미도착 / GPS 꺼짐 (${unarrivedList.length}명)
        </span>
        <div style="display:flex; flex-direction:column; gap:4px;">${unarrivedItemsHtml}</div>
      </div>
    `;

    container.appendChild(box);
  }

  // PERFECT CIRCULAR LEAFLET AVATAR MARKERS
  function addCustomAvatarMarkerToMap(participantObj) {
    const avatarHtml = `
      <div class="custom-map-avatar-container">
        <div class="custom-map-avatar-ring" style="background: ${participantObj.isGpsConnected ? '#6c5ce7' : '#ff7675'}; border: 2px solid ${participantObj.isGpsConnected ? '#00b894' : '#ff7675'};">
          <img src="${safeImageUrl(participantObj.avatar)}" class="custom-map-avatar-img" style="${!participantObj.isGpsConnected ? 'filter:grayscale(80%);' : ''}">
        </div>
        <div class="custom-map-avatar-badge">${escapeHtml(participantObj.name)}</div>
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

  function renderMapCarousel(participants) {
    const carouselContainer = document.getElementById('mapFriendsCarousel');
    if (!carouselContainer) return;
    carouselContainer.innerHTML = '';

    participants.forEach((p, idx) => {
      const item = document.createElement('div');
      item.className = `carousel-friend-item ${idx === 0 ? 'active' : ''}`;
      item.setAttribute('data-name', p.name);

      item.innerHTML = `
        <img src="${safeImageUrl(p.avatar)}" class="carousel-friend-avatar">
        <span class="carousel-friend-name">${escapeHtml(p.name)}</span>
      `;

      item.addEventListener('click', () => {
        document.querySelectorAll('.carousel-friend-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        selectMapParticipant(p);
      });

      carouselContainer.appendChild(item);
    });
  }

  function selectMapParticipant(pObj) {
    selectedMapParticipant = pObj;
    if (leafletMapInstance && Number.isFinite(pObj.lat) && Number.isFinite(pObj.lng)) {
      leafletMapInstance.panTo([pObj.lat, pObj.lng]);
    }
    updateGpsStatusView(pObj);
  }

  // 위치 연결 상태 / 거리 표시 (실제 상태 기반)
  function updateGpsStatusView(pObj) {
    document.getElementById('detailFriendAvatar').src = pObj.avatar || DEFAULT_AVATAR;
    document.getElementById('detailFriendName').textContent = pObj.name;
    document.getElementById('detailFriendAddress').textContent = pObj.address || '위치 수신 중...';

    const hasCoords = Number.isFinite(pObj.lat) && Number.isFinite(pObj.lng);
    const statusEl = document.getElementById('statGpsStatus');
    if (statusEl) {
      if (!hasCoords) {
        statusEl.textContent = pObj.isMe ? '위치 확인 중' : '위치 공유 안 함';
        statusEl.className = 'stat-val';
      } else if (pObj.isGpsConnected && pObj.source !== 'ip') {
        statusEl.textContent = pObj.accuracy != null ? `연결됨 (±${pObj.accuracy}m)` : '연결됨';
        statusEl.className = 'stat-val text-green';
      } else if (pObj.source === 'ip') {
        statusEl.textContent = 'IP 대략 위치';
        statusEl.className = 'stat-val';
      } else {
        statusEl.textContent = '오프라인';
        statusEl.className = 'stat-val';
      }
    }

    const updatedEl = document.getElementById('statUpdated');
    if (updatedEl) {
      if (!pObj.lastGpsConnectedTs) {
        updatedEl.textContent = '-';
      } else {
        const diffMins = Math.floor((Date.now() - pObj.lastGpsConnectedTs) / 60000);
        if (diffMins < 1) updatedEl.textContent = '방금 전';
        else if (diffMins < 60) updatedEl.textContent = `${diffMins}분 전`;
        else updatedEl.textContent = `${Math.floor(diffMins / 60)}시간 전`;
      }
    }

    const distEl = document.getElementById('statDistance');
    if (distEl) {
      if (!hasCoords || !Number.isFinite(pObj.venueLat) || !Number.isFinite(pObj.venueLng)) {
        distEl.textContent = '-';
      } else {
        const distMeters = calculateHaversineDistance(pObj.lat, pObj.lng, pObj.venueLat, pObj.venueLng);
        distEl.textContent = distMeters > 1000
          ? `${(distMeters / 1000).toFixed(1)} km`
          : `${Math.round(distMeters)} m`;
      }
    }
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
      listContainer.innerHTML = `<p style="color:#888; text-align:center; padding:40px 20px;">등록된 친구가 없습니다.</p>`;
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
            <div class="friend-sub">📍 ${escapeHtml(f.homeLoc ? f.homeLoc : '친구')}</div>
          </div>
        </div>
      `;
      listContainer.appendChild(card);
    });
    if (window.lucide) window.lucide.createIcons();
  }




  // ==========================================
  // 6. Create Promise Modal
  // ==========================================
  if (btnOpenCreatePromise) {
    btnOpenCreatePromise.addEventListener('click', () => {
      populateFriendSelector();
      createPromiseModal.classList.add('active');


      const min10Time = new Date(Date.now() + 10 * 60 * 1000);
      const min10Formatted = new Date(min10Time.getTime() - min10Time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      
      const timeInput = document.getElementById('inputPromiseTime');
      timeInput.min = min10Formatted;
      timeInput.value = min10Formatted;
    });
  }

  if (btnCloseCreatePromise) btnCloseCreatePromise.addEventListener('click', () => createPromiseModal.classList.remove('active'));
  if (btnCancelCreatePromise) btnCancelCreatePromise.addEventListener('click', () => createPromiseModal.classList.remove('active'));

  function populateFriendSelector() {
    const container = document.getElementById('friendSelectorList');
    if (!container) return;
    container.innerHTML = '';

    if (friendsList.length === 0) {
      return;
    }

    friendsList.forEach(f => {
      const chip = document.createElement('div');
      chip.className = 'friend-chip selected';
      chip.setAttribute('data-name', f.name);
      chip.textContent = `✓ ${f.name}`;

      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        chip.textContent = chip.classList.contains('selected') ? `✓ ${f.name}` : f.name;
      });
      container.appendChild(chip);
    });
  }

  if (formCreatePromise) {
    formCreatePromise.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('inputPromiseTitle').value.trim();
      const location = document.getElementById('inputPromiseLocation').value.trim();
      const venueName = document.getElementById('inputPromiseVenueName').value.trim();
      const dateTimeVal = document.getElementById('inputPromiseTime').value;
      const leaveRule = document.getElementById('selectLeaveRule').value;
      const arrivalRadiusMeters = parseInt(document.getElementById('inputAutoArrivalDist').value) || 300;

      if (!title || !location || !dateTimeVal) {
        alert('약속 이름, 위치, 시간을 모두 입력해 주세요.');
        return;
      }

      // STRICT 10-MINUTE FUTURE CONSTRAINT VALIDATION
      const selectedTs = new Date(dateTimeVal).getTime();
      const currentTs = Date.now();
      
      if (selectedTs < currentTs + 10 * 60 * 1000 - 5000) {
        alert('⚠️ 약속 시간은 현재 시간으로부터 최소 10분 이후부터 설정해 주세요! (10분 미만 시각은 생성할 수 없습니다)');
        document.getElementById('inputPromiseTime').focus();
        return;
      }

      const selectedChips = document.querySelectorAll('.friend-chip.selected');
      let selectedFriendNames = Array.from(selectedChips).map(c => c.getAttribute('data-name'));

      const myName = userProfile ? userProfile.name : '나';
      const participantsList = [myName];
      const invitedList = selectedFriendNames.filter(n => n !== myName);

      const dateObj = new Date(dateTimeVal);
      const targetTs = dateObj.getTime();
      const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()} ${String(dateObj.getHours()).padStart(2,'0')}:${String(dateObj.getMinutes()).padStart(2,'0')}`;

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
        dateTime: dateStr,
        leaveRule: leaveRule,
        hostName: myName,
        hostUid: ensureProfileUid() || '',
        arrivalRadiusMeters: arrivalRadiusMeters,
        lat: venueLat,
        lng: venueLng,
        participants: participantsList,
        invitedUsers: invitedList,
        checkedIn: false,
        createdAt: Date.now()
      };

      selectedPickedLat = null;
      selectedPickedLng = null;

      fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`)
        .then(res => res.json())
        .then(data => {
          if (data && data.length > 0) {
            newPromise.lat = parseFloat(data[0].lat);
            newPromise.lng = parseFloat(data[0].lon);
            syncPromisesToCloud(newPromise);
            renderPromises();
          }
        }).catch(() => {});

      promisesList.unshift(newPromise);
      syncPromisesToCloud(newPromise);
      document.getElementById('inputPromiseTitle').value = '';
      document.getElementById('inputPromiseLocation').value = '';
      document.getElementById('inputPromiseVenueName').value = '';
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

    if (!promiseObj.checkedIn) {
      promiseObj.checkedIn = true;
      syncPromisesToCloud(promiseObj);
    }
  }

  // Initialize App
  initInstantGpsTracking();
  // initFirebaseRealtimeDB() is now called earlier (before getRedirectResult)
  checkOnboarding();
  renderAll();
});

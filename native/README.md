# 네이티브 앱 (안드로이드)

웹앱(`https://promise-alarm-app.web.app`)을 Capacitor 로 감싼 안드로이드 래퍼입니다.
화면은 그대로 호스팅된 웹을 로드하므로, 웹을 배포하면 앱도 자동으로 최신 상태가 됩니다.

## 네이티브로 얻는 것

- 앱을 완전히 닫아도 지각 시각에 OS 알림(전용 알람 채널, 최대 중요도)이 울립니다.
  웹앱은 탭이 종료되면 소리를 낼 수 없어 이 부분만 네이티브가 필요합니다.
- 정각부터 30초 간격으로 최대 40회(약 20분) 예약되며, 도착하면 남은 예약이 취소됩니다.
  (벌칙 지속 시간이 설정된 약속은 그 시간만큼만 예약)
- 알림 소리는 기본 알림음이 아니라 전용 사이렌(`android/app/src/main/res/raw/late_alarm.wav`, 8초)입니다.
  음원은 `node tools/make-alarm-sound.js` 로 생성/재생성합니다.
- 절전(Doze) 상태에서도 울리도록 `allowWhileIdle` + `USE_EXACT_ALARM` 사용, 재부팅 후에도 예약이 복원됩니다.
- 네이티브 앱에서는 웹 사이렌을 끄고 OS 알람만 울려 소리가 겹치지 않습니다.
- 홈 화면 앱 아이콘 / 전체 화면 WebView.

## 구조

- `capacitor.config.json` — `server.url` 로 배포된 웹을 로드
- `www/` — 네트워크 없을 때 표시되는 대체 화면
- `android/` — 생성된 안드로이드 프로젝트 (권한은 `AndroidManifest.xml` 에 추가됨)
- 웹 쪽 연동 코드는 `js/app.js` 의 "네이티브(Capacitor) 브릿지" 섹션
  (`window.Capacitor` 가 없으면 전부 무시되므로 브라우저 동작에는 영향 없음)

## APK 빌드

로컬에 Java/Android SDK 가 없으면 GitHub Actions 로 빌드합니다.

1. 커밋 & 푸시
2. GitHub > Actions > **Build Android APK** > Run workflow
3. 완료 후 Artifacts 에서 `promise-alarm-debug-apk` 다운로드 → 폰에 설치

로컬에서 빌드하려면 JDK 21 + Android SDK 설치 후:

```bash
cd native
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

산출물: `native/android/app/build/outputs/apk/debug/app-debug.apk`

## 설치 후 확인할 권한

- 알림 허용 (Android 13+ 는 첫 실행 시 요청)
- 배터리 최적화 제외 (설정 > 앱 > 약속 알람 > 배터리 > 제한 없음) — 예약 알람이 지연되지 않게
- 위치 권한 "항상 허용" — 백그라운드 도착 판정용

# 네이티브 앱 (안드로이드)

웹앱(`https://promise-alarm-app.web.app`)을 Capacitor 로 감싼 안드로이드 래퍼입니다.
화면은 그대로 호스팅된 웹을 로드하므로, 웹을 배포하면 앱도 자동으로 최신 상태가 됩니다.

## 네이티브로 얻는 것 (알라미 방식)

- **앱을 완전히 종료해도, 화면이 꺼져 있어도, 재부팅 후에도** 지각 시각에 울립니다.
  `AlarmManager.setAlarmClock` 으로 예약하므로 절전(Doze) 상태에서도 정확한 시각에 깨어납니다.
- 울릴 때 하는 일 (`AlarmService`, 포그라운드 서비스):
  - 알람 볼륨(STREAM_ALARM)을 최대로 올리고 사이렌을 **무한 반복** 재생 (끝나면 원래 볼륨 복구)
  - 진동 반복, PARTIAL_WAKE_LOCK 유지
  - 전체 화면 인텐트로 잠금화면 위에 `AlarmActivity` 표시 (화면 자동 켜짐, 뒤로 가기로 안 꺼짐)
- 끄는 방법: 알람 화면의 "알람 끄기" 버튼, 알림의 "알람 끄기" 액션, 또는 **약속 장소 도착**
  (도착하면 웹 로직이 `PromiseAlarm.stop` 호출)
- 벌칙 지속 시간이 설정된 약속은 그 시간이 지나면 자동 종료, 미설정이면 1시간 안전장치.
- 진동 벌칙 약속은 소리 없이 진동만 반복합니다.
- 알람 음원: `android/app/src/main/res/raw/late_alarm.wav` (8초 사이렌).
  `node tools/make-alarm-sound.js` 로 재생성합니다.

## 네이티브 코드 구성

| 파일 | 역할 |
| --- | --- |
| `PromiseAlarmPlugin.java` | JS 브릿지 (`schedule` / `stop` / `cancelAll` / `status` / 설정 화면 열기) |
| `AlarmStore.java` | 예약 목록 저장(SharedPreferences) + AlarmManager 등록 |
| `AlarmReceiver.java` | 예약 시각 수신, 부팅/업데이트 후 재예약 |
| `AlarmService.java` | 사이렌·진동·웨이크락·전체 화면 인텐트 (포그라운드 서비스) |
| `AlarmActivity.java` | 잠금화면 위 전체 화면 알람 UI (`res/layout/activity_alarm.xml`) |

웹 쪽 연동은 `js/app.js` 의 "네이티브(Capacitor) 브릿지" 섹션입니다
(`window.Capacitor` 가 없으면 전부 무시되므로 브라우저 동작에는 영향 없음).

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

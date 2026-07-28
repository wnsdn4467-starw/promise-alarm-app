package app.promisealarm.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

/**
 * 지각 알람 본체.
 *  - 알람 볼륨을 최대로 올리고 사이렌을 무한 반복 재생한다. (STREAM_ALARM)
 *  - 진동을 반복한다.
 *  - 전체 화면 인텐트로 잠금화면 위에 AlarmActivity 를 띄운다.
 *  - 포그라운드 서비스이므로 앱이 종료된 상태에서도 계속 울린다.
 */
public class AlarmService extends Service {

    public static final String ACTION_START = "app.promisealarm.ALARM_START";
    public static final String ACTION_STOP = "app.promisealarm.ALARM_STOP";
    public static final String CHANNEL_ID = "promise-late-alarm-fullscreen";
    private static final int NOTIF_ID = 90001;

    private static boolean ringing = false;

    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable autoStop;
    private int savedAlarmVolume = -1;

    public static boolean isRinging() {
        return ringing;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null || intent.getAction() == null ? ACTION_START : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            stopEverything();
            return START_NOT_STICKY;
        }

        String title = intent == null ? null : intent.getStringExtra(AlarmStore.EXTRA_TITLE);
        if (title == null || title.isEmpty()) title = "약속";
        long durationMs = intent == null ? 0L : intent.getLongExtra(AlarmStore.EXTRA_DURATION, 0L);
        boolean vibrateOnly = intent != null && intent.getBooleanExtra(AlarmStore.EXTRA_VIBRATE_ONLY, false);
        int alarmId = intent == null ? 0 : intent.getIntExtra(AlarmStore.EXTRA_ID, 0);

        createChannel();
        startForeground(NOTIF_ID, buildNotification(title, alarmId));

        if (!ringing) {
            ringing = true;
            acquireWakeLock();
            if (!vibrateOnly) startSiren();
            startVibration();
            showAlarmScreen(title, alarmId);
        }

        // 지속 시간이 설정된 경우 그 시간이 지나면 자동 종료 (0 이면 1시간 안전장치)
        long limit = durationMs > 0 ? durationMs : 60L * 60L * 1000L;
        if (autoStop != null) handler.removeCallbacks(autoStop);
        autoStop = new Runnable() {
            @Override
            public void run() {
                stopEverything();
            }
        };
        handler.postDelayed(autoStop, limit);

        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "지각 알람",
                NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("약속 시간에 도착하지 않으면 울리는 전체 화면 알람");
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ch.setSound(null, null);          // 소리는 서비스가 직접 재생한다
        ch.enableVibration(false);
        ch.setBypassDnd(true);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String title, int alarmId) {
        Intent full = new Intent(this, AlarmActivity.class);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        full.putExtra(AlarmStore.EXTRA_TITLE, title);
        full.putExtra(AlarmStore.EXTRA_ID, alarmId);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent fullPi = PendingIntent.getActivity(this, 1001, full, piFlags);

        Intent stop = new Intent(this, AlarmService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1002, stop, piFlags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle("🔔 지각!!")
                .setContentText(title + " · 아직 도착하지 않았습니다.")
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(fullPi)
                .setFullScreenIntent(fullPi, true)      // 잠금화면 위 전체 화면
                .addAction(android.R.drawable.ic_media_pause, "알람 끄기", stopPi);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setCategory(Notification.CATEGORY_ALARM);
            b.setVisibility(Notification.VISIBILITY_PUBLIC);
        }
        return b.build();
    }

    private void showAlarmScreen(String title, int alarmId) {
        Intent i = new Intent(this, AlarmActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        i.putExtra(AlarmStore.EXTRA_TITLE, title);
        i.putExtra(AlarmStore.EXTRA_ID, alarmId);
        try {
            startActivity(i);
        } catch (Exception e) {
            // 백그라운드 액티비티 시작이 막힌 기기는 전체 화면 인텐트가 대신 처리한다.
        }
    }

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "promise:alarm");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(60L * 60L * 1000L);
    }

    private void startSiren() {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        try {
            // 알람 볼륨을 최대로 (사용자가 낮춰둔 상태에서도 울리도록)
            savedAlarmVolume = am.getStreamVolume(AudioManager.STREAM_ALARM);
            am.setStreamVolume(AudioManager.STREAM_ALARM,
                    am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
        } catch (Exception e) {
            savedAlarmVolume = -1;
        }

        try {
            player = MediaPlayer.create(this, R.raw.late_alarm);
            if (player == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                player.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
            } else {
                player.setAudioStreamType(AudioManager.STREAM_ALARM);
            }
            player.setLooping(true);
            player.setVolume(1.0f, 1.0f);
            player.start();
        } catch (Exception e) {
            player = null;
        }
    }

    private void startVibration() {
        vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (vibrator == null || !vibrator.hasVibrator()) return;
        long[] pattern = new long[]{0, 700, 400};
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrator.vibrate(pattern, 0);
            }
        } catch (Exception e) {
            // 무시
        }
    }

    private void stopEverything() {
        ringing = false;
        if (autoStop != null) handler.removeCallbacks(autoStop);

        if (player != null) {
            try { player.stop(); } catch (Exception e) {}
            try { player.release(); } catch (Exception e) {}
            player = null;
        }
        if (vibrator != null) {
            try { vibrator.cancel(); } catch (Exception e) {}
            vibrator = null;
        }
        if (savedAlarmVolume >= 0) {
            try {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                am.setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVolume, 0);
            } catch (Exception e) {}
            savedAlarmVolume = -1;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception e) {}
        }
        wakeLock = null;

        // 알람 화면도 닫는다.
        sendBroadcast(new Intent(AlarmActivity.ACTION_CLOSE_SCREEN)
                .setPackage(getPackageName()));

        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopEverything();
        super.onDestroy();
    }

    /** 외부(플러그인)에서 알람을 멈출 때 사용 */
    public static void stop(Context ctx) {
        Intent i = new Intent(ctx, AlarmService.class);
        i.setAction(ACTION_STOP);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception e) {
            ctx.stopService(new Intent(ctx, AlarmService.class));
        }
    }
}

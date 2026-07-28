package app.promisealarm.mobile;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

/** 잠금화면 위에 뜨는 전체 화면 지각 알람. 버튼으로만 끌 수 있다. */
public class AlarmActivity extends Activity {

    public static final String ACTION_CLOSE_SCREEN = "app.promisealarm.CLOSE_ALARM_SCREEN";

    private BroadcastReceiver closeReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 화면을 켜고 잠금화면 위에 표시
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) km.requestDismissKeyguard(this, null);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_alarm);

        String title = getIntent() == null ? null : getIntent().getStringExtra(AlarmStore.EXTRA_TITLE);
        TextView titleView = findViewById(R.id.alarmPromiseTitle);
        titleView.setText(title == null || title.isEmpty() ? "약속" : title);

        Button stopBtn = findViewById(R.id.alarmStopButton);
        stopBtn.setOnClickListener(v -> {
            AlarmService.stop(getApplicationContext());
            finishAndRemoveTaskCompat();
        });

        Button openBtn = findViewById(R.id.alarmOpenAppButton);
        openBtn.setOnClickListener(v -> {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(i);
        });

        closeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                finishAndRemoveTaskCompat();
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_CLOSE_SCREEN);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(closeReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(closeReceiver, filter);
        }
    }

    private void finishAndRemoveTaskCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) finishAndRemoveTask();
        else finish();
    }

    /** 뒤로 가기로는 알람을 끌 수 없다. (알라미 방식) */
    @Override
    public void onBackPressed() {
        // 무시
    }

    @Override
    protected void onDestroy() {
        if (closeReceiver != null) {
            try { unregisterReceiver(closeReceiver); } catch (Exception e) {}
            closeReceiver = null;
        }
        super.onDestroy();
    }
}

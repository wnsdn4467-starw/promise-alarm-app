package app.promisealarm.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** 예약된 시각에 호출되어 알람 서비스를 띄운다. */
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction() == null ? "" : intent.getAction();

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            // 재부팅/업데이트 후 예약 복원
            AlarmStore.scheduleAllFromStore(context);
            return;
        }

        Intent svc = new Intent(context, AlarmService.class);
        svc.setAction(AlarmService.ACTION_START);
        svc.putExtra(AlarmStore.EXTRA_ID, intent.getIntExtra(AlarmStore.EXTRA_ID, 0));
        svc.putExtra(AlarmStore.EXTRA_TITLE, intent.getStringExtra(AlarmStore.EXTRA_TITLE));
        svc.putExtra(AlarmStore.EXTRA_DURATION, intent.getLongExtra(AlarmStore.EXTRA_DURATION, 0L));
        svc.putExtra(AlarmStore.EXTRA_VIBRATE_ONLY, intent.getBooleanExtra(AlarmStore.EXTRA_VIBRATE_ONLY, false));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(svc);
        } else {
            context.startService(svc);
        }
    }
}

package app.promisealarm.mobile;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 예약된 지각 알람을 SharedPreferences 에 보관하고 AlarmManager 에 등록한다.
 * 앱이 완전히 종료되어도, 재부팅 후에도 알람이 살아있게 하는 것이 목적이다.
 */
public class AlarmStore {

    public static final String PREFS = "promise_alarm_store";
    private static final String KEY_ALARMS = "alarms";

    public static final String EXTRA_ID = "alarm_id";
    public static final String EXTRA_TITLE = "alarm_title";
    public static final String EXTRA_DURATION = "alarm_duration_ms";
    public static final String EXTRA_VIBRATE_ONLY = "alarm_vibrate_only";

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static JSONArray load(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString(KEY_ALARMS, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    public static void save(Context ctx, JSONArray arr) {
        prefs(ctx).edit().putString(KEY_ALARMS, arr.toString()).apply();
    }

    /** 저장된 모든 알람을 취소한다. */
    public static void cancelAll(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        JSONArray arr = load(ctx);
        for (int i = 0; i < arr.length(); i += 1) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            am.cancel(pendingIntentFor(ctx, o.optInt("id"), false));
        }
        save(ctx, new JSONArray());
    }

    /** 알람 목록 전체를 다시 예약한다. (기존 예약은 모두 취소) */
    public static void replaceAll(Context ctx, JSONArray alarms) {
        cancelAll(ctx);
        save(ctx, alarms);
        scheduleAllFromStore(ctx);
    }

    public static void scheduleAllFromStore(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        JSONArray arr = load(ctx);
        long now = System.currentTimeMillis();

        for (int i = 0; i < arr.length(); i += 1) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("at", 0L);
            if (at <= 0) continue;

            // 이미 지난 알람이라도 아직 울려야 하는 시간대면 즉시 울린다.
            long duration = o.optLong("durationMs", 0L);
            long limit = duration > 0 ? duration : 60L * 60L * 1000L;
            if (at + limit < now) continue;
            long trigger = Math.max(at, now + 1000L);

            PendingIntent pi = pendingIntentFor(ctx, o.optInt("id"), true,
                    o.optString("title", "약속"), duration, o.optBoolean("vibrateOnly", false));

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    // setAlarmClock: Doze/절전 상태에서도 정확히 울리는 알람 시계용 예약
                    am.setAlarmClock(new AlarmManager.AlarmClockInfo(trigger, pi), pi);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, trigger, pi);
                }
            } catch (SecurityException e) {
                am.set(AlarmManager.RTC_WAKEUP, trigger, pi);
            }
        }
    }

    public static PendingIntent pendingIntentFor(Context ctx, int id, boolean withExtras) {
        return pendingIntentFor(ctx, id, withExtras, "약속", 0L, false);
    }

    public static PendingIntent pendingIntentFor(Context ctx, int id, boolean withExtras,
                                                 String title, long durationMs, boolean vibrateOnly) {
        Intent intent = new Intent(ctx, AlarmReceiver.class);
        intent.setAction("app.promisealarm.FIRE." + id);
        if (withExtras) {
            intent.putExtra(EXTRA_ID, id);
            intent.putExtra(EXTRA_TITLE, title);
            intent.putExtra(EXTRA_DURATION, durationMs);
            intent.putExtra(EXTRA_VIBRATE_ONLY, vibrateOnly);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(ctx, id, intent, flags);
    }
}

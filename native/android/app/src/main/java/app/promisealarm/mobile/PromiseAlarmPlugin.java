package app.promisealarm.mobile;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 웹(JS) → 네이티브 알람 브릿지.
 *
 *  Capacitor.nativePromise('PromiseAlarm', 'schedule', { alarms: [{ id, title, at, durationMs, vibrateOnly }] })
 *  Capacitor.nativePromise('PromiseAlarm', 'stop')
 *  Capacitor.nativePromise('PromiseAlarm', 'cancelAll')
 *  Capacitor.nativePromise('PromiseAlarm', 'status')
 *  Capacitor.nativePromise('PromiseAlarm', 'openExactAlarmSettings')
 *  Capacitor.nativePromise('PromiseAlarm', 'openBatterySettings')
 */
@CapacitorPlugin(name = "PromiseAlarm")
public class PromiseAlarmPlugin extends Plugin {

    @PluginMethod
    public void schedule(PluginCall call) {
        JSArray incoming = call.getArray("alarms");
        JSONArray out = new JSONArray();
        if (incoming != null) {
            for (int i = 0; i < incoming.length(); i += 1) {
                JSONObject o = incoming.optJSONObject(i);
                if (o == null) continue;
                long at = o.optLong("at", 0L);
                if (at <= 0) continue;
                JSONObject item = new JSONObject();
                try {
                    item.put("id", o.optInt("id"));
                    item.put("title", o.optString("title", "약속"));
                    item.put("at", at);
                    item.put("durationMs", o.optLong("durationMs", 0L));
                    item.put("vibrateOnly", o.optBoolean("vibrateOnly", false));
                } catch (Exception e) {
                    continue;
                }
                out.put(item);
            }
        }

        AlarmStore.replaceAll(getContext(), out);

        JSObject ret = new JSObject();
        ret.put("scheduled", out.length());
        ret.put("canScheduleExact", canScheduleExact());
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        AlarmService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        AlarmStore.cancelAll(getContext());
        AlarmService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ringing", AlarmService.isRinging());
        ret.put("pending", AlarmStore.load(getContext()).length());
        ret.put("canScheduleExact", canScheduleExact());
        call.resolve(ret);
    }

    /** Android 12+ 에서 '알람 및 리마인더' 권한 화면 열기 */
    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { getContext().startActivity(i); } catch (Exception e) {}
        }
        call.resolve();
    }

    /** 배터리 최적화 제외 요청 화면 열기 (예약 알람이 지연되지 않게) */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { getContext().startActivity(i); } catch (Exception e) {}
        }
        call.resolve();
    }

    private boolean canScheduleExact() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }
}

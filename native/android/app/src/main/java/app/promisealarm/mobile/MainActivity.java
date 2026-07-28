package app.promisealarm.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PromiseAlarmPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

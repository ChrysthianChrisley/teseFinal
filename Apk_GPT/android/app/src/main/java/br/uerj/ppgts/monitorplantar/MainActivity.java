package br.uerj.ppgts.monitorplantar;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(MonitorNativePlugin.class);
        super.onCreate(state);
    }
}

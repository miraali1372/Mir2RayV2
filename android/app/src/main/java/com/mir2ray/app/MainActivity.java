package com.mir2ray.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(XrayPlugin.class);
        super.onCreate(savedInstanceState);
        try {
            XrayCoreManager.init(this);
        } catch (Exception e) {
            android.util.Log.e("MainActivity", "Xray pre-init failed (will retry on connect)", e);
        }
    }
}

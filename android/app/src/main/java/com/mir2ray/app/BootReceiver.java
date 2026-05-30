package com.mir2ray.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent != null && Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            try {
                SecureStorage ss = new SecureStorage(context);
                String enabled = ss.getString("mir2ray_auto_start");
                if ("1".equals(enabled)) {
                    Intent serviceIntent = new Intent(context, Mir2RayVpnService.class);
                    serviceIntent.putExtra(Mir2RayVpnService.EXTRA_SHARE_URI, ss.getString("mir2ray_last_share_uri"));
                    serviceIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        context.startForegroundService(serviceIntent);
                    } else {
                        context.startService(serviceIntent);
                    }
                    Log.i(TAG, "Auto-started VPN service on boot");
                }
            } catch (Exception e) {
                Log.w(TAG, "BootReceiver failed", e);
            }
        }
    }
}

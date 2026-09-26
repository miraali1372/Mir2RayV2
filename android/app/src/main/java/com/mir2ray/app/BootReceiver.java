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
                // Don't resurrect the VPN on boot if the user had manually turned it off.
                String lastState = ss.getString("mir2ray_vpn_last_state");
                if ("1".equals(enabled) && !"0".equals(lastState)) {
                    Intent serviceIntent = new Intent(context, Mir2RayVpnService.class);
                    String payload = ss.getString("mir2ray_last_vpn_payload");
                    if (payload != null && !payload.isEmpty()) {
                        serviceIntent.putExtra(Mir2RayVpnService.EXTRA_PAYLOAD_JSON, payload);
                        Mir2RayVpnService.applyPayloadExtras(serviceIntent, payload);
                    } else {
                        serviceIntent.putExtra(Mir2RayVpnService.EXTRA_SHARE_URI, ss.getString("mir2ray_last_share_uri"));
                    }
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

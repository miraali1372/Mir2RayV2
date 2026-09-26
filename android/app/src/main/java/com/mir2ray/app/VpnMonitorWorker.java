package com.mir2ray.app;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class VpnMonitorWorker extends Worker {
    private static final String TAG = "VpnMonitorWorker";

    public VpnMonitorWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            SecureStorage ss = new SecureStorage(getApplicationContext());
            String enabled = ss.getString("mir2ray_auto_start");
            // Respect a manual disconnect: the UI writes vpn_last_state="0" when the user turns the
            // VPN off. Without this check the worker would silently reconnect within 15 minutes,
            // making the VPN impossible to keep off while auto-start is enabled.
            String lastState = ss.getString("mir2ray_vpn_last_state");
            boolean userTurnedOff = "0".equals(lastState);
            
            if ("1".equals(enabled) && !userTurnedOff) {
                if (!XrayCoreManager.isRunning()) {
                    Intent serviceIntent = new Intent(getApplicationContext(), Mir2RayVpnService.class);
                    String payload = ss.getString("mir2ray_last_vpn_payload");
                    if (payload != null && !payload.isEmpty()) {
                        serviceIntent.putExtra(Mir2RayVpnService.EXTRA_PAYLOAD_JSON, payload);
                        Mir2RayVpnService.applyPayloadExtras(serviceIntent, payload);
                    } else {
                        serviceIntent.putExtra(Mir2RayVpnService.EXTRA_SHARE_URI, ss.getString("mir2ray_last_share_uri"));
                    }
                    serviceIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                            getApplicationContext().startForegroundService(serviceIntent);
                        } else {
                            getApplicationContext().startService(serviceIntent);
                        }
                        Log.i(TAG, "Attempted to start VPN service from worker");
                    } catch (Exception e) {
                        Log.w(TAG, "Failed to start VPN service from worker", e);
                        // WorkManager applies the request's exponential backoff. Do not enqueue a
                        // second retry chain, which can otherwise create reconnect storms.
                        return Result.retry();
                    }
                }
            }
            return Result.success();
        } catch (Exception e) {
            Log.w(TAG, "VpnMonitorWorker failed", e);
            return Result.failure();
        }
    }
    
}

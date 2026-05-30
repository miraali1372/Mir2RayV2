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
            if ("1".equals(enabled)) {
                if (!XrayCoreManager.isRunning()) {
                    Intent serviceIntent = new Intent(getApplicationContext(), Mir2RayVpnService.class);
                    serviceIntent.putExtra(Mir2RayVpnService.EXTRA_SHARE_URI, ss.getString("mir2ray_last_share_uri"));
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

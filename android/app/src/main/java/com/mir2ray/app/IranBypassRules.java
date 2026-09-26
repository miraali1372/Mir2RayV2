package com.mir2ray.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.net.VpnService;
import android.util.Log;

import java.util.HashSet;
import java.util.Set;

final class IranBypassRules {
    private static final String TAG = "IranBypassRules";

    private IranBypassRules() {}

    static void applyPackageBypass(Context context, VpnService.Builder builder, String[] allowedApps, String[] userDisallowedApps) {
        if (allowedApps != null && allowedApps.length > 0) {
            Log.i(TAG, "Allowed-app VPN mode is active; Iranian app bypass is implicit for apps not in allowed list");
            return;
        }

        Set<String> packages = new HashSet<>();
        addPackages(packages, userDisallowedApps);
        // The VPN process must remain outside its own TUN to prevent the Xray outbound from
        // recursively entering the tunnel. All other bypasses are explicit user choices.
        packages.add(context.getPackageName());

        int added = 0;
        for (String pkg : packages) {
            if (pkg == null) continue;
            String cleaned = pkg.trim();
            if (cleaned.isEmpty()) continue;
            try {
                builder.addDisallowedApplication(cleaned);
                added++;
            } catch (PackageManager.NameNotFoundException ignored) {
                // Not installed on this device.
            } catch (Exception e) {
                Log.w(TAG, "Could not bypass package: " + cleaned, e);
            }
        }
        Log.i(TAG, "Applied direct-app bypass for " + added + " installed packages");
    }

    private static void addPackages(Set<String> output, String[] packages) {
        if (packages == null) return;
        for (String pkg : packages) {
            if (pkg != null && !pkg.trim().isEmpty()) output.add(pkg.trim());
        }
    }

}

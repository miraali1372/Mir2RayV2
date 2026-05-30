package com.mir2ray.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** Copies geo/rule assets required by libv2ray (same as v2rayNG). */
final class XrayAssetHelper {
    private static final String TAG = "XrayAssetHelper";
    private static final String[] GEO_FILES = {
            "geoip.dat",
            "geosite.dat",
            "geoip-only-cn-private.dat"
    };

    private XrayAssetHelper() {}

    static File prepareEnvDir(Context context) throws Exception {
        File dir = new File(context.getFilesDir(), "xray_assets");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("Cannot create xray asset directory");
        }
        AssetManager assets = context.getAssets();
        for (String name : GEO_FILES) {
            copyIfMissing(assets, name, dir);
        }
        return dir;
    }

    private static void copyIfMissing(AssetManager assets, String name, File dir) throws Exception {
        File out = new File(dir, name);
        if (out.exists() && out.length() > 0) return;
        try (InputStream in = assets.open(name);
             OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[8192];
            int read;
            while ((read = in.read(buf)) != -1) {
                os.write(buf, 0, read);
            }
            Log.i(TAG, "Copied asset " + name + " (" + out.length() + " bytes)");
        } catch (Exception e) {
            Log.w(TAG, "Asset missing in APK: " + name, e);
        }
    }
}

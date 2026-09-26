package com.mir2ray.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Copies geo/rule assets required by libv2ray (same as v2rayNG). */
final class XrayAssetHelper {
    private static final String TAG = "XrayAssetHelper";
    private static final String[] GEO_FILES = {
            "geoip.dat",
            "geosite.dat",
            "geoip-only-cn-private.dat"
    };
    private static final String GEO_ASSETS_VERSION_FILE = "xray_assets_version.txt";
    private static final String FALLBACK_GEO_ASSETS_VERSION = "libv2ray=v26.7.19;rules=202607210715;geoipOnly=202607171233";
    private static final String VERSION_MARKER = ".geo_version";

    private XrayAssetHelper() {}

    static File prepareEnvDir(Context context) throws Exception {
        File dir = new File(context.getFilesDir(), "xray_assets");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("Cannot create xray asset directory");
        }
        File versionFile = new File(dir, VERSION_MARKER);
        AssetManager assets = context.getAssets();
        String bundledVersion = readBundledVersion(assets);
        boolean refresh = !bundledVersion.equals(readMarker(versionFile));
        for (String name : GEO_FILES) {
            copyAsset(assets, name, dir, refresh);
        }
        if (refresh) {
            writeMarker(versionFile, bundledVersion);
        }
        return dir;
    }

    private static String readBundledVersion(AssetManager assets) {
        try (InputStream in = assets.open(GEO_ASSETS_VERSION_FILE)) {
            byte[] buf = new byte[256];
            int read = in.read(buf);
            if (read > 0) {
                return new String(buf, 0, read, StandardCharsets.UTF_8).trim();
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not read bundled geo asset version, using fallback", e);
        }
        return FALLBACK_GEO_ASSETS_VERSION;
    }

    private static void copyAsset(AssetManager assets, String name, File dir, boolean force) throws Exception {
        File out = new File(dir, name);
        if (!force && out.exists() && out.length() > 0) return;
        File tmp = new File(dir, name + ".tmp");
        File backup = new File(dir, name + ".bak");
        if (tmp.exists() && !tmp.delete()) {
            throw new IllegalStateException("Cannot remove stale temporary asset: " + name);
        }
        try (InputStream in = assets.open(name);
             FileOutputStream os = new FileOutputStream(tmp, false)) {
            byte[] buf = new byte[8192];
            int read;
            while ((read = in.read(buf)) != -1) {
                os.write(buf, 0, read);
            }
            os.flush();
            os.getFD().sync();
        }
        if (tmp.length() <= 0) {
            tmp.delete();
            throw new IllegalStateException("Bundled Xray asset is empty: " + name);
        }

        if (backup.exists() && !backup.delete()) {
            tmp.delete();
            throw new IllegalStateException("Cannot remove stale asset backup: " + name);
        }
        if (out.exists() && !out.renameTo(backup)) {
            tmp.delete();
            throw new IllegalStateException("Cannot back up existing Xray asset: " + name);
        }
        if (!tmp.renameTo(out)) {
            if (backup.exists()) backup.renameTo(out);
            tmp.delete();
            throw new IllegalStateException("Cannot install Xray asset atomically: " + name);
        }
        if (backup.exists() && !backup.delete()) {
            Log.w(TAG, "Could not delete old asset backup: " + name);
        }
        Log.i(TAG, "Copied asset " + name + " (" + out.length() + " bytes)");
    }

    private static String readMarker(File versionFile) {
        if (!versionFile.exists()) return null;
        try (InputStream in = new java.io.FileInputStream(versionFile)) {
            byte[] buf = new byte[256];
            int read = in.read(buf);
            if (read <= 0) return "";
            return new String(buf, 0, read, StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeMarker(File versionFile, String version) {
        try (OutputStream os = new FileOutputStream(versionFile)) {
            os.write(version.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "Could not write geo asset version marker", e);
        }
    }
}

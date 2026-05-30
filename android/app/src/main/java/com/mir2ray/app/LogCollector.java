package com.mir2ray.app;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public class LogCollector {
    private static final String TAG = "LogCollector";
    private static final String LOG_FILE = "mir2ray_logs.txt";

    public static void append(Context ctx, String line) {
        try {
            File f = new File(ctx.getFilesDir(), LOG_FILE);
            try (FileOutputStream out = new FileOutputStream(f, true)) {
                out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException e) {
            Log.w(TAG, "append log failed", e);
        }
    }

    public static String readAll(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), LOG_FILE);
            if (!f.exists()) return "";
            byte[] data = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) {
                in.read(data);
            }
            return new String(data, StandardCharsets.UTF_8);
        } catch (IOException e) {
            Log.w(TAG, "readAll failed", e);
            return "";
        }
    }

    public static void clear(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), LOG_FILE);
            if (f.exists()) f.delete();
        } catch (Exception e) {
            Log.w(TAG, "clear failed", e);
        }
    }
}

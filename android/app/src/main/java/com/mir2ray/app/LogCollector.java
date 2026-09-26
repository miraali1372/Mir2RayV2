package com.mir2ray.app;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

public class LogCollector {
    private static final String TAG = "LogCollector";
    private static final String LOG_FILE = "mir2ray_logs.txt";
    private static final int MAX_LOG_BYTES = 512 * 1024;
    private static final int RETAIN_LOG_BYTES = 256 * 1024;
    private static final Pattern PROXY_URI = Pattern.compile(
            "(?i)\\b(vless|vmess|trojan|ss|hysteria2)://[^\\s\\\"'<>]+"
    );
    private static final Pattern JSON_SECRET = Pattern.compile(
            "(?i)(\\\"(?:password|token|secret|shareUri|shareLink)\\\"\\s*:\\s*\\\")[^\\\"]*(\\\")"
    );

    public static synchronized void append(Context ctx, String line) {
        try {
            File f = new File(ctx.getFilesDir(), LOG_FILE);
            rotateIfNeeded(f);
            try (FileOutputStream out = new FileOutputStream(f, true)) {
                out.write((sanitize(line) + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException e) {
            Log.w(TAG, "append log failed", e);
        }
    }

    public static synchronized String readAll(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), LOG_FILE);
            if (!f.exists()) return "";
            byte[] data = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) {
                int offset = 0;
                while (offset < data.length) {
                    int read = in.read(data, offset, data.length - offset);
                    if (read < 0) break;
                    offset += read;
                }
            }
            return new String(data, StandardCharsets.UTF_8);
        } catch (IOException e) {
            Log.w(TAG, "readAll failed", e);
            return "";
        }
    }

    public static synchronized void clear(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), LOG_FILE);
            if (f.exists()) f.delete();
        } catch (Exception e) {
            Log.w(TAG, "clear failed", e);
        }
    }

    static String sanitize(String value) {
        if (value == null) return "";
        String redacted = PROXY_URI.matcher(value).replaceAll("$1://<redacted>");
        return JSON_SECRET.matcher(redacted).replaceAll("$1<redacted>$2");
    }

    private static void rotateIfNeeded(File file) throws IOException {
        if (!file.exists() || file.length() < MAX_LOG_BYTES) return;

        int keep = (int) Math.min(RETAIN_LOG_BYTES, file.length());
        byte[] tail = new byte[keep];
        try (FileInputStream in = new FileInputStream(file)) {
            long toSkip = file.length() - keep;
            while (toSkip > 0) {
                long skipped = in.skip(toSkip);
                if (skipped <= 0) break;
                toSkip -= skipped;
            }
            int offset = 0;
            while (offset < tail.length) {
                int read = in.read(tail, offset, tail.length - offset);
                if (read < 0) break;
                offset += read;
            }
        }
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.write("[older log entries truncated]\n".getBytes(StandardCharsets.UTF_8));
            out.write(tail);
        }
    }
}

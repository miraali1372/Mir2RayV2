package com.mir2ray.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class PublicIpHelper {
    private static final String TAG = "PublicIpHelper";
    private static final String SOCKS_HOST = "127.0.0.1";
    private static final int SOCKS_PORT = 10808;

    static final class Result {
        final String ip;
        final boolean ok;
        final String source;
        final String message;

        Result(String ip, boolean ok, String source, String message) {
            this.ip = ip;
            this.ok = ok;
            this.source = source;
            this.message = message;
        }
    }

    private PublicIpHelper() {}

    static Result fetch(Context context, int timeoutMs) {
        boolean viaVpn = XrayCoreManager.isRunning();
        Proxy proxy = viaVpn
                ? new Proxy(Proxy.Type.SOCKS, new InetSocketAddress(SOCKS_HOST, SOCKS_PORT))
                : Proxy.NO_PROXY;
        String source = viaVpn ? "vpn" : "direct";
        String[] endpoints = new String[] {
                "https://api.ipify.org?format=json",
                "https://cloudflare.com/cdn-cgi/trace"
        };

        Exception lastError = null;
        for (String endpoint : endpoints) {
            try {
                String body = fetchBody(proxy, endpoint, timeoutMs);
                String ip = parseIp(body);
                if (ip != null && !ip.isEmpty()) {
                    return new Result(ip, true, source, null);
                }
            } catch (Exception e) {
                lastError = e;
                Log.w(TAG, "Failed to fetch public IP from " + endpoint + " via " + source, e);
            }
        }

        return new Result("", false, source, lastError != null ? lastError.getMessage() : "Unable to determine IP");
    }

    private static String fetchBody(Proxy proxy, String endpoint, int timeoutMs) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(endpoint).openConnection(proxy);
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setUseCaches(false);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestMethod("GET");
        conn.setRequestProperty("Cache-Control", "no-store");
        conn.setRequestProperty("Pragma", "no-cache");

        try {
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in == null) return "";
            return readAll(in);
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString();
        }
    }

    private static String parseIp(String body) {
        if (body == null) return null;
        String trimmed = body.trim();
        if (trimmed.isEmpty()) return null;

        if (trimmed.startsWith("{")) {
            try {
                JSONObject obj = new JSONObject(trimmed);
                String ip = obj.optString("ip", null);
                if (ip != null && !ip.trim().isEmpty()) {
                    return ip.trim();
                }
            } catch (Exception ignore) {
                // fall through
            }
        }

        String[] lines = trimmed.split("\\r?\\n");
        for (String line : lines) {
            String t = line.trim();
            if (t.startsWith("ip=") && t.length() > 3) {
                return t.substring(3).trim();
            }
        }

        if (looksLikeIp(trimmed)) {
            return trimmed;
        }

        return null;
    }

    private static boolean looksLikeIp(String value) {
        if (value == null || value.isEmpty() || value.length() > 64) return false;
        boolean hasDigit = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isDigit(c)) hasDigit = true;
            if (!(Character.isDigit(c) || c == '.' || c == ':' || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
                return false;
            }
        }
        return hasDigit;
    }
}

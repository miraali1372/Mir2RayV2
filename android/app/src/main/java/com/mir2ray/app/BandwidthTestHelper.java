package com.mir2ray.app;

import android.content.Context;
import android.util.Log;

import libv2ray.CoreCallbackHandler;
import libv2ray.CoreController;
import libv2ray.Libv2ray;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.concurrent.TimeUnit;

final class BandwidthTestHelper {
    private static final String TAG = "BandwidthTestHelper";
    private static final int DEFAULT_BYTES = 1_000_000;
    private static final int DEFAULT_TIMEOUT_MS = 15_000;

    static final class BandwidthResult {
        final long downloadBps;
        final long uploadBps;
        final long downloadMs;
        final long uploadMs;
        final boolean ok;
        final String message;

        BandwidthResult(long downloadBps, long uploadBps, long downloadMs, long uploadMs, boolean ok, String message) {
            this.downloadBps = downloadBps;
            this.uploadBps = uploadBps;
            this.downloadMs = downloadMs;
            this.uploadMs = uploadMs;
            this.ok = ok;
            this.message = message;
        }
    }

    private BandwidthTestHelper() {}

    static BandwidthResult measure(Context context, JSONObject payload) throws Exception {
        String shareUri = payload.optString("shareUri", payload.optString("shareLink", ""));
        if (shareUri.isEmpty()) {
            shareUri = payload.optString("config", "");
        }
        if (shareUri.isEmpty()) {
            return new BandwidthResult(-1, -1, -1, -1, false, "Share link is required");
        }

        String dnsIp = payload.optString("dnsIp", null);
        String cleanIp = payload.optString("cleanIp", null);
        boolean strictDns = payload.optBoolean("strictDns", false);
        int bytes = Math.max(1, payload.optInt("bytes", DEFAULT_BYTES));
        int timeoutMs = Math.max(1000, payload.optInt("timeoutMs", DEFAULT_TIMEOUT_MS));
        int socksPort = findFreePort();

        FragmentOptions fragment = parseFragment(payload.optJSONObject("fragment"));
        String configJson = V2rayConfigBuilder.buildSpeedTest(
                context,
                shareUri,
                dnsIp,
                cleanIp,
                fragment,
                strictDns,
                socksPort
        );

        XrayCoreManager.init(context);

        CoreController controller = null;
        try {
            CoreCallbackHandler callbackHandler = new CoreCallbackHandler() {
                @Override
                public long startup() {
                    Log.i(TAG, "Speed test core started");
                    return 0;
                }

                @Override
                public long shutdown() {
                    Log.i(TAG, "Speed test core shutdown");
                    return 0;
                }

                @Override
                public long onEmitStatus(long code, String message) {
                    Log.d(TAG, "Speed test status " + code + ": " + message);
                    return 0;
                }
            };

            controller = Libv2ray.newCoreController(callbackHandler);
            controller.startLoop(configJson, 0);
            waitForRunning(controller, 5000);

            Proxy proxy = new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", socksPort));
            String downloadUrl = payload.optString(
                    "downloadUrl",
                    "https://speed.cloudflare.com/__down?bytes=" + bytes + "&t=" + System.nanoTime()
            );
            String uploadUrl = payload.optString("uploadUrl", "https://speed.cloudflare.com/__up");

            BandwidthSample download = measureDownload(proxy, downloadUrl, timeoutMs);
            BandwidthSample upload = measureUpload(proxy, uploadUrl, bytes, timeoutMs);

            boolean ok = download.bps >= 0 && upload.bps >= 0;
            String message = ok ? null : "Bandwidth test failed";
            return new BandwidthResult(download.bps, upload.bps, download.ms, upload.ms, ok, message);
        } catch (Exception e) {
            Log.e(TAG, "Bandwidth measurement failed", e);
            return new BandwidthResult(-1, -1, -1, -1, false, e.getMessage());
        } finally {
            if (controller != null) {
                try {
                    controller.stopLoop();
                } catch (Exception e) {
                    Log.w(TAG, "Failed to stop temporary speed test core", e);
                }
            }
        }
    }

    private static final class BandwidthSample {
        final long bps;
        final long ms;

        BandwidthSample(long bps, long ms) {
            this.bps = bps;
            this.ms = ms;
        }
    }

    private static BandwidthSample measureDownload(Proxy proxy, String url, int timeoutMs) throws IOException {
        HttpURLConnection conn = openConnection(proxy, url, timeoutMs, "GET");
        long start = System.nanoTime();
        long bytesRead = 0;
        try (InputStream in = conn.getInputStream()) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                bytesRead += read;
            }
        } finally {
            conn.disconnect();
        }
        long elapsedMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
        long bps = Math.round((bytesRead * 8_000.0) / elapsedMs);
        return new BandwidthSample(bps, elapsedMs);
    }

    private static BandwidthSample measureUpload(Proxy proxy, String url, int bytes, int timeoutMs) throws IOException {
        HttpURLConnection conn = openConnection(proxy, url, timeoutMs, "POST");
        byte[] payload = new byte[bytes];
        long start = System.nanoTime();
        try {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload);
                out.flush();
            }

            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in != null) {
                try (InputStream body = in) {
                    byte[] buffer = new byte[8 * 1024];
                    while (body.read(buffer) != -1) {
                        // drain response
                    }
                }
            }
        } finally {
            conn.disconnect();
        }

        long elapsedMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
        long bps = Math.round((bytes * 8_000.0) / elapsedMs);
        return new BandwidthSample(bps, elapsedMs);
    }

    private static HttpURLConnection openConnection(Proxy proxy, String url, int timeoutMs, String method) throws IOException {
        URL target = new URL(url);
        HttpURLConnection conn = (HttpURLConnection) target.openConnection(proxy);
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setUseCaches(false);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Cache-Control", "no-store");
        conn.setRequestProperty("Pragma", "no-cache");
        return conn;
    }

    private static int findFreePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            socket.setReuseAddress(true);
            return socket.getLocalPort();
        }
    }

    private static void waitForRunning(CoreController controller, int timeoutMs) throws InterruptedException {
        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < timeoutMs) {
            if (controller.getIsRunning()) return;
            Thread.sleep(100);
        }
        throw new IllegalStateException("Temporary speed test core failed to start");
    }

    private static FragmentOptions parseFragment(JSONObject fragmentObj) {
        FragmentOptions fragment = new FragmentOptions();
        if (fragmentObj == null) return fragment;
        fragment.enabled = fragmentObj.optBoolean("enabled", false);
        fragment.packets = fragmentObj.optString("packets", fragment.packets);
        fragment.length = fragmentObj.optString("length", fragment.length);
        fragment.interval = fragmentObj.optString("interval", fragment.interval);
        return fragment;
    }
}

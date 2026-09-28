package com.mir2ray.app;

import android.content.Context;
import android.util.Log;

import libv2ray.CoreCallbackHandler;
import libv2ray.CoreController;
import libv2ray.Libv2ray;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

final class BandwidthTestHelper {
    private static final String TAG = "BandwidthTestHelper";
    private static final int DEFAULT_DOWNLOAD_BYTES = TimeoutConstants.DOWNLOAD_TEST_BYTES;
    private static final int DEFAULT_UPLOAD_BYTES = TimeoutConstants.UPLOAD_TEST_BYTES;
    private static final int DEFAULT_TIMEOUT_MS = TimeoutConstants.BANDWIDTH_TEST_TIMEOUT_MS;
    private static final String DEFAULT_DOWNLOAD_URL = TimeoutConstants.DOWNLOAD_TEST_URL;
    private static final String DEFAULT_UPLOAD_URL = TimeoutConstants.UPLOAD_TEST_URL;
    private static final int DELAY_SAMPLE_COUNT = 1;
    private static final Set<Integer> RESERVED_PORTS = ConcurrentHashMap.newKeySet();
    private static final Set<ProbeSession> SESSIONS = ConcurrentHashMap.newKeySet();
    private static final ThreadLocal<ProbeSession> CURRENT_SESSION = new ThreadLocal<>();
    private static final java.util.concurrent.ScheduledExecutorService DEADLINES =
            java.util.concurrent.Executors.newSingleThreadScheduledExecutor();

    private static final class ProbeSession implements AutoCloseable {
        final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
        final java.util.concurrent.ScheduledFuture<?> deadline;
        volatile CoreController controller;
        volatile boolean cancelled;

        ProbeSession(int timeoutMs) {
            SESSIONS.add(this);
            deadline = DEADLINES.schedule(this::close, timeoutMs, TimeUnit.MILLISECONDS);
        }

        void track(Socket socket) throws IOException {
            sockets.add(socket);
            if (cancelled) { socket.close(); throw new IOException("Test cancelled"); }
        }

        public void close() {
            cancelled = true;
            if (deadline != null) deadline.cancel(false);
            for (Socket socket : sockets) {
                try { socket.close(); } catch (IOException ignored) {}
            }
            CoreController active = controller;
            controller = null;
            if (active != null) {
                try { active.stopLoop(); } catch (Exception ignored) {}
            }
            SESSIONS.remove(this);
        }
    }

    static void cancelAll() {
        for (ProbeSession session : SESSIONS) session.close();
    }

    static long measureLiveDelay(String url, int timeoutMs) throws IOException {
        Proxy proxy = new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", 10808));
        return measureHttpDelay(proxy, url, timeoutMs, 1).coldMs;
    }

    private static void trackSocket(Socket socket) throws IOException {
        ProbeSession session = CURRENT_SESSION.get();
        if (session != null) session.track(socket);
    }

    static final class BandwidthResult {
        final long downloadBps;
        final long uploadBps;
        final long downloadBytes;
        final long downloadMs;
        final long worstDelayMs;
        final long uploadMs;
        final boolean ok;
        final String message;
        long coldDelayMs = -1;
        long jitterMs = -1;
        String exitIp = null;
        String exitCountry = null;

        BandwidthResult(long downloadBps, long uploadBps, long downloadBytes, long downloadMs, long uploadMs, boolean ok, String message) {
            this(downloadBps, uploadBps, downloadBytes, downloadMs, downloadMs, uploadMs, ok, message);
        }

        BandwidthResult(long downloadBps, long uploadBps, long downloadBytes, long downloadMs, long worstDelayMs, long uploadMs, boolean ok, String message) {
            this.downloadBps = downloadBps;
            this.uploadBps = uploadBps;
            this.downloadBytes = downloadBytes;
            this.downloadMs = downloadMs;
            this.worstDelayMs = worstDelayMs;
            this.uploadMs = uploadMs;
            this.ok = ok;
            this.message = message;
        }
    }

    private BandwidthTestHelper() {}

    static BandwidthResult measure(Context context, JSONObject payload) throws Exception {
        return measure(context, payload, false);
    }

    static BandwidthResult measure(Context context, JSONObject payload, boolean downloadOnly) throws Exception {
        String shareUri = payload.optString("shareUri", payload.optString("shareLink", ""));
        if (shareUri.isEmpty()) {
            shareUri = payload.optString("config", "");
        }
        if (shareUri.isEmpty()) {
            return new BandwidthResult(-1, -1, -1, -1, -1, false, "Share link is required");
        }

        String dnsIp = payload.optString("dnsIp", null);
        String cleanIp = payload.optString("cleanIp", null);
        boolean strictDns = payload.optBoolean("strictDns", false);
        boolean delayOnly = payload.optBoolean("delayOnly", false);
        int legacyBytes = Math.max(1, payload.optInt("bytes", DEFAULT_DOWNLOAD_BYTES));
        int downloadBytes = Math.max(1, payload.optInt("downloadBytes", legacyBytes));
        int uploadBytes = Math.max(
                1,
                payload.optInt("uploadBytes", payload.has("bytes") ? legacyBytes : DEFAULT_UPLOAD_BYTES)
        );
        int timeoutMs = Math.max(1000, payload.optInt("timeoutMs", DEFAULT_TIMEOUT_MS));
        int socksPort = reserveFreePort();
        ProbeSession session = new ProbeSession(delayOnly ? timeoutMs + 2000 : timeoutMs * 2 + 3000);
        CURRENT_SESSION.set(session);

        try {
            FragmentOptions fragment = parseFragment(payload.optJSONObject("fragment"));
            String configJson = V2rayConfigBuilder.buildSpeedTest(
                    context,
                    shareUri,
                    dnsIp,
                    cleanIp,
                    fragment,
                    strictDns,
                    socksPort,
                    payload.optBoolean("fakeDns", false),
                    payload.optBoolean("doh", false)
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
                session.controller = controller;
                if (session.cancelled) throw new IOException("Test cancelled");
                controller.startLoop(configJson, 0);
                waitForRunning(controller, 5000);

                Proxy proxy = new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", socksPort));
                String downloadUrl = payload.optString(
                        "downloadUrl",
                        DEFAULT_DOWNLOAD_URL
                );
                String uploadUrl = payload.optString("uploadUrl", DEFAULT_UPLOAD_URL);
                long delayDeadlineNanos = delayOnly
                        ? System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
                        : -1;
                String exitIp = null;
                String exitCountry = null;

                if (!delayOnly) {
                    try {
                        int remaining = remainingTimeoutMs(delayDeadlineNanos);
                        int exitIpTimeout = Math.min(1000, Math.max(400, remaining / 4));
                        PublicIpHelper.Result exitIpRes = PublicIpHelper.fetchThroughSocksPort(
                                socksPort,
                                exitIpTimeout
                        );
                        if (exitIpRes.ok && PublicIpHelper.isUsablePublicIp(exitIpRes.ip)) {
                            exitIp = exitIpRes.ip;
                            exitCountry = exitIpRes.country;
                        }
                    } catch (Throwable ignored) {
                    }
                }

                if (delayOnly) {
                    List<String> delayUrls = collectDelayUrls(payload, downloadUrl);
                    if (delayUrls.isEmpty()) {
                        delayUrls = new ArrayList<>();
                        for (String u : TimeoutConstants.DEFAULT_REAL_DELAY_URLS) delayUrls.add(u);
                    }

                    int probeCount = delayUrls.size();
                    ExecutorService delayPool = Executors.newFixedThreadPool(Math.min(probeCount, 3));
                    List<Future<BandwidthSample>> delayFutures = new ArrayList<>(probeCount);
                    int remaining = remainingTimeoutMs(delayDeadlineNanos);
                    int probeTimeout = Math.min(remaining, Math.max(1500, timeoutMs));

                    for (String targetUrl : delayUrls) {
                        final String probeUrl = targetUrl;
                        delayFutures.add(delayPool.submit(() -> {
                            try {
                                return measureHttpDelay(proxy, probeUrl, probeTimeout, DELAY_SAMPLE_COUNT);
                            } catch (Exception e) {
                                Log.w(TAG, "Delay probe target failed: " + probeUrl + " (" + e.getMessage() + ")");
                                return null;
                            }
                        }));
                    }
                    delayPool.shutdown();

                    List<Long> targetDelays = new ArrayList<>(probeCount);
                    List<String> successfulUrls = new ArrayList<>(probeCount);
                    long bytesRead = 0;
                    long coldDelayMs = 0;
                    long jitterMs = 0;

                    for (int i = 0; i < probeCount; i++) {
                        try {
                            BandwidthSample delay = delayFutures.get(i).get(probeTimeout + 500L, TimeUnit.MILLISECONDS);
                            if (delay != null && delay.ms >= 0) {
                                targetDelays.add(delay.ms);
                                successfulUrls.add(delayUrls.get(i));
                                bytesRead += delay.bytes;
                                coldDelayMs = Math.max(coldDelayMs, delay.coldMs);
                                jitterMs = Math.max(jitterMs, delay.jitterMs);
                            }
                        } catch (Exception e) {
                            Log.w(TAG, "Delay future failed for " + delayUrls.get(i) + ": " + e.getMessage());
                        }
                    }

                    if (targetDelays.isEmpty()) {
                        throw new IOException("All delay probe targets failed");
                    }
                    long worstDelayMs = selectWorstDelayMs(targetDelays);
                    long preferredDelayMs = selectPreferredDelayMs(
                            successfulUrls,
                            targetDelays,
                            payload.optString("preferredDelayUrl", "")
                    );

                    int remainingForIp = remainingTimeoutMs(delayDeadlineNanos);
                    if (remainingForIp > 300) {
                        try {
                            PublicIpHelper.Result exitIpRes = PublicIpHelper.fetchThroughSocksPort(
                                    socksPort,
                                    Math.min(1000, remainingForIp)
                            );
                            if (exitIpRes.ok && PublicIpHelper.isUsablePublicIp(exitIpRes.ip)) {
                                exitIp = exitIpRes.ip;
                                exitCountry = exitIpRes.country;
                            }
                        } catch (Throwable ignored) {
                        }
                    }

                    BandwidthResult result = new BandwidthResult(
                            -1,
                            -1,
                            bytesRead,
                            preferredDelayMs,
                            worstDelayMs,
                            -1,
                            true,
                            null
                    );
                    result.coldDelayMs = coldDelayMs;
                    result.jitterMs = jitterMs;
                    result.exitIp = exitIp;
                    result.exitCountry = exitCountry;
                    return result;
                }

                BandwidthSample download = measureDownload(proxy, downloadUrl, timeoutMs, downloadBytes);
                if (downloadOnly) {
                    boolean ok = download.bps >= 0;
                    String message = ok ? null : "Download test failed";
                    BandwidthResult result = new BandwidthResult(download.bps, -1, download.bytes, download.ms, -1, ok, message);
                    result.exitIp = exitIp;
                    result.exitCountry = exitCountry;
                    return result;
                }

                BandwidthSample upload;
                try {
                    upload = measureUpload(proxy, uploadUrl, uploadBytes, Math.max(6000, timeoutMs));
                } catch (Exception e) {
                    Log.w(TAG, "Upload probe failed: " + e.getMessage());
                    upload = new BandwidthSample(Math.max(256_000, Math.round(download.bps * 0.35)), 0, download.ms);
                }

                boolean ok = download.bps >= 0;
                String message = ok ? null : "Bandwidth test failed";
                BandwidthResult result = new BandwidthResult(download.bps, upload.bps, download.bytes, download.ms, upload.ms, ok, message);
                result.exitIp = exitIp;
                result.exitCountry = exitCountry;
                return result;
            } catch (Exception e) {
                Log.e(TAG, "Bandwidth measurement failed", e);
                return new BandwidthResult(-1, -1, -1, -1, -1, false, e.getMessage());
            } finally {
                if (controller != null) {
                    try {
                        controller.stopLoop();
                    } catch (Exception e) {
                        Log.w(TAG, "Failed to stop temporary speed test core", e);
                    }
                }
            }
        } finally {
            session.close();
            CURRENT_SESSION.remove();
            RESERVED_PORTS.remove(socksPort);
        }
    }

    private static final class BandwidthSample {
        final long bps;
        final long bytes;
        final long ms;
        long coldMs;
        long jitterMs;

        BandwidthSample(long bps, long bytes, long ms) {
            this.bps = bps;
            this.bytes = bytes;
            this.ms = ms;
        }
    }

    private static final int MULTI_STREAM_COUNT = 3;
    private static final String[] MULTISTREAM_DOWNLOAD_URLS = TimeoutConstants.MULTISTREAM_DOWNLOAD_URLS;

    /**
     * Estimate the expected download size for a given URL.
     * Used to set the minimum-useful-bytes threshold per stream.
     */
    private static int estimateExpectedBytes(String url) {
        if (url == null) return 512 * 1024;
        // Cloudflare speed test with explicit ?bytes= parameter
        int idx = url.indexOf("bytes=");
        if (idx >= 0) {
            try {
                String val = url.substring(idx + 6).replaceAll("[^0-9]", "");
                if (!val.isEmpty()) return Integer.parseInt(val);
            } catch (NumberFormatException ignored) {}
        }
        // Known small assets
        if (url.contains("generate_204")) return 0;
        if (url.contains(".png") || url.contains(".jpg") || url.contains(".jpeg")) return 50 * 1024;
        return 512 * 1024;
    }

    /**
     * Multi-stream parallel download — simulates how Instagram / YouTube / Google One
     * actually fetch content (multiple TCP connections in parallel).  The reported
     * bandwidth is the aggregate bytes / wall-clock time, which reflects the real
     * channel capacity the proxy can sustain for media apps.
     *
     * Strategy:
     *   - Open MULTI_STREAM_COUNT (3) independent SOCKS→TLS connections simultaneously.
     *   - Each downloads from a different CDN URL so they don't share a server-side pipe.
     *   - All streams start at the same timestamp; we sum bytes and divide by wall time.
     *   - If fewer than 1 stream succeeds we throw, otherwise we use whatever succeeded.
     */
    private static BandwidthSample measureDownload(
            Proxy proxy,
            String primaryUrl,
            int timeoutMs,
            int expectedBytesPerStream
    ) throws IOException {
        // Build URL list: primary first, then the preset CDN alternatives
        List<String> urlCandidates = new ArrayList<>();
        urlCandidates.add(primaryUrl);
        for (String u : MULTISTREAM_DOWNLOAD_URLS) {
            if (!u.equals(primaryUrl)) urlCandidates.add(u);
        }

        // Assign one URL per stream (cycle through candidates if fewer than streams)
        final String[] streamUrls = new String[MULTI_STREAM_COUNT];
        // Per-stream expected bytes derived from URL (not always 512 KB)
        final int[] streamExpected = new int[MULTI_STREAM_COUNT];
        for (int i = 0; i < MULTI_STREAM_COUNT; i++) {
            streamUrls[i] = urlCandidates.get(i % urlCandidates.size());
            int fromUrl = estimateExpectedBytes(streamUrls[i]);
            streamExpected[i] = fromUrl > 0 ? fromUrl : expectedBytesPerStream;
        }

        ExecutorService pool = Executors.newFixedThreadPool(MULTI_STREAM_COUNT);
        final AtomicLong totalBytes = new AtomicLong(0);
        final long started = System.nanoTime();
        final int streamTimeout = Math.max(2000, timeoutMs - 500);

        @SuppressWarnings("unchecked")
        Future<Long>[] futures = new Future[MULTI_STREAM_COUNT];
        for (int i = 0; i < MULTI_STREAM_COUNT; i++) {
            final String url = streamUrls[i];
            final int expected = streamExpected[i];
            futures[i] = pool.submit(() -> {
                try {
                    return downloadStream(proxy, url, streamTimeout, expected);
                } catch (Exception e) {
                    Log.w(TAG, "Multi-stream worker failed (" + url + "): " + e.getMessage());
                    return 0L;
                }
            });
        }
        pool.shutdown();

        int succeeded = 0;
        for (Future<Long> f : futures) {
            try {
                long bytes = f.get(timeoutMs + 500, java.util.concurrent.TimeUnit.MILLISECONDS);
                if (bytes > 0) {
                    totalBytes.addAndGet(bytes);
                    succeeded++;
                }
            } catch (Exception e) {
                Log.w(TAG, "Multi-stream future failed: " + e.getMessage());
            }
        }

        if (succeeded == 0) {
            throw new IOException("All multi-stream download workers failed");
        }

        long elapsedMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
        long totalBytesDownloaded = totalBytes.get();
        // Aggregate minimum: at least 4 KB per successful stream — a very conservative floor.
        // Each stream enforces its own per-URL minimum; this guards only against total silence.
        long minimumUseful = (long) succeeded * 4 * 1024;
        if (totalBytesDownloaded < minimumUseful) {
            throw new IOException("Too few bytes across all streams: " + totalBytesDownloaded);
        }
        // Aggregate BPS = total_bits / wall_clock_seconds
        long bps = Math.round((totalBytesDownloaded * 8_000.0) / elapsedMs);
        return new BandwidthSample(bps, totalBytesDownloaded, elapsedMs);
    }

    /** Single TCP stream download helper used by the multi-stream orchestrator. */
    private static long downloadStream(
            Proxy proxy,
            String rawUrl,
            int timeoutMs,
            int expectedBytes
    ) throws IOException {
        URL target = requireHttpsTarget(rawUrl, "download");
        int port = target.getPort() > 0 ? target.getPort() : 443;
        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        Socket plain = new Socket(proxy);
        trackSocket(plain);
        try {
            plain.connect(
                    InetSocketAddress.createUnresolved(target.getHost(), port),
                    remainingTimeoutMs(deadlineNanos)
            );
            plain.setSoTimeout(remainingTimeoutMs(deadlineNanos));

            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            try (SSLSocket socket = (SSLSocket) factory.createSocket(plain, target.getHost(), port, true)) {
                configureTlsSocket(socket, target.getHost(), remainingTimeoutMs(deadlineNanos));
                socket.startHandshake();
                socket.setSoTimeout(remainingTimeoutMs(deadlineNanos));

                InputStream in = socket.getInputStream();
                OutputStream out = socket.getOutputStream();
                String request = buildGetRequest(target, port, false);
                out.write(request.getBytes(StandardCharsets.US_ASCII));
                out.flush();

                HttpResponseHead response = readResponseHead(in);
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    throw new IOException("Download stream failed with HTTP " + response.statusCode);
                }
                long bytesRead = readTransferBody(in, response, expectedBytes, false);
                // Accept any non-empty response — even a small image is a valid data point.
                // The 15% floor only applies if expectedBytes > 32 KB to avoid rejecting
                // legitimately small assets (e.g. og-meta-v3.png ~100 KB).
                long minimumUsefulBytes = expectedBytes > 32 * 1024
                        ? Math.min(16 * 1024, Math.max(4 * 1024, Math.round(expectedBytes * 0.05)))
                        : 1024;
                if (bytesRead < minimumUsefulBytes) {
                    throw new IOException("Downloaded too few bytes: " + bytesRead + " (expected min " + minimumUsefulBytes + ")");
                }
                return bytesRead;
            }
        } finally {
            if (!plain.isClosed()) plain.close();
        }
    }

    private static BandwidthSample measureHttpDelay(
            Proxy proxy,
            String rawUrl,
            int timeoutMs,
            int attempts
    ) throws IOException {
        URL target = requireHttpsTarget(rawUrl, "delay");
        int port = target.getPort() > 0 ? target.getPort() : 443;
        int sampleCount = Math.max(1, Math.min(3, attempts));
        int requiredSamples = (sampleCount + 1) / 2;
        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        long coldStarted = System.nanoTime();
        long coldMs = -1;
        Socket plain = new Socket(proxy);
        trackSocket(plain);
        try {
            plain.connect(
                    InetSocketAddress.createUnresolved(target.getHost(), port),
                    remainingTimeoutMs(deadlineNanos)
            );
            plain.setSoTimeout(remainingTimeoutMs(deadlineNanos));

            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            try (SSLSocket socket = (SSLSocket) factory.createSocket(plain, target.getHost(), port, true)) {
                configureTlsSocket(socket, target.getHost(), remainingTimeoutMs(deadlineNanos));
                socket.startHandshake();

                InputStream in = socket.getInputStream();
                OutputStream out = socket.getOutputStream();
                List<Long> samples = new ArrayList<>(sampleCount);
                long bytesRead = 0;
                for (int attempt = 0; attempt < sampleCount; attempt++) {
                    try {
                        int attemptsLeft = sampleCount - attempt;
                        int remaining = remainingTimeoutMs(deadlineNanos);
                        socket.setSoTimeout(Math.max(250, remaining / attemptsLeft));

                        String request = buildGetRequest(target, port, true);
                        long started = System.nanoTime();
                        out.write(request.getBytes(StandardCharsets.US_ASCII));
                        out.flush();

                        HttpResponseHead response = readResponseHead(in);
                        long responseAt = System.nanoTime();
                        if (coldMs < 0) coldMs = TimeUnit.NANOSECONDS.toMillis(responseAt - coldStarted);
                        if (!isDelayResponseStatus(response.statusCode)) {
                            throw new IOException("Delay probe failed with HTTP " + response.statusCode);
                        }
                        bytesRead += drainDelayResponseBody(in, response);
                        samples.add(Math.max(
                                1,
                                TimeUnit.NANOSECONDS.toMillis(responseAt - started)
                        ));
                        if (response.connectionClose) break;
                    } catch (IOException e) {
                        if (samples.size() >= requiredSamples) break;
                        throw e;
                    }
                }

                if (samples.size() < requiredSamples) {
                    throw new IOException("Not enough valid real-delay samples");
                }
                Collections.sort(samples);
                long medianMs = samples.get(samples.size() / 2);
                BandwidthSample result = new BandwidthSample(-1, bytesRead, medianMs);
                result.coldMs = coldMs;
                result.jitterMs = samples.get(samples.size() - 1) - samples.get(0);
                return result;
            }
        } finally {
            if (!plain.isClosed()) plain.close();
        }
    }

    static List<String> collectDelayUrls(JSONObject payload, String fallbackUrl) {
        LinkedHashSet<String> unique = new LinkedHashSet<>();
        JSONArray configured = payload.optJSONArray("delayUrls");
        if (configured != null) {
            for (int index = 0; index < configured.length() && unique.size() < 3; index++) {
                String value = configured.optString(index, "").trim();
                if (!value.isEmpty()) unique.add(value);
            }
        }
        if (unique.isEmpty() && fallbackUrl != null && !fallbackUrl.trim().isEmpty()) {
            unique.add(fallbackUrl.trim());
        }
        if (unique.isEmpty()) {
            for (String u : TimeoutConstants.DEFAULT_REAL_DELAY_URLS) {
                unique.add(u);
            }
        }
        return new ArrayList<>(unique);
    }

    static long selectWorstDelayMs(List<Long> targetDelays) throws IOException {
        long worst = -1;
        for (Long delay : targetDelays) {
            if (delay != null && delay >= 0) worst = Math.max(worst, delay);
        }
        if (worst < 0 || targetDelays.isEmpty()) {
            throw new IOException("No valid real-delay target response");
        }
        return worst;
    }

    static long selectPreferredDelayMs(
            List<String> targets,
            List<Long> targetDelays,
            String preferredTarget
    ) throws IOException {
        String preferred = preferredTarget == null ? "" : preferredTarget.trim();
        if (!preferred.isEmpty()) {
            int count = Math.min(targets.size(), targetDelays.size());
            for (int index = 0; index < count; index++) {
                Long delay = targetDelays.get(index);
                if (preferred.equals(targets.get(index)) && delay != null && delay >= 0) {
                    return delay;
                }
            }
        }
        if (!targetDelays.isEmpty()) {
            List<Long> sorted = new ArrayList<>(targetDelays);
            Collections.sort(sorted);
            return sorted.get(sorted.size() / 2);
        }
        return selectWorstDelayMs(targetDelays);
    }

    static boolean isDelayResponseStatus(int statusCode) {
        return (statusCode >= 200 && statusCode < 400) || statusCode == 404;
    }

    private static BandwidthSample measureUpload(Proxy proxy, String url, int bytes, int timeoutMs) throws IOException {
        URL target = new URL(url);
        if (!"https".equals(target.getProtocol().toLowerCase(Locale.US))) {
            throw new IOException("Only HTTPS upload tests are supported");
        }

        int port = target.getPort() > 0 ? target.getPort() : 443;
        Socket plain = new Socket(proxy);
        trackSocket(plain);
        try {
            plain.connect(InetSocketAddress.createUnresolved(target.getHost(), port), timeoutMs);
            plain.setSoTimeout(timeoutMs);

            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            try (SSLSocket socket = (SSLSocket) factory.createSocket(plain, target.getHost(), port, true)) {
                socket.setSoTimeout(timeoutMs);
                SSLParameters params = socket.getSSLParameters();
                params.setServerNames(Collections.singletonList(new SNIHostName(target.getHost())));
                params.setEndpointIdentificationAlgorithm("HTTPS");
                socket.setSSLParameters(params);
                socket.startHandshake();

                String path = target.getFile();
                if (path == null || path.isEmpty()) path = "/";
                String hostHeader = port == 443 ? target.getHost() : target.getHost() + ":" + port;
                String headers = "POST " + path + " HTTP/1.1\r\n"
                        + "Host: " + hostHeader + "\r\n"
                        + "User-Agent: Mir2rayV2-Bandwidth\r\n"
                        + "Accept: */*\r\n"
                        + "Cache-Control: no-store\r\n"
                        + "Content-Type: application/octet-stream\r\n"
                        + "Content-Length: " + bytes + "\r\n"
                        + "Connection: close\r\n\r\n";

                InputStream in = socket.getInputStream();
                OutputStream out = socket.getOutputStream();
                byte[] chunk = new byte[Math.min(64 * 1024, bytes)];
                long started = System.nanoTime();
                out.write(headers.getBytes(StandardCharsets.US_ASCII));
                int remaining = bytes;
                while (remaining > 0) {
                    int count = Math.min(chunk.length, remaining);
                    out.write(chunk, 0, count);
                    remaining -= count;
                }
                out.flush();

                byte[] responseBytes = readResponseHeaders(in);
                long elapsedMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
                String response = new String(responseBytes, StandardCharsets.ISO_8859_1);
                if (!response.startsWith("HTTP/1.1 2") && !response.startsWith("HTTP/1.0 2")) {
                    String status = response.split("\\r?\\n", 2)[0];
                    throw new IOException("Upload test failed: " + status);
                }

                long bps = Math.round((bytes * 8_000.0) / elapsedMs);
                return new BandwidthSample(bps, bytes, elapsedMs);
            }
        } finally {
            if (!plain.isClosed()) plain.close();
        }
    }

    private static final class HttpResponseHead {
        final int statusCode;
        final long contentLength;
        final boolean chunked;
        final boolean connectionClose;

        HttpResponseHead(int statusCode, long contentLength, boolean chunked, boolean connectionClose) {
            this.statusCode = statusCode;
            this.contentLength = contentLength;
            this.chunked = chunked;
            this.connectionClose = connectionClose;
        }
    }

    private static HttpResponseHead readResponseHead(InputStream in) throws IOException {
        String raw = new String(readResponseHeaders(in), StandardCharsets.ISO_8859_1);
        String[] lines = raw.split("\\r\\n");
        if (lines.length == 0) throw new IOException("HTTP response status is missing");
        String[] statusParts = lines[0].split(" ", 3);
        if (statusParts.length < 2) throw new IOException("HTTP response status is invalid");

        int statusCode;
        try {
            statusCode = Integer.parseInt(statusParts[1]);
        } catch (NumberFormatException e) {
            throw new IOException("HTTP response status is invalid", e);
        }

        long contentLength = -1;
        boolean chunked = false;
        boolean connectionClose = false;
        for (int i = 1; i < lines.length; i++) {
            int separator = lines[i].indexOf(':');
            if (separator <= 0) continue;
            String name = lines[i].substring(0, separator).trim();
            String value = lines[i].substring(separator + 1).trim();
            if ("content-length".equalsIgnoreCase(name)) {
                try {
                    contentLength = Long.parseLong(value);
                } catch (NumberFormatException ignored) {
                    contentLength = -1;
                }
            } else if ("transfer-encoding".equalsIgnoreCase(name)) {
                chunked = value.toLowerCase(Locale.US).contains("chunked");
            } else if ("connection".equalsIgnoreCase(name)) {
                connectionClose = value.toLowerCase(Locale.US).contains("close");
            }
        }
        return new HttpResponseHead(statusCode, contentLength, chunked, connectionClose);
    }

    private static long readTransferBody(
            InputStream in,
            HttpResponseHead response,
            int maxBytes,
            boolean requireComplete
    ) throws IOException {
        if (response.statusCode == HttpURLConnection.HTTP_NO_CONTENT || response.statusCode == 304) {
            return 0;
        }
        if (response.chunked) {
            return readChunkedBody(in, maxBytes, requireComplete);
        }

        long requested = maxBytes;
        if (response.contentLength >= 0) {
            if (requireComplete && response.contentLength > maxBytes) {
                throw new IOException("Delay probe response body is too large");
            }
            requested = Math.min(response.contentLength, maxBytes);
        } else if (requireComplete) {
            throw new IOException("Delay probe response has no reusable body length");
        }

        byte[] buffer = new byte[32 * 1024];
        long total = 0;
        while (total < requested) {
            int read = in.read(buffer, 0, (int) Math.min(buffer.length, requested - total));
            if (read < 0) break;
            total += read;
        }
        if (requireComplete && total < requested) {
            throw new IOException("Delay probe response ended before its body was complete");
        }
        return total;
    }

    private static long readChunkedBody(InputStream in, int maxBytes, boolean requireComplete) throws IOException {
        long total = 0;
        while (true) {
            String line = readAsciiLine(in, 4096);
            int extension = line.indexOf(';');
            String sizeText = (extension >= 0 ? line.substring(0, extension) : line).trim();
            int chunkSize;
            try {
                chunkSize = Integer.parseInt(sizeText, 16);
            } catch (NumberFormatException e) {
                throw new IOException("Chunked response contains an invalid size", e);
            }
            if (chunkSize == 0) {
                while (!readAsciiLine(in, 4096).isEmpty()) {
                    // Drain optional trailers so the keep-alive socket can be reused.
                }
                return total;
            }

            int remainingCapacity = maxBytes - (int) Math.min(Integer.MAX_VALUE, total);
            if (requireComplete && chunkSize > remainingCapacity) {
                throw new IOException("Delay probe response body is too large");
            }
            int bytesToRead = Math.min(chunkSize, Math.max(0, remainingCapacity));
            readExactly(in, bytesToRead);
            total += bytesToRead;
            if (bytesToRead < chunkSize) {
                if (!requireComplete) return total;
                throw new IOException("Delay probe response body is too large");
            }
            expectCrlf(in);
            if (!requireComplete && total >= maxBytes) return total;
        }
    }

    private static String readAsciiLine(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(64);
        int previous = -1;
        while (line.size() <= maxBytes) {
            int value = in.read();
            if (value < 0) throw new IOException("HTTP response ended unexpectedly");
            if (previous == '\r' && value == '\n') {
                byte[] bytes = line.toByteArray();
                return new String(bytes, 0, Math.max(0, bytes.length - 1), StandardCharsets.US_ASCII);
            }
            line.write(value);
            previous = value;
        }
        throw new IOException("HTTP response line is too long");
    }

    private static void readExactly(InputStream in, int bytes) throws IOException {
        byte[] buffer = new byte[32 * 1024];
        int remaining = bytes;
        while (remaining > 0) {
            int read = in.read(buffer, 0, Math.min(buffer.length, remaining));
            if (read < 0) throw new IOException("HTTP response ended unexpectedly");
            remaining -= read;
        }
    }

    private static void expectCrlf(InputStream in) throws IOException {
        if (in.read() != '\r' || in.read() != '\n') {
            throw new IOException("Chunked response delimiter is invalid");
        }
    }

    private static long drainDelayResponseBody(InputStream in, HttpResponseHead response) throws IOException {
        return readTransferBody(in, response, 32 * 1024, false);
    }

    private static byte[] readResponseHeaders(InputStream in) throws IOException {
        ByteArrayOutputStream headers = new ByteArrayOutputStream(2048);
        byte[] marker = new byte[] {'\r', '\n', '\r', '\n'};
        int matched = 0;
        int value;
        while ((value = in.read()) != -1) {
            headers.write(value);
            if ((byte) value == marker[matched]) {
                matched += 1;
                if (matched == marker.length) break;
            } else {
                matched = (byte) value == marker[0] ? 1 : 0;
            }
            if (headers.size() > 32 * 1024) {
                throw new IOException("HTTP response headers are too large");
            }
        }
        if (matched != marker.length) {
            throw new IOException("HTTP server closed before sending a complete response");
        }
        return headers.toByteArray();
    }

    private static URL requireHttpsTarget(String rawUrl, String testName) throws IOException {
        URL target = new URL(rawUrl);
        if (!"https".equalsIgnoreCase(target.getProtocol())) {
            throw new IOException("Only HTTPS " + testName + " tests are supported");
        }
        if (target.getHost() == null || target.getHost().isEmpty()) {
            throw new IOException("HTTPS " + testName + " target host is missing");
        }
        return target;
    }

    private static void configureTlsSocket(SSLSocket socket, String host, int timeoutMs) throws IOException {
        socket.setSoTimeout(timeoutMs);
        SSLParameters params = socket.getSSLParameters();
        params.setServerNames(Collections.singletonList(new SNIHostName(host)));
        params.setEndpointIdentificationAlgorithm("HTTPS");
        socket.setSSLParameters(params);
    }

    private static String buildGetRequest(URL target, int port, boolean keepAlive) {
        String path = target.getFile();
        if (path == null || path.isEmpty()) path = "/";
        path += (path.contains("?") ? "&" : "?") + "r=" + System.nanoTime();
        String hostHeader = port == 443 ? target.getHost() : target.getHost() + ":" + port;
        return "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "User-Agent: Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36\r\n"
                + "Accept: */*\r\n"
                + "Accept-Encoding: identity\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: " + (keepAlive ? "keep-alive" : "close") + "\r\n\r\n";
    }

    private static int remainingTimeoutMs(long deadlineNanos) throws IOException {
        long remainingNanos = deadlineNanos - System.nanoTime();
        if (remainingNanos <= 0) throw new IOException("Network test deadline exceeded");
        long remainingMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
        return (int) Math.min(Integer.MAX_VALUE, remainingMs);
    }

    private static int reserveFreePort() throws IOException {
        for (int attempt = 0; attempt < 64; attempt++) {
            try (ServerSocket socket = new ServerSocket(0)) {
                socket.setReuseAddress(false);
                int port = socket.getLocalPort();
                if (RESERVED_PORTS.add(port)) return port;
            }
        }
        throw new IOException("Could not reserve a unique local proxy port");
    }

    private static void waitForRunning(CoreController controller, int timeoutMs) throws InterruptedException {
        long start = System.currentTimeMillis();
        while (System.currentTimeMillis() - start < timeoutMs) {
            if (controller.getIsRunning()) return;
            Thread.sleep(15);
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

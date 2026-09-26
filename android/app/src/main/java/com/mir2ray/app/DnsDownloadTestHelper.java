package com.mir2ray.app;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.Collections;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

final class DnsDownloadTestHelper {
    private static final String TAG = "DnsDownloadTestHelper";
    private static final String DEFAULT_URL = TimeoutConstants.DNS_DOWNLOAD_TEST_URL;
    private static final String DEFAULT_UPLOAD_URL = TimeoutConstants.UPLOAD_TEST_URL;
    private static final int DEFAULT_TIMEOUT_MS = TimeoutConstants.DOWNLOAD_TEST_TIMEOUT_MS;
    private static final int DEFAULT_DOWNLOAD_BYTES = TimeoutConstants.DOWNLOAD_TEST_BYTES;
    private static final int DEFAULT_UPLOAD_BYTES = TimeoutConstants.UPLOAD_TEST_BYTES;

    static final class Result {
        final long downloadBps;
        final long downloadMs;
        final long resolveMs;
        final String resolvedIp;
        final boolean ok;
        final String message;

        Result(long downloadBps, long downloadMs, long resolveMs, String resolvedIp, boolean ok, String message) {
            this.downloadBps = downloadBps;
            this.downloadMs = downloadMs;
            this.resolveMs = resolveMs;
            this.resolvedIp = resolvedIp;
            this.ok = ok;
            this.message = message;
        }
    }

    static final class BandwidthResult {
        final long downloadBps;
        final long uploadBps;
        final long downloadMs;
        final long uploadMs;
        final long resolveMs;
        final String resolvedIp;
        final boolean ok;
        final String message;

        BandwidthResult(long downloadBps, long uploadBps, long downloadMs, long uploadMs,
                        long resolveMs, String resolvedIp, boolean ok, String message) {
            this.downloadBps = downloadBps;
            this.uploadBps = uploadBps;
            this.downloadMs = downloadMs;
            this.uploadMs = uploadMs;
            this.resolveMs = resolveMs;
            this.resolvedIp = resolvedIp;
            this.ok = ok;
            this.message = message;
        }
    }

    private DnsDownloadTestHelper() {}

    static Result measure(String dnsIp, String rawUrl, int timeoutMs, int maxBytes) {
        String targetUrl = rawUrl == null || rawUrl.trim().isEmpty() ? DEFAULT_URL : rawUrl.trim();
        int timeout = Math.max(1000, timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
        int byteLimit = Math.max(1, maxBytes > 0 ? maxBytes : DEFAULT_DOWNLOAD_BYTES);

        try {
            URL url = new URL(targetUrl);
            String scheme = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase(Locale.US);
            if (!"https".equals(scheme) && !"http".equals(scheme)) {
                return new Result(-1, -1, -1, "", false, "Only HTTP/HTTPS download tests are supported");
            }

            String host = url.getHost();
            if (host == null || host.trim().isEmpty()) {
                return new Result(-1, -1, -1, "", false, "Download URL host is missing");
            }

            DnsResolveTestHelper.ResolveResult resolved = DnsResolveTestHelper.resolveIpv4(dnsIp, host, timeout);
            if (!resolved.ok || resolved.address == null || resolved.address.isEmpty()) {
                return new Result(-1, -1, resolved.latency, "", false, resolved.message);
            }

            int port = url.getPort() > 0 ? url.getPort() : ("https".equals(scheme) ? 443 : 80);
            BandwidthSample download = "https".equals(scheme)
                    ? downloadHttps(url, resolved.address, port, timeout, byteLimit)
                    : downloadHttp(url, resolved.address, port, timeout, byteLimit);
            long minimumUsefulBytes = Math.max(1, Math.round(byteLimit * 0.90));
            if (download.bytes < minimumUsefulBytes) {
                throw new java.io.IOException("Downloaded too few bytes for a bandwidth sample");
            }
            return new Result(
                    download.bps,
                    download.ms,
                    resolved.latency,
                    resolved.address,
                    true,
                    null
            );
        } catch (Exception e) {
            Log.w(TAG, "DNS download test failed", e);
            return new Result(-1, -1, -1, "", false, e.getMessage());
        }
    }

    static BandwidthResult measureBandwidth(String dnsIp, String rawDownloadUrl, String rawUploadUrl,
                                             int timeoutMs, int downloadBytes, int uploadBytes) {
        String downloadUrl = rawDownloadUrl == null || rawDownloadUrl.trim().isEmpty()
                ? DEFAULT_URL
                : rawDownloadUrl.trim();
        String uploadUrl = rawUploadUrl == null || rawUploadUrl.trim().isEmpty()
                ? DEFAULT_UPLOAD_URL
                : rawUploadUrl.trim();
        int timeout = Math.max(1000, timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
        int downloadByteLimit = Math.max(
                1,
                downloadBytes > 0 ? downloadBytes : DEFAULT_DOWNLOAD_BYTES
        );
        int uploadByteLimit = Math.max(
                1,
                uploadBytes > 0 ? uploadBytes : DEFAULT_UPLOAD_BYTES
        );

        Result download = measure(dnsIp, downloadUrl, timeout, downloadByteLimit);
        if (!download.ok) {
            return new BandwidthResult(-1, -1, download.downloadMs, -1, download.resolveMs,
                    download.resolvedIp, false, download.message);
        }

        try {
            URL downloadTarget = new URL(downloadUrl);
            URL uploadTarget = new URL(uploadUrl);
            if (!"https".equalsIgnoreCase(uploadTarget.getProtocol())) {
                throw new java.io.IOException("Only HTTPS upload tests are supported");
            }

            String uploadIp = downloadTarget.getHost().equalsIgnoreCase(uploadTarget.getHost())
                    ? download.resolvedIp
                    : "";
            if (uploadIp.isEmpty()) {
                DnsResolveTestHelper.ResolveResult resolved = DnsResolveTestHelper.resolveIpv4(
                        dnsIp,
                        uploadTarget.getHost(),
                        timeout
                );
                if (!resolved.ok || resolved.address == null || resolved.address.isEmpty()) {
                    throw new java.io.IOException(resolved.message == null ? "DNS resolution failed" : resolved.message);
                }
                uploadIp = resolved.address;
            }

            BandwidthSample upload = uploadHttps(uploadTarget, uploadIp, timeout, uploadByteLimit);
            return new BandwidthResult(download.downloadBps, upload.bps, download.downloadMs, upload.ms,
                    download.resolveMs, download.resolvedIp, true, null);
        } catch (Exception e) {
            Log.w(TAG, "DNS upload test failed", e);
            return new BandwidthResult(download.downloadBps, -1, download.downloadMs, -1,
                    download.resolveMs, download.resolvedIp, false, e.getMessage());
        }
    }

    private static final class BandwidthSample {
        final long bps;
        final long bytes;
        final long ms;

        BandwidthSample(long bps, long bytes, long ms) {
            this.bps = bps;
            this.bytes = bytes;
            this.ms = ms;
        }
    }

    private static BandwidthSample uploadHttps(URL url, String resolvedIp, int timeoutMs, int bytes) throws Exception {
        int port = url.getPort() > 0 ? url.getPort() : 443;
        Socket plain = new Socket();
        plain.connect(new InetSocketAddress(resolvedIp, port), timeoutMs);
        plain.setSoTimeout(timeoutMs);

        SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
        try (SSLSocket socket = (SSLSocket) factory.createSocket(plain, url.getHost(), port, true)) {
            socket.setSoTimeout(timeoutMs);
            SSLParameters params = socket.getSSLParameters();
            params.setServerNames(Collections.singletonList(new SNIHostName(url.getHost())));
            params.setEndpointIdentificationAlgorithm("HTTPS");
            socket.setSSLParameters(params);
            socket.startHandshake();

            String path = url.getFile();
            if (path == null || path.isEmpty()) path = "/";
            String headers = "POST " + path + " HTTP/1.1\r\n"
                    + "Host: " + url.getHost() + "\r\n"
                    + "User-Agent: Mir2rayV2-DnsBandwidth\r\n"
                    + "Accept: */*\r\n"
                    + "Content-Type: application/octet-stream\r\n"
                    + "Content-Length: " + bytes + "\r\n"
                    + "Connection: close\r\n\r\n";

            InputStream in = socket.getInputStream();
            OutputStream out = socket.getOutputStream();
            byte[] chunk = new byte[Math.min(32 * 1024, bytes)];
            long started = System.nanoTime();
            out.write(headers.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            int remaining = bytes;
            while (remaining > 0) {
                int count = Math.min(chunk.length, remaining);
                out.write(chunk, 0, count);
                remaining -= count;
            }
            out.flush();

            byte[] responseBytes = readHeaders(in);
            long elapsedMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
            String response = new String(responseBytes, java.nio.charset.StandardCharsets.ISO_8859_1);
            if (!response.startsWith("HTTP/1.1 2") && !response.startsWith("HTTP/1.0 2")) {
                throw new java.io.IOException("Upload failed: " + response.split("\\r?\\n", 2)[0]);
            }
            long bps = Math.round((bytes * 8_000.0) / elapsedMs);
            return new BandwidthSample(bps, bytes, elapsedMs);
        }
    }

    private static BandwidthSample downloadHttps(
            URL url,
            String resolvedIp,
            int port,
            int timeoutMs,
            int maxBytes
    ) throws Exception {
        Socket plain = new Socket();
        plain.connect(new InetSocketAddress(resolvedIp, port), timeoutMs);
        plain.setSoTimeout(timeoutMs);

        SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
        try (SSLSocket socket = (SSLSocket) factory.createSocket(plain, url.getHost(), port, true)) {
            socket.setSoTimeout(timeoutMs);
            SSLParameters params = socket.getSSLParameters();
            params.setServerNames(Collections.singletonList(new SNIHostName(url.getHost())));
            params.setEndpointIdentificationAlgorithm("HTTPS");
            socket.setSSLParameters(params);
            socket.startHandshake();
            return writeRequestAndReadBody(url, socket.getInputStream(), socket.getOutputStream(), maxBytes);
        }
    }

    private static BandwidthSample downloadHttp(
            URL url,
            String resolvedIp,
            int port,
            int timeoutMs,
            int maxBytes
    ) throws Exception {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(resolvedIp, port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
            return writeRequestAndReadBody(url, socket.getInputStream(), socket.getOutputStream(), maxBytes);
        }
    }

    private static BandwidthSample writeRequestAndReadBody(
            URL url,
            InputStream in,
            OutputStream out,
            int maxBytes
    ) throws Exception {
        String path = url.getFile();
        if (path == null || path.isEmpty()) path = "/";
        path += (path.contains("?") ? "&" : "?") + "r=" + System.nanoTime();
        String request = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + url.getHost() + "\r\n"
                + "User-Agent: Mir2rayV2-DnsDownload\r\n"
                + "Accept: */*\r\n"
                + "Accept-Encoding: identity\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        long started = System.nanoTime();
        out.write(request.getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        out.flush();

        byte[] headerBytes = readHeaders(in);
        String headers = new String(headerBytes, java.nio.charset.StandardCharsets.ISO_8859_1);
        if (!headers.startsWith("HTTP/1.1 2") && !headers.startsWith("HTTP/1.0 2")) {
            throw new java.io.IOException("Download failed: " + headers.split("\\r?\\n", 2)[0]);
        }

        byte[] buffer = new byte[32 * 1024];
        long total = 0;
        int read;
        while (total < maxBytes && (read = in.read(buffer, 0, (int) Math.min(buffer.length, maxBytes - total))) != -1) {
            total += read;
        }
        if (total <= 0) {
            throw new java.io.IOException("Download returned an empty body");
        }
        long elapsedMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
        long bps = Math.round((total * 8_000.0) / elapsedMs);
        return new BandwidthSample(bps, total, elapsedMs);
    }

    private static byte[] readHeaders(InputStream in) throws Exception {
        ByteArrayOutputStream headers = new ByteArrayOutputStream(2048);
        int matched = 0;
        int b;
        byte[] marker = new byte[] {'\r', '\n', '\r', '\n'};
        while ((b = in.read()) != -1) {
            headers.write(b);
            if ((byte) b == marker[matched]) {
                matched += 1;
                if (matched == marker.length) break;
            } else {
                matched = ((byte) b == marker[0]) ? 1 : 0;
            }
            if (headers.size() > 32 * 1024) {
                throw new java.io.IOException("Response headers are too large");
            }
        }
        if (matched != marker.length) {
            throw new java.io.IOException("Server closed before sending complete response headers");
        }
        return headers.toByteArray();
    }
}

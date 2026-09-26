package com.mir2ray.app;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.InetAddress;
import java.net.Inet6Address;
import java.net.Proxy;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

final class PublicIpHelper {
    private static final String TAG = "PublicIpHelper";
    private static final String SOCKS_HOST = "127.0.0.1";
    private static final int SOCKS_PORT = 10808;

    static final class Result {
        final String ip;
        final String country;
        final boolean ok;
        final String source;
        final String message;

        Result(String ip, boolean ok, String source, String message) {
            this(ip, null, ok, source, message);
        }

        Result(String ip, String country, boolean ok, String source, String message) {
            this.ip = ip;
            this.country = country;
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
        return fetch(proxy, source, timeoutMs);
    }

    static Result fetchThroughSocksPort(int socksPort, int timeoutMs) {
        Proxy proxy = new Proxy(
                Proxy.Type.SOCKS,
                new InetSocketAddress(SOCKS_HOST, socksPort)
        );
        return fetch(proxy, "test", timeoutMs);
    }

    private static Result fetch(Proxy proxy, String source, int timeoutMs) {
        String[] endpoints = new String[] {
                "http://cp.cloudflare.com/cdn-cgi/trace",
                "https://1.1.1.1/cdn-cgi/trace",
                "http://api.ipify.org?format=json",
                "https://icanhazip.com/"
        };

        Exception lastError = null;
        int totalBudgetMs = Math.max(800, timeoutMs);
        long deadline = SystemClock.elapsedRealtime() + totalBudgetMs;
        int reservePerEndpointMs = Math.min(1000, Math.max(500, totalBudgetMs / (endpoints.length * 2)));
        for (int index = 0; index < endpoints.length; index++) {
            long remainingMs = deadline - SystemClock.elapsedRealtime();
            if (remainingMs < 300) break;
            int attemptsAfterThis = endpoints.length - index - 1;
            int reservedMs = attemptsAfterThis * reservePerEndpointMs;
            int endpointTimeout = (int) Math.max(300, Math.min(3500, remainingMs - reservedMs));
            try {
                String body = fetchBody(proxy, endpoints[index], endpointTimeout);
                String ip = parseIp(body);
                String country = parseCountry(body);
                if (isUsablePublicIp(ip)) {
                    return new Result(ip, country, true, source, null);
                }
                lastError = new IOException("IP endpoint returned an invalid or local address");
            } catch (Exception e) {
                lastError = e;
                Log.w(TAG, "IP endpoint failed via " + source + ": " + e.getMessage());
            }
        }

        return new Result("", null, false, source, lastError != null ? lastError.getMessage() : "Unable to determine IP");
    }

    private static String fetchBody(Proxy proxy, String endpoint, int timeoutMs) throws IOException {
        return fetchBodyViaSocket(proxy, endpoint, timeoutMs);
    }

    private static String fetchBodyViaSocket(Proxy proxy, String endpoint, int timeoutMs) throws IOException {
        URL url = new URL(endpoint);
        String host = url.getHost();
        boolean tls = "https".equalsIgnoreCase(url.getProtocol());
        int port = url.getPort() > 0 ? url.getPort() : (tls ? 443 : 80);
        boolean socks = proxy.type() == Proxy.Type.SOCKS;
        Socket plain = socks ? new Socket(proxy) : new Socket();
        try {
            InetSocketAddress target = socks
                    ? InetSocketAddress.createUnresolved(host, port)
                    : new InetSocketAddress(host, port);
            plain.connect(target, timeoutMs);
            plain.setSoTimeout(timeoutMs);

            if (!tls) {
                return writeRequestAndRead(url, host, plain);
            }

            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            try (SSLSocket socket = (SSLSocket) factory.createSocket(plain, host, port, true)) {
                SSLParameters params = socket.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS");
                if (!looksLikeIp(host)) {
                    params.setServerNames(Collections.singletonList(new SNIHostName(host)));
                }
                socket.setSSLParameters(params);
                socket.setSoTimeout(timeoutMs);
                socket.startHandshake();

                return writeRequestAndRead(url, host, socket);
            }
        } finally {
            try { plain.close(); } catch (IOException ignore) {}
        }
    }

    private static String writeRequestAndRead(URL url, String host, Socket socket) throws IOException {
        String path = url.getFile();
        if (path == null || path.isEmpty()) path = "/";
        OutputStream out = socket.getOutputStream();
        String request = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + host + "\r\n"
                + "User-Agent: Mir2rayV2-IPCheck\r\n"
                + "Accept: application/json,text/plain,*/*\r\n"
                + "Connection: close\r\n\r\n";
        out.write(request.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        return readHttpResponse(socket.getInputStream());
    }

    private static String readHttpResponse(InputStream in) throws IOException {
        ByteArrayOutputStream headers = new ByteArrayOutputStream(2048);
        int matched = 0;
        int value;
        byte[] marker = new byte[] {'\r', '\n', '\r', '\n'};
        while ((value = in.read()) != -1) {
            headers.write(value);
            if ((byte) value == marker[matched]) {
                if (++matched == marker.length) break;
            } else {
                matched = (byte) value == marker[0] ? 1 : 0;
            }
            if (headers.size() > 32 * 1024) throw new IOException("Response headers are too large");
        }
        String headerText = headers.toString(StandardCharsets.ISO_8859_1.name());
        String status = headerText.split("\\r?\\n", 2)[0];
        if (!status.matches("HTTP/1\\.[01] 2\\d\\d.*")) {
            throw new IOException("IP check failed: " + status);
        }

        ByteArrayOutputStream body = new ByteArrayOutputStream(512);
        byte[] buffer = new byte[4096];
        int read;
        while (body.size() < 64 * 1024 && (read = in.read(buffer, 0,
                Math.min(buffer.length, 64 * 1024 - body.size()))) != -1) {
            body.write(buffer, 0, read);
        }
        byte[] bodyBytes = body.toByteArray();
        if (headerText.toLowerCase(java.util.Locale.US).contains("transfer-encoding: chunked")) {
            bodyBytes = decodeChunkedBody(bodyBytes);
        }
        return new String(bodyBytes, StandardCharsets.UTF_8);
    }

    static byte[] decodeChunkedBody(byte[] encoded) throws IOException {
        ByteArrayOutputStream decoded = new ByteArrayOutputStream(encoded.length);
        int position = 0;
        while (position < encoded.length) {
            int lineEnd = findCrlf(encoded, position);
            if (lineEnd < 0) throw new IOException("Malformed chunked response");
            String sizeLine = new String(encoded, position, lineEnd - position, StandardCharsets.US_ASCII).trim();
            int extension = sizeLine.indexOf(';');
            if (extension >= 0) sizeLine = sizeLine.substring(0, extension).trim();

            final int chunkSize;
            try {
                chunkSize = Integer.parseInt(sizeLine, 16);
            } catch (NumberFormatException e) {
                throw new IOException("Malformed chunk size", e);
            }
            position = lineEnd + 2;
            if (chunkSize == 0) break;
            if (chunkSize < 0 || position + chunkSize > encoded.length) {
                throw new IOException("Truncated chunked response");
            }
            decoded.write(encoded, position, chunkSize);
            position += chunkSize;
            if (position + 1 >= encoded.length || encoded[position] != '\r' || encoded[position + 1] != '\n') {
                throw new IOException("Malformed chunk terminator");
            }
            position += 2;
        }
        return decoded.toByteArray();
    }

    private static int findCrlf(byte[] bytes, int start) {
        for (int i = start; i + 1 < bytes.length; i++) {
            if (bytes[i] == '\r' && bytes[i + 1] == '\n') return i;
        }
        return -1;
    }

    static String parseIp(String body) {
        if (body == null) return null;
        String trimmed = body.trim();
        if (trimmed.isEmpty()) return null;

        if (trimmed.startsWith("{")) {
            try {
                JSONObject obj = new JSONObject(trimmed);
                String ip = obj.optString("ip", null);
                if (looksLikeIp(ip)) {
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
                String ip = t.substring(3).trim();
                if (looksLikeIp(ip)) return ip;
            }
        }

        if (looksLikeIp(trimmed)) {
            return trimmed;
        }

        return null;
    }

    static String parseCountry(String body) {
        if (body == null) return null;
        String trimmed = body.trim();
        if (trimmed.isEmpty()) return null;

        if (trimmed.startsWith("{")) {
            try {
                JSONObject obj = new JSONObject(trimmed);
                String loc = obj.optString("country_code", obj.optString("countryCode", obj.optString("country", null)));
                if (loc != null && !loc.trim().isEmpty()) {
                    return loc.trim().toUpperCase(java.util.Locale.US);
                }
            } catch (Exception ignore) {
            }
        }

        String[] lines = trimmed.split("\\r?\\n");
        for (String line : lines) {
            String t = line.trim();
            if (t.startsWith("loc=") && t.length() > 4) {
                return t.substring(4).trim().toUpperCase(java.util.Locale.US);
            }
        }

        return null;
    }

    static boolean isUsablePublicIp(String value) {
        if (!looksLikeIp(value)) return false;
        try {
            InetAddress address = InetAddress.getByName(value.trim());
            if (address.isAnyLocalAddress()
                    || address.isLoopbackAddress()
                    || address.isLinkLocalAddress()
                    || address.isSiteLocalAddress()
                    || address.isMulticastAddress()) {
                return false;
            }
            byte[] raw = address.getAddress();
            if (raw.length == 4) {
                int first = raw[0] & 0xff;
                int second = raw[1] & 0xff;
                return !(first == 100 && second >= 64 && second <= 127)
                        && !(first == 198 && (second == 18 || second == 19));
            }
            return raw.length == 16 && (raw[0] & 0xfe) != 0xfc;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean looksLikeIp(String value) {
        if (value == null) return false;
        String candidate = value.trim();
        if (candidate.isEmpty() || candidate.length() > 64) return false;
        if (candidate.indexOf(':') >= 0) {
            for (int i = 0; i < candidate.length(); i++) {
                char c = candidate.charAt(i);
                if (!(Character.digit(c, 16) >= 0 || c == ':' || c == '.')) return false;
            }
            try {
                return InetAddress.getByName(candidate) instanceof Inet6Address;
            } catch (Exception ignored) {
                return false;
            }
        }

        String[] octets = candidate.split("\\.", -1);
        if (octets.length != 4) return false;
        for (String octet : octets) {
            if (octet.isEmpty() || octet.length() > 3) return false;
            for (int i = 0; i < octet.length(); i++) {
                if (!Character.isDigit(octet.charAt(i))) return false;
            }
            try {
                if (Integer.parseInt(octet) > 255) return false;
            } catch (NumberFormatException ignored) {
                return false;
            }
        }
        return true;
    }
}

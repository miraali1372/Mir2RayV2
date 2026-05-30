package com.mir2ray.app;

import java.net.InetSocketAddress;
import java.net.Socket;

/** TCP connect latency (real RTT), used for DNS/CDN/server ping on Android. */
final class TcpPingHelper {
    private TcpPingHelper() {}

    static long ping(String host, int port, int timeoutMs) {
        if (host == null || host.isEmpty()) return -1;
        long start = System.currentTimeMillis();
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            return System.currentTimeMillis() - start;
        } catch (Exception e) {
            return -1;
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
        }
    }
}

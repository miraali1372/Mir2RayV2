package com.mir2ray.app;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.TimeUnit;

/** TCP connect latency (real RTT), used for DNS/CDN/server ping on Android. */
final class TcpPingHelper {
    private TcpPingHelper() {}

    static final class Result {
        final long latency;
        final String ip;

        Result(long latency, String ip) {
            this.latency = latency;
            this.ip = ip;
        }
    }

    static Result ping(String host, int port, int timeoutMs) {
        if (host == null || host.isEmpty()) return new Result(-1, null);
        Socket socket = new Socket();
        String resolvedIp = null;
        try {
            // DNS lookup is setup work, not TCP connect latency.
            InetAddress address = InetAddress.getByName(host);
            resolvedIp = address.getHostAddress();
            InetSocketAddress target = new InetSocketAddress(address, port);
            long started = System.nanoTime();
            socket.connect(target, timeoutMs);
            long latency = Math.max(
                    1,
                    TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
            );
            return new Result(latency, resolvedIp);
        } catch (Exception e) {
            return new Result(-1, resolvedIp);
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
        }
    }
}

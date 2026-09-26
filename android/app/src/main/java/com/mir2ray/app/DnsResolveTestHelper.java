package com.mir2ray.app;

import android.util.Log;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

final class DnsResolveTestHelper {
    private static final String TAG = "DnsResolveTestHelper";
    private static final SecureRandom RANDOM = new SecureRandom();

    static final class Result {
        final long latency;
        final boolean ok;
        final String message;

        Result(long latency, boolean ok, String message) {
            this.latency = latency;
            this.ok = ok;
            this.message = message;
        }
    }

    static final class ResolveResult {
        final String address;
        final long latency;
        final boolean ok;
        final String message;

        ResolveResult(String address, long latency, boolean ok, String message) {
            this.address = address;
            this.latency = latency;
            this.ok = ok;
            this.message = message;
        }
    }

    private DnsResolveTestHelper() {}

    static Result test(String dnsIp, String domain, int timeoutMs) {
        if (dnsIp == null || dnsIp.trim().isEmpty()) {
            return new Result(-1, false, "DNS IP is required");
        }
        String targetDomain = domain == null || domain.trim().isEmpty()
                ? "cp.cloudflare.com"
                : domain.trim();
        int timeout = Math.max(500, timeoutMs);
        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout);
        List<Long> samples = new ArrayList<>(3);
        String lastMessage = "DNS query timed out";
        for (int attempt = 0; attempt < 3; attempt++) {
            long remainingNanos = deadlineNanos - System.nanoTime();
            if (remainingNanos <= 0) break;
            int attemptsLeft = 3 - attempt;
            int attemptTimeout = (int) Math.max(
                    250,
                    TimeUnit.NANOSECONDS.toMillis(remainingNanos) / attemptsLeft
            );
            Result sample = testOnce(dnsIp.trim(), targetDomain, attemptTimeout);
            if (sample.ok && sample.latency >= 0) {
                samples.add(sample.latency);
            } else if (sample.message != null && !sample.message.isEmpty()) {
                lastMessage = sample.message;
            }
        }

        if (samples.size() < 2) return new Result(-1, false, lastMessage);
        Collections.sort(samples);
        return new Result(samples.get(samples.size() / 2), true, null);
    }

    private static Result testOnce(String dnsIp, String domain, int timeoutMs) {
        try (DatagramSocket socket = new DatagramSocket()) {
            InetAddress dnsAddress = InetAddress.getByName(dnsIp);
            byte[] query = buildQuery(domain);
            int queryId = ((query[0] & 0xff) << 8) | (query[1] & 0xff);
            DatagramPacket request = new DatagramPacket(
                    query,
                    query.length,
                    new InetSocketAddress(dnsAddress, 53)
            );

            socket.setSoTimeout(timeoutMs);
            long started = System.nanoTime();
            socket.send(request);

            byte[] buffer = new byte[512];
            DatagramPacket response = new DatagramPacket(buffer, buffer.length);
            socket.receive(response);
            long elapsedMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));

            boolean valid = isValidAnswer(buffer, response.getLength(), queryId);
            return valid
                    ? new Result(elapsedMs, true, null)
                    : new Result(-1, false, "DNS response did not contain a valid answer");
        } catch (Exception e) {
            Log.d(TAG, "DNS resolve sample failed", e);
            return new Result(-1, false, e.getMessage());
        }
    }

    static ResolveResult resolveIpv4(String dnsIp, String domain, int timeoutMs) {
        if (dnsIp == null || dnsIp.trim().isEmpty()) {
            return new ResolveResult("", -1, false, "DNS IP is required");
        }
        String targetDomain = domain == null || domain.trim().isEmpty()
                ? "www.youtube.com"
                : domain.trim();
        int timeout = Math.max(500, timeoutMs);

        try (DatagramSocket socket = new DatagramSocket()) {
            InetAddress dnsAddress = InetAddress.getByName(dnsIp.trim());
            byte[] query = buildQuery(targetDomain);
            int queryId = ((query[0] & 0xff) << 8) | (query[1] & 0xff);
            DatagramPacket request = new DatagramPacket(
                    query,
                    query.length,
                    new InetSocketAddress(dnsAddress, 53)
            );

            socket.setSoTimeout(timeout);
            long started = System.nanoTime();
            socket.send(request);

            byte[] buffer = new byte[512];
            DatagramPacket response = new DatagramPacket(buffer, buffer.length);
            socket.receive(response);
            long elapsedMs = Math.max(1, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));

            String address = findFirstAAnswer(buffer, response.getLength(), queryId);
            return address != null && !address.isEmpty()
                    ? new ResolveResult(address, elapsedMs, true, null)
                    : new ResolveResult("", -1, false, "DNS response did not contain an IPv4 answer");
        } catch (Exception e) {
            Log.w(TAG, "DNS IPv4 resolve failed", e);
            return new ResolveResult("", -1, false, e.getMessage());
        }
    }

    private static byte[] buildQuery(String domain) throws Exception {
        byte[] packet = new byte[512];
        int id = RANDOM.nextInt(0xffff);
        packet[0] = (byte) ((id >> 8) & 0xff);
        packet[1] = (byte) (id & 0xff);
        packet[2] = 0x01; // recursion desired
        packet[3] = 0x00;
        packet[4] = 0x00;
        packet[5] = 0x01; // one question

        int offset = 12;
        String[] labels = domain.split("\\.");
        for (String label : labels) {
            byte[] labelBytes = label.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            if (labelBytes.length == 0 || labelBytes.length > 63) {
                throw new IllegalArgumentException("Invalid DNS label");
            }
            packet[offset++] = (byte) labelBytes.length;
            System.arraycopy(labelBytes, 0, packet, offset, labelBytes.length);
            offset += labelBytes.length;
        }
        packet[offset++] = 0x00;
        packet[offset++] = 0x00;
        packet[offset++] = 0x01; // A
        packet[offset++] = 0x00;
        packet[offset++] = 0x01; // IN

        byte[] query = new byte[offset];
        System.arraycopy(packet, 0, query, 0, offset);
        return query;
    }

    private static boolean isValidAnswer(byte[] packet, int length, int queryId) {
        if (length < 12) return false;

        int responseId = ((packet[0] & 0xff) << 8) | (packet[1] & 0xff);
        if (responseId != queryId) return false;

        int flags = ((packet[2] & 0xff) << 8) | (packet[3] & 0xff);
        boolean isResponse = (flags & 0x8000) != 0;
        int rcode = flags & 0x000f;
        if (!isResponse || rcode != 0) return false;

        int questions = readU16(packet, 4);
        int answers = readU16(packet, 6);
        if (answers <= 0) return false;

        int offset = 12;
        for (int i = 0; i < questions; i++) {
            offset = skipName(packet, length, offset);
            if (offset < 0 || offset + 4 > length) return false;
            offset += 4;
        }

        for (int i = 0; i < answers; i++) {
            offset = skipName(packet, length, offset);
            if (offset < 0 || offset + 10 > length) return false;
            int type = readU16(packet, offset);
            int klass = readU16(packet, offset + 2);
            int rdLength = readU16(packet, offset + 8);
            offset += 10;
            if (offset + rdLength > length) return false;
            if (klass == 1 && rdLength > 0 && (type == 1 || type == 28 || type == 5)) {
                return true;
            }
            offset += rdLength;
        }

        return false;
    }

    private static String findFirstAAnswer(byte[] packet, int length, int queryId) {
        if (length < 12) return null;

        int responseId = ((packet[0] & 0xff) << 8) | (packet[1] & 0xff);
        if (responseId != queryId) return null;

        int flags = ((packet[2] & 0xff) << 8) | (packet[3] & 0xff);
        boolean isResponse = (flags & 0x8000) != 0;
        int rcode = flags & 0x000f;
        if (!isResponse || rcode != 0) return null;

        int questions = readU16(packet, 4);
        int answers = readU16(packet, 6);
        if (answers <= 0) return null;

        int offset = 12;
        for (int i = 0; i < questions; i++) {
            offset = skipName(packet, length, offset);
            if (offset < 0 || offset + 4 > length) return null;
            offset += 4;
        }

        for (int i = 0; i < answers; i++) {
            offset = skipName(packet, length, offset);
            if (offset < 0 || offset + 10 > length) return null;
            int type = readU16(packet, offset);
            int klass = readU16(packet, offset + 2);
            int rdLength = readU16(packet, offset + 8);
            offset += 10;
            if (offset + rdLength > length) return null;
            if (klass == 1 && type == 1 && rdLength == 4) {
                return (packet[offset] & 0xff) + "."
                        + (packet[offset + 1] & 0xff) + "."
                        + (packet[offset + 2] & 0xff) + "."
                        + (packet[offset + 3] & 0xff);
            }
            offset += rdLength;
        }

        return null;
    }

    private static int skipName(byte[] packet, int length, int offset) {
        int pos = offset;
        while (pos < length) {
            int labelLength = packet[pos] & 0xff;
            if (labelLength == 0) return pos + 1;
            if ((labelLength & 0xc0) == 0xc0) {
                return pos + 2;
            }
            pos += 1 + labelLength;
        }
        return -1;
    }

    private static int readU16(byte[] packet, int offset) {
        return ((packet[offset] & 0xff) << 8) | (packet[offset + 1] & 0xff);
    }
}

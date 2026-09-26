package com.mir2ray.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

@RunWith(AndroidJUnit4.class)
public class VpnCoreInstrumentedTest {

    @Test
    public void secureStorage_roundTripsAndRemovesCiphertext() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SecureStorage storage = new SecureStorage(context);
        String key = "instrumentation_secret";
        String value = "vless://test-credential@example.invalid:443";

        storage.putString(key, value);
        assertEquals(value, storage.getString(key));
        storage.remove(key);
        assertNull(storage.getString(key));
    }

    @Test
    public void uriParser_parsesModernVlessAndRejectsMissingPort() {
        ProfileItem parsed = V2rayUriParser.parse(
                "vless://00000000-0000-0000-0000-000000000001@example.com:443"
                        + "?encryption=none&security=tls&type=ws&host=cdn.example.com&path=%2Fws#test"
        );

        assertNotNull(parsed);
        assertEquals("vless", parsed.configType);
        assertEquals("example.com", parsed.server);
        assertEquals("443", parsed.serverPort);
        assertEquals("ws", parsed.network);
        assertEquals("cdn.example.com", parsed.host);
        assertNull(V2rayUriParser.parse("vless://id@example.com"));
    }

    @Test
    public void publicIpHelper_parsesSupportedBodiesAndDecodesChunkedResponses() throws Exception {
        assertEquals("203.0.113.7", PublicIpHelper.parseIp("{\"ip\":\"203.0.113.7\"}"));
        assertEquals("2001:db8::7", PublicIpHelper.parseIp("warp=off\nip=2001:db8::7\nts=1"));
        assertEquals("203.0.113.8", PublicIpHelper.parseIp("203.0.113.8\n"));
        assertNull(PublicIpHelper.parseIp("{\"ip\":\"not-an-ip\"}"));
        assertNull(PublicIpHelper.parseIp("999.999.999.999"));
        assertTrue(PublicIpHelper.isUsablePublicIp("203.0.113.8"));
        assertFalse(PublicIpHelper.isUsablePublicIp("127.0.0.1"));
        assertFalse(PublicIpHelper.isUsablePublicIp("10.0.0.1"));
        assertFalse(PublicIpHelper.isUsablePublicIp("fd00::1"));

        String payload = "ip=203.0.113.9\n";
        byte[] payloadBytes = payload.getBytes(StandardCharsets.UTF_8);
        String chunked = Integer.toHexString(payloadBytes.length)
                + "\r\n" + payload + "\r\n0\r\n\r\n";
        byte[] decoded = PublicIpHelper.decodeChunkedBody(chunked.getBytes(StandardCharsets.US_ASCII));
        assertEquals(payload, new String(decoded, StandardCharsets.UTF_8));
        assertEquals("203.0.113.9", PublicIpHelper.parseIp(new String(decoded, StandardCharsets.UTF_8)));
    }

    @Test
    public void realDelayTargets_keepAHealthGateAndSelectThePreferredServiceResponse() throws Exception {
        JSONObject payload = new JSONObject().put(
                "delayUrls",
                new JSONArray()
                        .put("https://connectivitycheck.gstatic.com/generate_204")
                        .put("https://static.cdninstagram.com/rsrc.php/y4/r/QaBlI0OZiks.ico")
                        .put("https://connectivitycheck.gstatic.com/generate_204")
        );
        List<String> targets = BandwidthTestHelper.collectDelayUrls(
                payload,
                "https://fallback.invalid/"
        );

        assertEquals(2, targets.size());
        assertEquals(
                "https://static.cdninstagram.com/rsrc.php/y4/r/QaBlI0OZiks.ico",
                targets.get(1)
        );
        assertEquals(
                420L,
                BandwidthTestHelper.selectWorstDelayMs(Arrays.asList(85L, 420L, 160L))
        );
        assertEquals(
                420L,
                BandwidthTestHelper.selectPreferredDelayMs(
                        Arrays.asList("general", "meta", "other"),
                        Arrays.asList(85L, 420L, 160L),
                        "meta"
                )
        );
        assertEquals(
                420L,
                BandwidthTestHelper.selectPreferredDelayMs(
                        Arrays.asList("general", "meta", "other"),
                        Arrays.asList(85L, 420L, 160L),
                        "missing"
                )
        );
        assertTrue(BandwidthTestHelper.isDelayResponseStatus(204));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(404));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(403));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(302));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(500));
    }

    @Test
    public void realDelay_rejectsAConfigWithoutAUsableExitIp() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        JSONObject payload = new JSONObject()
                .put(
                        "shareUri",
                        "vless://00000000-0000-4000-8000-000000000001@192.0.2.1:443"
                                + "?encryption=none&security=tls&sni=example.com&type=tcp#no-exit"
                )
                .put("delayOnly", true)
                .put("timeoutMs", 3000)
                .put("downloadUrl", "https://connectivitycheck.gstatic.com/generate_204");

        BandwidthTestHelper.BandwidthResult result = BandwidthTestHelper.measure(context, payload);

        assertFalse(result.ok);
        assertEquals(-1L, result.downloadMs);
        assertEquals("Exit IP validation failed", result.message);
    }

    @Test
    public void configBuilder_createsTunDnsAndProxyWithoutEmbeddingTemplatePlaceholder() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String credentials = "aes-256-gcm:test-password";
        String encoded = Base64.encodeToString(credentials.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP)
                .replace("=", "");
        String shareUri = "ss://" + encoded + "@203.0.113.10:8388#instrumentation";

        String built = V2rayConfigBuilder.build(
                context,
                shareUri,
                null,
                null,
                new FragmentOptions(),
                false
        );
        JSONObject config = new JSONObject(built);
        JSONArray inbounds = config.getJSONArray("inbounds");
        JSONArray outbounds = config.getJSONArray("outbounds");

        assertEquals("tun", inbounds.getJSONObject(1).getString("tag"));
        assertEquals("proxy", outbounds.getJSONObject(0).getString("tag"));
        assertEquals("shadowsocks", outbounds.getJSONObject(0).getString("protocol"));
        assertFalse(built.contains("00000000-0000-0000-0000-000000000000"));
        assertTrue(config.getJSONObject("dns").getJSONArray("servers").length() >= 1);

        JSONArray rules = config.getJSONObject("routing").getJSONArray("rules");
        boolean blocksQuic = false;
        boolean proxiesUdp = false;
        int quicBlockIndex = -1;
        int proxyIndex = -1;
        for (int i = 0; i < rules.length(); i++) {
            JSONObject rule = rules.getJSONObject(i);
            if (rule.optInt("port", -1) == 443
                    && "udp".equals(rule.optString("network"))
                    && "block".equals(rule.optString("outboundTag"))) {
                blocksQuic = true;
                quicBlockIndex = i;
            }
            if ("tcp,udp".equals(rule.optString("network"))
                    && "proxy".equals(rule.optString("outboundTag"))) {
                proxiesUdp = true;
                proxyIndex = i;
            }
        }
        assertTrue(blocksQuic);
        assertTrue(proxiesUdp);
        assertTrue(proxyIndex > quicBlockIndex);
    }

    @Test
    public void configBuilder_appliesFakeDnsAndDohFlags() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String credentials = "aes-256-gcm:test-password";
        String encoded = Base64.encodeToString(credentials.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP)
                .replace("=", "");
        String shareUri = "ss://" + encoded + "@203.0.113.10:8388#dns-flags";
        JSONObject payload = new JSONObject()
                .put("shareUri", shareUri)
                .put("fakeDns", true)
                .put("doh", true);

        String built = V2rayConfigBuilder.build(
                context,
                payload.toString(),
                new String[] { shareUri },
                null,
                null,
                new FragmentOptions(),
                false
        );
        JSONObject config = new JSONObject(built);
        assertTrue(config.has("fakedns"));

        JSONArray dnsServers = config.getJSONObject("dns").getJSONArray("servers");
        assertEquals("fakedns", dnsServers.getString(0));
        boolean hasCloudflareDoh = false;
        boolean hasGoogleDoh = false;
        for (int i = 0; i < dnsServers.length(); i++) {
            String server = dnsServers.getString(i);
            if ("https://1.1.1.1/dns-query".equals(server)) {
                hasCloudflareDoh = true;
            }
            if ("https://8.8.8.8/dns-query".equals(server)) {
                hasGoogleDoh = true;
            }
        }
        assertTrue(hasCloudflareDoh);
        assertTrue(hasGoogleDoh);

        JSONArray destOverride = config
                .getJSONArray("inbounds")
                .getJSONObject(0)
                .getJSONObject("sniffing")
                .getJSONArray("destOverride");
        boolean hasFakeDnsSniffing = false;
        for (int i = 0; i < destOverride.length(); i++) {
            if ("fakedns".equals(destOverride.getString(i))) {
                hasFakeDnsSniffing = true;
                break;
            }
        }
        assertTrue(hasFakeDnsSniffing);
    }

        @Test
        public void speedTest_preservesDohFakeDnsAndFragment() throws Exception {
                Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
                FragmentOptions fragment = new FragmentOptions();
                fragment.enabled = true;
                String built = V2rayConfigBuilder.buildSpeedTest(context,
                                "vless://00000000-0000-4000-8000-000000000001@example.com:443?security=tls&type=tcp",
                                null, null, fragment, false, 22090, true, true);
                JSONObject config = new JSONObject(built);
                assertTrue(config.has("fakedns"));
                JSONArray servers = config.getJSONObject("dns").getJSONArray("servers");
                boolean hasDoh = false;
                for (int index = 0; index < servers.length(); index++) {
                        if ("https://1.1.1.1/dns-query".equals(servers.optString(index))) hasDoh = true;
                }
                assertTrue(hasDoh);
                assertTrue(built.contains("fragment"));
                assertEquals(22090, config.getJSONArray("inbounds").getJSONObject(0).getInt("port"));
        }

        @Test
        public void liveProxy_measuresColdAndWarmResponses() throws Exception {
                String shareUri = InstrumentationRegistry.getArguments().getString("liveProxy", "");
                org.junit.Assume.assumeTrue(!shareUri.isEmpty());
                Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
                JSONObject payload = new JSONObject().put("shareUri", shareUri)
                                .put("delayOnly", true).put("timeoutMs", 12000)
                                .put("delayUrls", new JSONArray().put("https://cp.cloudflare.com/generate_204"));
                BandwidthTestHelper.BandwidthResult result = BandwidthTestHelper.measure(context, payload);
                assertTrue(result.message, result.ok);
                assertTrue(result.downloadMs > 0);
                assertTrue(result.coldDelayMs >= result.downloadMs);
                assertTrue(result.jitterMs >= 0);
        }

        @Test
        public void cancelProbe_closesRunningWorkPromptly() throws Exception {
                Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
                JSONObject payload = new JSONObject().put("shareUri",
                                "vless://00000000-0000-4000-8000-000000000001@192.0.2.1:443?security=tls&type=tcp")
                                .put("delayOnly", true).put("timeoutMs", 30000);
                java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newSingleThreadExecutor();
                java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
                java.util.concurrent.Future<BandwidthTestHelper.BandwidthResult> pending = executor.submit(() -> {
                        entered.countDown();
                        return BandwidthTestHelper.measure(context, payload);
                });
                try {
                        assertTrue(entered.await(2, java.util.concurrent.TimeUnit.SECONDS));
                        java.util.concurrent.CountDownLatch delay = new java.util.concurrent.CountDownLatch(1);
                        delay.await(400, java.util.concurrent.TimeUnit.MILLISECONDS);
                        BandwidthTestHelper.cancelAll();
                        assertFalse(pending.get(6, java.util.concurrent.TimeUnit.SECONDS).ok);
                } finally {
                        BandwidthTestHelper.cancelAll();
                        executor.shutdownNow();
                }
        }
}

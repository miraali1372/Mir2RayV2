package com.mir2ray.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class BandwidthTestHelperTest {

    @Test
    public void targetEvidence_fieldsPreservedAndFormatted() {
        BandwidthTestHelper.TargetEvidence evidence = new BandwidthTestHelper.TargetEvidence(
                "https://www.youtube.com/generate_204",
                "www.youtube.com",
                true,
                204,
                125L,
                0L,
                null,
                1700000000000L,
                "video",
                false
        );

        assertEquals("https://www.youtube.com/generate_204", evidence.target);
        assertEquals("www.youtube.com", evidence.destination);
        assertTrue(evidence.ok);
        assertEquals(204, evidence.status);
        assertEquals(204, evidence.statusCode);
        assertEquals(125L, evidence.latencyMs);
        assertEquals(0L, evidence.bytes);
        assertNull(evidence.error);
        assertEquals(1700000000000L, evidence.checkedAt);
        assertEquals("video", evidence.tier);
        assertFalse(evidence.browserVerified);
    }

    @Test
    public void targetEvidence_distinguishesHttpStatusFromTransportError() {
        // HTTP status error (e.g. 403 Forbidden)
        BandwidthTestHelper.TargetEvidence httpError = new BandwidthTestHelper.TargetEvidence(
                "https://www.google.com/generate_204",
                "www.google.com",
                false,
                403,
                -1L,
                0L,
                "HTTP 403",
                1700000000000L,
                "web",
                false
        );
        assertFalse(httpError.ok);
        assertEquals(403, httpError.status);
        assertEquals(403, httpError.statusCode);
        assertEquals("HTTP 403", httpError.error);

        // Socket/Transport error (e.g. connection refused)
        BandwidthTestHelper.TargetEvidence transportError = new BandwidthTestHelper.TargetEvidence(
                "https://www.google.com/generate_204",
                "www.google.com",
                false,
                -1,
                -1L,
                0L,
                "Connection refused",
                1700000000000L,
                "web",
                false
        );
        assertFalse(transportError.ok);
        assertEquals(-1, transportError.status);
        assertEquals(-1, transportError.statusCode);
        assertEquals("Connection refused", transportError.error);
    }

    @Test
    public void sanitizeError_redactsSensitiveUrisAndCredentials() {
        String raw = "Failed connect to vless://e5d1b712-4217-48f8-b3ab-0a4f5b871234@server.com:443?encryption=none&security=reality#MyConfig";
        String sanitized = BandwidthTestHelper.sanitizeError(raw);
        assertFalse(sanitized.contains("vless://"));
        assertFalse(sanitized.contains("e5d1b712-4217-48f8-b3ab-0a4f5b871234"));
        assertFalse(sanitized.contains("encryption=none"));
        assertTrue(sanitized.contains("[REDACTED_URI]") || sanitized.contains("[REDACTED_UUID]"));

        String rawAuth = "Proxy auth error at https://user:secretpassword@proxy.example.com:8080/path";
        String sanitizedAuth = BandwidthTestHelper.sanitizeError(rawAuth);
        assertFalse(sanitizedAuth.contains("secretpassword"));
        assertTrue(sanitizedAuth.contains("[REDACTED_AUTH]"));
    }

    @Test
    public void sanitizeUrl_removesQueryParametersAndUserInfo() {
        String urlWithQuery = "https://example.com/generate_204?secret=123&token=abc";
        String sanitized = BandwidthTestHelper.sanitizeUrl(urlWithQuery);
        assertEquals("https://example.com/generate_204", sanitized);
        assertFalse(sanitized.contains("secret"));
    }

    @Test
    public void extractHost_returnsCorrectHostOrUnknown() {
        assertEquals("www.youtube.com", BandwidthTestHelper.extractHost("https://www.youtube.com/generate_204"));
        assertEquals("unknown", BandwidthTestHelper.extractHost("not a url"));
        assertEquals("unknown", BandwidthTestHelper.extractHost(null));
    }

    @Test
    public void determineTier_classifiesKnownDomains() {
        assertEquals("video", BandwidthTestHelper.determineTier("https://www.youtube.com/generate_204"));
        assertEquals("video", BandwidthTestHelper.determineTier("https://rr1---sn-4g5ednks.googlevideo.com/videoplayback"));
        assertEquals("social", BandwidthTestHelper.determineTier("https://www.facebook.com/generate_204"));
        assertEquals("social", BandwidthTestHelper.determineTier("https://static.cdninstagram.com/rsrc.php/v3/yA/r/"));
        assertEquals("web", BandwidthTestHelper.determineTier("https://www.google.com/generate_204"));
        assertEquals("web", BandwidthTestHelper.determineTier("https://connectivitycheck.gstatic.com/generate_204"));
        assertEquals("web", BandwidthTestHelper.determineTier("https://generativelanguage.googleapis.com/v1beta/models"));
        assertEquals("cdn", BandwidthTestHelper.determineTier("https://cp.cloudflare.com/generate_204"));
        assertEquals("standard", BandwidthTestHelper.determineTier("https://example.com/check"));
        assertEquals("standard", BandwidthTestHelper.determineTier(null));
    }

    @Test
    public void isDelayResponseStatus_acceptsOnly2xx() {
        assertTrue(BandwidthTestHelper.isDelayResponseStatus(200));
        assertTrue(BandwidthTestHelper.isDelayResponseStatus(204));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(301));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(302));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(400));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(403));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(404));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(500));
        assertFalse(BandwidthTestHelper.isDelayResponseStatus(502));
    }

    @Test
    public void bandwidthResult_holdsTargetEvidenceAndCountryProvenance() {
        BandwidthTestHelper.BandwidthResult result = new BandwidthTestHelper.BandwidthResult(
                -1L, -1L, 0L, 120L, 120L, -1L, true, null
        );
        result.exitIp = "198.51.100.1";
        result.exitCountry = "DE";
        result.countryProvenance = "measured";

        BandwidthTestHelper.TargetEvidence ev1 = new BandwidthTestHelper.TargetEvidence(
                "https://www.google.com/generate_204", "www.google.com",
                true, 204, 110L, 0L, null, System.currentTimeMillis(), "web", false
        );
        BandwidthTestHelper.TargetEvidence ev2 = new BandwidthTestHelper.TargetEvidence(
                "https://www.youtube.com/generate_204", "www.youtube.com",
                true, 204, 130L, 0L, null, System.currentTimeMillis(), "video", false
        );
        result.targetEvidence = Collections.unmodifiableList(Arrays.asList(ev1, ev2));

        assertTrue(result.ok);
        assertEquals("198.51.100.1", result.exitIp);
        assertEquals("DE", result.exitCountry);
        assertEquals("measured", result.countryProvenance);
        assertEquals(2, result.targetEvidence.size());
        assertEquals("web", result.targetEvidence.get(0).tier);
        assertEquals("video", result.targetEvidence.get(1).tier);
    }

    @Test
    public void selectWorstDelayMs_picksMaximum() throws Exception {
        List<Long> samples = Arrays.asList(50L, 230L, 120L);
        assertEquals(230L, BandwidthTestHelper.selectWorstDelayMs(samples));
    }

    @Test
    public void selectPreferredDelayMs_picksTargetIfPresent() throws Exception {
        List<String> urls = Arrays.asList("https://google.com", "https://youtube.com", "https://facebook.com");
        List<Long> delays = Arrays.asList(80L, 150L, 200L);
        assertEquals(150L, BandwidthTestHelper.selectPreferredDelayMs(urls, delays, "https://youtube.com"));
        assertEquals(200L, BandwidthTestHelper.selectPreferredDelayMs(urls, delays, "https://facebook.com"));
        // Fallback to worst delay if preferred target is missing
        assertEquals(200L, BandwidthTestHelper.selectPreferredDelayMs(urls, delays, "nonexistent"));
    }
}

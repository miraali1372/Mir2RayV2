package com.mir2ray.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LogCollectorTest {

    @Test
    public void sanitize_redactsProxyUrisAndJsonSecrets() {
        String raw = "failed ss://method:password@example.com:443 "
                + "{\"shareUri\":\"vless://uuid@example.com:443\",\"token\":\"abc123\"}";

        String sanitized = LogCollector.sanitize(raw);
        assertTrue(sanitized.contains("ss://<redacted>"));
        assertTrue(sanitized.contains("\"shareUri\":\"<redacted>\""));
        assertTrue(sanitized.contains("\"token\":\"<redacted>\""));
        assertFalse(sanitized.contains("password@example.com"));
        assertFalse(sanitized.contains("uuid@example.com"));
        assertFalse(sanitized.contains("abc123"));
    }
}

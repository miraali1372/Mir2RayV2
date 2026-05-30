package com.mir2ray.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Builds a full Xray JSON config from a share link (v2rayNG template + outbound).
 */
public final class V2rayConfigBuilder {
    private static final String TAG = "V2rayConfigBuilder";

    private V2rayConfigBuilder() {}

    public static String build(Context context, String shareUri, String dnsIp, String cleanIp, FragmentOptions fragment) throws Exception {
        return build(context, shareUri, dnsIp, cleanIp, fragment, false);
    }

    public static String build(Context context, String shareUri, String dnsIp, String cleanIp, FragmentOptions fragment, boolean strictDns) throws Exception {
        ProfileItem profile = V2rayUriParser.parse(shareUri);
        if (profile == null) {
            throw new IllegalArgumentException("Invalid or unsupported share link");
        }
        if (cleanIp != null && !cleanIp.isEmpty()) {
            applyCleanIp(profile, cleanIp);
        }
        if (profile.server == null || profile.server.isEmpty()) {
            throw new IllegalArgumentException("Server address is missing");
        }
        if (profile.serverPort == null || profile.serverPort.isEmpty()) {
            throw new IllegalArgumentException("Server port is missing");
        }

        JSONObject config = new JSONObject(loadTemplate(context));
        JSONObject proxyOutbound = V2rayOutboundBuilder.buildProxyOutbound(profile, fragment);

        JSONArray outbounds = config.getJSONArray("outbounds");
        boolean replaced = false;
        for (int i = 0; i < outbounds.length(); i++) {
            if ("proxy".equals(outbounds.getJSONObject(i).optString("tag"))) {
                outbounds.put(i, proxyOutbound);
                replaced = true;
                break;
            }
        }
        if (!replaced) {
            outbounds.put(0, proxyOutbound);
        }

        applyDns(config, dnsIp, strictDns);
        applyRouting(config, "tun");

        String result = config.toString();
        Log.i(TAG, "Built config " + profile.configType + " -> " + profile.server + ":" + profile.serverPort);
        return result;
    }

    public static String buildSpeedTest(Context context, String shareUri, String dnsIp, String cleanIp, FragmentOptions fragment, boolean strictDns, int socksPort) throws Exception {
        ProfileItem profile = V2rayUriParser.parse(shareUri);
        if (profile == null) {
            throw new IllegalArgumentException("Invalid or unsupported share link");
        }
        if (cleanIp != null && !cleanIp.isEmpty()) {
            applyCleanIp(profile, cleanIp);
        }
        if (profile.server == null || profile.server.isEmpty()) {
            throw new IllegalArgumentException("Server address is missing");
        }
        if (profile.serverPort == null || profile.serverPort.isEmpty()) {
            throw new IllegalArgumentException("Server port is missing");
        }

        JSONObject config = new JSONObject(loadTemplate(context));
        JSONObject proxyOutbound = V2rayOutboundBuilder.buildProxyOutbound(profile, fragment);

        JSONArray outbounds = config.getJSONArray("outbounds");
        boolean replaced = false;
        for (int i = 0; i < outbounds.length(); i++) {
            if ("proxy".equals(outbounds.getJSONObject(i).optString("tag"))) {
                outbounds.put(i, proxyOutbound);
                replaced = true;
                break;
            }
        }
        if (!replaced) {
            outbounds.put(0, proxyOutbound);
        }

        config.put("inbounds", buildSpeedTestInbounds(socksPort));
        applyDns(config, dnsIp, strictDns);
        applyRouting(config, "speedtest");

        String result = config.toString();
        Log.i(TAG, "Built speed-test config " + profile.configType + " -> " + profile.server + ":" + profile.serverPort);
        return result;
    }

    private static void applyDns(JSONObject config, String dnsIp, boolean strictDns) throws Exception {
        JSONObject dns = config.optJSONObject("dns");
        if (dns == null) {
            dns = new JSONObject();
            config.put("dns", dns);
        }
        JSONArray servers = new JSONArray();
        if (dnsIp != null && !dnsIp.isEmpty()) {
            servers.put(dnsIp);
        }
        if (!strictDns || servers.length() == 0) {
            servers.put("8.8.8.8");
            servers.put("1.1.1.1");
        }
        dns.put("servers", servers);
        dns.put("queryStrategy", "UseIPv4");
    }

    private static JSONArray buildSpeedTestInbounds(int socksPort) throws Exception {
        JSONArray inbounds = new JSONArray();
        inbounds.put(new JSONObject()
                .put("tag", "speedtest")
                .put("listen", "127.0.0.1")
                .put("port", socksPort)
                .put("protocol", "socks")
                .put("settings", new JSONObject()
                        .put("auth", "noauth")
                        .put("udp", true)
                        .put("userLevel", 8))
                .put("sniffing", new JSONObject()
                        .put("enabled", true)
                        .put("destOverride", new JSONArray()
                                .put("http")
                                .put("tls")
                                .put("quic"))));
        return inbounds;
    }

    private static void applyRouting(JSONObject config, String inboundTag) throws Exception {
        JSONObject routing = config.getJSONObject("routing");
        routing.put("domainStrategy", "IPIfNonMatch");
        JSONArray rules = new JSONArray();

        rules.put(new JSONObject()
                .put("type", "field")
                .put("inboundTag", new JSONArray().put(inboundTag))
                .put("network", "tcp,udp")
                .put("outboundTag", "proxy"));

        rules.put(new JSONObject()
                .put("type", "field")
                .put("ip", new JSONArray().put("geoip:private"))
                .put("outboundTag", "direct"));

        routing.put("rules", rules);
    }

    private static String loadTemplate(Context context) throws Exception {
        try (InputStream in = context.getAssets().open("v2ray_config_with_tun.json");
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString();
        }
    }

    private static void applyCleanIp(ProfileItem profile, String cleanIp) {
        if (cleanIp == null || cleanIp.isEmpty()) return;
        String originalServer = profile.server;
        profile.server = cleanIp;
        if (profile.host == null || profile.host.isEmpty()) {
            profile.host = originalServer;
        }
        if (profile.sni == null || profile.sni.isEmpty()) {
            profile.sni = originalServer;
        }
        if (profile.authority == null || profile.authority.isEmpty()) {
            profile.authority = originalServer;
        }
        if (profile.configType != null && profile.configType.equals("vmess") && profile.network != null && profile.network.equals("ws") && (profile.host == null || profile.host.isEmpty())) {
            profile.host = originalServer;
        }
    }
}

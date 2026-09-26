package com.mir2ray.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Builds a full Xray JSON config from a share link (v2rayNG template + outbound).
 */
public final class V2rayConfigBuilder {
    private static final String TAG = "V2rayConfigBuilder";
    private static final String[] PRIVATE_CIDRS = new String[] {
            "0.0.0.0/8",
            "10.0.0.0/8",
            "100.64.0.0/10",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "172.16.0.0/12",
            "192.0.0.0/24",
            "192.0.2.0/24",
            "192.168.0.0/16",
            "198.18.0.0/15",
            "198.51.100.0/24",
            "203.0.113.0/24",
            "::1/128",
            "fc00::/7",
            "fe80::/10"
    };
    private static final String[] DEFAULT_DNS_SERVERS = new String[] {
            "1.1.1.1",
            "8.8.8.8"
    };
    private static final String[] IRAN_DIRECT_DOMAINS = new String[] {
            "regexp:(^|\\.)ir$",
            "domain:digikala.com",
            "domain:snapp.cab",
            "domain:snapp.taxi",
            "domain:tapsi.cab",
            "domain:aparat.com",
            "domain:filimo.com",
            "domain:namava.ir",
            "domain:telewebion.com",
            "domain:cafebazaar.ir",
            "domain:myket.ir",
            "domain:shaparak.ir",
            "domain:sadadpsp.ir",
            "domain:asanpardakht.ir",
            "domain:sep.ir",
            "domain:bmi.ir",
            "domain:bankmellat.ir",
            "domain:bpi.ir",
            "domain:banksepah.ir",
            "domain:bsi.ir",
            "domain:tejaratbank.ir",
            "domain:parsian-bank.ir",
            "domain:sb24.ir",
            "domain:bankpasargad.com",
            "domain:bankmaskan.ir",
            "domain:bankshahr.com",
            "domain:enbank.ir",
            "domain:rb24.ir",
            "domain:eitaa.com",
            "domain:rubika.ir",
            "domain:messengerg2c4.iranlms.ir",
            "domain:bale.ai",
            "domain:mci.ir",
            "domain:irancell.ir",
            "domain:rightel.ir"
    };

    private V2rayConfigBuilder() {}

    public static String build(Context context, String shareUri, String dnsIp, String cleanIp, FragmentOptions fragment) throws Exception {
        return build(context, shareUri, dnsIp, cleanIp, fragment, false);
    }

    public static String build(Context context, String shareUri, String dnsIp, String cleanIp, FragmentOptions fragment, boolean strictDns) throws Exception {
        return build(context, null, new String[] {shareUri}, dnsIp, cleanIp, fragment, strictDns);
    }

    public static String build(Context context, String payloadJson, String[] shareUris, String dnsIp, String cleanIp, FragmentOptions fragment, boolean strictDns) throws Exception {
        List<ProfileBuildInput> inputs = buildInputs(payloadJson, shareUris, cleanIp, fragment);
        if (inputs.isEmpty()) {
            throw new IllegalArgumentException("Share link is required");
        }

        JSONObject config = new JSONObject(loadTemplate(context));
        JSONArray proxyOutbounds = new JSONArray();
        JSONArray proxyTags = new JSONArray();
        int skipped = 0;

        for (ProfileBuildInput input : inputs) {
            if (proxyOutbounds.length() >= 5) break;
            try {
                ProfileItem profile = parseAndValidate(input.shareUri, input.cleanIp);
                JSONObject proxyOutbound = V2rayOutboundBuilder.buildProxyOutbound(profile, input.fragment);
                String tag = proxyOutbounds.length() == 0 ? "proxy" : "proxy-" + (proxyOutbounds.length() + 1);
                proxyOutbound.put("tag", tag);
                proxyOutbounds.put(proxyOutbound);
                proxyTags.put(tag);
                Log.i(TAG, "Prepared outbound " + tag + " " + profile.configType + " -> " + profile.server + ":" + profile.serverPort);
            } catch (Exception e) {
                skipped++;
                if (inputs.size() == 1) throw e;
                Log.w(TAG, "Skipping invalid balanced outbound", e);
            }
        }

        if (proxyOutbounds.length() == 0) {
            throw new IllegalArgumentException("No valid VPN outbounds");
        }

        boolean fakeDns = false;
        boolean doh = false;
        if (payloadJson != null && !payloadJson.trim().isEmpty()) {
            try {
                JSONObject p = new JSONObject(payloadJson);
                fakeDns = p.optBoolean("fakeDns", false);
                doh = p.optBoolean("doh", false);
            } catch (Exception e) {
                Log.w(TAG, "Could not read fakeDns/doh flags", e);
            }
        }

        applyOutbounds(config, proxyOutbounds);
        applyDns(config, dnsIp, strictDns, doh);
        applyFakeDns(config, fakeDns);
        applyRouting(context, config, "tun", proxyTags);

        String result = config.toString();
        Log.i(TAG, "Built config with " + proxyOutbounds.length() + " outbound(s), skipped=" + skipped);
        return result;
    }

    public static String buildSpeedTest(Context context, String shareUri, String dnsIp, String cleanIp, FragmentOptions fragment, boolean strictDns, int socksPort) throws Exception {
        return buildSpeedTest(context, shareUri, dnsIp, cleanIp, fragment, strictDns, socksPort, false, false);
    }

    public static String buildSpeedTest(Context context, String shareUri, String dnsIp, String cleanIp, FragmentOptions fragment, boolean strictDns, int socksPort, boolean fakeDns, boolean doh) throws Exception {
        ProfileItem profile = parseAndValidate(shareUri, cleanIp);

        JSONObject config = new JSONObject(loadTemplate(context));
        JSONObject proxyOutbound = V2rayOutboundBuilder.buildProxyOutbound(profile, fragment);
        proxyOutbound.remove("mux");

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
        applyDns(config, dnsIp, strictDns, doh);
        applyFakeDns(config, fakeDns);
        applySpeedTestRouting(config);

        String result = config.toString();
        Log.i(TAG, "Built speed-test config " + profile.configType + " -> " + profile.server + ":" + profile.serverPort);
        return result;
    }

    private static List<ProfileBuildInput> buildInputs(String payloadJson, String[] shareUris, String cleanIp, FragmentOptions fragment) {
        List<ProfileBuildInput> inputs = new ArrayList<>();
        if (payloadJson != null && !payloadJson.trim().isEmpty()) {
            try {
                JSONObject payload = new JSONObject(payloadJson);
                JSONArray profiles = payload.optJSONArray("balancedProfiles");
                if (profiles != null) {
                    for (int i = 0; i < profiles.length() && inputs.size() < 5; i++) {
                        JSONObject item = profiles.optJSONObject(i);
                        if (item == null) continue;
                        String shareUri = item.optString("shareUri", "").trim();
                        if (shareUri.isEmpty()) continue;
                        inputs.add(new ProfileBuildInput(
                                shareUri,
                                item.optString("cleanIp", "").trim(),
                                parseFragment(item.optJSONObject("fragment"), fragment)
                        ));
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not parse balanced profile payload", e);
            }
        }

        if (inputs.isEmpty() && shareUris != null) {
            for (int i = 0; i < shareUris.length && inputs.size() < 5; i++) {
                String shareUri = shareUris[i] != null ? shareUris[i].trim() : "";
                if (shareUri.isEmpty()) continue;
                inputs.add(new ProfileBuildInput(
                        shareUri,
                        i == 0 ? cleanIp : null,
                        fragment
                ));
            }
        }
        return inputs;
    }

    private static ProfileItem parseAndValidate(String shareUri, String cleanIp) throws Exception {
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
        if (("vless".equals(profile.configType) || "trojan".equals(profile.configType))
                && (profile.security == null || profile.security.isEmpty() || "none".equalsIgnoreCase(profile.security))) {
            throw new IllegalArgumentException(profile.configType + " requires TLS or Reality encryption");
        }
        return profile;
    }

    private static FragmentOptions parseFragment(JSONObject fragmentObj, FragmentOptions fallback) {
        if (fragmentObj == null) return fallback;
        FragmentOptions fragment = new FragmentOptions();
        if (fallback != null) {
            fragment.enabled = fallback.enabled;
            fragment.packets = fallback.packets;
            fragment.length = fallback.length;
            fragment.interval = fallback.interval;
        }
        fragment.enabled = fragmentObj.optBoolean("enabled", fragment.enabled);
        fragment.packets = fragmentObj.optString("packets", fragment.packets);
        fragment.length = fragmentObj.optString("length", fragment.length);
        fragment.interval = fragmentObj.optString("interval", fragment.interval);
        return fragment;
    }

    private static void applyOutbounds(JSONObject config, JSONArray proxyOutbounds) throws Exception {
        JSONArray existing = config.getJSONArray("outbounds");
        JSONArray updated = new JSONArray();
        for (int i = 0; i < proxyOutbounds.length(); i++) {
            updated.put(proxyOutbounds.getJSONObject(i));
        }
        for (int i = 0; i < existing.length(); i++) {
            JSONObject outbound = existing.getJSONObject(i);
            String tag = outbound.optString("tag", "");
            if (!tag.startsWith("proxy")) {
                updated.put(outbound);
            }
        }
        config.put("outbounds", updated);
    }

    private static void applyDns(JSONObject config, String dnsIp, boolean strictDns, boolean doh) throws Exception {
        JSONObject dns = config.optJSONObject("dns");
        if (dns == null) {
            dns = new JSONObject();
            config.put("dns", dns);
        }
        JSONArray servers = new JSONArray();
        if (dnsIp != null && !dnsIp.isEmpty() && isIpAddress(dnsIp)) {
            servers.put(dnsIp);
        } else if (dnsIp != null && !dnsIp.isEmpty()) {
            Log.w(TAG, "Ignoring invalid DNS server IP: " + dnsIp);
        }
        if (!strictDns || servers.length() == 0) {
            if (doh) {
                // IP-based DoH endpoints (no bootstrap resolution needed). Plain-IP fallbacks are
                // kept after them so DNS still works if DoH is unreachable.
                servers.put("https://1.1.1.1/dns-query");
                servers.put("https://8.8.8.8/dns-query");
            }
            for (String server : DEFAULT_DNS_SERVERS) {
                if (!containsString(servers, server)) {
                    servers.put(server);
                }
            }
        }
        dns.put("servers", servers);
        dns.put("queryStrategy", "UseIPv4");
    }

    /**
     * Enable Xray FakeDNS: the resolver hands out fake IPs instantly and sniffing maps them back to
     * the domain, so routing decisions need no real DNS round-trip (faster connection setup). The
     * real resolution happens at the proxy server. Default off (opt-in) since it changes DNS behavior.
     */
    private static void applyFakeDns(JSONObject config, boolean fakeDns) throws Exception {
        if (!fakeDns) return;

        config.put("fakedns", new JSONArray().put(new JSONObject()
                .put("ipPool", "198.18.0.0/15")
                .put("poolSize", 32768)));

        JSONObject dns = config.optJSONObject("dns");
        if (dns == null) {
            dns = new JSONObject();
            config.put("dns", dns);
        }
        JSONArray existing = dns.optJSONArray("servers");
        JSONArray servers = new JSONArray().put("fakedns");
        if (existing != null) {
            for (int i = 0; i < existing.length(); i++) {
                servers.put(existing.get(i));
            }
        }
        dns.put("servers", servers);

        // Sniffing must surface the fake IP back to its domain on every inbound.
        JSONArray inbounds = config.optJSONArray("inbounds");
        if (inbounds != null) {
            for (int i = 0; i < inbounds.length(); i++) {
                JSONObject inbound = inbounds.optJSONObject(i);
                if (inbound == null) continue;
                JSONObject sniffing = inbound.optJSONObject("sniffing");
                if (sniffing == null) {
                    sniffing = new JSONObject().put("enabled", true);
                    inbound.put("sniffing", sniffing);
                }
                JSONArray dest = sniffing.optJSONArray("destOverride");
                if (dest == null) dest = new JSONArray();
                boolean hasFake = false;
                for (int j = 0; j < dest.length(); j++) {
                    if ("fakedns".equals(dest.optString(j))) { hasFake = true; break; }
                }
                if (!hasFake) dest.put("fakedns");
                sniffing.put("destOverride", dest);
                sniffing.put("enabled", true);
            }
        }
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

    private static void applySpeedTestRouting(JSONObject config) throws Exception {
        JSONObject routing = config.getJSONObject("routing");
        routing.put("domainStrategy", "AsIs");
        routing.remove("balancers");
        routing.put("rules", new JSONArray().put(new JSONObject()
                .put("type", "field")
                .put("inboundTag", new JSONArray().put("speedtest"))
                .put("network", "tcp,udp")
                .put("outboundTag", "proxy")));
    }

    private static void applyRouting(Context context, JSONObject config, String inboundTag, JSONArray proxyTags) throws Exception {
        JSONObject routing = config.getJSONObject("routing");
        routing.put("domainStrategy", "IPIfNonMatch");
        if (proxyTags.length() > 1) {
            routing.put("balancers", new JSONArray().put(new JSONObject()
                    .put("tag", "best5")
                    .put("selector", proxyTags)
                    .put("strategy", new JSONObject()
                            .put("type", "leastPing"))));
        } else {
            routing.remove("balancers");
        }
        JSONArray rules = new JSONArray();

        // 1) QUIC over a TCP-backed proxy can stall before the app retries HTTP/2.
        // Route UDP/443 to the local block outbound so that fallback happens promptly.
        rules.put(new JSONObject()
                .put("type", "field")
                .put("inboundTag", buildRoutingInboundTags(inboundTag))
                .put("network", "udp")
                .put("port", 443)
                .put("outboundTag", "block"));

        // 2) Private / loopback ranges -> direct.
        rules.put(new JSONObject()
                .put("type", "field")
                .put("inboundTag", buildRoutingInboundTags(inboundTag))
                .put("ip", buildPrivateCidrs())
                .put("outboundTag", "direct"));

        // 3) Iranian domains -> direct (curated list + geosite radix tree).
        rules.put(new JSONObject()
                .put("type", "field")
                .put("inboundTag", buildRoutingInboundTags(inboundTag))
                .put("domain", buildIranDirectDomains())
                .put("outboundTag", "direct"));

        // 4) Iranian IP ranges + domestic CDNs -> direct. Beyond geoip:ir, this routes the big
        //    Iranian hosting/CDN providers (ArvanCloud, Derak, IranServer, ParsPack) directly:
        //    most Iranian sites sit behind these, and their ranges are NOT inside geoip:ir, so
        //    without this their traffic would wrongly go through the proxy (slow, and some
        //    Iran-only sites block foreign IPs). Requires the Chocolate4U geo databases.
        rules.put(new JSONObject()
                .put("type", "field")
                .put("inboundTag", buildRoutingInboundTags(inboundTag))
                .put("ip", new JSONArray()
                        .put("geoip:ir")
                        .put("geoip:arvancloud")
                        .put("geoip:derakcloud")
                        .put("geoip:iranserver")
                        .put("geoip:parspack"))
                .put("outboundTag", "direct"));

        // 5) Everything else -> proxy / balancer.
        JSONObject proxyRule = new JSONObject()
                .put("type", "field")
                .put("inboundTag", buildRoutingInboundTags(inboundTag))
                .put("network", "tcp,udp");
        if (proxyTags.length() > 1) {
            proxyRule.put("balancerTag", "best5");
        } else {
            proxyRule.put("outboundTag", "proxy");
        }
        rules.put(proxyRule);

        routing.put("rules", rules);
    }

    private static JSONArray buildRoutingInboundTags(String inboundTag) {
        JSONArray tags = new JSONArray().put(inboundTag);
        // The main VPN config also exposes a local SOCKS inbound for health/IP
        // checks. Route it explicitly instead of relying on Xray's fallback.
        if ("tun".equals(inboundTag)) tags.put("socks");
        return tags;
    }

    private static JSONArray buildPrivateCidrs() {
        JSONArray cidrs = new JSONArray();
        for (String cidr : PRIVATE_CIDRS) {
            cidrs.put(cidr);
        }
        return cidrs;
    }

    private static JSONArray buildIranDirectDomains() {
        JSONArray domains = new JSONArray();
        for (String domain : IRAN_DIRECT_DOMAINS) {
            domains.put(domain);
        }
        // Broad coverage for Iranian sites via the bundled Chocolate4U geosite database.
        // geosite:ir is the comprehensive Iran domain set (category-ir is a subset).
        domains.put("geosite:ir");
        return domains;
    }

    private static boolean containsString(JSONArray array, String value) {
        if (array == null || value == null) return false;
        for (int i = 0; i < array.length(); i++) {
            if (value.equals(array.optString(i))) return true;
        }
        return false;
    }

    private static boolean isIpAddress(String value) {
        if (value == null || value.trim().isEmpty()) return false;
        String v = value.trim();
        try {
            java.net.InetAddress parsed = java.net.InetAddress.getByName(v);
            return v.equals(parsed.getHostAddress()) || v.contains(":");
        } catch (Exception e) {
            return false;
        }
    }

    private static volatile String templateCache;

    private static String loadTemplate(Context context) throws Exception {
        String cached = templateCache;
        if (cached != null) return cached;
        try (InputStream in = context.getAssets().open("v2ray_config_with_tun.json");
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            String template = sb.toString();
            templateCache = template;
            return template;
        }
    }

    private static final class ProfileBuildInput {
        final String shareUri;
        final String cleanIp;
        final FragmentOptions fragment;

        ProfileBuildInput(String shareUri, String cleanIp, FragmentOptions fragment) {
            this.shareUri = shareUri;
            this.cleanIp = cleanIp;
            this.fragment = fragment;
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

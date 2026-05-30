package com.mir2ray.app;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Builds Xray outbound JSON from a parsed profile (v2rayNG-compatible).
 */
public final class V2rayOutboundBuilder {
    private V2rayOutboundBuilder() {}

    public static JSONObject buildProxyOutbound(ProfileItem profile, FragmentOptions fragment) throws Exception {
        JSONObject outbound;
        switch (profile.configType) {
            case "vless":
                outbound = buildVless(profile);
                break;
            case "vmess":
                outbound = buildVmess(profile);
                break;
            case "trojan":
                outbound = buildTrojan(profile);
                break;
            case "shadowsocks":
                outbound = buildShadowsocks(profile);
                break;
            default:
                throw new IllegalArgumentException("Unsupported protocol: " + profile.configType);
        }
        outbound.put("tag", "proxy");
        outbound.put("mux", new JSONObject().put("enabled", false));
        applyFragment(outbound, profile, fragment);
        return outbound;
    }

    private static JSONObject buildVless(ProfileItem p) throws Exception {
        JSONObject user = new JSONObject()
                .put("id", p.password)
                .put("encryption", p.method != null ? p.method : "none")
                .put("level", 8);
        if (p.flow != null && !p.flow.isEmpty()) {
            user.put("flow", p.flow);
        }

        JSONObject vnext = new JSONObject()
                .put("address", p.server)
                .put("port", Integer.parseInt(p.serverPort))
                .put("users", new JSONArray().put(user));

        JSONObject outbound = new JSONObject()
                .put("protocol", "vless")
                .put("settings", new JSONObject().put("vnext", new JSONArray().put(vnext)))
                .put("streamSettings", new JSONObject());

        populateTransport(outbound.getJSONObject("streamSettings"), p);
        populateTls(outbound.getJSONObject("streamSettings"), p);
        return outbound;
    }

    private static JSONObject buildVmess(ProfileItem p) throws Exception {
        JSONObject user = new JSONObject()
                .put("id", p.password)
                .put("alterId", 0)
                .put("security", p.method != null && !p.method.isEmpty() ? p.method : "auto")
                .put("level", 8);

        JSONObject vnext = new JSONObject()
                .put("address", p.server)
                .put("port", Integer.parseInt(p.serverPort))
                .put("users", new JSONArray().put(user));

        JSONObject outbound = new JSONObject()
                .put("protocol", "vmess")
                .put("settings", new JSONObject().put("vnext", new JSONArray().put(vnext)))
                .put("streamSettings", new JSONObject());

        populateTransport(outbound.getJSONObject("streamSettings"), p);
        populateTls(outbound.getJSONObject("streamSettings"), p);
        return outbound;
    }

    private static JSONObject buildShadowsocks(ProfileItem p) throws Exception {
        JSONObject server = new JSONObject()
                .put("address", p.server)
                .put("port", Integer.parseInt(p.serverPort))
                .put("password", p.password)
                .put("method", p.method != null ? p.method : "aes-256-gcm")
                .put("level", 8);

        return new JSONObject()
                .put("protocol", "shadowsocks")
                .put("settings", new JSONObject().put("servers", new JSONArray().put(server)))
                .put("streamSettings", new JSONObject().put("network", "tcp"));
    }

    private static JSONObject buildTrojan(ProfileItem p) throws Exception {
        JSONObject server = new JSONObject()
                .put("address", p.server)
                .put("port", Integer.parseInt(p.serverPort))
                .put("password", p.password)
                .put("level", 8);

        JSONObject outbound = new JSONObject()
                .put("protocol", "trojan")
                .put("settings", new JSONObject().put("servers", new JSONArray().put(server)))
                .put("streamSettings", new JSONObject());

        populateTransport(outbound.getJSONObject("streamSettings"), p);
        populateTls(outbound.getJSONObject("streamSettings"), p);
        return outbound;
    }

    private static void populateTransport(JSONObject stream, ProfileItem p) throws Exception {
        String network = p.network != null && !p.network.isEmpty() ? p.network : "tcp";
        stream.put("network", network);

        switch (network) {
            case "ws":
                stream.put("wsSettings", new JSONObject()
                        .put("path", emptyOr(p.path, "/"))
                        .put("host", emptyOr(p.host, "")));
                break;
            case "grpc":
                stream.put("grpcSettings", new JSONObject()
                        .put("serviceName", emptyOr(p.serviceName, ""))
                        .put("multiMode", "multi".equals(p.mode))
                        .put("authority", emptyOr(p.authority, "")));
                break;
            case "httpupgrade":
                stream.put("httpupgradeSettings", new JSONObject()
                        .put("path", emptyOr(p.path, "/"))
                        .put("host", emptyOr(p.host, "")));
                break;
            case "xhttp":
                stream.put("xhttpSettings", new JSONObject()
                        .put("path", emptyOr(p.path, "/"))
                        .put("host", emptyOr(p.host, ""))
                        .put("mode", emptyOr(p.xhttpMode, "auto")));
                break;
            case "h2":
            case "http":
                stream.put("network", "h2");
                JSONArray hosts = new JSONArray();
                if (p.host != null && !p.host.isEmpty()) {
                    for (String h : p.host.split(",")) {
                        if (!h.trim().isEmpty()) hosts.put(h.trim());
                    }
                }
                stream.put("httpSettings", new JSONObject()
                        .put("host", hosts)
                        .put("path", emptyOr(p.path, "/")));
                break;
            case "tcp":
            default:
                JSONObject tcp = new JSONObject();
                JSONObject header = new JSONObject();
                if ("http".equals(p.headerType)) {
                    header.put("type", "http");
                    JSONObject request = new JSONObject();
                    JSONArray hostArr = new JSONArray();
                    if (p.host != null && !p.host.isEmpty()) {
                        hostArr.put(p.host.split(",")[0].trim());
                    }
                    request.put("headers", new JSONObject().put("Host", hostArr));
                    JSONArray pathArr = new JSONArray();
                    pathArr.put(emptyOr(p.path, "/"));
                    request.put("path", pathArr);
                    header.put("request", request);
                } else {
                    header.put("type", "none");
                }
                tcp.put("header", header);
                stream.put("tcpSettings", tcp);
                break;
        }
    }

    private static void populateTls(JSONObject stream, ProfileItem p) throws Exception {
        if (p.security == null || p.security.isEmpty()) return;
        stream.put("security", p.security);

        String sni = p.sni;
        if (sni == null || sni.isEmpty()) {
            if (p.host != null && looksLikeDomain(p.host.split(",")[0])) {
                sni = p.host.split(",")[0].trim();
            } else if (looksLikeDomain(p.server)) {
                sni = p.server;
            }
        }

        JSONObject tls = new JSONObject()
                .put("allowInsecure", p.insecure)
                .put("serverName", sni != null ? sni : "");

        if (p.fingerPrint != null && !p.fingerPrint.isEmpty()) {
            tls.put("fingerprint", p.fingerPrint);
        }
        if (p.alpn != null && !p.alpn.isEmpty()) {
            JSONArray alpn = new JSONArray();
            for (String part : p.alpn.split(",")) {
                if (!part.trim().isEmpty()) alpn.put(part.trim());
            }
            if (alpn.length() > 0) tls.put("alpn", alpn);
        }
        if (p.publicKey != null && !p.publicKey.isEmpty()) tls.put("publicKey", p.publicKey);
        if (p.shortId != null && !p.shortId.isEmpty()) tls.put("shortId", p.shortId);
        if (p.spiderX != null && !p.spiderX.isEmpty()) tls.put("spiderX", p.spiderX);

        if ("reality".equals(p.security)) {
            stream.put("realitySettings", tls);
        } else {
            stream.put("tlsSettings", tls);
        }
    }

    private static void applyFragment(JSONObject outbound, ProfileItem profile, FragmentOptions fragment) throws Exception {
        if (fragment == null || !fragment.enabled) return;
        if (profile.security == null) return;
        if (!"tls".equals(profile.security) && !"reality".equals(profile.security)) return;

        JSONObject stream = outbound.getJSONObject("streamSettings");
        String packets = fragment.packets != null ? fragment.packets : "10-20";
        if ("reality".equals(profile.security) && "tlshello".equals(packets)) {
            packets = "1-3";
        } else if ("tls".equals(profile.security) && !"tlshello".equals(packets)) {
            packets = "tlshello";
        }

        JSONObject fragmentMask = new JSONObject()
                .put("type", "fragment")
                .put("settings", new JSONObject()
                        .put("packets", packets)
                        .put("length", fragment.length != null ? fragment.length : "100-200")
                        .put("delay", fragment.interval != null ? fragment.interval : "10-20"));

        JSONObject noiseMask = new JSONObject()
                .put("type", "noise")
                .put("settings", new JSONObject()
                        .put("noise", new JSONArray().put(new JSONObject()
                                .put("rand", "10-20")
                                .put("delay", "10-16"))));

        JSONObject finalMask = new JSONObject()
                .put("tcp", new JSONArray().put(fragmentMask))
                .put("udp", new JSONArray().put(noiseMask));
        stream.put("finalmask", finalMask);
    }

    private static String emptyOr(String value, String fallback) {
        return value != null && !value.isEmpty() ? value : fallback;
    }

    private static boolean looksLikeDomain(String value) {
        if (value == null || value.isEmpty()) return false;
        return value.matches("^[a-zA-Z0-9.-]+$") && !value.matches("^\\d+\\.\\d+\\.\\d+\\.\\d+$");
    }
}

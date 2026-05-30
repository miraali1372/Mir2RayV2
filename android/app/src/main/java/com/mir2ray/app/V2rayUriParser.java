package com.mir2ray.app;

import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Parses v2rayNG-compatible share links (vless://, vmess://, trojan://).
 */
public final class V2rayUriParser {
    private static final String TAG = "V2rayUriParser";

    private V2rayUriParser() {}

    public static ProfileItem parse(String rawUri) {
        if (rawUri == null) return null;
        String uri = rawUri.trim();
        if (uri.isEmpty()) return null;

        try {
            if (uri.startsWith("vless://")) return parseVless(uri);
            if (uri.startsWith("vmess://")) return parseVmess(uri);
            if (uri.startsWith("trojan://")) return parseTrojan(uri);
            if (uri.startsWith("ss://")) return parseShadowsocks(uri);
            if (uri.startsWith("hy2://") || uri.startsWith("hysteria2://")) return parseHysteria2(uri);
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse URI", e);
        }
        return null;
    }

    private static ProfileItem parseVless(String uri) {
        Uri parsed = Uri.parse(fixIllegalUrl(uri));
        if (parsed.getHost() == null || parsed.getPort() <= 0) return null;
        Map<String, String> query = parseQuery(parsed);

        ProfileItem item = new ProfileItem();
        item.configType = "vless";
        item.remarks = decodeFragment(parsed.getFragment());
        item.server = parsed.getHost();
        item.serverPort = String.valueOf(parsed.getPort());
        item.password = parsed.getUserInfo();
        item.method = query.getOrDefault("encryption", "none");
        applyQuery(item, query, false);
        return item;
    }

    private static ProfileItem parseShadowsocks(String uri) throws Exception {
        String payload = uri.substring(5);
        String name = "";
        int hash = payload.indexOf('#');
        if (hash >= 0) {
            name = decodeFragment(payload.substring(hash + 1));
            payload = payload.substring(0, hash);
        }

        ProfileItem item = new ProfileItem();
        item.configType = "shadowsocks";
        item.remarks = name.isEmpty() ? "Shadowsocks" : name;

        if (payload.contains("@")) {
            Uri parsed = Uri.parse(fixIllegalUrl("ss://" + payload));
            String userInfo = parsed.getUserInfo();
            if (userInfo != null && userInfo.contains(":")) {
                String[] parts = userInfo.split(":", 2);
                item.method = parts[0];
                item.password = parts[1];
            } else {
                item.password = userInfo;
                item.method = "aes-256-gcm";
            }
            item.server = parsed.getHost();
            item.serverPort = String.valueOf(parsed.getPort());
            Map<String, String> query = parseQuery(parsed);
            applyQuery(item, query, false);
            return item;
        }

        String decoded = new String(Base64.decode(payload, Base64.DEFAULT), StandardCharsets.UTF_8);
        String body = decoded.contains("@") ? decoded : "ss://" + decoded;
        Uri parsed = Uri.parse(fixIllegalUrl(body.startsWith("ss://") ? body : "ss://" + body));
        String userInfo = parsed.getUserInfo();
        if (userInfo != null && userInfo.contains(":")) {
            String[] parts = userInfo.split(":", 2);
            item.method = parts[0];
            item.password = parts[1];
        }
        item.server = parsed.getHost();
        item.serverPort = String.valueOf(parsed.getPort());
        return item;
    }

    private static ProfileItem parseHysteria2(String uri) {
        Uri parsed = Uri.parse(fixIllegalUrl(uri.replace("hysteria2://", "hy2://")));
        ProfileItem item = new ProfileItem();
        item.configType = "hysteria2";
        item.remarks = decodeFragment(parsed.getFragment());
        item.server = parsed.getHost();
        item.serverPort = String.valueOf(parsed.getPort());
        item.password = parsed.getUserInfo();
        Map<String, String> query = parseQuery(parsed);
        item.security = query.getOrDefault("security", "tls");
        item.sni = query.get("sni");
        item.insecure = "1".equals(query.get("insecure"));
        return item;
    }

    private static ProfileItem parseTrojan(String uri) {
        Uri parsed = Uri.parse(fixIllegalUrl(uri));
        if (parsed.getHost() == null || parsed.getPort() <= 0) return null;
        Map<String, String> query = parseQuery(parsed);

        ProfileItem item = new ProfileItem();
        item.configType = "trojan";
        item.remarks = decodeFragment(parsed.getFragment());
        item.server = parsed.getHost();
        item.serverPort = String.valueOf(parsed.getPort());
        item.password = parsed.getUserInfo();
        if (query.isEmpty()) {
            item.network = "tcp";
            item.security = "tls";
            item.insecure = false;
        } else {
            applyQuery(item, query, false);
            item.security = query.getOrDefault("security", "tls");
        }
        return item;
    }

    private static ProfileItem parseVmess(String uri) throws Exception {
        String payload = uri.substring("vmess://".length());
        if (payload.contains("?") && payload.contains("&")) {
            return parseVmessStd(uri);
        }
        String decoded = new String(Base64.decode(payload, Base64.DEFAULT), StandardCharsets.UTF_8);
        JSONObject json = new JSONObject(decoded);
        ProfileItem item = new ProfileItem();
        item.configType = "vmess";
        item.remarks = json.optString("ps", "VMess");
        item.server = json.optString("add", "");
        item.serverPort = json.optString("port", "");
        item.password = json.optString("id", "");
        item.method = json.optString("scy", "auto");
        item.network = json.optString("net", "tcp");
        item.headerType = json.optString("type", "");
        item.host = json.optString("host", "");
        item.path = json.optString("path", "");
        item.security = json.optString("tls", "");
        item.sni = json.optString("sni", "");
        item.fingerPrint = json.optString("fp", "");
        item.alpn = json.optString("alpn", "");
        item.insecure = "1".equals(json.optString("insecure", ""));
        if ("kcp".equals(item.network)) {
            item.seed = item.path;
        } else if ("grpc".equals(item.network)) {
            item.mode = item.headerType;
            item.serviceName = item.path;
            item.authority = item.host;
        }
        return item;
    }

    private static ProfileItem parseVmessStd(String uri) throws Exception {
        Uri parsed = Uri.parse(fixIllegalUrl(uri));
        if (parsed.getHost() == null || parsed.getPort() <= 0) return null;
        Map<String, String> query = parseQuery(parsed);

        ProfileItem item = new ProfileItem();
        item.configType = "vmess";
        item.remarks = decodeFragment(parsed.getFragment());
        item.server = parsed.getHost();
        item.serverPort = String.valueOf(parsed.getPort());
        item.password = parsed.getUserInfo();
        item.method = "auto";
        applyQuery(item, query, false);
        return item;
    }

    private static void applyQuery(ProfileItem item, Map<String, String> query, boolean defaultInsecure) {
        item.network = query.getOrDefault("type", "tcp");
        item.headerType = query.get("headerType");
        item.host = query.get("host");
        item.path = query.get("path");
        item.seed = query.get("seed");
        item.mode = query.get("mode");
        item.serviceName = query.get("serviceName");
        item.authority = query.get("authority");
        item.xhttpMode = query.get("mode");
        item.xhttpExtra = query.get("extra");

        item.security = query.get("security");
        if (item.security != null && !item.security.equals("tls") && !item.security.equals("reality")) {
            item.security = null;
        }

        if ("1".equals(query.get("insecure")) || "1".equals(query.get("allowInsecure")) || "1".equals(query.get("allow_insecure"))) {
            item.insecure = true;
        } else if ("0".equals(query.get("insecure")) || "0".equals(query.get("allowInsecure")) || "0".equals(query.get("allow_insecure"))) {
            item.insecure = false;
        } else {
            item.insecure = defaultInsecure;
        }

        item.sni = query.get("sni");
        item.fingerPrint = query.get("fp");
        item.alpn = query.get("alpn");
        item.publicKey = query.get("pbk");
        item.shortId = query.get("sid");
        item.spiderX = query.get("spx");
        item.flow = query.get("flow");
    }

    private static Map<String, String> parseQuery(Uri uri) {
        Map<String, String> map = new HashMap<>();
        String raw = uri.getEncodedQuery();
        if (raw == null || raw.isEmpty()) return map;
        for (String part : raw.split("&")) {
            int idx = part.indexOf('=');
            if (idx > 0) {
                String key = URLDecoder.decode(part.substring(0, idx), StandardCharsets.UTF_8);
                String value = URLDecoder.decode(part.substring(idx + 1), StandardCharsets.UTF_8);
                map.put(key, value);
            } else if (!part.isEmpty()) {
                map.put(URLDecoder.decode(part, StandardCharsets.UTF_8), "");
            }
        }
        return map;
    }

    private static String decodeFragment(String fragment) {
        if (fragment == null || fragment.isEmpty()) return "Mir2rayV2";
        return URLDecoder.decode(fragment, StandardCharsets.UTF_8);
    }

    private static String fixIllegalUrl(String url) {
        return url.replace(" ", "%20");
    }
}

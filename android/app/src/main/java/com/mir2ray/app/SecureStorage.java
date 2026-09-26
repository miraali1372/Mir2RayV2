package com.mir2ray.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

public class SecureStorage {
    private static final String TAG = "SecureStorage";
    private static final String PREF_FILE = "mir2ray_secure_prefs";
    private static final String KEY_ALIAS = "mir2ray_secure_storage";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String LEGACY_PREF_FILE = "mir2ray_legacy_prefs";
    private static final Object KEY_LOCK = new Object();
    private static volatile SecretKey cachedKey;

    private SharedPreferences prefs;

    public SecureStorage(Context context) {
        try {
            prefs = context.getApplicationContext().getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE);
        } catch (Exception e) {
            Log.e(TAG, "Secure storage init failed; using private app storage fallback", e);
            prefs = context.getApplicationContext().getSharedPreferences(LEGACY_PREF_FILE, Context.MODE_PRIVATE);
            return;
        }
    }

    public void putString(String key, String value) {
        try {
            prefs.edit().putString(key, encrypt(value)).apply();
        } catch (Exception e) {
            Log.e(TAG, "putString failed", e);
            throw new RuntimeException(e);
        }
    }

    public String getString(String key) {
        try {
            String stored = prefs.getString(key, null);
            if (stored == null) return null;
            return decrypt(stored);
        } catch (Exception e) {
            Log.e(TAG, "getString failed", e);
            return null;
        }
    }

    public void remove(String key) {
        try {
            prefs.edit().remove(key).apply();
        } catch (Exception e) {
            Log.e(TAG, "remove failed", e);
            throw new RuntimeException(e);
        }
    }

    private SecretKey getOrCreateKey() throws Exception {
        SecretKey key = cachedKey;
        if (key != null) return key;
        synchronized (KEY_LOCK) {
            key = cachedKey;
            if (key != null) return key;

            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                key = ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            } else {
                KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true)
                        .setUserAuthenticationRequired(false);
                keyGenerator.init(builder.build());
                key = keyGenerator.generateKey();
            }
            cachedKey = key;
            return key;
        }
    }

    private String encrypt(String plainText) throws Exception {
        if (plainText == null) return null;
        SecretKey secretKey = getOrCreateKey();
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        // The key is created with setRandomizedEncryptionRequired(true), so a caller-provided IV is
        // rejected on modern keystore (keystore2 / Android 12+). Let the keystore generate the IV
        // and read it back instead.
        cipher.init(Cipher.ENCRYPT_MODE, secretKey);
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(plainText.getBytes(StandardCharsets.UTF_8));
        byte[] payload = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, payload, 0, iv.length);
        System.arraycopy(encrypted, 0, payload, iv.length, encrypted.length);
        return Base64.encodeToString(payload, Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        byte[] payload = Base64.decode(encoded, Base64.NO_WRAP);
        if (payload.length <= 12) {
            throw new IllegalArgumentException("Encrypted value is truncated");
        }
        byte[] iv = new byte[12];
        byte[] encrypted = new byte[payload.length - 12];
        System.arraycopy(payload, 0, iv, 0, 12);
        System.arraycopy(payload, 12, encrypted, 0, encrypted.length);
        SecretKey secretKey = getOrCreateKey();
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }
}

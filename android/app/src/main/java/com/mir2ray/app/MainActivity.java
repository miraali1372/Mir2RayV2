package com.mir2ray.app;

import android.os.Bundle;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;

import java.util.concurrent.atomic.AtomicBoolean;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final AtomicBoolean CRASH_LOGGER_INSTALLED = new AtomicBoolean(false);
    private static final AtomicBoolean CORE_PREWARM_STARTED = new AtomicBoolean(false);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        installCrashLogger(getApplicationContext());
        registerPlugin(XrayPlugin.class);
        super.onCreate(savedInstanceState);
        applySystemBarTheme();

        // Loading libv2ray and preparing its 25+ MB routing databases can take several seconds on
        // first run. Pre-warm it without blocking Activity launch; startVpn() is synchronized with
        // this initialization and will wait if the user connects before pre-warm completes.
        // A gomobile call may keep its originating native thread attached for the lifetime of the
        // process. Activity recreation must therefore never create another pre-warm thread.
        if (CORE_PREWARM_STARTED.compareAndSet(false, true)) {
            final android.content.Context appContext = getApplicationContext();
            Thread prewarm = new Thread(() -> {
                try {
                    XrayCoreManager.init(appContext);
                } catch (Throwable e) {
                    android.util.Log.e("MainActivity", "Xray pre-init failed (will retry on connect)", e);
                }
            }, "Xray-Core-Prewarm");
            prewarm.start();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        applySystemBarTheme();
    }

    private void applySystemBarTheme() {
        applySystemBarThemeNow();
        View decor = getWindow().getDecorView();
        decor.postDelayed(this::applySystemBarThemeNow, 80);
        decor.postDelayed(this::applySystemBarThemeNow, 400);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applySystemBarTheme();
        }
    }

    private void applySystemBarThemeNow() {
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#09090B"));
        window.setNavigationBarColor(Color.parseColor("#09090B"));

        int flags = window.getDecorView().getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        window.getDecorView().setSystemUiVisibility(flags);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                        0,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            }
        }
    }

    /**
     * Persist the full stack of any fatal (process-wide) crash to the in-app log before the app dies,
     * so users whose device crashes on connect can send a diagnosable log. Chains to the default
     * handler so normal crash reporting still happens.
     */
    static void installCrashLogger(final android.content.Context context) {
        if (!CRASH_LOGGER_INSTALLED.compareAndSet(false, true)) return;
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            try {
                LogCollector.append(context, "FATAL CRASH on thread '" + thread.getName() + "':\n"
                        + android.util.Log.getStackTraceString(throwable));
            } catch (Throwable ignore) {
                // never let the crash logger itself mask the original crash
            }
            if (previous != null) previous.uncaughtException(thread, throwable);
        });
    }
}

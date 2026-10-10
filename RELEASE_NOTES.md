# Mir2rayV2

## v1.0.9
- رفع قطعی حذف کانفیگ‌های دارای TCP timeout/error/latency نامعتبر در مسیر دریافت و پینگ همه.
- حذف کانفیگ‌های دارای Real Ping/Real Delay timeout/error/latency نامعتبر از state، storage و خروجی نهایی همان تست.
- جلوگیری از بازگردانی state قدیمی با صف‌کردن ذخیره‌سازی کانفیگ‌ها.
- اجرای Windows Portable با درخواست دسترسی Administrator از manifest/electron-builder.

## v1.0.8
- Real Layer 7 Google AI Studio verification (`https://generativelanguage.googleapis.com/v1beta/models`) replacing fake 204 endpoint checks.
- Fail-closed country policy: configs with Iranian or restricted exit IPs strictly prevented from receiving AI Studio eligibility or top rankings.
- MTU harmonized across all layers (Windows TUN, Android VPN service, Xray runtime) to 1280 (with 1360 adaptive candidate) eliminating IP fragmentation.
- Dedicated UDP/53 routing to internal DNS layer (`dns-out`), resolving packet loss and DNS bottlenecks.
- Optimized QUIC / UDP:443 management with blackhole `none` response for instantaneous browser fallback to HTTP/2 over TCP.
- Stricter quality evaluation penalizing high jitter (>250ms/500ms), packet loss, and throttled bandwidth (<100 kbps).

## Previous Features
- VPN connection based on Xray
- Config test with adjustable worker count
- Longer timeout for unstable networks
- Config sorting by latency and download speed
- Top 20 config download test
- Current public IP and DNS display on the home screen
- DNS tools and live traffic stats
- Home-screen update button connected to GitHub Releases
- GitHub release fallback updater when the API is rate limited
- Android APK released as a GitHub asset

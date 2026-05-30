# Mir2rayV2

Mobile VPN client built on Xray for Android.

## Active features

- VPN connection through Xray
- Config testing with adjustable worker count
- Longer timeout for unstable networks
- Sorting configs by test result
- Current public IP and DNS shown on the home screen
- DNS tools and live traffic stats
- Bottom update button wired to GitHub Releases

## Release flow

- Android release APK is published as a GitHub release asset only
- Latest APK: https://github.com/miraali1372/Mir2RayV2/releases/latest
- APK name follows `Mir2rayV2-vX.Y.Z.apk`
- Release notes are read from `RELEASE_NOTES.md`

## Build

```bash
npm install
npm run build:android
cd android
./gradlew assembleRelease
```

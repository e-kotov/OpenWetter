# OpenWetter v0.1.0-alpha.2 — Android layout fix and observed map overlays

This is an experimental **debug-signed** Android APK for Android 8.0 or newer (API 26+). It is not a production release.

## Fixes and changes
- Fixed header buttons obscured by Android status-bar icons on Android 15+ / targetSdk 35 using dynamic status, navigation, cutout and keyboard insets.
- Improved narrow-screen header so forecast/compare and settings buttons do not crowd the app title.
- New independent **☔ Rain radar** switch overlays the most recently available RainViewer radar observation.
- New **☁ Satellite clouds** switch overlays DWD Meteosat cloud imagery (WMS); adjustable opacity.
- Radar history remains a separate selectable playback timeline.
- Added unit and mocked mobile-browser checks for overlays, DWD WMS URL construction, and narrow-screen layouts.

**The new map overlays are observations, not ICON forecast rain/cloud fields.** They do not follow the chosen future forecast hour. A true animated ICON gridded weather map is still unimplemented.

## Installation and limits
- Download `OpenWetter-v0.1.0-alpha.2-debug.apk` below.
- This APK uses a GitHub-runner temporary debug-signing key. **Uninstall the previous preview before installing** if Android rejects the update due to a different signature. Uninstalling clears local app settings.
- Live map imagery needs network access and depends on external data services. Some layers may be temporarily unavailable; the DWD cloud layer has not been tested against the live service on-device.
- The WebView layout has been updated and Android compilation/automated browser tests run in CI; physical-device verification is still needed.
- `SHA256SUMS.txt` contains the expected file checksum.

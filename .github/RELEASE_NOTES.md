# OpenWetter v0.1.0-alpha.1 — Android preview

This is an **early experimental preview** of OpenWetter. Download the attached **OpenWetter-v0.1.0-alpha.1-debug.apk** to install it on Android 8.0+ (API 26+). This APK is **debug-signed**, not a production-signed release.

Features included:
- DWD ICON-D2, ICON-EU and ICON global point forecasts using Open-Meteo
- Model comparisons, weather charts, selected-location search and saved settings
- Historical precipitation radar layers and configurable time scrubbing
- Bundled web interface in an Android WebView shell

Limitations:
- No animated, gridded forecast maps yet; the map does not display forecast model raster fields.
- Internet is required for live forecasts, map tiles, geocoding and radar data.
- Browser interface tests use mocked network data. The APK builds on GitHub Actions but **has not been tested on a physical Android device**.
- This build uses a temporary Android debug-signing key; future builds may require removing this preview before installing a newer one.

GitHub Actions runs JavaScript/browser tests and builds the APK before publication. The attached `SHA256SUMS.txt` provides the APK hash for integrity checks.

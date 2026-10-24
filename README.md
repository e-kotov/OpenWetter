# OpenWetter — DWD weather and radar prototype

A small, independently implemented open-source weather explorer for private, non-commercial use.

**Status:** A *tested browser/PWA prototype*, **not** a finished weather application. The native Android wrapper has source code but has **not** been compiled or exercised with an Android device. See the test section.

## Interface scope

The interface places compact weather forecasts and a graph above the map, using independently implemented gestures and styling. It currently provides one switchable chart instead of a full stack of independently editable graphs, and it does not yet render gridded forecast maps.

## Working features

- DWD **ICON-D2**, **ICON-EU**, and **ICON Global** point forecasts via the **Open-Meteo DWD API**.
- Graphs: temperature, hourly precipitation, wind speed, cloud cover; tap or drag to select hour; detailed selected values.
- Map with OpenStreetMap tiles; tap to select forecast point, mouse drag to pan, wheel/buttons to zoom; touch: 1 finger scrubs weather time, 2 fingers pan and pinch zoom.
- RainViewer **observed radar frames**, an independent historical timeline; translucent overlay and opacity setting.
- City search using Open-Meteo geocoding, geolocation (with permission), saved preferences and last successful forecast, play/pause timeline.
- Offline-cached static shell (PWA), not offline weather; no API keys or accounts required for personal use.

**Important limitations:** The forecast-mode map is a basemap and forecast location marker, **not a gridded forecast animation**; no raw DWD ICON GRIB2 processing or direct DWD radar ingestion yet. RainViewer offers past observations only, at a maximum raster tile zoom of 7 and may rate-limit or have incomplete coverage. Forecast graph and historical radar use **separate time axes**. The web UI and chart code is implemented, but production-grade network behaviour and Android integration need device verification.

## Run the prototype

From the repository root:

```sh
python3 -m http.server 8000 --directory web
# Open http://localhost:8000 on your computer
```

You need **internet access in the browser** to get forecasts, OSM tiles, radar, and geocoding. Localhost is treated as a secure origin for browser geolocation and installing a PWA. To try it on a phone on your own LAN, host the web app over **HTTPS** (needed for geolocation and PWA installation), or build the Android wrapper.

On Android Chrome, once hosted on HTTPS, open the URL and choose **Install app** from the browser's menu. This is a PWA, not a compiled native APK.

## Android project / APK build

Android project is under `android/`. It uses a minimal Java WebView rather than Compose and serves bundled assets from a secure local origin using `shouldInterceptRequest`. The app makes HTTPS requests directly to Open-Meteo, OpenStreetMap and RainViewer.

Prerequisites: JDK 17, **Android SDK 35**, and **Gradle 8.9** (no wrapper jar included). With them installed:

```sh
gradle -p android :app:assembleDebug
# Result: android/app/build/outputs/apk/debug/app-debug.apk
```

For a new GitHub repository, `.github/workflows/android.yml` runs JavaScript and Chromium tests and builds the debug APK in GitHub Actions on every push to `main` and on pull requests and uploads the APK as an Actions artifact. It is **not a signed release build**. Because this environment lacks the Android SDK, native compilation/installation has not been verified here.

## Tests

```sh
node --test web/tests/*.test.mjs
python3 -m http.server 8000 --directory web
# Optional browser integration test:
python3 web/tests/browser_test.py
```

The browser integration test loads the actual HTML/CSS/JS into an isolated Chromium page, replacing external API responses and tiles with mocks because the development container blocks HTTP navigation. It uses Playwright and assumes Chromium at `/usr/bin/chromium`. **A green mocked test does not prove live APIs or the Android wrapper work.**

## Provider and licensing notes

- DWD open data is generally free with attribution under CC BY 4.0; check terms for each product: https://www.dwd.de/copyright
- Open-Meteo no-key access for non-commercial use is subject to request limits: https://open-meteo.com/en/terms
- RainViewer public API is for personal, educational and small-community use, with attribution and rate limits: https://www.rainviewer.com/api/weather-maps-api.html
- OSM tiles subject to tile usage policy; no bulk scraping or offline prefetch: https://operations.osmfoundation.org/policies/tiles/

Data is **not bundled** in the repository. The code is licensed MIT; third-party datasets/tiles remain subject to their own terms.

## Next engineering milestone

For an animated gridded forecast map, add a backend that obtains selected **ICON-D2 GRIB2** variables from `https://opendata.dwd.de/weather/nwp/icon-d2/grib/`, decodes with ecCodes, reprojects rasters to Web Mercator, and serves cached XYZ raster/vector tiles. This step is **not implemented** in the current prototype.

## Screenshot note

`screenshots/mobile.png` and `screenshots/desktop.png` were generated by an isolated browser test with **synthetic weather values and synthetic map imagery**. They demonstrate layout and interactions only; they are **not real forecasts or real OpenStreetMap screenshots**.

## GitHub Actions

[CI workflows](https://github.com/e-kotov/OpenWetter/actions) run the Node unit tests, mocked Chromium mobile/desktop UI tests, and Android debug build. The build uploads `openwetter-debug-apk` as an artifact. This **debug APK** is for personal testing, not signed release distribution. If any CI job is red, inspect its logs rather than assuming the Android shell works.

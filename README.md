# OpenWetter — DWD weather and radar prototype

A small, independently implemented open-source weather explorer for private, non-commercial use.

**Status:** A *tested browser/PWA prototype*, **not** a finished weather application. The Android wrapper **has been compiled successfully by GitHub Actions**, but has **not yet been tested on an Android device**. See the test section.

## Interface scope

The interface places synchronized weather graphs above the map, with independently implemented gestures and styling. It does not yet render gridded forecast-model maps, but can overlay latest observed radar and satellite cloud imagery.

## Working features

- DWD **ICON-D2**, **ICON-EU**, and **ICON Global** point forecasts via the **Open-Meteo DWD API**.
- Graphs: temperature, hourly precipitation, wind speed, cloud cover; tap or drag to select hour; detailed selected values.
- Map with OpenStreetMap tiles; tap to select forecast point, mouse drag to pan, wheel/buttons to zoom; touch: 1 finger scrubs weather time, 2 fingers pan and pinch zoom.
- RainViewer **observed rain radar** as a toggleable overlay independent of ICON forecast time, plus a separate historical radar timeline with opacity setting.
- **Observed satellite clouds** via DWD Meteosat public WMS, toggleable above the map with adjustable transparency. These are satellite observations, not future ICON cloud forecasts.
- Fixed Android 15+ edge-to-edge status bar and navigation-bar overlap by applying Android WindowInsets and display-cutout-safe padding around the WebView.
- City search using Open-Meteo geocoding, geolocation (with permission), saved preferences and last successful forecast, play/pause timeline.
- Offline-cached static shell (PWA), not offline weather; no API keys or accounts required for personal use.

**Important limitations:** The map remains a basemap plus forecast location marker with optional **observed** rain/cloud overlays, **not a gridded forecast animation**. The observed overlays are independent of the selected ICON future time. No raw DWD ICON GRIB2 processing or direct DWD radar ingestion yet. RainViewer offers past observations only, at a maximum raster tile zoom of 7 and may rate-limit or have incomplete coverage. Forecast graph and historical radar use **separate time axes**. The web UI and chart code is implemented, but production-grade network behaviour and Android integration need device verification.

## Run the prototype

From the repository root:

```sh
python3 -m http.server 8000 --directory web
# Open http://localhost:8000 on your computer
```

You need **internet access in the browser** to get forecasts, OSM tiles, radar, and geocoding. Localhost is treated as a secure origin for browser geolocation and installing a PWA. To try it on a phone on your own LAN, host the web app over **HTTPS** (needed for geolocation and PWA installation), or build the Android wrapper.

On Android Chrome, once hosted on HTTPS, open the URL and choose **Install app** from the browser's menu. This is a PWA, not a compiled native APK.

## Android project / APK build

Android project is under `android/`. It uses a minimal Java WebView rather than Compose and serves bundled assets from a secure local origin using `shouldInterceptRequest`. The app makes HTTPS requests directly to Open-Meteo, OpenStreetMap, RainViewer and DWD WMS.

Prerequisites: JDK 17, **Android SDK 35**, and **Gradle 8.9** (no wrapper jar included). With them installed:

```sh
gradle -p android :app:assembleDebug
# Result: android/app/build/outputs/apk/debug/app-debug.apk
```

For a new GitHub repository, `.github/workflows/android.yml` runs JavaScript and Chromium tests and builds the debug APK in GitHub Actions on every push to `main` and on pull requests and uploads the APK as an Actions artifact. It is **not a signed release build**. The Android debug APK has been compiled successfully by GitHub Actions; the new system-bar layout and live imagery still require verification on an Android device.

## Tests

```sh
node --test web/tests/*.test.mjs
python3 -m http.server 8000 --directory web
# Optional browser integration test:
python3 web/tests/browser_test.py
```

The browser integration test loads the actual HTML/CSS/JS into an isolated Chromium page, replacing external API responses and tiles with mocks because the development container blocks HTTP navigation. It uses Playwright and assumes Chromium at `/usr/bin/chromium`. **A green mocked test does not prove live APIs or the Android wrapper work.**

## Provider and licensing notes

- DWD satellite WMS and open data are generally free with attribution under CC BY 4.0; check terms for each product: https://www.dwd.de/copyright
- Open-Meteo no-key access for non-commercial use is subject to request limits: https://open-meteo.com/en/terms
- RainViewer public API is for personal, educational and small-community use, with attribution and rate limits: https://www.rainviewer.com/api/weather-maps-api.html
- OSM tiles subject to tile usage policy; no bulk scraping or offline prefetch: https://operations.osmfoundation.org/policies/tiles/

Data is **not bundled** in the repository. The code is licensed MIT; third-party datasets/tiles remain subject to their own terms.

## Next engineering milestone

For an animated gridded forecast map, add a backend that obtains selected **ICON-D2 GRIB2** variables from `https://opendata.dwd.de/weather/nwp/icon-d2/grib/`, decodes with ecCodes, reprojects rasters to Web Mercator, and serves cached XYZ raster/vector tiles. This step is **not implemented** in the current prototype.

## Screenshot note

`screenshots/mobile.png` and `screenshots/desktop.png` were generated by an isolated browser test with **synthetic weather values and synthetic map imagery**. They demonstrate layout and interactions only; they are **not real forecasts or real OpenStreetMap screenshots**.

## Android prerelease

The [GitHub Releases page](https://github.com/e-kotov/OpenWetter/releases) provides downloadable preview APKs. The `v0.1.0-alpha.2` prerelease is **debug-signed for testing**, not a production/release-signed build; future builds may use a different debug certificate and require uninstalling the previous preview before installation.

## GitHub Actions

[CI workflows](https://github.com/e-kotov/OpenWetter/actions) run the Node unit tests, mocked Chromium mobile/desktop UI tests, and Android debug build. The build uploads `openwetter-debug-apk` as an artifact. This **debug APK** is for personal testing, not signed release distribution. If any CI job is red, inspect its logs rather than assuming the Android shell works.

## DWD ICON-D2 spatial forecast pipeline

A dedicated scheduled [ICON grid pipeline](.github/workflows/icon-data.yml) downloads **real DWD ICON-D2 native GRIB2** fields for latitude, longitude, cloud cover, precipitation and temperature every six hours using ecCodes and SciPy. It samples native grid cells onto a **0.05° (~3–5 km) display raster**, publishing 49 hourly frames in the compressed `latest.json.gz` file on the `icon-data` branch. This is genuine ICON-D2 data, but the map has lower resolution than the native ICON-D2 mesh, and nearest-neighbour sampling is not conservative precipitation regridding.

When published data are available, map rain/cloud fields respond to timeline scrubbing and the temperature, rain and cloud graphs for places inside the domain are sampled from those same grids. Wind remains from the Open-Meteo ICON-D2 point API. ICON-EU and Global currently still use Open-Meteo point forecasts and have no forecast grid layers. When the grid service is unavailable or expired, the app does not invent weather fields and continues with separate point forecasts.

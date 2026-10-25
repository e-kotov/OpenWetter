# OpenWetter v0.1.0-alpha.4 — native-detail DWD weather previews

Experimental debug-signed Android APK for Android 8.0+; tested by GitHub Actions but not certified on a physical Android device.

## Changes

- DWD ICON-D2 precipitation from **193 real 15-minute GRIB2 frames** (48-hour forecast).
- Actual DWD ICON-D2 hourly cloud and temperature raster overlays, sampled from the native approximately 2 km mesh onto a 0.0125° display grid.
- DWD **RADOLAN-RY native 1 km / five-minute** precipitation radar replaces the third-party radar imagery for observed rain.
- Graph point-series come from the same processed ICON-D2 forecast grid. Wind remains DWD ICON point values from Open-Meteo.
- Map/radar scrubbing and playback follow the distinct forecast and observed timelines; data frames are loaded on demand.
- Bounded app raster cache and incremental radar-data publication.
- Persistent private release signing workflow and [instructions](../../blob/main/SIGNING.md), requiring the owner to generate and configure private GitHub Actions secrets before first use.

## Limitations

This is a **debug-signed preview**; its signing certificate changes across GitHub runners. To make future updates use a persistent certificate, follow SIGNING.md. A stable certificate does not disable Google Play Protect scans for GitHub-downloaded APKs.

ICON-EU/Global still have point forecasts only, the gridded ICON-D2 map covers the Germany region and does not increase the native model's meteorological resolution, and observed cloud satellite imagery is separate from forecast cloud cover. The application needs live data from GitHub data branches and DWD/Open-Meteo servers.

The workflows verify Android compilation, mocked-browser interfaces and the separately published weather datasets. Real Android-device performance remains unverified.

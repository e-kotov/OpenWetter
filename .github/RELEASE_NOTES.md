# OpenWetter v0.1.0-alpha.3 — genuine ICON-D2 forecast maps

Experimental debug-signed Android APK for Android 8.0 and newer.

## New
- Rain and cloud map overlays are now derived from actual DWD ICON-D2 GRIB2 spatial fields, not another provider's forecasts.
- A GitHub Actions data pipeline processes 49 hourly grids and refreshes every six hours on the separate icon-data branch.
- Rain, cloud and temperature point graphs inside the Germany map region are sampled from exactly the same ICON-D2 grids displayed on the map.
- Wind values are still from Open-Meteo's DWD ICON-D2 point forecast.
- The original observed radar/satellite controls remain independent.
- Map scrubbing and playback select the corresponding gridded forecast hour.

## Important limitations
- The display grid is **0.05 degrees**, roughly 3–5 km, sampled from native approximately 2 km ICON-D2 data. It is not the original full-resolution ICON-D2 mesh.
- This initial pipeline supports ICON-D2 only. ICON-EU and ICON Global retain their existing point forecasts; no gridded map for those models yet.
- The weather-grid service uses raw.githubusercontent.com and needs a network connection and a successful scheduled GitHub Actions run.
- The data covers 49 hourly model steps. An absent, expired or out-of-domain grid must not be misrepresented as actual forecast fields.
- Android APK compilation and mocked-browser tests are automated; **live Android device performance and reliability remain to be verified**.
- Debug signing keys on different CI jobs may be incompatible; uninstall a previous debug preview first if Android blocks installation.

The checksum file SHA256SUMS.txt provides the hash of the attached APK.

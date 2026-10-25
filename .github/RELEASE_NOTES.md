# OpenWetter v0.1.0-beta.1 — signed high-detail weather maps

First preview signed with the new **persistent OpenWetter release certificate** (not the temporary GitHub Actions debug key). Android 8.0+.

## What changed

- **ICON-D2 high-resolution regional forecast tiles:** Each visible approximately 1° area loads its complete 48-hour time series from the same genuine DWD GRIB2 source. This lets you scrub through 193 quarter-hour precipitation frames and 49 hourly cloud forecasts without repeated full-country downloads once the viewport tiles are cached.
- **ICON-EU lightweight official WMS precipitation:** Selecting ICON-EU now renders hourly 1-hour accumulated rain from DWD's `dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H` layer. Only needed 256-pixel map tiles are downloaded. It is intentionally labelled **ICON-EU (~7 km)**, not the native-detail D2 model.
- ICON-EU WMS imagery is cached on disk; ICON-D2 bundles use the existing compressed browser/Android cache. Persistent storage is subject to device space and eviction.
- ICON-D2 rain/cloud forecasts and selected-location graphs remain derived from the same genuine DWD data grids. ICON-EU graphs continue to use the separately-labelled Open-Meteo ICON-EU point data.
- Existing DWD 1 km/5-minute observed radar, radar caching and scrub continuity are retained.

## Installation and testing

**Important: Before installing this first permanently signed APK, uninstall the old alpha.6 debug-signed preview once.** Android cannot update a debug-signed app with an APK signed by the new release certificate. Afterward, future APKs signed with this same key and a higher version code can install as normal updates.

The GitHub Actions workflow verifies the release signature and publishes SHA-256 checksums. Browser and Android-build tests pass; live performance on a physical Android phone is still unverified.

Permanent signing provides consistent update identity but **does not bypass Google Play Protect sideloading checks**. This build uses a separately encrypted private signing key and the GitHub Actions secret; neither is attached to the release.

Cloud-cover maps are high-detail ICON-D2 only because an equivalent official WMS cloud layer for ICON-EU was not verified. DWD's WMS may occasionally be delayed or rate-limited, and the EU hourly layer is only rendered at published valid forecast hours.

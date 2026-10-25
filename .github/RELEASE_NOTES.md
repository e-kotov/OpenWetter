# OpenWetter v0.1.0-beta.2 — Resilient ICON-D2 forecast graphs

This Android 8.0+ release is signed using the **same permanent certificate as beta.1**, so it installs as an in-place update over beta.1.

## Fixes

- ICON-D2 temperature, precipitation and cloud graphs are now populated **directly from real DWD gridded point-series data**, without depending on the separate Open-Meteo point API.
- If the Open-Meteo API times out, the three DWD graphs remain visible. Wind remains unavailable until that API responds; no wind values are invented.
- Point requests have descriptive timeout errors and retry transient network faults, respecting intentional cancellation when locations change.
- Requests for identical compressed DWD geographic tiles are now coalesced, so point-series graphs and map rendering share an in-flight download rather than fetching twice.
- An automated mobile-browser regression deliberately simulates "signal is aborted without reason", checks that DWD graphs are visible, and confirms wind recovers when the API becomes available.

## Verification and limitations

All 37 unit tests, the simulated mobile/desktop browser tests, and Android compilation passed. Separate live tests checked the published DWD point-series binary and Open-Meteo JSON API. Neither proves performance on a particular phone.

Native-detail ICON-D2 precipitation and cloud maps, ICON-EU WMS precipitation, radar history, and persistent caching remain available.

This is an experimental beta. Future upgrades signed with the same release certificate should install without uninstalling. Google Play Protect may still request scans of APKs installed outside Google Play.

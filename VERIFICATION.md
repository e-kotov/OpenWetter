# Verification report

## Verified in the current environment (2026-10-25)

- `node --check web/app.js`: passed.
- `node --check web/logic.mjs`: passed.
- `node --test web/tests/*.test.mjs`: **7/7 passed**.
- `python3 web/tests/browser_test.py`: **mobile and desktop passed**.
- Chromium UI scenarios: mock forecast load, changing variable, selecting time, changing ICON model, switching to radar, receiving radar metadata, changing radar frame, settings and opacity, location search, mobile one-finger touch scrubbing, desktop map dragging.
- PNG UI previews generated from simulated data/map tiles.

## Not verified

- Access to Open-Meteo, RainViewer and OpenStreetMap from this environment (internet disabled).
- Android compilation, emulator/device installation, and WebView geolocation (Android SDK/emulator absent).
- Real DWD GRIB2 radar/weather processing (not implemented in this prototype).
- Continuous production operation and external API compatibility.

Run the GitHub Actions workflow to verify web and Android CI; local Android builds remain unavailable here.

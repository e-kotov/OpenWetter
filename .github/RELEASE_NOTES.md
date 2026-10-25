# OpenWetter v0.1.0-beta.6 — six-hour historical weather graphs

Android 8.0+ · Uses the **same persistent signing certificate** as beta.1–beta.5,
so this APK should install over beta.5 without uninstalling.

## New: historical temperature, rain, wind and cloud charts

When you select **Radar** or **▶ Radar → forecast**:
- All four line/bar charts now show the recent past over the same time span
  as the observed radar map, followed by future ICON predictions.
- A visible marker separates the actual past from the forecast.
- The chart cursor follows the chosen radar observation (5-minute timestamps);
  temperature/wind/cloud/rain readouts follow the corresponding time.
- Tap a past position on a graph to scrub the actual radar map without
  switching unexpectedly to forecast mode.
- Historical curves/bars are muted or dashed; the future forecast keeps
  the established chart colors. Missing historical values stay missing.
- The last nine hours of archived **ICON point model estimates** are requested
  from the Open-Meteo DWD API. The native DWD ICON-D2 15-minute future
  rain/cloud/temperature grids still have precedence where available.

## Scientific provenance

Historical temperature, wind, cloud and precipitation **chart values are
archived ICON model estimates, not direct station measurements or radar
observations**. The 1 km animated RADOLAN RY precipitation *map* remains actual
DWD radar observation. Historical graph precipitation currently uses
modelled hourly rainfall rather than rainfall volumes integrated from the
radar raster; no radar-derived graph series is claimed. The graph source is
labelled explicitly and the original UTC timestamps are preserved.

## Verification and limitations

GitHub CI passed unit tests for historical/future data separation and model
provenance, mocked Chromium mobile and desktop interactions with radar-time
chart synchronization, and Android compilation.

The Open-Meteo point API may intermittently be unavailable. When it is
unavailable and has no usable cached data, history may be missing even if
OpenWetter's native grid forecast and radar map still work. The feature
does not generate or interpolate missing measurements.

This is an experimental signed prerelease distributed via GitHub.

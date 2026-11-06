# OpenWetter v0.0.1-alpha.1

Android 8.0+ · Signed with OpenWetter's permanent release certificate, so it
installs over earlier signed OpenWetter builds without uninstalling.

First release of the rebuilt app. Weather maps now come from the OpenWetter
tile service, filled from DWD open data by a small self-hosted publisher.

## What's inside

- **ICON-D2 forecast maps, 13 layers:** rain and snowfall (15-minute steps),
  total/low/mid/high cloud, temperature, dew point, humidity, sea-level
  pressure, wind speed, gusts and wind direction, for 48 hours.
- **Past model maps:** the **Past** button shows the same layers for the last
  five days, from earlier model runs (model values, not observations).
- **Observed radar** (DWD RADOLAN, 1 km, every 5 minutes) for up to two days,
  followed by DWD's 2-hour **radar nowcast**.
- **Official DWD warnings** on the map and for the selected place.
- **Charts** for a place from the same grid as the map, one small download.
- Low data use: compact lossless tiles, only the visible area, cached on the
  device; drawing happens on the graphics chip.

## Limits

- Not yet tested on a physical Android device; please report problems.
- The data service is a single self-hosted publisher, not a guaranteed
  service; DWD feeds or the publisher can be late (stale radar is labelled).

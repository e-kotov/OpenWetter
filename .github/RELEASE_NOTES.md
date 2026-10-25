# OpenWetter v0.1.0-alpha.5 — smoother DWD radar scrubbing

Experimental debug-signed APK for Android 8.0+.

## Radar animation improvements
- Keep the last decoded 5-minute DWD RADOLAN RY observation on screen while the next frame downloads.
- Show the **actual displayed radar timestamp** separately from the requested timestamp while buffering.
- Decode and recolour only the visible part of the genuine 1 km radar grid instead of all 4.3 million pixels on every swipe.
- Cache radar observations separately from forecast fields, prefetch adjacent frames, and coalesce rapid finger movements so they do not generate many simultaneous downloads.
- The ICON-D2 forecast canvas also keeps its previous frame visible while loading.
- Adjust DWD data refresh schedules away from minute zero, where GitHub often delays jobs.

## Existing features
- Real native-derived DWD ICON-D2 15-minute precipitation forecast and hourly cloud/temperature grids.
- Direct DWD 1 km/5-minute observed rain radar and separate observed satellite clouds.
- Map scrubbing, 15-minute forecast timeline, model comparison, synchronized point graphs and saved locations.

## Limitations
Android builds are tested in CI and mocked Chromium but not on a real Android device. An uncached observation still takes time to download, and GitHub Actions scheduling does not guarantee exact five-minute publication. This is **debug-signed**, so installation may require removing the previous preview, and Google Play Protect may still request scanning. See [SIGNING.md](../../blob/main/SIGNING.md) for permanent release signing.

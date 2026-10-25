# OpenWetter v0.1.0-beta.4 — smooth real-frame weather animation

Android 8.0+ · Permanently signed with the **same OpenWetter signing certificate as beta.1–beta.3**, so this release should install over beta.3 without uninstalling.

## New: subtle seamless rain/cloud transitions

- Weather frames now use a **260 ms visual crossfade** instead of abruptly swapping the whole precipitation image.
- **Observed DWD RADOLAN-RY radar** transitions between genuine **five-minute** scans, covering up to six hours of history.
- **DWD ICON-D2** precipitation and cloud imagery transitions between the real **15-minute precipitation** and hourly cloud fields. Each geographic chunk still carries the original 48-hour model run.
- **ICON-EU** hourly precipitation WMS map tiles use the same transition once all tiles for the next hour have arrived.
- The old weather frame remains visible while new data load; blending begins only when the new frame is ready.
- Rapid scrubbing may interrupt an earlier fade; the current visible blend is captured as the starting image to reduce flicker.
- Panning, zooming, resizing, changing models, or toggling map layers does **not** animate the old geographic or model scene.
- New **Settings → Smooth weather frame transitions (260 ms)** checkbox (on by default), persisted on device; Android **Reduced Motion** is respected.

## Scientific accuracy

The fade is a **visual display transition only**. No synthetic radar scan, new forecast time step, optical-flow movement, or intermediate precipitation value is generated. Every frame retains its original DWD timestamp, and the displayed point graphs still use native-derived DWD values and separately labelled wind data.

## Verification and limitations

GitHub Actions verifies JavaScript tests, mocked Chromium mobile/desktop interaction and Android build. This release fixes a canvas compositor regression discovered during those browser tests. Physical Android performance on the user's device remains to be checked; slow connections can still delay uncached frames, but should not create an empty weather map.

This remains a GitHub-distributed prerelease, and Google Play Protect may still suggest a scan.

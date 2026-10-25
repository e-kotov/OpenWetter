# OpenWetter v0.1.0-beta.5 — continuous radar-to-forecast playback

Android 8.0+ · Signed with the same persistent OpenWetter release certificate
as beta.1–beta.4, allowing an in-place upgrade.

## New: observation-to-model weather animation

- New **▶ Radar → forecast** map mode joins the actual DWD RADOLAN-RY radar
  history to ICON forecast steps in one chronological playback and scrubber.
- **Crossfades across the radar/forecast boundary** only after the incoming
  weather rendering finishes. An outgoing snapshot stays visible while data
  download and rendering are in progress.
- Existing dedicated Radar and Forecast modes remain available, with their
  original playback controls.
- Source and timestamp labelling clearly distinguishes observations from
  predictions. No intermediate meteorological values, invented radar scans,
  or simulated rainfall motion are generated.
- Native DWD radar manifest staleness no longer hides valid older observations:
  original timestamps remain available and the map marks delayed data as
  **STALE RADAR**.
- Reduced-motion and the existing Smooth weather transitions setting are
  still respected.

## Six-hour radar history versus DWD retention

OpenWetter publishes up to 73 five-minute radar frames, spanning six hours.
The upstream public DWD RY directory actually retains a longer recent archive.
The application's six-hour cap is intentional for storage and download costs,
not an upstream DWD limitation.

## Verification and limitations

GitHub CI verified the new timeline unit tests, browser playback and crossfade
behavior, plus Android compilation. Tests include missing radar frames, the
model-source boundary, and the reduced-animation setting. Native-device
performance still needs observation on actual hardware.

GitHub Actions scheduling may be delayed, so the publisher can lag behind DWD.
This release prevents publication delays from disabling historical radar but
does not guarantee five-minute live updates. A future direct WMS fallback or
external heartbeat would make live radar more robust.

This is an experimental GitHub-distributed prerelease; Android Play Protect
may prompt for a security scan.

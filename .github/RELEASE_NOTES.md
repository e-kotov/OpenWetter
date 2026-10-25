# OpenWetter v0.1.0-alpha.6 — persistent weather cache

Early, debug-signed Android build for Android 8.0+.

## Fixes: fewer mobile-data transfers during scrubbing

- Weather frames are kept as their original compressed DWD data in Android WebView CacheStorage, surviving app restarts where Android permits storage. They are also retained in a separate bounded decoded-RAM cache.
- The full 24-frame DWD RADOLAN RY radar history can be cached locally (~13.7 MB compressed); a new observation no longer changes the URLs of existing frames.
- ICON-D2 rainfall and cloud forecast maps can be explicitly preloaded (~125 MB compressed for 193 precipitation and 49 cloud frames). Individual downloaded frames are retained automatically, so previously viewed forecast times don't require another network transfer.
- Settings provides two progress-reporting, cancellable cache-preload controls. Downloads are user initiated to avoid unexpected large mobile-data usage.
- Model point-series tiles use persistent compressed caching too, avoiding repeated downloads for multiple nearby selected locations.
- Radar frame visual continuity, visible-viewport rendering and bounded nearby-frame prefetch from alpha.5 are retained.

## Limitations

The first visit to a frame still requires network unless it has been preloaded, and saved compressed data must still be decompressed when evicted from RAM. CacheStorage can be unavailable or cleared by Android when storage is constrained. DWD radar publication requires its separate data workflow; this app cannot fabricate observations when the feed is stale.

Tests cover CacheStorage persistence, cache eviction, historical radar URL stability, network fetch deduplication, mocked Android-sized browser scrubbing, and Android compilation. **Real phone performance and storage persistence remain unverified.**

This is a temporary-key debug APK, not yet signed with the permanent signing identity. See [SIGNING.md](../../blob/main/SIGNING.md). APK signing does not bypass Google Play Protect scans.

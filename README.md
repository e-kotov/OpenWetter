# OpenWetter — open-source Android weather maps

Experimental Android and browser weather application. Real **Deutscher Wetterdienst (DWD) ICON-D2** forecast maps for 13 weather variables, 1 km observed DWD radar for the past two days, DWD's 2-hour radar nowcast, official DWD warnings and synchronized time scrubbing. The source is MIT-licensed; DWD data and third-party base maps have their own terms.

## Features

- **ICON-D2 model forecast maps (13 layers):** rain and snowfall (15-minute steps), total/low/mid/high cloud cover, 2 m temperature, dew point, relative humidity, sea-level pressure, 10 m wind speed, gusts and wind direction (hourly steps), for the 48 hours of the newest model run. Each layer has its own colour scale and legend with units.
- **Observed precipitation:** DWD RADOLAN RY 1 km / 5-minute rain-rate composites, up to two days back. Missing scans are shown as missing, never reconstructed.
- **Radar nowcast:** DWD RADVOR RV, the radar-based extrapolation for the next two hours, shown after the newest observed scan. It is a forecast derived from radar, **not** an observation.
- **One precipitation layer through time:** observed radar up to the newest scan, then the radar nowcast, then ICON-D2 model rain. The label at the top of the map names the source of the frame on screen (Radar · Nowcast · ICON-D2 run).
- **Official DWD warnings:** active warning areas for the selected time as a map layer, and warnings covering the place as a coloured strip in the graphs.
- **7-day meteogram:** thin graphs on one shared time axis from today 00:00: *Everyday* (sky bands, cloud on 14 pressure levels from 1000 to 200 hPa, rain, wind speed and gusts) and *Temperature* (line, change since yesterday's run, freezing level), plus optional Wind, Pressure and Humidity graphs. Daily maximum/minimum row, day strip and a readout of the selected time.
- **Seamless ICON point forecast:** ICON-D2 (2 km, 48 h) → ICON-EU (7 km, 5 days) → ICON Global (11 km) from one Open-Meteo request; red marks show where the model changes. Each model can also be shown alone, or all three compared on one page.
- Saved places, place search, units, and a customisable map layer bar and graph set.
- Android API 26+ WebView shell with system status-bar cutout/inset handling.

**Weather source distinction:** ICON-D2 maps are model forecasts; RADOLAN RY is observed radar; the RADVOR nowcast is a radar-based forecast. They are not interchangeable and the map label always names the source shown. ICON-EU and ICON Global are used for the graphs only (DWD ICON point forecasts via Open-Meteo); the maps are ICON-D2 and end with the newest ICON-D2 run (48 h).

## Controls

| Gesture | Effect |
|---|---|
| One finger sideways on the map | Change the time in fine steps (default 1.2 days per full-width swipe); right is later |
| One finger up or down | Change the time in coarse steps (default 120 % of the 7-day range per full-width swipe); up is later |
| Mixed directions | Each movement counts along its own dominant direction, so one swipe can go coarse, then fine. A quick release keeps going briefly. A 6 px touch slop prevents accidental scrubs. |
| Two fingers | Move and zoom the map. The forecast place follows the square in the centre ("Panned location"). |
| Tap a graph | Jump to that time |
| Hold a graph | Compare · Edit range · Edit graph (show/hide elements) · Add · Delete · Help |
| Tap the clock | Back to now |
| Double-tap a day | Compare ICON-D2, ICON-EU and ICON |
| Layer bar | Tap icons to switch layers (precipitation + one model field + warnings); ⊕ chooses and orders them; the orange button picks the model for the graphs |
| Colour bar | Opacity of the layer |

Swipe speeds (in % of range, days or hours per full-width swipe) and time stepping are in Settings → Swipe settings. On desktop: mouse wheel zooms, Ctrl/⌘-drag or right-drag pans, arrow keys step the time.

## Installation

The GitHub [Releases](https://github.com/e-kotov/OpenWetter/releases) page has signed Android APKs (Android 8.0+). Every release is signed with the same permanent certificate and has a higher Android version code than the previous one, so newer APKs install over older ones without losing settings. Release tags are semantic versions and always increase. The app is built and tested by GitHub Actions; it is **not yet verified on a physical Android device**.

To run the PWA locally:

```sh
python3 -m http.server 8000 --directory web
# Open http://localhost:8000
```

To compile Android locally: JDK 17, Android SDK 35 and Gradle 8.9:

```sh
gradle -p android :app:assembleDebug
```

## Signing for future updates

**See [SIGNING.md](SIGNING.md)** for a GitHub-only, one-time [signing-key provisioning workflow](.github/workflows/provision-signing.yml). Set one strong private Actions password, generate the certificate on the GitHub runner, and store only the encrypted keystore and public certificate in the repository. Then the [signed release workflow](.github/workflows/signed-release.yml) creates release APKs with a stable signing identity. **Signing does not suppress Google Play Protect's sideloading scan prompts.** Do not commit private keys or passwords to this public repository.

## Data source: the OpenWetter tile service

All map layers, radar, nowcast, warnings and ICON-D2 chart series come from one public, CORS-enabled service, **https://openwetter-data.ekotov.pro**, filled from DWD open data by the Rust publisher in [`tools/icon-rs`](tools/icon-rs) (see [Running the publisher](#running-the-publisher)).

- `latest.json` (short cache) points to the newest ICON-D2 run manifest, the ICON-D2 history index (`icon_d2/history/index.json`: the first 3 hours of every run of the last five days, in 256-cell tiles), and the radar, nowcast and warnings indexes.
- `icon_d2/<run>/manifest.json` describes the regular latitude/longitude grid (0.03° × 0.02°), the layers, their time steps and which 128-pixel tiles exist. Tiles are lossless grey WebP images; each holds 24 consecutive time steps of one layer stacked vertically, so one tile serves 6 hours of 15-minute rain or 24 hours of hourly fields. A missing rain/snow tile means dry for that whole chunk.
- Every pixel is an 8-bit code with a documented decode formula (rain/snow mm/h on a logarithmic scale from 0.05 to 64 mm/h; percent; °C = code/2 − 60; hPa = code + 900; m/s = code/4; direction = code × 1.5°); 255 means no data.
- `icon_d2/<run>/series/<x>_<y>.bin.gz` holds every layer's full time series for a 32 × 32-cell block, so the charts for a tapped place need one small download.
- `radar/index.json` lists 2-hour radar chunks (256-pixel tiles) and the most recent single scans (one tile for the whole grid); `nowcast/index.json` the current 2-hour RADVOR nowcast; `warnings/index.json` the active DWD warnings with their polygons.

When the radar, nowcast or warnings index is unavailable, the app hides that feature instead of failing.

**Operational caveat:** the service is a single self-hosted publisher, not a guaranteed production CDN; DWD feeds or the publisher can be late. Stale radar is labelled **STALE RADAR** rather than presented as live.

## How the maps are drawn

- **Only what is visible:** the app requests only the tiles that intersect the map view, for the chunk that contains the selected time, with at most four downloads in flight and duplicate requests merged. The neighbouring chunk is prefetched when the cursor nears a chunk edge.
- **Exact values:** tiles are decoded with `createImageBitmap(…, {colorSpaceConversion:'none', premultiplyAlpha:'none'})` and uploaded to WebGL without colour conversion or premultiplication (single-channel textures, nearest-neighbour sampling), so each pixel's code reaches the shader unchanged. The upload format is verified with all 256 codes at start-up (falling back to RGBA if a GPU is not exact), and `?debug=codes` compares a live tile decoded through WebGL with the same tile decoded by a 2D canvas.
- **Correct geography:** the base map is Web Mercator and the data grid is regular latitude/longitude. The GPU converts every screen pixel from Mercator y to latitude and then to the grid row, instead of stretching whole tiles.
- **Colours:** a 256-entry palette per layer maps codes to colours; no-data and dry pixels are transparent. Wind direction is drawn as sparse arrows (pointing where the wind blows to) over a faint direction colour wheel.
- **Memory:** decoded images are released right after upload; GPU textures are kept in a size-bounded least-recently-used cache and deleted on eviction. Tall radar chunks are split to respect the device's maximum texture size. Without WebGL the app falls back to a simpler Canvas 2D renderer.
- **Persistent cache:** downloaded tiles and chart series are immutable and stored compressed in the browser/Android WebView CacheStorage, so revisited times and places need no new transfer, even after restarting the app (as long as Android keeps the site data). The menu's *Offline maps* entry downloads the visible radar area for the past 6 hours and ICON-D2 rain for 48 hours. Basemap imagery is not bulk downloaded.

## Time axis

- One 7-day axis for graphs and map, from today 00:00 to the end of day 7 in the place's time zone. The time moves in whole minutes ("smooth"), or in data steps if chosen in Swipe settings.
- **Map rain:** for a time up to the newest radar scan, the observed scan at or before it; then nowcast frames; then the ICON-D2 rain frame (15-minute steps) to the end of the newest run. Before the radar history, earlier ICON-D2 runs are read from the history index, fetched only when needed.
- **Map fields** (cloud, temperature, pressure, wind, …): the ICON-D2 frame nearest the selected time at the layer's own step; earlier hours from earlier runs' history slices.
- An optional 260 ms crossfade blends the previous and next real frames visually; no intermediate weather is computed. The previous frame stays on screen until the next one has loaded; the map label then adds "· loading". Smooth transitions can be switched off in Settings; the system Reduced Motion preference is honoured.

## Graphs

Graph values come from Open-Meteo's DWD API (`/v1/dwd-icon`, `models=icon_d2,icon_eu,icon_global`, `past_days=1`, `forecast_days=7`), stitched per hour from the finest model that has data. The temperature change band compares with yesterday's run from Open-Meteo's previous-runs API (`temperature_2m_previous_day1`). Hours before now are model values from the same runs, not observations. The last response per place is kept for 12 hours as an offline fallback.

## Tests

```sh
node --test web/tests/*.test.mjs
python3 web/tests/browser_test.py   # needs Playwright and a Chromium/Chrome (OPENWETTER_CHROMIUM=path; screenshots to OPENWETTER_CAPTURES or ./screenshots)
cargo clippy --release --manifest-path tools/icon-rs/Cargo.toml
```

Browser UI tests use synthetic tile-service responses (tiny lossless WebP tiles with known codes) and check exact decoding through the WebGL path, but do not prove mobile live data performance. Neither substitutes for testing on an Android device.

## Licensing and attribution

- Code: MIT in [LICENSE](LICENSE).
- Weather data: DWD open data (ICON-D2, RADOLAN RY, RADVOR RV, warnings) generally under CC BY 4.0 (check [DWD licensing](https://www.dwd.de/copyright)), republished as tiles by the OpenWetter tile service.
- DWD point-forecast fallback: [Open-Meteo non-commercial terms](https://open-meteo.com/en/terms).
- Basemap tiles: [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/); no bulk tile prefetch or redistribution.

Keep use of the data and map services within their individual terms. No service-account credentials or private signing material are stored in this repository.

## Running the publisher

`tools/icon-rs` is a single Rust program that downloads DWD open data, converts it to the tiles above and uploads them to an S3-compatible bucket (Cloudflare R2). It runs on a small Linux server with systemd timers:

```sh
cd tools/icon-rs
cargo build --release
./target/release/icon-rs icon --out /tmp/openwetter-test --state /tmp/openwetter-test.json   # local dry run, no upload
```

- Subcommands: `icon` (ICON-D2 layers, chart series and 5-day history; every 15 minutes, publishes each new DWD run once), `radar`, `nowcast` and `warnings` (every 5 minutes). Each takes `--out DIR` for a local dry run or `--publish` for the bucket, plus `--state FILE`.
- `deploy/` has the systemd units (memory-capped, sharing one lock so jobs never overlap) and `install.sh`. Bucket credentials go in `/etc/openwetter/r2.env` (see `deploy/r2.env.example`) and are never committed.
- Measured on a 1 vCPU server: one ICON-D2 run takes 4–7 minutes with under 100 MB of memory; radar, nowcast and warnings under 90 MB. Monthly upload counts are capped to stay within the bucket's free tier.
- Storage keeps only what readers need: the newest run in full (the previous one for 30 minutes after a new run goes live), 3-hour history slices for 5 days, and 2 days of radar. Objects the state no longer references are swept after each publish.

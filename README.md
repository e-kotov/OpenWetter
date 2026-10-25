# OpenWetter — open-source Android weather maps

Experimental Android and browser weather application. Real **Deutscher Wetterdienst (DWD) ICON-D2** rain and cloud forecasts, 1 km observed DWD radar, and synchronized time scrubbing. The source is MIT-licensed; DWD data and third-party base maps have their own terms.

## Current alpha.6 features

- **Real DWD ICON-D2 model data:** 193 predicted precipitation frames at **15-minute** intervals covering 48 hours; 49 hourly cloud and 2-metre temperature frames. Sources are native GRIB2 fields processed by `tools/produce_icon.py`, not simulated forecasts.
- **High-detail map:** DWD's approximately 2.1 km unstructured triangular mesh is sampled into a 0.0125° latitude–longitude grid for display. This preserves substantially more native spatial detail than alpha.3's 0.05° grid, but the display mesh must not be misrepresented as weather information finer than the original ICON model.
- **Observed precipitation:** DWD RADOLAN RY ODIM-HDF5 1 km / 5-minute rain-rate composites, geographically reprojected onto a 0.005° display grid. Up to 73 five-minute observations (six hours) of historical radar rain are accessible, separate from predicted precipitation.
- **Synchronized graphs:** forecast rain, cloud cover, and temperature at a location are sampled from the same processed ICON-D2 fields shown on the map; wind and ancillary variables come from the Open-Meteo API selecting DWD ICON-D2.
- Independent rain and cloud forecast toggles, observed radar and satellite controls, model selection, model comparison, saved places and touch time scrubbing.
- Android API 26+ WebView shell with system status-bar cutout/inset handling.

**Weather source distinction:** ICON-D2 rain is a forecast; RADOLAN RY is observed radar; Meteosat clouds are observed satellite images. They are not interchangeable and do not share identical time windows. ICON-EU and ICON Global currently use DWD ICON model point forecasts via Open-Meteo, **not** full raster forecast layers.

## Installation

The GitHub [Releases](https://github.com/e-kotov/OpenWetter/releases) page contains experimental APKs, including release-key-signed beta versions. Old alpha debug APKs are not compatible with the permanent beta signing certificate; uninstall once before installing a signed beta. Subsequent beta releases will reuse the same certificate. The debug build is compiled and smoke-tested by GitHub Actions, **not yet verified on a physical Android device with a live internet connection**.

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

## Data source and publishing workflow

- `tools/produce_icon.py`: downloads DWD ICON-D2 GRIB2 via the official [DWD v1 open-data feed](https://opendata.dwd.de/weather/nwp/v1/m/icon-d2/p/), maps native cell centers to the 0.0125° raster, writes independently gzip-compressed binary forecast frames plus geographic point-series chunks. Runs in `.github/workflows/icon-data.yml` every three hours and publishes to branch [icon-data](../../tree/icon-data).
- `tools/produce_radar.py`: downloads DWD's [official RADOLAN RY](https://opendata.dwd.de/weather/radar/radolan/ry/) 1 km ODIM-HDF5 data, decodes precipitation RATE with gain 0.01 mm/h and projects into geographic raster frames. Runs in `.github/workflows/radar-data.yml` every five minutes and publishes to branch [radar-data](../../tree/radar-data), reusing previously processed frames rather than reprocessing all 24 each time.
- The browser fetches the frame required for the selected time *on demand*, with a small in-memory frame cache and adjacent-frame prefetch for scrubbing. A full 48-hour forecast is not required in mobile memory.
- `tools/verify_published_data.py` tests the actual published binary format and Android WebView's allowed cross-origin fetching in a scheduled GitHub Action.

**Operational caveat:** GitHub Actions schedules may run late, and these large public data branches are a proof-of-concept cache, not guaranteed production-grade CDN infrastructure. The ICON product is about 222 MB per model run, including point-series chunks, although the app requests only selected files. Consider an object-storage/CDN service for longer-term production reliability and lower publishing overhead.

## Tests

```sh
node --test web/tests/*.test.mjs
python3 web/tests/browser_test.py
python3 tools/test_grids.py
```

Browser UI tests use synthetic weather responses and do not prove mobile live data performance. The scheduled binary-data verification fetches actual published files. Neither substitutes for testing on an Android device.

## Licensing and attribution

- Code: MIT in [LICENSE](LICENSE).
- Weather data: DWD open data generally under CC BY 4.0 (check [DWD licensing](https://www.dwd.de/copyright)).
- DWD point-forecast fallback: [Open-Meteo non-commercial terms](https://open-meteo.com/en/terms).
- Basemap tiles: [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/); no bulk tile prefetch or redistribution.

Keep use of the data and map services within their individual terms. No service-account credentials or private signing material are stored in this repository.

## Smooth radar scrubbing

The radar renderer retains the last decoded image while another observed five-minute frame downloads (and labels the actual displayed timestamp during buffering). It processes only the visible geographic crop of the original-resolution radar rather than recolouring the entire country on every gesture, preloads adjacent frames, and limits rapid-gesture network requests. Radar precision and native observed timestamps are unchanged; slower connections can still delay *new* uncached frames.

## Persistent weather caching and offline animation preparation

OpenWetter now stores **compressed real DWD raster frames** in the browser/Android WebView CacheStorage on disk, independently of the small decoded-frame RAM cache. Once downloaded, the same radar observation or ICON forecast frame can be shown again without another network transfer, even after reopening the app, as long as Android retains its site data. Radar frame URLs use immutable observation timestamps; publishing a new five-minute observation no longer changes historical frame URLs. ICON frames remain versioned by forecast cycle. Point-series tiles use the same persistent cache.

In Settings, **Cache 6 h radar history (approximately 40–45 MB)** preloads all available radar observations in the six-hour window, and **Cache visible ICON-D2 area (48 h)** downloads only the regional tiles intersecting the current map view, each containing the whole ICON-D2 48-hour rain/cloud timeline. Preloading is optional; the app otherwise downloads frames on demand and caches them for reuse. Cache buttons can be cancelled and resume by re-running. The compressed-cache entry limits are 30 radar, 315 fallback full-domain ICON frames, 22 regional point-series tiles and 360 WMS tiles (roughly a few hundred MB maximum); browser storage quotas or automatic eviction may reduce retention. Basemap imagery is not bulk downloaded.

**Important:** The first visit to an uncached frame still requires network, and its gzip bytes must still be decoded for display. Low-memory phones may evict decoded frames. A stored frame can appear faster without using mobile data, but completely smooth first-time scrubbing of an unprepared dataset is not guaranteed.

## Lightweight, spatially accurate map modes

**Preferred within ICON-D2's Central-European coverage:** at map zoom 7 or above, OpenWetter reuses DWD-derived 1° spatial bundles already published as `icon-data/series/{x}/{y}.bin.gz`. Each compressed bundle (typically 0.4–0.8 MB) contains **all 193 fifteen-minute rain frames and all 49 hourly cloud frames** for approximately one degree of the original high-detail 0.0125° display grid. Only bundles intersecting the current map viewport are fetched (up to four simultaneous requests); they stay in RAM and compressed disk cache. All 48 hours can then be scrubbed without another download for the same area and ICON-D2 model run. The raster still represents approximately **2.1 km native model detail**, not more. When zoomed out below 7, whole-domain on-demand fields remain the lower-bandwidth choice for large geographic areas.

**Alternative when selecting ICON-EU:** OpenWetter requests hourly accumulated precipitation through the official DWD WMS layer `dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H`. The GeoServer renders only visible 256-pixel map tiles; fetched PNGs are retained in disk and memory caches. This model's native resolution is approximately **6.5–7 km**, not ICON-D2. A separate ICON-EU WMS cloud-cover layer was not available in the tested DWD catalogue, so **cloud map overlays remain ICON-D2 only**; the ICON-EU cloud graph still uses its labelled Open-Meteo ICON-EU point API. WMS precipitation coverage is limited to the currently published valid hours, and some server responses may be empty in dry regions or unavailable during outages. DWD service calls are subject to DWD attribution and availability terms.

Switch models using the existing top model selector to compare native D2 spatial data and the lightweight EU precipitation WMS. Both remain clearly labelled. No separate non-DWD or fake model overlay is inserted.

## Signing rollout

The beta.1 prerelease is built using the **permanent private signing key** provisioned by GitHub Actions and stored encrypted in this repository. Android will accept later higher-version release builds signed by the same certificate as in-place updates. The existing alpha.6 debug build has a different signing identity, so it requires a one-time uninstall before the first beta installation. Google Play Protect may still offer scans for GitHub-installed APKs.

## Radar observation history and forecast separation

The **Forecast · future** / **Radar · past 6h** switch at the top of the map selects two *independent* time axes. Forecast mode displays future DWD ICON precipitation/cloud model predictions (ICON-D2 ~2 km; optional ICON-EU rain ~7 km), not observations. Radar mode displays observed DWD RADOLAN RY rainfall intensity (1 km cells, 5-minute cadence), with a 2-hour or 6-hour history-window selector. Its selected timestamp is a real UTC observation time; no historical missing frames are fabricated. The forecast charts remain model predictions even when looking at radar history and are explicitly labelled as such. The radar source is distinct from the current satellite cloud observation.

The publisher now retains up to **73 consecutive five-minute observation slots** (six hours including endpoints) when available; actual history displayed is derived from the timestamps returned by DWD. The original feed provides a longer rolling archive, but this viewer intentionally keeps six hours to bound storage and network load. Frames are downloaded on demand, and the optional cache preload requires explicit interaction (prefer Wi-Fi). The on-device compressed radar cache retains up to 90 observations to avoid refetching when switching history windows.

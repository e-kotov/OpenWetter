# OpenWetter — open-source Android weather maps

Experimental Android and browser weather application. Real **Deutscher Wetterdienst (DWD) ICON-D2** rain and cloud forecasts, 1 km observed DWD radar, and synchronized time scrubbing. The source is MIT-licensed; DWD data and third-party base maps have their own terms.

## Current alpha.4 features

- **Real DWD ICON-D2 model data:** 193 predicted precipitation frames at **15-minute** intervals covering 48 hours; 49 hourly cloud and 2-metre temperature frames. Sources are native GRIB2 fields processed by `tools/produce_icon.py`, not simulated forecasts.
- **High-detail map:** DWD's approximately 2.1 km unstructured triangular mesh is sampled into a 0.0125° latitude–longitude grid for display. This preserves substantially more native spatial detail than alpha.3's 0.05° grid, but the display mesh must not be misrepresented as weather information finer than the original ICON model.
- **Observed precipitation:** DWD RADOLAN RY ODIM-HDF5 1 km / 5-minute rain-rate composites, geographically reprojected onto a 0.005° display grid. Up to 24 frames of historical rain observations are accessible, separate from predicted precipitation.
- **Synchronized graphs:** forecast rain, cloud cover, and temperature at a location are sampled from the same processed ICON-D2 fields shown on the map; wind and ancillary variables come from the Open-Meteo API selecting DWD ICON-D2.
- Independent rain and cloud forecast toggles, observed radar and satellite controls, model selection, model comparison, saved places and touch time scrubbing.
- Android API 26+ WebView shell with system status-bar cutout/inset handling.

**Weather source distinction:** ICON-D2 rain is a forecast; RADOLAN RY is observed radar; Meteosat clouds are observed satellite images. They are not interchangeable and do not share identical time windows. ICON-EU and ICON Global currently use DWD ICON model point forecasts via Open-Meteo, **not** full raster forecast layers.

## Installation

The GitHub [Releases](https://github.com/e-kotov/OpenWetter/releases) page contains experimental debug APKs. They are not guaranteed to update over one another because GitHub-hosted debug keys change. The debug build is compiled and smoke-tested by GitHub Actions, **not yet verified on a physical Android device with a live internet connection**.

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

**See [SIGNING.md](SIGNING.md)** to set up a **persistent, privately held release certificate** with GitHub Actions encrypted secrets. Once configured, the [signed release workflow](.github/workflows/signed-release.yml) creates a signed APK with a stable identity for Android updates. **Signing does not suppress Google Play Protect's sideloading scan prompts.** Do not commit private keys or passwords to this public repository.

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

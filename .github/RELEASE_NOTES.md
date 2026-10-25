# OpenWetter v0.1.0-beta.3 — six hours of observed radar and clear forecast controls

Android 8.0+ · Permanently signed by the **same OpenWetter release certificate as beta.1 and beta.2**. Install over beta.2 without uninstalling.

## Past observations versus future predictions

- **Radar · past 6h** at the top of the map now means actual DWD RADOLAN RY precipitation measurements, not forecasts. Select **Past 2h** for a shorter animation or **Past 6h** to inspect a full six hours of historical scans.
- The radar publisher now retains **73 original five-minute observation slots**, providing a six-hour interval from earliest to latest when DWD offers a complete run. Native radar spatial resolution remains **1 km**.
- **Forecast · future** separately selects the DWD ICON model's predicted rainfall and clouds. ICON-D2 provides 15-minute precipitation steps and approximately 2 km native detail; ICON-EU offers lighter hourly precipitation tiles at about 7 km detail.
- The app now identifies the active layer in large map tabs, displays its actual observation or prediction time, and gives each mode the correct independent time slider.
- Forecast horizon buttons (48 hours / 5 days) are hidden in radar mode. Radar history buttons (Past 2h / Past 6h) are hidden in forecast mode. Forecast graphs are clearly identified as predictions even while radar history is displayed.
- The optional live radar overlay in forecast mode explicitly says **observed**, not future prediction, and is not shown as a separate toggle while radar is the primary map.

## Performance and storage

- The compressed six-hour radar history was verified at approximately **37.7 MB total** on October 25, 2026. It is served as individually requested observations, not downloaded in full on launch.
- The Settings control **Cache 6h observed radar** preloads history explicitly on Wi-Fi. The compressed on-device radar cache now holds up to 90 frames, so repeated scrubbing should not re-download the same weather observations while cached.
- The six-hour publisher and browser/Android tests passed. The source DWD directory retains more historical observations than the app currently publishes; six hours is OpenWetter's chosen bounded window.

## Installation and limitations

Future releases continue using the established permanent OpenWetter signing identity. The first migration from debug-signed alpha versions still requires uninstalling that debug APK; beta.3 can directly update beta.1 or beta.2 subject to Android version codes.

Physical Android performance remains unverified; GitHub Actions schedules can lag and DWD may occasionally omit a scan, in which case actual available history can be shorter. The app never fabricates missing radar data. Google Play Protect may continue requesting scans for APKs installed outside Google Play.

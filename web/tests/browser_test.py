"""Mocked Chromium UI tests for the Flowx-style interface: layout, one-finger
time scrubbing (slop, per-move dominant axis, momentum, clamping), two-finger
map pan/pinch with the forecast following the map centre, graph taps and the
long-press graph menu, the layer bar, observed radar -> nowcast -> ICON-D2
rain, exact decoding through the WebGL renderer, settings, comparison page and
graceful handling of missing endpoints.

The app is served from a routed fake HTTPS origin (no network). Every external
response is synthetic: tile-service JSON is generated in the page for the
current time, and map tiles are tiny lossless WebP images whose 8-bit codes
follow a known formula, so exact decoding through the GPU path is checked.
This does NOT prove production network access or mobile performance.
"""
import json
import mimetypes
import os
import pathlib
import shutil
import struct
import zlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
CAPTURES = pathlib.Path(os.environ.get('OPENWETTER_CAPTURES') or ROOT.parent / 'screenshots')
CAPTURES.mkdir(exist_ok=True)
ORIGIN = 'https://openwetter.test/'
APP_URL = ORIGIN + 'index.html?test=1&no-sw'

# Lossless grey WebP fixtures (generated with Pillow, lossless=True). Code at
# column c, row r of frame f = (2c + 3r + 5f) % 250 + 1, frames stacked
# vertically. ICON: 40 x 45 px x 24 frames; radar chunk 100 x 90 x 24; radar frame 100 x 90.
ICON_TILE = 'UklGRhoBAABXRUJQVlA4TA0BAAAvJ8ANAc1lRP8Djty2DSSsfcm38/idTZVevRMRjNy2jeSBgHZmbpsQP+Ej6nC8pV///fv679/Xf//+gfBvpZt/i0oF0hxanC9NIUOrAPFvYfMg6UsGJvV1C4U6PHpM1JcEsC9NIUMrqaOjx6TmQdyXxzCp5+dGoc6NHpP35SEbvjSFDK2kTo0ek5oHd3x5ApMavC8U6sjoMZd8OWfNl6aQp6uJfwOjx6TmwUVfDmFS0/eZQp0WPeamL0fs+tIUMrSSOit6TGoe3Pblb5jU0XdEoQ6KHnPdl7+4wJemkKGV1DHRY1Lz4BW+fIRJnX+/FOqM6DHv8OUDt/jSFDK0kjohekxqHrzHlxQypVWZQgA='
RADAR_CHUNK = 'UklGRooDAABXRUJQVlA4TH4DAAAvY8AbAs1lRP8DkCRJjtuEey7w/7+KD2gHMd0NaJ2IgOS2jSDJAw08i/xghfL9Dwqf+BJMU0g7fwm0c+jhT7s9UQBB3e5EAQRvux8FEKTtYRRAMLaRKICga4NRAMHVxqMAgqgdigIIlnY0CiAo2oQogMhvc6IAIrlNiwKIzDYzCiDS2uQogMhp86MAIqGlRAHE7JYVBRBTW2IUQMxruVEAMamlRwHEjMYQBRCHG0kUQBxrPFEAcaBRRQHEaGOLAoihRhgFEI8bZxRAPGi0UQBxrzFHAcRNI48CiEvjjwL41/hf21OervHnb480Ea+FHx2vhRwpr4UZNa+FFkGvhRNNr4UQWa+FDWWvhQpxr4UHfa+FBAteCwMuvJZ0jHgtuXjxWhKx47Vk4chrScGU1zIfX17LZKx5LTNx57VMw6DXMgePXssEbHotR3HqtRzCrNcyjl+vZRDLXssIrr2WhyzBa0Hz7rXcwb7Xcs0KvJYzT4bX8ovBz2lreJulKfxoS/Ba0JbgtaAtwWtBU/RaKBH1WvjQ9VrIkPZamFD3Wmgw4LVw4MFrIcCG15KNE68lFTNeSx5+vJYkLHktGbjyWqZjzGuZizevZSL2vJZZOPRapmDSazmOT6/lIFa9liO49VqGMey1jOHZaxnAttfyiCV4LWjmvZZbluC1oC3BazmxU17Lh4qfU/5v/9SC2z8fjn5O+b/9U6dt/3wA+znl//ZPfbP980Xi55T/2z91wfbPF6KfU/5v/9TN2z8vXcdh1/yc8n/753fo9s+XYJpC2r69Y1P+b//Ugts/b/MdmL5pJ+X/9k8tuP3zNt+B6Zt2Uv5v/xT/2z9LcBzQluA4oGk5Dn3TTsr/7Z9acPvnbb4D0zftpPzf/qn7t3+W4DigLcFxQBN0HPqmnZT/2z9V//aPwjsdS3Ac0CQdBwXQN+2k/N/+Kfm3f5bgOKBpOg6EqDoOfdNOyv/tn4J/+0fhnQ5Rx4EPXcdBAfRNOyn/t3+q/e0fVceBDmHHgQtpx6Fv2kn5v/1T/m//BBvKjgMV4o6DAuibdlL+b/8U+ts/0o4DE+qOAw36jkPftJPyf/un/N/+CSLkHQcWHDgOCqBv2kn5v/1T42//6DsOJFhwHBgw4Tj0TTsp/7d/yv/tn+DAg+NAgA3HQQH0BZ2U/9s/5f/2T1BgwnHIx4fjkIwRxwE='
RADAR_FRAME = 'UklGRsIAAABXRUJQVlA4TLYAAAAvY0AWAM1lRP8DECNJcqQEhSr8N/nU/2yhISIiJuCB9/DxnyDfA+kT+qRP9tOkT052SZ+cj5I+uVwkfXLLHOmTG7dIn9w+RPrkrhXSJ/dOkD4ZuJ70yczFpE/GriR9MnkZ6ZPha0ifzF9A+mTJadInq46SPll4jvTJ2kOkT5afIH1SeDfpk8j7SJ903kH6JPVW0ie1N5E+Cb4mfdJ8Qfok+4z0SfmB9En8Rvqk/1HewTfew8dvOQ=='


def solid_png(rgba=(190, 211, 203, 255), size=256):
    raw = b''.join(b'\x00' + bytes(rgba) * size for _ in range(size))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


GROUND = solid_png()
CLOUD = solid_png((235, 240, 250, 90))

MOCK = r'''(() => {
  const F = __FIXTURE_JSON__;
  const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const counters = {forecast:{}, geocode:0, wmsMetadata:0, wmsTiles:0, urls:{}, point:0, previous:0};
  window.__mockCounts = () => JSON.parse(JSON.stringify(counters));
  const now = Math.floor(Date.now()/1000), anchor = Math.floor(now/3600)*3600;
  const runTime = Math.floor(now/10800)*10800 - 10800;
  const run = new Date(runTime*1000).toISOString().slice(0,16), runKey = run.replace(':','');
  const D = 'https://openwetter-data.ekotov.pro/';
  const ICON_GRID = {west:4, north:56, lon_step:.25, lat_step:.2, width:40, height:45, row0:'north'};
  const RADAR_GRID = {west:4, north:56, lon_step:.1, lat_step:.1, width:100, height:90, row0:'north'};
  const layers = {};
  for (const name of ['precip','snow','cloud_total','cloud_low','cloud_mid','cloud_high','temperature','dew_point',
      'humidity','pressure','wind_speed','wind_gust','wind_direction']) {
    const quarter = name==='precip'||name==='snow';
    layers[name] = {step_minutes: quarter?15:60, code:{}, missing_tile:'outside the model',
      chunks: Array.from({length: quarter?8:2}, (_,i) => ({chunk:i, first_step_minutes: quarter?15+i*360:60+i*1440,
        frames:24, tiles:[[0,0,F.ICON_TILE_BYTES]]}))};
  }
  const seriesLayers = [{name:'precip',frames:192,step_minutes:15,first_step_minutes:15},
    {name:'temperature',frames:48,step_minutes:60,first_step_minutes:60},
    {name:'cloud_total',frames:48,step_minutes:60,first_step_minutes:60}];
  const manifest = () => ({schema:'openwetter-tiles-2', model:'icon_d2', run, generated_at:now, grid:ICON_GRID, tile:128,
    frames_per_chunk:24, encoding:{nodata:255}, layers,
    ...(window.__mockSeries ? {series:{tile:32, path:'series/{x}_{y}.bin.gz', tiles:[[0,0],[1,0],[0,1],[1,1]], layers:seriesLayers}} : {})});
  const latest = Math.floor(now/300)*300 - 300;
  const c0 = Math.floor(latest/7200)*7200 - 4*3600;
  const radar = () => ({schema:'openwetter-radar-1', product:'DWD RADOLAN RY', generated_at:now, grid:RADAR_GRID,
    tile:256, step_seconds:300, latest, code:{unit:'mm/h', dry:0},
    chunks:[0,1].map(i => ({start:c0+i*7200, frames:24, tile:256, path:'radar/c/'+(c0+i*7200)+'/{x}_{y}.webp',
      tiles:[[0,0,F.RADAR_CHUNK_BYTES]], missing_frames: i===0?[3]:[]})),
    frames: Array.from({length:(latest-(c0+4*3600))/300+1}, (_,i) => c0+4*3600+i*300)
      .map(t => ({time:t, tile:2048, path:'radar/f/'+t+'/{x}_{y}.webp', tiles:[[0,0,F.RADAR_FRAME_BYTES]]}))});
  const issued = latest - 300;
  const nowcast = () => ({schema:'openwetter-nowcast-1', product:'DWD RADVOR RV', issued, grid:RADAR_GRID, tile:256,
    step_seconds:300, first_time:issued+300, frames:24, path:'nowcast/'+issued+'/{x}_{y}.webp',
    tiles:[[0,0,F.RADAR_CHUNK_BYTES]], code:{unit:'mm/h'}});
  const warnings = () => ({schema:'openwetter-warnings-1', generated_at:now, warnings:[{id:'w1', event:'FROST',
    severity:'Moderate', urgency:'Immediate', onset:now-3600, expires:now+6*3600, color:[255,235,59],
    headline:{de:'Amtliche WARNUNG vor FROST', en:'Official WARNING of FROST'}, description:{en:'Frost expected.'},
    instruction:{en:'Protect plants.'}, areas:[{name:'Dortmund area', polygons:[[[6,51],[9,51],[9,52.5],[6,52.5],[6,51]]]}]}]});
  const seriesBlock = async (x, y) => {
    const w = Math.min(32, 40-32*x), h = Math.min(32, 45-32*y), n = w*h;
    const body = new Uint8Array(n*(192+48+48));
    body.fill(99, 0, 192*n);              // 0.8 mm/h
    body.fill(142, 192*n, 240*n);         // 11 °C
    body.fill(60, 240*n);                 // 60 %
    return new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip')));
  };
  // Open-Meteo multi-model point forecast (suffix per model): ICON-D2 to +48 h,
  // ICON-EU to +120 h, ICON Global to the end; from yesterday 00:00.
  const forecast = url => {
    const q = new URL(url).searchParams, vars = q.get('hourly').split(','), models = q.get('models').split(',');
    const start = anchor - 48*3600, n = 48 + 7*24, hourly = {time: Array.from({length:n}, (_,i) => start+3600*i)};
    const end = {icon_d2: anchor+48*3600, icon_eu: anchor+120*3600, icon_global: Infinity};
    const offset = {icon_d2:0, icon_eu:4, icon_global:-2};
    const value = (v, i, m) => { const k = i - 48;
      if (v === 'temperature_2m') return Math.round((8+offset[m]+5*Math.sin(k/6))*10)/10;
      if (v === 'dew_point_2m') return 3;
      if (v === 'precipitation') return Math.round(Math.max(0,2*Math.sin((k+offset[m])/4))*10)/10;
      if (v === 'wind_speed_10m') return Math.round(14+6*Math.cos(k/7));
      if (v === 'wind_gusts_10m') return 30;
      if (v === 'wind_direction_10m') return 225;
      if (v === 'pressure_msl') return 1013;
      if (v.startsWith('cloud_cover')) return Math.round(50+45*Math.sin(k/5));
      return 50; };
    for (const m of models) for (const v of vars)
      hourly[v+'_'+m] = hourly.time.map((t,i) => t < end[m] ? value(v,i,m) : null);
    return {latitude:51.51, longitude:7.46, timezone:'Europe/Berlin', hourly};
  };
  const previousRun = url => {
    const start = anchor - 48*3600, n = 48 + 7*24, time = Array.from({length:n}, (_,i) => start+3600*i);
    return {timezone:'Europe/Berlin', hourly:{time, temperature_2m:time.map(() => 7), temperature_2m_previous_day1:time.map(() => 7)}};
  };
  window.__mockInfo = {now, anchor, runTime, run, latest, c0, issued};
  window.__radarWaiters = [];
  window.__releaseRadar = () => { window.__delayRadar = false; while (window.__radarWaiters.length) window.__radarWaiters.shift()(); };
  const json = body => new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}});
  const webp = b64 => new Response(bytes(b64), {status:200, headers:{'Content-Type':'image/webp'}});
  const realFetch = window.fetch.bind(window);
  window.fetch = async (arg, init) => {
    const url = String(arg.url || arg);
    if (url.startsWith(D)) {
      counters.urls[url] = (counters.urls[url]||0) + 1;
      const path = url.slice(D.length);
      if (window.__mock404) return new Response('not found', {status:404});
      if (path === 'latest.json') return json({schema:'openwetter-tiles-2', generated_at:now,
        icon_d2:{run, manifest:'icon_d2/'+runKey+'/manifest.json', history:'icon_d2/history/index.json'},
        radar:'radar/index.json', nowcast:'nowcast/index.json', warnings:'warnings/index.json'});
      if (path === 'icon_d2/'+runKey+'/manifest.json') return json(manifest());
      // History index: three earlier runs (3, 6, 9 h before the newest run). Real slices hold
      // 12 rain / 3 hourly frames; the mock reuses the 24-frame fixture tile, so 24 frames here.
      if (path === 'icon_d2/history/index.json') return json({schema:'openwetter-history-1', generated_at:now,
        grid:ICON_GRID, tile:256, path:'icon_d2/history/{run_key}/{layer}/{x}_{y}.webp', codes:{},
        slices:[1,2,3].map(k => { const t = runTime-k*10800, r = new Date(t*1000).toISOString().slice(0,16);
          return {run:r, run_key:r.replace(':',''), start:t, layers:Object.fromEntries(Object.entries(layers).map(([name,l]) =>
            [name, {step_minutes:l.step_minutes, first_step_minutes:l.step_minutes, frames:24, tiles:[[0,0,F.ICON_TILE_BYTES]]}]))}; })});
      if (path.startsWith('icon_d2/history/') && path.endsWith('/0_0.webp')) return webp(F.ICON_TILE);
      if (path.startsWith('icon_d2/'+runKey+'/series/')) {
        const [x, y] = path.match(/(\d+)_(\d+)\.bin\.gz$/).slice(1).map(Number); return seriesBlock(x, y);
      }
      if (path.startsWith('icon_d2/'+runKey+'/') && path.endsWith('/0_0.webp')) return webp(F.ICON_TILE);
      if (path === 'radar/index.json') return json(radar());
      if (path === 'nowcast/index.json') return json(nowcast());
      if (path === 'warnings/index.json') return json(warnings());
      if (path.startsWith('radar/') || path.startsWith('nowcast/')) {
        if (window.__delayRadar && (path.startsWith('radar/c/') || path.startsWith('nowcast/'))) await new Promise(r => window.__radarWaiters.push(r));
        return webp(path.startsWith('radar/f/') ? F.RADAR_FRAME : F.RADAR_CHUNK);
      }
      return new Response('not found', {status:404});
    }
    if (url.includes('previous-runs-api.open-meteo.com')) { counters.previous = (counters.previous||0) + 1; return json(previousRun(url)); }
    if (url.includes('/v1/dwd-icon')) {
      counters.point = (counters.point||0) + 1; counters.lastPoint = url;
      if (window.__mockPointDown) return new Response('down', {status:503});
      return json(forecast(url));
    }
    if (url.includes('geocoding-api.open-meteo.com')) {
      counters.geocode++; return json({results:[{latitude:50.7374, longitude:7.0982, name:'Bonn', country:'Germany'}]});
    }
    if (url.includes('/Icon-eu_reg00625_fd_sl_TOTPREC01H/wms?')) {
      counters.wmsMetadata++;
      const iso = t => new Date(t*1000).toISOString();
      const xml = '<WMS_Capabilities><Capability><Layer><Layer><Name>dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H</Name>'+
        '<Dimension name="time" units="ISO8601">'+iso(anchor-86400)+'/'+iso(anchor+78*3600)+'/PT1H</Dimension>'+
        '<Dimension name="REFERENCE_TIME" units="ISO8601">'+iso(anchor-6*3600)+'</Dimension></Layer></Layer></Capability></WMS_Capabilities>';
      return new Response(xml, {status:200, headers:{'content-type':'text/xml'}});
    }
    if (url.startsWith('https://maps.dwd.de/geoserver/dwd/wms?')) {
      counters.wmsTiles++;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const c = canvas.getContext('2d'); c.fillStyle = 'rgba(48,145,231,.65)'; c.fillRect(0,0,256,256);
      return new Response(bytes(canvas.toDataURL('image/png').split(',')[1]), {status:200, headers:{'content-type':'image/png'}});
    }
    if (url.startsWith('https://openwetter.test/')) return realFetch(arg, init);
    throw new Error('Unexpected request: '+url);
  };
})();'''


def new_page(browser, viewport, mobile=False, flags=None):
    context = browser.new_context(viewport=viewport, device_scale_factor=1, has_touch=mobile, is_mobile=mobile)

    def serve(route):
        path = route.request.url[len(ORIGIN):].split('?')[0] or 'index.html'
        file = (ROOT / path).resolve()
        if ROOT not in file.parents or not file.is_file():
            return route.fulfill(status=404, body='missing')
        route.fulfill(status=200, body=file.read_bytes(),
                      content_type=mimetypes.guess_type(str(file))[0] or 'application/javascript')
    context.route(ORIGIN + '**', serve)
    context.route('https://tile.openstreetmap.org/**', lambda r: r.fulfill(status=200, body=GROUND, content_type='image/png'))
    context.route('https://maps.dwd.de/**', lambda r: r.fulfill(status=200, body=CLOUD, content_type='image/png'))
    fixture = json.dumps({'ICON_TILE': ICON_TILE, 'RADAR_CHUNK': RADAR_CHUNK, 'RADAR_FRAME': RADAR_FRAME,
                          'ICON_TILE_BYTES': len(ICON_TILE) * 3 // 4, 'RADAR_CHUNK_BYTES': len(RADAR_CHUNK) * 3 // 4,
                          'RADAR_FRAME_BYTES': len(RADAR_FRAME) * 3 // 4})
    context.add_init_script(''.join(f'window.{k}={json.dumps(v)};' for k, v in (flags or {}).items()))
    context.add_init_script(MOCK.replace('__FIXTURE_JSON__', fixture))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(APP_URL)
    return page, errors


def cdp_touch(page, frames, step_ms=16):
    """frames: list of [(x, y), ...] per step; same finger count throughout."""
    c = page.context.new_cdp_session(page)
    tp = lambda fr: [{'x': x, 'y': y, 'id': i + 1} for i, (x, y) in enumerate(fr)]
    c.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': tp(frames[0])})
    for fr in frames[1:]:
        page.wait_for_timeout(step_ms)
        c.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': tp(fr)})
    c.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def path(start, end, n):
    return [[(sx + (ex - sx) * k / n, sy + (ey - sy) * k / n) for (sx, sy), (ex, ey) in zip(start, end)] for k in range(n + 1)]


def tap(page, x, y, hold=0):
    c = page.context.new_cdp_session(page)
    c.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y, 'id': 1}]})
    if hold:
        page.wait_for_timeout(hold)
    c.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.wait_for_timeout(150)


def expected_code(lat, lon, index):
    """Fixture formula: code at column c, row r of frame f = (2c + 3r + 5f) % 250 + 1 (ICON grid 4E/56N, 0.25 x 0.2 deg)."""
    col, row = round((lon - 4) / .25), round((56 - lat) / .2)
    return (2 * col + 3 * row + 5 * index) % 250 + 1


def mid_time(page):
    page.evaluate('(()=>{const b=openwetterTest.timeBounds();openwetterTest.setTime((b.min+b.max)/2)})()')


def minutes_for_drag(page, dx, dy, x=150, y=600, steps=25, hold=200):
    a = page.evaluate('openwetterTest.state.time')
    frames = path([(x, y)], [(x + dx, y + dy)], steps) + [[(x + dx, y + dy)]] * (hold // 16)
    cdp_touch(page, frames)
    page.wait_for_timeout(250)
    return (page.evaluate('openwetterTest.state.time') - a) / 60


def back(page):
    page.locator('.page-bar .round-button').click()


def ui_mobile(browser):
    page, errors = new_page(browser, {'width': 412, 'height': 915}, mobile=True)
    page.wait_for_function('window.openwetterTest?.state.point&&openwetterTest.state.icon&&openwetterTest.state.radar&&openwetterTest.state.nowcast')
    page.wait_for_timeout(400)
    st = lambda expr: page.evaluate('openwetterTest.state.' + expr)
    assert page.evaluate('openwetterTest.renderer.kind') in ('webgl2', 'webgl'), 'WebGL renderer unavailable'

    # Layout measured from Flowx (412 x 915): 56 / 28 / 64+2+64 / 28 / 28 / map.
    boxes = page.evaluate('''()=>{const b=s=>{const r=document.querySelector(s).getBoundingClientRect();return [Math.round(r.y),Math.round(r.height)];};
      return {bar:b('.appbar'),ext:b('#extremes'),days:b('#days'),read:b('#readout'),map:b('#map'),chip:b('#mapChip'),
        layers:b('#layerBar'),legend:b('#legend'),graphs:[...document.querySelectorAll('.graph')].map(g=>{const r=g.getBoundingClientRect();return [Math.round(r.y),Math.round(r.height)];})};}''')
    assert boxes['bar'] == [0, 56] and boxes['ext'] == [56, 28], boxes
    assert boxes['graphs'] == [[84, 64], [150, 64]], boxes
    assert boxes['days'] == [214, 28] and boxes['read'] == [242, 28] and boxes['map'][0] == 270, boxes
    assert boxes['chip'] == [278, 36] and boxes['layers'] == [819, 44] and boxes['legend'] == [871, 36], boxes
    assert page.locator('#extremes span').count() == 14
    assert page.locator('#days button').count() == 7 and page.locator('#days button.active').count() == 1
    assert page.locator('#layerButtons button').count() == 7
    assert page.inner_text('#placeName') == 'Dortmund'
    counts = page.evaluate('window.__mockCounts()')
    assert counts['point'] == 1 and counts['previous'] == 1, counts
    assert page.evaluate('openwetterTest.state.point.transitions.map(t=>t.from+">"+t.to).join()') == 'icon_d2>icon_eu,icon_eu>icon_global'

    # Rain: observed radar up to the latest scan, then the nowcast, then ICON-D2, each labelled.
    info = page.evaluate('window.__mockInfo')
    for t, source, label in ((info['latest'] - 1800, 'radar', 'Radar'), (info['latest'] + 900, 'nowcast', 'Nowcast'),
                             (info['latest'] + 6 * 3600, 'forecast', 'ICON-D2')):
        page.evaluate(f'openwetterTest.setTime({t})')
        assert page.evaluate('openwetterTest.rainSource(openwetterTest.state.time)') == source, (t, source)
        page.wait_for_function(f"(t=>t.startsWith('{label}')&&!t.includes('loading'))(document.querySelector('.chip-source')?.textContent||'')")
    frame = page.evaluate('openwetterTest.rainFrameAt(openwetterTest.state.time).frame')
    assert frame['source'] == 'icon' and frame['layer'] == 'precip', frame
    sample = page.evaluate('openwetterTest.sample(52.0,7.5)')
    assert sample['code'] == expected_code(52.0, 7.5, sample['index']), sample

    # Exact codes for a field layer through decode -> texture -> per-fragment Mercator -> readback.
    page.click('[data-layer=temperature]')
    page.evaluate(f"openwetterTest.setTime({info['runTime']}+6*3600)")
    page.wait_for_timeout(600)
    for lat, lon in ((52.0, 7.5), (50.2, 10.25), (54.6, 13.0)):
        s = page.evaluate(f'openwetterTest.sample({lat},{lon})')
        assert s['layer'] == 'temperature' and s['code'] == expected_code(lat, lon, s['index']), (lat, lon, s)
    page.wait_for_function("document.getElementById('mapChip').innerText.includes('Temperature')")
    assert 'Precipitation' in page.inner_text('#mapChip')
    page.click('[data-layer=temperature]')
    assert st('field') is None

    # One-finger scrubbing with the swapped Flowx defaults.
    width = page.evaluate("document.getElementById('map').getBoundingClientRect().width")
    range_min = page.evaluate('(openwetterTest.timeBounds().max+60-openwetterTest.timeBounds().min)/60')
    h_rate, v_rate = 1.2 * 1440 / width, 1.2 * range_min / width   # minutes per px: sideways fine, up/down coarse
    mid_time(page)
    for dx in (50, 100):
        got = minutes_for_drag(page, dx, 0)
        assert abs(got - (dx - 6) * h_rate) <= 2, (dx, got, (dx - 6) * h_rate)
        assert abs(minutes_for_drag(page, -dx, 0) + got) <= 1
    got = minutes_for_drag(page, 0, -50, x=206, y=650)
    assert abs(got - 44 * v_rate) <= 2, (got, 44 * v_rate)
    assert abs(minutes_for_drag(page, 0, 50, x=206, y=600) + got) <= 1
    a = st('time')   # L-shape: fine then coarse in one gesture
    cdp_touch(page, path([(150, 600)], [(210, 600)], 15) + path([(210, 600)], [(210, 540)], 15)[1:] + [[(210, 540)]] * 12)
    page.wait_for_timeout(250)
    assert abs((st('time') - a) / 60 - (54 * h_rate + 60 * v_rate)) <= 4
    mid_time(page)
    a = st('time')   # a quick flick carries on
    cdp_touch(page, path([(100, 600)], [(220, 600)], 4), step_ms=8)
    page.wait_for_timeout(500)
    assert (st('time') - a) / 60 > 114 * h_rate + 5, ((st('time') - a) / 60, 114 * h_rate)
    for _ in range(3):   # clamped to today 00:00 ... day 7 23:59
        minutes_for_drag(page, 0, -300, x=206, y=790, hold=0)
    assert st('time') == page.evaluate('openwetterTest.timeBounds().max')
    for _ in range(3):
        minutes_for_drag(page, 0, 300, x=206, y=320, hold=0)
    assert st('time') == page.evaluate('openwetterTest.timeBounds().min')
    page.click('#clockBtn')
    assert abs(st('time') - page.evaluate('Date.now()/1000')) < 90

    # Tap a graph: jump to that time. Long-press: graph menu with add / delete / edit.
    tap(page, 300, 110)
    v = page.evaluate('openwetterTest.timeView()')
    assert abs((st('time') - v['start']) / (v['end'] - v['start']) - 300 / 412) < .004
    tap(page, 250, 180, hold=700)
    assert page.inner_text('#popupMenu').split('\n') == ['Compare', 'Edit range', 'Edit graph', 'Add', 'Delete', 'Help']
    page.locator('#popupMenu button', has_text='Add').click()
    page.locator('.dialog .model-row', has_text='Wind').click()
    assert page.locator('#graphs .graph').count() == 3
    tap(page, 250, 250, hold=700)
    page.locator('#popupMenu button', has_text='Delete').click()
    assert page.locator('#graphs .graph').count() == 2
    tap(page, 250, 120, hold=700)
    page.locator('#popupMenu button', has_text='Edit graph').click()
    page.get_by_role('checkbox', name='Cloud layers').uncheck()
    back(page)
    assert page.evaluate("JSON.parse(localStorage.getItem('openwetter.ui.v3')).graphs[0].elements.cloudLayers") is False
    tap(page, 250, 120, hold=700)
    page.locator('#popupMenu button', has_text='Edit range').click()
    block = page.locator('.field-block', has_text='Precipitation')
    block.locator('input[type=number]').nth(1).fill('8')
    page.locator('.dialog-actions button', has_text='Save').click()
    assert page.evaluate('openwetterTest.state.graphs[0].ranges.precip') == [0, 8]

    # Two fingers: pan moves the forecast place to the map centre; pinch zooms.
    z0, t0 = st('map.zoom'), st('time')
    cdp_touch(page, path([(180, 600), (240, 600)], [(120, 540), (180, 540)], 20))
    page.wait_for_function("openwetterTest.state.place.name==='Panned location'")
    assert page.inner_text('#placeName') == 'Panned location' and st('time') == t0
    page.wait_for_function('window.__mockCounts().point===2')
    c = page.evaluate('[openwetterTest.state.map.latitude,openwetterTest.state.map.longitude,openwetterTest.state.place.latitude,openwetterTest.state.place.longitude]')
    assert abs(c[0] - c[2]) < 1e-9 and abs(c[1] - c[3]) < 1e-9, c
    cdp_touch(page, path([(176, 600), (236, 600)], [(146, 600), (266, 600)], 20))
    page.wait_for_timeout(300)
    assert abs(st('map.zoom') - z0 - 1) < .02, st('map.zoom') - z0

    # Layer bar: toggles; legend follows the last picked layer; the layer editor's order persists.
    page.click('[data-layer=precip]')
    assert st('rain') is False
    page.wait_for_function("document.getElementById('mapChip').innerText.trim()==='No map layer'")
    page.click('[data-layer=precip]')
    page.click('[data-layer=wind_speed]')
    assert page.get_attribute('#legend', 'data-layer') == 'wind_speed'
    page.click('[data-layer=wind_speed]')
    page.click('[data-layer=warnings]')
    assert st('warningsOn') is False
    page.wait_for_function("document.getElementById('warningsCanvas').hidden")
    page.click('[data-layer=warnings]')
    page.click('#editLayersBtn')
    page.get_by_role('checkbox', name='Snowfall').check()
    page.locator('.tabs button', has_text='Order').click()
    page.get_by_role('button', name='Move up Snowfall').click()
    page.locator('.dialog-actions button', has_text='Save').click()
    assert page.evaluate("[...document.querySelectorAll('#layerButtons button')].map(b=>b.dataset.layer).slice(-2)") == ['snow', 'warnings']

    # Settings: units and swipe speed take effect immediately.
    page.click('#placeBtn')
    page.locator('#settingsBtn').click()
    page.locator('.field-row', has_text='Wind').locator('select').select_option('kt')
    assert page.inner_text('#unitWind') == 'kt'
    page.locator('.drawer-item', has_text='Swipe settings').click()
    page.locator('.field-block', has_text='Horizontal').locator('input').fill('2.4')
    page.locator('.dialog-actions button', has_text='Save').click()
    back(page)
    mid_time(page)
    got = minutes_for_drag(page, 100, 0)
    assert abs(got - 94 * 2 * h_rate) <= 3, (got, 94 * 2 * h_rate)

    # Model comparison (double-tap a day) shows each ICON model.
    page.locator('#days button').first.dblclick()
    page.wait_for_selector('.page .compare-model')
    assert page.locator('.compare-model h3').all_inner_texts() == ['DWD ICON-D2 · 2 km', 'DWD ICON-EU · 7 km', 'DWD ICON · 11 km']
    back(page)

    # Search a place from the drawer.
    before = page.evaluate('window.__mockCounts().point')
    page.click('#placeBtn')
    page.fill('#searchInput', 'Bonn')
    page.press('#searchInput', 'Enter')
    page.wait_for_function("openwetterTest.state.place.name.startsWith('Bonn')")
    page.wait_for_function(f'window.__mockCounts().point==={before}+1')
    page.wait_for_timeout(300)
    page.screenshot(path=str(CAPTURES / 'mobile-412x915.png'))
    assert not errors, errors
    print('Mobile UI: layout, scrubbing, gestures, rain sequence, exact codes, layers, settings, compare: OK')
    page.context.close()


def ui_desktop(browser):
    page, errors = new_page(browser, {'width': 1440, 'height': 900}, mobile=False)
    page.wait_for_function('window.openwetterTest?.state.point&&openwetterTest.state.icon')
    z0 = page.evaluate('openwetterTest.state.map.zoom')
    page.mouse.move(720, 600)
    page.mouse.wheel(0, -300)
    page.wait_for_timeout(200)
    assert page.evaluate('openwetterTest.state.map.zoom') > z0
    t0 = page.evaluate('openwetterTest.state.time')
    page.keyboard.press('ArrowRight')
    assert page.evaluate('openwetterTest.state.time') - t0 == 3600
    page.screenshot(path=str(CAPTURES / 'desktop-1440x900.png'))
    assert not errors, errors
    print('Desktop UI: wheel zoom and keyboard time steps: OK')
    page.context.close()


def verify_missing_endpoints(browser):
    page, errors = new_page(browser, {'width': 390, 'height': 844}, mobile=True, flags={'__mock404': True})
    page.wait_for_function('window.openwetterTest?.state.point&&openwetterTest.state.iconError')
    page.wait_for_timeout(300)
    assert page.evaluate('openwetterTest.rainSource(openwetterTest.state.time)') == 'forecast'
    assert page.inner_text('.chip-source') in ('Loading…', 'No rain map for this time')
    assert page.locator('#warningsCanvas').is_hidden()
    assert page.locator('#extremes span').count() == 14
    assert not errors, errors
    page.context.close()
    page, errors = new_page(browser, {'width': 390, 'height': 844}, mobile=True, flags={'__mockPointDown': True})
    page.wait_for_function("openwetterTest.state.pointError&&!document.getElementById('toast').hidden")
    assert 'Forecast unavailable' in page.inner_text('#toast')
    assert not errors, errors
    print('Missing tile-service or forecast endpoints degrade without errors: OK')
    page.context.close()


def main():
    with sync_playwright() as p:
        executable = (os.environ.get('OPENWETTER_CHROMIUM') or shutil.which('chromium') or
                      shutil.which('chromium-browser') or shutil.which('google-chrome') or p.chromium.executable_path)
        browser = p.chromium.launch(headless=True, executable_path=executable,
                                    args=['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
                                          '--use-angle=swiftshader', '--ignore-gpu-blocklist'])
        ui_mobile(browser)
        ui_desktop(browser)
        verify_missing_endpoints(browser)
        browser.close()


if __name__ == '__main__':
    main()

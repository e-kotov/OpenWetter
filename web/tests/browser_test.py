"""Mocked Chromium UI tests: touch scrubbing, stacked charts, model comparison,
places, the WebGL tile renderer, radar/nowcast/forecast sequencing, layer menu,
warnings and graceful handling of missing tile-service endpoints.

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
CAPTURES = ROOT.parent / 'screenshots'
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
  const counters = {forecast:{}, geocode:0, wmsMetadata:0, wmsTiles:0, urls:{}};
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
  const forecast = url => {
    const model = new URL(url).searchParams.get('models');
    const count = model==='icon_d2'?48:120, past = Number(new URL(url).searchParams.get('past_hours')||0);
    const n = Array.from({length:count+past}, (_,i) => i-past), offset = {icon_d2:0, icon_eu:4, icon_global:-2}[model];
    return {latitude:51.51, longitude:7.46, timezone:'Europe/Berlin', hourly:{
      time:n.map(i => anchor+3600*i),
      temperature_2m:n.map(i => Math.round((12+offset+6*Math.sin(i/6))*10)/10),
      precipitation:n.map(i => Math.round(Math.max(0,2*Math.sin((i+offset)/4))*10)/10),
      wind_speed_10m:n.map(i => Math.round(12+4*Math.cos(i/7))),
      wind_direction_10m:n.map(() => 180), cloud_cover:n.map(i => Math.round(55+40*Math.sin(i/5))),
      relative_humidity_2m:n.map(() => 70), pressure_msl:n.map(() => 1013)}};
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
    if (url.includes('/v1/dwd-icon')) {
      const model = new URL(url).searchParams.get('models');
      counters.forecast[model] = (counters.forecast[model]||0) + 1;
      if (window.__mockD2OfflinePoint && model==='icon_d2') throw new DOMException('signal is aborted without reason', 'AbortError');
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


def input_range(page, selector, value):
    page.locator(selector).evaluate('(input,value)=>{input.value=String(value);input.dispatchEvent(new Event("input",{bubbles:true}));}', value)


def touch_drag(page, dx, dy):
    b = page.locator('#map').bounding_box()
    x = b['x'] + b['width'] * .43; y = b['y'] + b['height'] * .56
    c = page.context.new_cdp_session(page)
    c.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y, 'id': 1}]})
    c.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x + dx / 2, 'y': y + dy / 2, 'id': 1}]})
    c.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x + dx, 'y': y + dy, 'id': 1}]})
    c.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.wait_for_timeout(50)


def two_finger_pan_and_pinch(page):
    b = page.locator('#map').bounding_box()
    x = b['x'] + b['width'] * .5; y = b['y'] + b['height'] * .65
    c = page.context.new_cdp_session(page)
    start = [{'x': x - 22, 'y': y, 'id': 1}, {'x': x + 22, 'y': y, 'id': 2}]
    end = [{'x': x - 68, 'y': y + 18, 'id': 1}, {'x': x + 68, 'y': y + 18, 'id': 2}]
    c.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': start})
    c.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': end})
    c.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.wait_for_timeout(60)


EXPECTED_CODE = '(c,r,f)=>(c*2+r*3+f*5)%250+1'


def check_exact_codes(page, latitude, longitude, grid):
    """Decoded value at a point through the WebGL path equals the fixture formula."""
    result = page.evaluate('''async([lat,lon,g,formula])=>{
      const code=eval(formula),o=openwetterTest,d=o.currentDisplay(),frame=d.iconFrame||d.radarFrame;
      const sample=await o.sampleAt(lat,lon);
      const col=Math.round((lon-g.west)/g.lon),row=Math.round((g.north-lat)/g.lat);
      return {sample,expected:code(col,row,frame.index),index:frame.index};
    }''', [latitude, longitude, grid, EXPECTED_CODE])
    assert result['sample']['code'] == result['expected'], result
    return result


def ui(kind, viewport, browser):
    page, errors = new_page(browser, viewport, mobile=kind == 'mobile')
    page.wait_for_function('window.openwetterTest?.state.forecast?.hourly?.time?.length===48&&openwetterTest.state.icon')
    state = lambda expr: page.evaluate('window.openwetterTest.state.' + expr)
    assert page.locator('#locationName').inner_text() == 'Dortmund, Germany'
    assert page.locator('#graphStack .plot-row').count() == 4
    assert page.locator('#graphStack .plot-cursor').count() == 4
    assert state('model') == 'icon_d2'
    assert '°' in page.locator('#heroTemp').inner_text()
    assert page.evaluate('window.__mockCounts().forecast.icon_d2') == 1
    assert page.evaluate('openwetterTest.renderer.kind') in ('webgl2', 'webgl'), 'WebGL renderer unavailable'
    if kind == 'mobile':
        geometry = page.evaluate('''()=>{
          const row=document.querySelector('.header-line');
          return {width:innerWidth,rects:[...row.children].map(x=>{const r=x.getBoundingClientRect();return {left:r.left,right:r.right};})};
        }''')
        bounds = geometry['rects']
        assert all(0 <= v['left'] and v['right'] <= geometry['width'] + 1 for v in bounds), geometry
        assert all(bounds[i]['right'] <= bounds[i + 1]['left'] + 2 for i in range(len(bounds) - 1)), geometry
        for width in [320, 360, 390]:
            page.set_viewport_size({'width': width, 'height': 844})
            m = page.evaluate('''()=>[...document.querySelector('.header-line').children].map(x=>({left:x.getBoundingClientRect().left,right:x.getBoundingClientRect().right}))''')
            assert all(0 <= v['left'] and v['right'] <= width + 1 for v in m), (width, m)
            assert all(m[i]['right'] <= m[i + 1]['left'] + 2 for i in range(len(m) - 1)), (width, m)
    assert not errors, errors

    # The layer menu lists the radar, the nowcast and all 13 ICON-D2 layers.
    page.locator('#layersBtn').click()
    assert page.locator('#layerPanel').is_visible()
    values = page.locator('#layerList input[name="mapLayer"]').evaluate_all('els=>els.map(e=>e.value)')
    assert values[:3] == ['timeline', 'radar', 'nowcast'], values
    assert len(values) == 16, values
    assert page.locator('#layerList input[value="precip"]').is_checked()
    page.locator('#layerList input[value="temperature"]').check()
    page.locator('#closeLayers').click()
    assert state('iconLayer') == 'temperature'
    assert 'ICON-D2 temperature' in page.locator('#mapLayerName').inner_text()
    assert '°C' in page.locator('#mapLegend').inner_text()
    assert 'hourly' in page.locator('#timeRange').inner_text()

    # Time indicator moves; the four plotted graphs do not scroll (hourly layer: one slider step = 1 h).
    bounds = page.evaluate('openwetterTest.timeBounds()')
    assert bounds['min'] == state('anchor')
    input_range(page, '#timeSlider', 20)
    assert (state('selectedTime') - state('anchor')) / 3600 == 20
    expected = 20 * 3600 / (bounds['max'] - bounds['min']) * 100
    page.wait_for_function(f'Math.abs(parseFloat(document.querySelector(".plot-cursor").style.left)-{expected})<0.05')
    positions = page.locator('.plot-cursor').evaluate_all('(els)=>els.map(e=>e.style.left)')
    assert len(set(positions)) == 1, positions
    # Exact codes through decode -> texture -> per-fragment Mercator->lat/lon -> readback.
    page.wait_for_function('document.querySelector("#iconCanvas").dataset.weatherFrame?.startsWith("icon:")')
    grid = {'west': 4, 'north': 56, 'lon': .25, 'lat': .2}
    check_exact_codes(page, 51.5142, 7.4653, grid)
    check_exact_codes(page, 48.137, 11.575, grid)
    check = page.evaluate('openwetterTest.selfCheckVisible()')
    assert check['ok'] and check['mismatches'] == 0 and check['checked'] == 40 * 45, check
    # Past days: the map of earlier runs. The history index loads only when asked for.
    history_urls = 'Object.keys(window.__mockCounts().urls).filter(u=>u.includes("/history/"))'
    assert page.evaluate(history_urls) == []
    page.click('#horizonPast')
    page.wait_for_function('openwetterTest.state.history?.slices?.length===3')
    assert state('pastModel') is True
    assert page.locator('#horizonPast').get_attribute('aria-pressed') == 'true'
    step = 900 if state('iconLayer') in ('precip', 'snow') else 3600
    past = page.evaluate('openwetterTest.timeBounds()')
    assert past['max'] == state('anchor'), past
    assert past['min'] == state('icon.runTime') - 3 * 10800 + step, (past, 'earliest slice start')
    assert page.evaluate('openwetterTest.chartBounds().min') == state('anchor'), 'charts keep the forecast window'
    page.evaluate('openwetterTest.setSelectedTime(openwetterTest.state.icon.runTime-4*3600)')
    page.wait_for_function('document.querySelector("#iconCanvas").dataset.weatherFrame?.startsWith("icon-history:")')
    check_exact_codes(page, 51.5142, 7.4653, grid)
    assert page.locator('#mapLayerName').inner_text().startswith('PAST'), page.locator('#mapLayerName').inner_text()
    assert page.locator('.plot-cursor').first.evaluate('e=>e.style.visibility') == 'hidden'
    page.click('#horizon48')
    assert state('pastModel') is False and state('selectedTime') == state('anchor')
    page.wait_for_function('document.querySelector("#iconCanvas").dataset.weatherFrame?.startsWith("icon:")')
    input_range(page, '#timeSlider', 0)
    if kind == 'mobile':
        touch_drag(page, 100, 0)
        slow = (state('selectedTime') - state('anchor')) / 3600
        assert 3 <= slow <= 5, f'Horizontal scrub expected ≈4h, got {slow}'
        input_range(page, '#timeSlider', 0)
        touch_drag(page, 0, -100)
        fast = (state('selectedTime') - state('anchor')) / 3600
        assert 22 <= fast <= 26, f'Vertical scrub expected ≈24h, got {fast}'
        input_range(page, '#timeSlider', 0)
        old_zoom = state('map.zoom')
        two_finger_pan_and_pinch(page)
        assert state('map.zoom') > old_zoom, 'Two-finger pinch did not zoom the map'
    else:
        start = state('map.longitude')
        b = page.locator('#map').bounding_box()
        x = b['x'] + b['width'] * .45; y = b['y'] + b['height'] * .57
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 120, y + 18, steps=4); page.mouse.up()
        assert abs(state('map.longitude') - start) > .01

    # Clicking a fixed graph selects its absolute forecast time without scrolling it.
    row = page.locator('#graphStack .plot-body').first
    rect = row.bounding_box()
    page.mouse.click(rect['x'] + rect['width'] * .6, rect['y'] + rect['height'] * .5)
    target = bounds['min'] + .6 * (bounds['max'] - bounds['min'])
    assert abs(state('selectedTime') - target) <= 3600
    input_range(page, '#timeSlider', 0)

    # Independent sensitivity sliders persist and affect gestures immediately.
    page.locator('#settingsBtn').click()
    assert page.locator('#settingsPanel').is_visible()
    input_range(page, '#horizontalSpeed', 10)
    input_range(page, '#verticalSpeed', 48)
    assert state('horizontalHours') == 10 and state('verticalHours') == 48
    assert '"horizontalHours":10' in page.evaluate('localStorage.getItem("openwetter.settings.v2")')
    page.locator('#settingsBtn').click()
    if kind == 'mobile':
        touch_drag(page, 100, 0)
        assert 9 <= (state('selectedTime') - state('anchor')) / 3600 <= 11
        input_range(page, '#timeSlider', 0)
        touch_drag(page, 0, -100)
        assert state('selectedTime') == page.evaluate('openwetterTest.timeBounds().max')
        input_range(page, '#timeSlider', 0)

    # Compare models: same timestamp + same cursor across three different forecasts.
    page.locator('#viewCompare').click()
    page.wait_for_function('Object.keys(openwetterTest.state.forecasts).length===3')
    assert page.locator('.compare-row').count() == 3
    assert page.locator('#map').is_hidden()
    for model in ['icon_eu', 'icon_global']:
        assert state(f'forecasts.{model}.hourly.time.length') == 120
    input_range(page, '#timeSlider', 10)
    compare_times = page.locator('.plot-cursor').evaluate_all('(els)=>els.map(e=>e.style.left)')
    assert len(set(compare_times)) == 1, compare_times
    assert state('selectedTime') == state('anchor') + 36000
    assert state('forecasts.icon_eu.hourly.temperature_2m[0]') != state('forecasts.icon_d2.hourly.temperature_2m[0]')
    page.screenshot(path=str(CAPTURES / f'{kind}_compare.png'), full_page=True)

    page.locator('#horizon120').click()
    page.locator('#modelSelect').select_option('icon_eu')
    input_range(page, '#timeSlider', 100)
    assert state('selectedTime') == state('anchor') + 100 * 3600
    vals = page.locator('.compare-values').all_inner_texts()
    assert vals[0].startswith('—'), vals
    assert not vals[1].startswith('—'), vals
    page.locator('#modelSelect').select_option('icon_d2')

    # Drawer: switch an actual saved city, and search for a new city.
    page.locator('#placesBtn').click()
    assert page.locator('#placesDrawer').is_visible()
    page.locator('#placesList .choose-place', has_text='Rostock').click()
    page.wait_for_function('openwetterTest.state.place.name.includes("Rostock")')
    assert page.locator('#placesDrawer').is_hidden()
    page.wait_for_function('Object.keys(openwetterTest.state.forecasts).length===3')
    page.locator('#citySearch').fill('Bonn')
    page.locator('#searchForm').evaluate('(form)=>form.requestSubmit()')
    page.wait_for_function('openwetterTest.state.place.name.startsWith("Bonn")')
    page.locator('#placesBtn').click()
    page.locator('#savePlace').click()
    assert page.locator('#placesList .choose-place', has_text='Bonn').count() == 1
    page.locator('#closePlaces').click()

    # ICON-EU rain uses the official DWD hourly WMS, never mislabelled as ICON-D2.
    page.evaluate('openwetterTest.selectMapLayer("precip")')
    page.locator('#modelSelect').select_option('icon_eu')
    assert state('model') == 'icon_eu'
    page.locator('#viewForecast').click()
    assert page.locator('#graphStack .plot-row').count() == 4
    assert page.locator('#map').is_visible()
    assert page.locator('#modelDescription').inner_text().startswith('ICON-EU')
    page.wait_for_function('openwetterTest.state.euWms?.kind==="icon_eu_wms"')
    page.wait_for_function('window.__mockCounts().wmsTiles>0')
    assert 'ICON-EU hourly rain' in page.locator('#mapLayerName').inner_text()
    assert 'ICON-EU' in page.locator('#timeRange').inner_text()
    assert page.locator('#mapLegend').is_hidden()

    # Observation overlays keep their own timestamps.
    previous_time = state('selectedTime')
    page.locator('#toggleClouds').click()
    assert page.locator('#toggleClouds').get_attribute('aria-pressed') == 'true'
    page.wait_for_function('document.querySelectorAll("#cloudTiles img").length>0')
    url = page.locator('#cloudTiles img').first.get_attribute('src')
    assert 'Satellite_meteosat_1km_euat_rgb_clouds_day_and_night' in url, url
    assert 'Satellite © DWD' in page.locator('#radarAttribution').inner_text()
    page.locator('#toggleClouds').click()
    page.wait_for_function('document.querySelectorAll("#cloudTiles img").length===0')
    page.locator('#toggleRain').click()
    assert page.locator('#toggleRain').get_attribute('aria-pressed') == 'true'
    page.wait_for_function('openwetterTest.state.displayedRadarTime===openwetterTest.state.radar.latest')
    assert 'Radar © DWD' in page.locator('#radarAttribution').inner_text()
    assert 'Observations do not follow ICON time' in page.locator('#mapModelName').inner_text()
    assert state('selectedTime') == previous_time
    page.locator('#toggleRain').click()
    page.wait_for_function('document.querySelector("#radarCanvas").hidden')

    # Radar history: its own time axis and up to two days of observed scans.
    page.locator('#modeRadar').click()
    assert 'OBSERVED RADAR' in page.locator('#mapLayerName').inner_text()
    assert page.locator('#forecastHorizonButtons').is_hidden()
    assert page.locator('#radarHistoryButtons').is_visible()
    assert page.locator('#toggleRain').is_hidden()
    assert 'mm/h' in page.locator('#mapLegend').inner_text()
    page.locator('#radarHours2').click()
    assert state('radarHours') == 2 and 'past 2h' in page.locator('#modeRadar').inner_text()
    page.locator('#radarHours48').click()
    assert state('radarHours') == 48 and 'past 2 days' in page.locator('#modeRadar').inner_text()
    info = page.evaluate('window.__mockInfo')
    times = page.evaluate('openwetterTest.state.radar.frames.map(f=>f.time)')
    assert info['c0'] + 3 * 300 not in times, 'A missing radar scan was invented'
    assert times[-1] == info['latest']
    page.wait_for_function('openwetterTest.state.displayedRadarTime===openwetterTest.state.radar.latest')
    page.wait_for_function('''(()=>{const c=document.querySelector('#radarCanvas');
      return c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data[3]>0;})()''')
    check_exact_codes(page, 51.0, 7.0, {'west': 4, 'north': 56, 'lon': .1, 'lat': .1})
    page.wait_for_function("document.querySelector('#radarCanvas').dataset.weatherFrame==='radar:'+openwetterTest.state.radar.latest")
    assert page.locator('#smoothFrames').is_checked()
    # Delay an uncached chunk: the previous scan stays visible while it downloads.
    before = page.locator('#radarCanvas').evaluate('(canvas)=>canvas.toDataURL()')
    page.evaluate('window.__delayRadar=true')
    input_range(page, '#timeSlider', 5)
    assert state('radarIndex') == 5
    page.wait_for_timeout(240)
    assert state('displayedRadarTime') != state('radar.frames[5].time')
    assert before == page.locator('#radarCanvas').evaluate('(canvas)=>canvas.toDataURL()'), 'Radar vanished while loading'
    assert 'loading' in page.locator('#mapModelName').inner_text()
    page.evaluate('window.__releaseRadar()')
    page.wait_for_function('openwetterTest.state.displayedRadarTime===openwetterTest.state.radar.frames[5].time')
    assert 'loading' not in page.locator('#mapModelName').inner_text()
    page.wait_for_function('''()=>{const old=document.querySelector('#radarTransitionCanvas');
      return old.dataset.fromFrame&&old.dataset.toFrame==='radar:'+openwetterTest.state.radar.frames[5].time;}''')
    assert '260ms' in page.locator('#radarTransitionCanvas').evaluate('(c)=>c.style.transition')
    page.wait_for_timeout(310)
    assert page.locator('#radarTransitionCanvas').evaluate('(c)=>getComputedStyle(c).opacity') in ('0', '0.0')
    page.locator('#settingsBtn').click()
    page.locator('#smoothFrames').uncheck()
    page.locator('#settingsBtn').click()
    input_range(page, '#timeSlider', 4)
    page.wait_for_function('openwetterTest.state.displayedRadarTime===openwetterTest.state.radar.frames[4].time')
    assert page.locator('#radarTransitionCanvas').is_hidden(), 'Reduced animation mode must be an instant swap'
    # Scrubbing a whole chunk needs one tile transfer; after the GPU textures are
    # dropped, revisiting comes from the persistent compressed cache, not the network.
    for ix in range(0, 24):
        input_range(page, '#timeSlider', ix)
    chunk_url = f"https://openwetter-data.ekotov.pro/radar/c/{info['c0']}/0_0.webp"
    assert page.evaluate('(u)=>window.__mockCounts().urls[u]', chunk_url) == 1
    page.evaluate('openwetterTest.renderer.clear()')
    input_range(page, '#timeSlider', 30)
    input_range(page, '#timeSlider', 6)
    page.wait_for_function('openwetterTest.state.displayedRadarTime===openwetterTest.state.radar.frames[6].time')
    assert page.evaluate('(u)=>window.__mockCounts().urls[u]', chunk_url) == 1, 'Chunk tile downloaded twice'
    page.locator('#settingsBtn').click()
    page.locator('#smoothFrames').check()
    page.locator('#settingsBtn').click()
    assert 'Past ICON estimates' in page.locator('#plotsHeading').inner_text()
    assert 'past: ICON model' in page.locator('#graphStack .plot-row').first.inner_text()
    assert page.evaluate('openwetterTest.chartTime()') == state('radar.frames[6].time')

    # Rain sequence: observed radar, then the radar nowcast, then the model; each labelled.
    page.locator('#modeContinuous').click()
    combined = page.evaluate('openwetterTest.combinedFrames()')
    kinds = [f['kind'] for f in combined]
    assert kinds[0] == 'radar' and kinds[-1] == 'forecast'
    assert kinds.index('nowcast') > max(i for i, k in enumerate(kinds) if k == 'radar')
    assert kinds.index('forecast') > max(i for i, k in enumerate(kinds) if k == 'nowcast')
    assert all(combined[i]['time'] < combined[i + 1]['time'] for i in range(len(combined) - 1))
    assert 'OBSERVED RADAR' in page.locator('#timeRange').inner_text()
    first_nowcast = kinds.index('nowcast')
    page.wait_for_function("document.querySelector('#radarCanvas').dataset.weatherFrame?.startsWith('radar:')")
    page.evaluate('window.__delayRadar=true')
    input_range(page, '#timeSlider', first_nowcast)
    assert 'RADAR NOWCAST' in page.locator('#timeRange').inner_text()
    page.wait_for_timeout(240)
    # While the nowcast downloads the observed scan stays visible, and the map
    # label keeps describing that observation rather than the nowcast.
    assert 'OBSERVED RADAR' in page.locator('#mapLayerName').inner_text()
    assert 'loading nowcast' in page.locator('#mapModelName').inner_text()
    page.evaluate('window.__releaseRadar()')
    page.wait_for_function('document.querySelector("#radarCanvas").dataset.weatherFrame?.startsWith("nowcast:")')
    assert 'not observed' in page.locator('#mapLayerName').inner_text()
    assert 'loading' not in page.locator('#mapModelName').inner_text()
    first_forecast = kinds.index('forecast')
    input_range(page, '#timeSlider', first_forecast)
    assert 'ICON FORECAST' in page.locator('#timeRange').inner_text()
    assert page.locator('#boundaryTransitionCanvas').get_attribute('data-from-source') == 'radar'
    assert page.locator('#boundaryTransitionCanvas').get_attribute('data-to-source') == 'forecast'
    page.wait_for_function('document.querySelector("#boundaryTransitionCanvas").style.opacity==="0"')
    page.wait_for_timeout(450)

    # Official warnings: overlay for the selected time and a list for the selected place.
    page.locator('#modeForecast').click()
    page.locator('#modelSelect').select_option('icon_d2')
    page.locator('#horizon48').click()
    page.evaluate('''()=>{const s=openwetterTest.state;
      openwetterTest.setPlace({name:'Dortmund, Germany',latitude:51.5142,longitude:7.4653});
      openwetterTest.setSelectedTime(s.anchor+3600);}''')
    page.wait_for_function('!document.querySelector("#warningsList").hidden')
    assert 'FROST' in page.locator('#warningsList').inner_text()
    assert page.locator('#warningsCanvas').is_visible()
    page.locator('#layersBtn').click()
    page.locator('#toggleWarnings').uncheck()
    page.locator('#closeLayers').click()
    assert page.locator('#warningsCanvas').is_hidden()
    page.evaluate('openwetterTest.selectMapLayer("wind_direction")')
    page.wait_for_function('document.querySelector("#iconCanvas").dataset.weatherFrame?.includes(":wind_direction:")')
    page.evaluate('openwetterTest.renderMap()')
    page.screenshot(path=str(CAPTURES / f'{kind}.png'), full_page=True)
    assert not errors, errors
    print(f'{kind}: OK | renderer {page.evaluate("openwetterTest.renderer.kind")}/{page.evaluate("openwetterTest.renderer.format")}')
    page.context.close()


def verify_grid_series_survive_point_api_abort(browser):
    page, errors = new_page(browser, {'width': 390, 'height': 844}, mobile=True,
                            flags={'__mockD2OfflinePoint': True, '__mockSeries': True})
    page.wait_for_function('''()=>{
      const f=openwetterTest?.state?.forecasts?.icon_d2;
      return f?.fromRawGrid===true&&f?.gridOnly===true&&f?.hourly?.time?.length===192;
    }''')
    assert 'signal is aborted' not in page.locator('#message').inner_text().lower()
    assert page.locator('#graphStack .plot-row').count() == 4
    page.evaluate('openwetterTest.setSelectedTime(openwetterTest.state.anchor+3600)')
    assert page.locator('#heroTemp').inner_text() == '11°'
    assert page.locator('#quickCloud').inner_text() == '60%'
    assert page.locator('#quickRain').inner_text() == '0.8 mm'
    assert page.locator('#quickWind').inner_text() == '— km/h'
    assert page.evaluate('window.__mockCounts().urls').keys().__len__() > 0
    series_calls = page.evaluate('Object.keys(window.__mockCounts().urls).filter(u=>u.includes("/series/"))')
    assert len(series_calls) == 1, series_calls
    # The history index is fetched only for times before the newest run's first frame.
    history_calls = page.evaluate('Object.keys(window.__mockCounts().urls).filter(u=>u.includes("/history/"))')
    assert history_calls == [], history_calls
    # Restore the point API: it fills wind without replacing grid temperature/rain/cloud.
    page.evaluate('window.__mockD2OfflinePoint=false')
    page.evaluate('openwetterTest.selectModel("icon_d2")')
    page.wait_for_function('''()=>{const f=openwetterTest.state.forecasts.icon_d2;
      return f?.fromRawGrid===true&&f?.gridOnly===false&&f.hourly.wind_speed_10m.some(v=>typeof v==='number'&&v>0);}''')
    assert page.locator('#heroTemp').inner_text() == '11°'
    assert page.locator('#quickCloud').inner_text() == '60%'
    assert page.locator('#quickWind').inner_text() != '— km/h'
    # 15-minute ICON-D2 rain frames crossfade without inventing intermediate frames.
    page.wait_for_function("document.querySelector('#iconCanvas').dataset.weatherFrame?.startsWith('icon:')")
    page.evaluate('openwetterTest.setSelectedTime(openwetterTest.state.anchor+900)')
    page.wait_for_function('''()=>document.querySelector('#iconTransitionCanvas').dataset.toFrame?.endsWith(':'+openwetterTest.state.selectedTime)''')
    assert not errors, errors
    print('Grid chart series with point-API outage and recovery: OK')
    page.context.close()


def verify_missing_endpoints(browser):
    page, errors = new_page(browser, {'width': 390, 'height': 844}, mobile=True, flags={'__mock404': True})
    page.wait_for_function('window.openwetterTest?.state.forecast?.hourly?.time?.length===48')
    page.wait_for_function('openwetterTest.state.iconError&&openwetterTest.state.radarUnavailable')
    page.wait_for_timeout(300)
    assert page.locator('#modeRadar').is_hidden()
    assert page.locator('#toggleRain').is_hidden()
    assert page.locator('#warningsList').is_hidden()
    page.locator('#layersBtn').click()
    values = page.locator('#layerList input[name="mapLayer"]').evaluate_all('els=>els.map(e=>e.value)')
    assert 'radar' not in values and 'nowcast' not in values, values
    page.locator('#modeContinuous').click()
    assert page.evaluate('openwetterTest.combinedFrames().every(f=>f.kind==="forecast")')
    assert not errors, errors
    print('Missing tile-service endpoints hide features without errors: OK')
    page.context.close()


def main():
    with sync_playwright() as p:
        executable = (os.environ.get('OPENWETTER_CHROMIUM') or shutil.which('chromium') or
                      shutil.which('chromium-browser') or shutil.which('google-chrome') or p.chromium.executable_path)
        browser = p.chromium.launch(headless=True, executable_path=executable,
                                    args=['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
                                          '--use-angle=swiftshader', '--ignore-gpu-blocklist'])
        ui('mobile', {'width': 390, 'height': 844}, browser)
        ui('desktop', {'width': 1440, 'height': 900}, browser)
        verify_grid_series_survive_point_api_abort(browser)
        verify_missing_endpoints(browser)
        browser.close()


if __name__ == '__main__':
    main()

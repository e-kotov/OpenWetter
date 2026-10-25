"""Publish native-detail, high-resolution ICON-D2 fields for OpenWetter.

Downloads real DWD v1 native triangular mesh GRIB2 and samples onto a
0.0125-degree lat/lon raster (oversampling native ~2.1 km resolution).
Rain retains native fifteen-minute accumulations and 0.01 mm precision.
Cloud and air temperature are hourly. All point series share these pixels.

This is a display regridding, *not* a claim of increased forecast resolution.
"""
from __future__ import annotations

import concurrent.futures as cf
import gzip
import json
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin
from urllib.request import Request, urlopen

import numpy as np
from scipy.spatial import cKDTree

ROOT = 'https://opendata.dwd.de/weather/nwp/v1/m/icon-d2/p/'
WEST, EAST, SOUTH, NORTH = 4., 16., 47., 56.
CELL_DEG = .0125
WIDTH, HEIGHT = 961, 721
HOURS = 49
QUARTERS = 193
BLOCK = 80  # exactly 1 geographic degree per point-series block
FIELDS = ('CLAT', 'CLON', 'CLCT', 'TOT_PREC', 'T_2M')
FILL16 = np.uint16(65535)
FILL8 = np.uint8(255)

class AnchorParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            href = dict(attrs).get('href')
            if href and href not in ('../', './') and not href.startswith('?'):
                self.hrefs.append(href)

def links(url):
    with urlopen(Request(url, headers={'User-Agent': 'OpenWetter/0.2 (noncommercial weather viewer)'}), timeout=75) as res:
        html = res.read().decode('utf8')
    parser = AnchorParser()
    parser.feed(html)
    return parser.hrefs

def latest_complete_run():
    roots = {}
    for key in FIELDS:
        base = ROOT + key + '/r/'
        roots[key] = {}
        for href in links(base):
            stamp = unquote(href).strip('/')
            if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}', stamp):
                roots[key][stamp] = urljoin(base, href) + 's/'
    available = set.intersection(*(set(v) for v in roots.values()))
    for stamp in sorted(available, reverse=True):
        full = {key: roots[key][stamp] for key in FIELDS}
        if ('PT048H00M.grib2' in links(full['CLCT'])
                and 'PT048H00M.grib2' in links(full['TOT_PREC'])
                and 'PT000H15M.grib2' in links(full['TOT_PREC'])
                and 'PT048H00M.grib2' in links(full['T_2M'])):
            print('Complete official ICON-D2 run', stamp, flush=True)
            return stamp, full
    raise RuntimeError('No complete ICON-D2 run with fifteen-minute rain and hourly clouds')

def load_grib(directory, step, field):
    filename = 'PT000H00M.grib2' if field in ('CLAT', 'CLON') else f'PT{step//4:03}H{(step%4)*15:02}M.grib2'
    if field in ('CLCT', 'T_2M'):
        assert step % 4 == 0, 'Hourly-only field requested at fifteen-minute step'
    url = urljoin(directory, filename)
    with urlopen(Request(url, headers={'User-Agent': 'OpenWetter/0.2'}), timeout=100) as res:
        raw = res.read()
    if not raw.startswith(b'GRIB'):
        raise ValueError('Invalid DWD GRIB2 record: ' + url)
    import eccodes as ec
    with tempfile.TemporaryFile() as stream:
        stream.write(raw)
        stream.seek(0)
        handle = ec.codes_grib_new_from_file(stream)
        if handle is None:
            raise ValueError('Empty GRIB2 record: ' + url)
        try:
            data = np.array(ec.codes_get_array(handle, 'values'), dtype=np.float32)
            data[(~np.isfinite(data)) | (data >= 9990)] = np.nan
            unit = str(ec.codes_get(handle, 'units'))
            step_type = str(ec.codes_get(handle, 'stepType'))
            step_range = str(ec.codes_get(handle, 'stepRange'))
            validity = (int(ec.codes_get(handle, 'dataDate')), int(ec.codes_get(handle, 'dataTime')))
        finally:
            ec.codes_release(handle)
    return data, unit, step_type, step_range, validity

def encode_native(values, field):
    """Preserve the precipitation/radar hundredth-of-mm resolution."""
    if field == 'cloud':
        return np.where(np.isfinite(values), np.clip(np.rint(values), 0, 100), FILL8).astype(np.uint8)
    if field == 'temp':
        # Store in Celsius with 0.01 C resolution and an offset of +100 C.
        return np.where(np.isfinite(values), np.clip(np.rint((values - 273.15 + 100)*100), 0, 65534), FILL16).astype('<u2')
    if field == 'precip':
        return np.where(np.isfinite(values), np.clip(np.rint(values*100), 0, 65534), FILL16).astype('<u2')
    raise ValueError(field)

def write_gzip(path, binary):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(binary, compresslevel=6, mtime=0))

def block_bounds(tx, ty):
    r0, c0 = ty*BLOCK, tx*BLOCK
    r1, c1 = min(r0+BLOCK, HEIGHT), min(c0+BLOCK, WIDTH)
    if tx == 11: c1 = WIDTH
    if ty == 8: r1 = HEIGHT
    return r0, r1, c0, c1

def point_series_tiles(root, precip, cloud, temp):
    """Pack a compact 1-degree point-series tile for arbitrary clicked locations.

    Layout in gzip'd binary is precipitation 193 uint16 frames, clouds 49 uint8
    frames, temperature 49 uint16 frames, each time-major/row-major. A phone
    fetches ONE series tile for charts instead of hundreds of map images.
    """
    for ty in range(9):
        for tx in range(12):
            r0, r1, c0, c1 = block_bounds(tx, ty)
            segments = [
                np.asarray(precip[:, r0:r1, c0:c1], dtype='<u2').tobytes(),
                np.asarray(cloud[:, r0:r1, c0:c1], dtype=np.uint8).tobytes(),
                np.asarray(temp[:, r0:r1, c0:c1], dtype='<u2').tobytes(),
            ]
            write_gzip(root/f'series/{tx:02d}/{ty:02d}.bin.gz', b''.join(segments))
    print('Published 108 point-series tiles', flush=True)

def build(directory='icon-data'):
    directory = Path(directory)
    stamp, roots = latest_complete_run()
    initialization = datetime.strptime(stamp, '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc)-initialization>timedelta(hours=12):
        raise RuntimeError('Latest complete forecast is more than 12 hours old')
    latitude, _, _, _, _ = load_grib(roots['CLAT'], 0, 'CLAT')
    longitude, _, _, _, _ = load_grib(roots['CLON'], 0, 'CLON')
    if len(latitude) < 500_000 or latitude.shape != longitude.shape:
        raise ValueError('Invalid native ICON-D2 triangular mesh')
    xx = np.linspace(WEST, EAST, WIDTH, dtype=np.float32)
    yy = np.linspace(NORTH, SOUTH, HEIGHT, dtype=np.float32)
    lon, lat = np.meshgrid(xx, yy)
    scale = float(np.cos(np.deg2rad(51.5)))
    query = np.column_stack((lon.ravel()*scale, lat.ravel()))
    native = np.column_stack((longitude*scale, latitude))
    distance, nearest = cKDTree(native).query(query, workers=-1)
    mask = distance <= 0.04
    coverage = float(np.mean(mask))
    print('Native cells',len(latitude),'display grid',WIDTH,HEIGHT,'coverage',coverage,flush=True)
    if coverage < .95:
        raise RuntimeError('ICON-D2 native mesh fails spatial coverage check')
    # Disk-based arrays bound RAM while retaining all 193 rain time steps.
    directory.mkdir(parents=True, exist_ok=True)
    precip = np.memmap(directory/'.precip.work', mode='w+', dtype='<u2', shape=(QUARTERS, HEIGHT, WIDTH))
    clouds = np.memmap(directory/'.cloud.work', mode='w+', dtype=np.uint8, shape=(HOURS, HEIGHT, WIDTH))
    temp = np.memmap(directory/'.temp.work', mode='w+', dtype='<u2', shape=(HOURS, HEIGHT, WIDTH))
    def fetch(item):
        field, lead = item
        source, unit, kind, interval, _ = load_grib(roots[field], lead, field)
        if source.shape != latitude.shape: raise ValueError('Variable mesh mismatch '+field)
        if field=='TOT_PREC':
            if kind!='accum' or unit not in ('kg m**-2','kg m-2','mm','kg m**-2 (water equivalent)'):
                raise ValueError(f'Unexpected fifteen-minute precipitation metadata {unit} {kind} {interval}')
        pixel = np.full(WIDTH*HEIGHT, np.nan, np.float32)
        pixel[mask] = source[nearest[mask]]
        label = {'TOT_PREC':'precip', 'CLCT':'cloud', 'T_2M':'temp'}[field]
        return field,lead,encode_native(pixel.reshape(HEIGHT,WIDTH),label)
    work = [('TOT_PREC',i) for i in range(QUARTERS)]
    work += [(field,i*4) for field in ('CLCT','T_2M') for i in range(HOURS)]
    # Limit concurrency to avoid overwhelming the public DWD server.
    with cf.ThreadPoolExecutor(max_workers=5) as pool:
        for n,(field,lead,frame) in enumerate(pool.map(fetch,work)):
            if field == 'TOT_PREC':
                precip[lead] = frame
                path = directory/f'frames/precip/{lead:03d}.bin.gz'
            elif field == 'CLCT':
                clouds[lead//4] = frame
                path = directory/f'frames/cloud/{lead//4:03d}.bin.gz'
            else:
                temp[lead//4] = frame
                path = directory/f'frames/temp/{lead//4:03d}.bin.gz'
            write_gzip(path, frame.tobytes())
            if n % 24 == 0: print('Processed fields',n+1,'/',len(work),flush=True)
    precip.flush(); clouds.flush();temp.flush()
    point_series_tiles(directory, precip, clouds, temp)
    times = [(initialization+timedelta(minutes=i*15)).timestamp() for i in range(QUARTERS)]
    manifest = {
        'schema':2,'provider':'DWD', 'model':'ICON-D2', 'run':stamp,
        'generated_at':datetime.now(timezone.utc).isoformat(),
        'bbox':[WEST,SOUTH,EAST,NORTH], 'width':WIDTH,'height':HEIGHT,
        'pixel_degrees':CELL_DEG,
        'resolution_note':'0.0125 degree sampling of native ~2 km ICON-D2 triangular mesh; no increased native information',
        'precipitation':{'interval_minutes':15,'unit':'mm per 15 minutes','type':'uint16-le','scale':.01,'missing':65535,'count':QUARTERS,'path':'frames/precip/{index:03d}.bin.gz'},
        'cloud':{'interval_minutes':60,'unit':'percent','type':'uint8','scale':1,'missing':255,'count':HOURS,'path':'frames/cloud/{index:03d}.bin.gz'},
        'temp':{'interval_minutes':60,'unit':'degrees Celsius','type':'uint16-le','scale':.01,'offset':-100,'missing':65535,'count':HOURS,'path':'frames/temp/{index:03d}.bin.gz'},
        'point_series':{'size':BLOCK,'tiles_x':12,'tiles_y':9,'path':'series/{x:02d}/{y:02d}.bin.gz'},
        'start':int(times[0]), 'end':int(times[-1]),
    }
    (directory/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (directory/'.precip.work').unlink();(directory/'.cloud.work').unlink();(directory/'.temp.work').unlink()
    print('Built manifest, frames and native-derived point series:',sum(f.stat().st_size for f in directory.rglob('*.gz')),'bytes',flush=True)
    return manifest

if __name__ == '__main__':
    build(os.environ.get('ICON_OUTPUT','icon-data'))

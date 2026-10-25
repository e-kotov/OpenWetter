"""Download and downsample genuine DWD ICON-D2 grids for map + point forecasts.

The browser receives exactly the same spatial fields used to plot precipitation,
cloud-cover and temperature. The output is a gzip-compressed 0.05-degree sampled
raster rather than ICON-D2's full native 2 km mesh.
"""
from __future__ import annotations
import concurrent.futures
import base64
import gzip
import json
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin
from urllib.request import Request, urlopen
import numpy as np
from scipy.spatial import cKDTree
import eccodes as ec

ROOT='https://opendata.dwd.de/weather/nwp/v1/m/icon-d2/p/'
# Fixed geographic area: most of Germany and adjacent regions.
WEST,EAST,SOUTH,NORTH=4.0,16.0,47.0,56.0
WIDTH,HEIGHT=241,181       # 0.05 degree; sampled resolution ~3.5-5.5 km
N=WIDTH*HEIGHT
VARIABLES=('CLAT','CLON','CLCT','TOT_PREC','T_2M')
HOURS=49

class Anchors(HTMLParser):
    def __init__(self): super().__init__();self.hrefs=[]
    def handle_starttag(self,tag,attrs):
        if tag=='a':
            href=dict(attrs).get('href')
            if href and href not in ('../','./') and not href.startswith('?'):
                self.hrefs.append(href)

def links(url):
    with urlopen(Request(url,headers={'User-Agent':'OpenWetter/0.1 (research noncommercial)'}),timeout=45) as response:
        page=response.read().decode('utf-8')
    parser=Anchors();parser.feed(page)
    return parser.hrefs

def runs(variable):
    result={}
    root=ROOT+variable+'/r/'
    for href in links(root):
        stamp=unquote(href).rstrip('/')
        if re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d',stamp):
            result[stamp]=urljoin(root,href)+'s/'
    return result

def common_run():
    available={v:runs(v) for v in VARIABLES}
    common=set.intersection(*(set(r) for r in available.values()))
    if not common:raise RuntimeError('DWD has no common ICON-D2 run across required fields')
    # prefer a run with all 49 lead hours (latest may not have uploaded yet)
    for stamp in sorted(common,reverse=True):
        root=available['CLCT'][stamp]
        files=links(root)
        if 'PT048H00M.grib2' in files and 'PT000H00M.grib2' in files:
            print('Selected complete ICON-D2 run',stamp,flush=True)
            return stamp,{v:available[v][stamp] for v in VARIABLES}
    raise RuntimeError('No completed 48-hour ICON-D2 forecast run')

def get_grib(base,lead,variable):
    url=base+('PT000H00M.grib2' if variable in ('CLAT','CLON') else f'PT{lead:03d}H00M.grib2')
    with urlopen(Request(url,headers={'User-Agent':'OpenWetter/0.1'}),timeout=100) as response:
        payload=response.read()
    if not payload.startswith(b'GRIB'):raise ValueError(f'Not GRIB2: {url}')
    with tempfile.TemporaryFile() as buffer:
        buffer.write(payload);buffer.seek(0)
        handle=ec.codes_grib_new_from_file(buffer)
        if handle is None:raise ValueError(f'Missing GRIB field: {url}')
        try:
            data=np.asarray(ec.codes_get_array(handle,'values'),dtype=np.float32)
            # For the new DWD v1 feed, missing cells currently decode as 9999.
            data[~np.isfinite(data) | (data>=9990)]=np.nan
            unit=str(ec.codes_get(handle,'units'))
            step=str(ec.codes_get(handle,'stepRange'))
        finally:ec.codes_release(handle)
    return data,unit,step

def build(outdir):
    stamp,roots=common_run()
    start=datetime.strptime(stamp,'%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)
    lats,latunit,_=get_grib(roots['CLAT'],0,'CLAT')
    lons,lonunit,_=get_grib(roots['CLON'],0,'CLON')
    if len(lats)!=len(lons):raise ValueError('Coordinate arrays do not match')
    if len(lats)<500_000:raise ValueError('Unexpectedly sparse ICON-D2 coordinates')
    xs=np.linspace(WEST,EAST,WIDTH,dtype=np.float32)
    ys=np.linspace(NORTH,SOUTH,HEIGHT,dtype=np.float32)
    lonmesh,latmesh=np.meshgrid(xs,ys)
    # Local metric approximation in degrees. Enough for nearest native cell,
    # not a conservative precipitation remap.
    factor=np.cos(np.radians(51.5))
    sample=np.c_[lonmesh.ravel()*factor,latmesh.ravel()]
    native=np.c_[lons*factor,lats]
    tree=cKDTree(native)
    distance,index=tree.query(sample,workers=-1)
    mask=distance<=0.055
    print('Remap coverage',np.mean(mask),'grid',WIDTH,HEIGHT,flush=True)
    if np.mean(mask)<.92:raise ValueError('More than 8% of display domain outside ICON coverage')
    frames=[]
    for hour in range(HOURS):
        def fetch(field):return field,get_grib(roots[field],hour,field)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            inputs=dict(pool.map(fetch,('CLCT','TOT_PREC','T_2M')))
        packed={}
        for variable in ('CLCT','TOT_PREC','T_2M'):
            data,unit,step=inputs[variable]
            if len(data)!=len(lats):raise ValueError(f'Grid mismatch {variable}, hour {hour}')
            sampled=np.full(N,np.nan,dtype=np.float32)
            sampled[mask]=data[index[mask]]
            if variable=='T_2M':
                # DWD GRIB 2 m temperatures are in Kelvin.
                if unit not in ('K','kelvin'):raise ValueError(f'Unrecognized temperature unit {unit}')
                sampled-=273.15
                scaled=np.round((sampled+50)*2)
            elif variable=='CLCT':
                # cloud percent, 0..100
                scaled=np.round(sampled)
            else:
                # TOT_PREC in this product represents one-hour accumulation at
                # integral steps. Validate this rather than silently treating
                # 48h cumulative precipitation as a 1h amount.
                if hour>0 and (not re.search(r'(?:^|[- ])'+str(hour)+r'(?:$|[hm])',step)):
                    raise ValueError(f'Unexpected precipitation step {hour}: {step!r}')
                if unit not in ('kg m**-2','kg m-2','mm','kg m**-2 (water equivalent)'):
                    raise ValueError(f'Unexpected precipitation unit {unit}')
                scaled=np.round(sampled*10) # tenths of mm
            packed[variable]=base64.b64encode(np.where(np.isfinite(scaled),np.clip(scaled,0,254),255).astype(np.uint8).tobytes()).decode("ascii")
        frames.append({'time':int((start+timedelta(hours=hour)).timestamp()),
                       'cloud':packed['CLCT'],'precip':packed['TOT_PREC'],'temp':packed['T_2M']})
        if hour%8==0:print('Prepared genuine ICON fields',hour,'of',HOURS-1,flush=True)
    payload={'schema':1,'provider':'DWD','model':'ICON-D2','run':stamp,
             'bbox':[WEST,SOUTH,EAST,NORTH],'width':WIDTH,'height':HEIGHT,
             'resolution_note':'Nearest-cell sampled 0.05-degree display raster, derived from native ICON-D2 GRIB2',
             'precipitation':'One-hour total precipitation in tenths of mm',
             'temperature':'Degrees Celsius, 0.5 degree units offset -50',
             'cloud':'Cloud percentage, 0-100',
             'missing':255,'frames':frames}
    dest=Path(outdir);dest.mkdir(parents=True,exist_ok=True)
    compressed=gzip.compress(json.dumps(payload,separators=(',',':')).encode(),compresslevel=9,mtime=0)
    (dest/'latest.json.gz').write_bytes(compressed)
    (dest/'manifest.json').write_text(json.dumps({'model':'icon_d2','run':stamp,'generated_at':datetime.now(timezone.utc).isoformat(),
          'bytes':len(compressed),'valid_from':frames[0]['time'],'valid_to':frames[-1]['time'],
          'width':WIDTH,'height':HEIGHT},indent=2)+'\n')
    print('Saved',len(compressed),'bytes to',dest,flush=True)

if __name__=='__main__':
    build('icon-data')

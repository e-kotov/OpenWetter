"""Publish genuine DWD RADOLAN RY 1 km / 5 minute observed rain frames.

Input: official ODIM-HDF5 RY files, quantity RATE, gain 0.01 mm/h.
The native 1km radar values are sampled onto 0.005-degree pixels (oversampling,
not inventing additional spatial information), preserving 0.01 mm/h values.
"""
from __future__ import annotations
import gzip
import io
import json
import os
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen

import h5py
import numpy as np
from pyproj import CRS, Transformer

URL='https://opendata.dwd.de/weather/radar/radolan/ry/'
WEST,EAST,SOUTH,NORTH=4.,16.,47.,56.
STEP=.005
WIDTH,HEIGHT=2401,1801
KEEP=24

class Links(HTMLParser):
    def __init__(self):super().__init__();self.hrefs=[]
    def handle_starttag(self,tag,attrs):
        if tag=='a':
            link=dict(attrs).get('href')
            if link:self.hrefs.append(link)

def get_bytes(url):
    with urlopen(Request(url,headers={'User-Agent':'OpenWetter/0.2 (noncommercial precipitation viewer)'}),timeout=90) as f:
        return f.read()

def observations():
    x=Links();x.feed(get_bytes(URL).decode('utf-8'))
    entries=[]
    for fn in x.hrefs:
        m=re.fullmatch(r'raa01-ry_10000-(\d{10})-dwd---bin\.hdf5',fn)
        if not m:continue
        t=datetime.strptime(m.group(1),'%y%m%d%H%M').replace(tzinfo=timezone.utc)
        entries.append((int(t.timestamp()),fn))
    entries.sort()
    if not entries:raise RuntimeError('DWD RY directory contains no timed frames')
    return entries[-KEEP:]

def metadata_and_values(binary):
    with h5py.File(io.BytesIO(binary),'r') as f:
        what=f['dataset1/data1/what'].attrs
        wh=f['where'].attrs
        field=f['dataset1/data1/data'][:]
        if field.shape!=(1200,1100) or field.dtype!=np.dtype('uint16'):
            raise ValueError(f'Unexpected DWD RY grid {field.shape} / {field.dtype}')
        quantity=what['quantity'].decode() if isinstance(what['quantity'],bytes) else str(what['quantity'])
        if quantity!='RATE' or abs(float(what['gain'])-.01)>1e-9 or float(what['offset'])!=0.0:
            raise ValueError('Unrecognized native RADOLAN RY units')
        if int(what['nodata'])!=65535 or abs(float(wh['xscale'])-1000)>1e-4 or abs(float(wh['yscale'])-1000)>1e-4:
            raise ValueError('Unrecognized native RADOLAN RY geometry')
        proj=wh['projdef']
        if isinstance(proj,bytes):proj=proj.decode()
        return field,proj

def radar_index(proj,latitude,longitude):
    """Transform lon/lat into ODIM-HDF5 radar array rows and columns.

    Radar UL pixel centre is projected (0,0); x increases rightward and y
    decreases downward by 1000 metres per cell (verified against ODIM corners).
    """
    transformer=Transformer.from_crs(CRS.from_epsg(4326),CRS.from_proj4(proj),always_xy=True)
    x,y=transformer.transform(longitude,latitude)
    cols=np.rint(x/1000).astype(np.int32)
    rows=np.rint(-y/1000).astype(np.int32)
    valid=(cols>=0)&(cols<1100)&(rows>=0)&(rows<1200)
    return rows,cols,valid

def build(directory='radar-data'):
    dest=Path(directory); dest.mkdir(parents=True,exist_ok=True)
    entries=observations()
    newest=entries[-1][0]
    age=int(datetime.now(timezone.utc).timestamp())-newest
    print('Official radar frames',len(entries),'most recent',datetime.fromtimestamp(newest,timezone.utc).isoformat(),
          'age seconds',age,flush=True)
    if age>3600:raise RuntimeError('DWD RY source is more than 60 minutes old; refuse publishing as live')
    xs=np.linspace(WEST,EAST,WIDTH,dtype=np.float64)
    ys=np.linspace(NORTH,SOUTH,HEIGHT,dtype=np.float64)
    lon,lat=np.meshgrid(xs,ys)
    mapping=None
    manifest_frames=[]
    for step,(timestamp,filename) in enumerate(entries):
        binary=get_bytes(URL+filename)
        field,proj=metadata_and_values(binary)
        if mapping is None:
            mapping=radar_index(proj,lat,lon)
            row,col,valid=mapping
            print('Radar coverage',np.mean(valid),'original grid',field.shape,'output',WIDTH,HEIGHT,flush=True)
            if np.mean(valid)<.80:raise ValueError('Radar projection georeferencing failed')
        row,col,valid=mapping
        grid=np.full((HEIGHT,WIDTH),65535,dtype='<u2')
        grid[valid]=field[row[valid],col[valid]]
        path=f'frames/{timestamp}.bin.gz'
        (dest/'frames').mkdir(parents=True,exist_ok=True)
        (dest/path).write_bytes(gzip.compress(grid.tobytes(),compresslevel=6,mtime=0))
        manifest_frames.append({'time':timestamp,'file':path})
        if step%5==0:print('Decoded 1km radar frame',step+1,'/',len(entries),flush=True)
    manifest={
        'schema':1,'provider':'DWD','product':'RADOLAN-RY','unit':'mm/h',
        'resolution_note':'Native 1 km polar-stereographic RADOLAN RY sampled to 0.005-degree display pixels',
        'native_grid_metres':1000,'display_degrees':STEP,
        'bbox':[WEST,SOUTH,EAST,NORTH], 'width':WIDTH,'height':HEIGHT,
        'encoding':'uint16-le', 'gain':.01,'nodata':65535,
        'generated_at':datetime.now(timezone.utc).isoformat(),
        'latest_age_seconds':age,'frames':manifest_frames,
    }
    (dest/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('Published',len(manifest_frames),'genuine DWD 5-minute radar records',
          sum(p.stat().st_size for p in (dest/'frames').glob('*.gz')),'compressed bytes',flush=True)
    return manifest

if __name__=='__main__':
    build(os.environ.get('RADAR_OUTPUT','radar-data'))

"""One-off DWD ICON model feed diagnostic; no approximated values."""
from __future__ import annotations
import os
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, unquote
from urllib.request import Request, urlopen

ROOT = 'https://opendata.dwd.de/weather/nwp/v1/m/icon-d2/p/'

class Anchors(HTMLParser):
    def __init__(self):
        super().__init__(); self.hrefs=[]
    def handle_starttag(self, tag, attrs):
        if tag=='a':
            d=dict(attrs)
            if d.get('href'): self.hrefs.append(d['href'])

def listing(url):
    with urlopen(Request(url,headers={'User-Agent':'OpenWetter/0.1 (ICON grid research)'}),timeout=35) as f:
        raw=f.read().decode('utf-8')
    p=Anchors();p.feed(raw)
    return [href for href in p.hrefs if href not in ('../','./') and not href.startswith('?')]

def latest_var_run(variable):
    url=f'{ROOT}{variable}/r/'
    names=listing(url)
    runs=sorted([x for x in names if re.match(r'^\d{4}-\d\d-\d\dT\d\d:\d\d/])
    print(variable,'hrefs',names[:35], 'runs',runs[-4:],flush=True)
    if not runs: return None
    return urljoin(url,runs[-1])

def probe(variable):
    import eccodes as ec
    url=latest_var_run(variable)
    if url is None:return
    names=listing(url)
    print(variable,'run entries',len(names),'examples',names[:12],flush=True)
    candidates=[n for n in names if n.lower().endswith(('.grib2','.grb2','.grib','.grb2.bz2','.grib2.bz2'))]
    if not candidates:
        print(variable,'no GRIB direct, subdirs', [n for n in names if n.endswith('/')][:15],flush=True)
        return
    chosen=candidates[min(1,len(candidates)-1)]
    url=urljoin(url,chosen)
    print(variable,'fetch',url,flush=True)
    with urlopen(Request(url,headers={'User-Agent':'OpenWetter/0.1'}),timeout=90) as f:payload=f.read()
    print(variable,'download',len(payload),'bytes',payload[:8],flush=True)
    if chosen.endswith('.bz2'):
        import bz2
        payload=bz2.decompress(payload)
    from io import BytesIO
    f=BytesIO(payload)
    h=ec.codes_grib_new_from_file(f)
    if h is None:raise RuntimeError('GRIB decode returned no fields')
    try:
        for key in ('gridType','shortName','name','stepRange','stepType','typeOfLevel','numberOfValues','Ni','Nj','dataDate','dataTime'):
            try: print(variable,key,ec.codes_get(h,key),flush=True)
            except Exception as e:print(variable,key,'n/a',str(e)[:100],flush=True)
        values=ec.codes_get_array(h,'values')
        import numpy as np
        print(variable,'values shape',values.shape,'min/max',np.nanmin(values),np.nanmax(values),'first',values[:5],flush=True)
        if variable=='CLCT':
            try:
                lat=ec.codes_get_array(h,'latitudes');lon=ec.codes_get_array(h,'longitudes');print(variable,'lat/lon',lat.shape,lon.shape,lat[:3],lon[:3],flush=True)
            except Exception as e:print(variable,'missing lonlat',repr(e)[:600],flush=True)
    finally:ec.codes_release(h)

if __name__=='__main__':
    for variable in ['CLCT','TOT_PREC','CLON','CLAT','T_2M']:
        try:probe(variable)
        except Exception as e:print(variable,'ERROR',repr(e),flush=True)
,unquote(x))])
    print(variable,'hrefs',names[:35], 'runs',runs[-4:],flush=True)
    if not runs: return None
    return urljoin(url,runs[-1])

def probe(variable):
    import eccodes as ec
    url=latest_var_run(variable)
    if url is None:return
    names=listing(url)
    print(variable,'run entries',len(names),'examples',names[:12],flush=True)
    candidates=[n for n in names if n.lower().endswith(('.grib2','.grb2','.grib','.grb2.bz2','.grib2.bz2'))]
    if not candidates:
        print(variable,'no GRIB direct, subdirs', [n for n in names if n.endswith('/')][:15],flush=True)
        return
    chosen=candidates[min(1,len(candidates)-1)]
    url=urljoin(url,chosen)
    print(variable,'fetch',url,flush=True)
    with urlopen(Request(url,headers={'User-Agent':'OpenWetter/0.1'}),timeout=90) as f:payload=f.read()
    print(variable,'download',len(payload),'bytes',payload[:8],flush=True)
    if chosen.endswith('.bz2'):
        import bz2
        payload=bz2.decompress(payload)
    from io import BytesIO
    f=BytesIO(payload)
    h=ec.codes_grib_new_from_file(f)
    if h is None:raise RuntimeError('GRIB decode returned no fields')
    try:
        for key in ('gridType','shortName','name','stepRange','stepType','typeOfLevel','numberOfValues','Ni','Nj','dataDate','dataTime'):
            try: print(variable,key,ec.codes_get(h,key),flush=True)
            except Exception as e:print(variable,key,'n/a',str(e)[:100],flush=True)
        values=ec.codes_get_array(h,'values')
        import numpy as np
        print(variable,'values shape',values.shape,'min/max',np.nanmin(values),np.nanmax(values),'first',values[:5],flush=True)
        if variable=='CLCT':
            try:
                lat=ec.codes_get_array(h,'latitudes');lon=ec.codes_get_array(h,'longitudes');print(variable,'lat/lon',lat.shape,lon.shape,lat[:3],lon[:3],flush=True)
            except Exception as e:print(variable,'missing lonlat',repr(e)[:600],flush=True)
    finally:ec.codes_release(h)

if __name__=='__main__':
    for variable in ['CLCT','TOT_PREC','CLON','CLAT','T_2M']:
        try:probe(variable)
        except Exception as e:print(variable,'ERROR',repr(e),flush=True)

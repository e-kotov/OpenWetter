"""Smoke-test binary weather products using the public URLs Android actually requests.
This catches malformed grids, CORS regressions, and publishing failures without
pretending to exercise the Android WebView itself.
"""
from __future__ import annotations
import gzip
import json
import struct
import sys
from urllib.request import Request, urlopen

BASE = 'https://raw.githubusercontent.com/e-kotov/OpenWetter/'


def fetch(branch: str, path: str) -> bytes:
    url = BASE + branch + '/' + path
    with urlopen(Request(url, headers={
        'User-Agent': 'OpenWetter-integration-verification/0.2',
        'Origin': 'https://appassets.androidplatform.net',
    }), timeout=90) as response:
        cors=response.headers.get('access-control-allow-origin')
        if cors not in ('*','https://appassets.androidplatform.net'):
            raise RuntimeError(f'Cross-origin frame unavailable in WebView: {url}, CORS={cors!r}')
        return response.read()


def binary(branch: str, path: str, expected: int) -> bytes:
    raw=gzip.decompress(fetch(branch,path))
    if len(raw)!=expected:
        raise ValueError(f'Incorrect raw bytes for {branch}/{path}: {len(raw)} instead of {expected}')
    return raw


def check_icon():
    m=json.loads(fetch('icon-data','manifest.json'))
    assert m['schema']==2 and m['model']=='ICON-D2' and m['width']==961 and m['height']==721
    assert m['precipitation']['count']==193 and m['precipitation']['interval_minutes']==15
    assert m['cloud']['count']==49 and m['temp']['count']==49
    count=m['width']*m['height']
    for field,index,unit in [('precipitation',4,2),('cloud',1,1),('temp',1,2)]:
        obj=m[field]
        data=binary('icon-data',obj['path'].replace('{index:03d}',f'{index:03d}'),count*unit)
        missing=255 if unit==1 else 65535
        if unit==1:
            valid=sum(value!=missing for value in data)
        else:
            valid=sum(1 for (value,) in struct.iter_unpack('<H',data) if value!=missing)
        assert valid/count>.90,(field,valid,count)
        print('ICON',field,'valid fraction',round(valid/count,3))
    series=m['point_series']
    x,y=5,4
    cols=series['size']
    rows=series['size']
    n=cols*rows
    b=binary('icon-data',series['path'].replace('{x:02d}',f'{x:02d}').replace('{y:02d}',f'{y:02d}'),
      n*(m['precipitation']['count']*2+m['cloud']['count']+m['temp']['count']*2))
    print('ICON point-series verified',len(b),'bytes; run',m['run'])


def check_radar():
    m=json.loads(fetch('radar-data','manifest.json'))
    assert m['schema']==1 and m['product']=='RADOLAN-RY'
    assert m['width']==2401 and m['height']==1801 and m['native_grid_metres']==1000
    stamps=[f['time'] for f in m['frames']]
    assert len(stamps)>=10 and all(b-a==300 for a,b in zip(stamps,stamps[1:])), 'Radar samples not 5 minutes apart'
    path=m['frames'][-1]['file']
    raw=binary('radar-data',path,m['width']*m['height']*2)
    valid=sum(1 for (v,) in struct.iter_unpack('<H',raw) if v!=65535)
    assert valid/len(raw)*2>.60
    print('DWD radar latest',stamps[-1],'valid fraction',round(valid/(m['width']*m['height']),3))


if __name__=='__main__':
    check_icon()
    check_radar()
    print('Published binary weather datasets verified with CORS + genuine encoded resolution')

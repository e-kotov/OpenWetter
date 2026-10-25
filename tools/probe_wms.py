"""Probe actual public DWD GeoServer WMS capabilities and tiny preview tiles."""
from __future__ import annotations
import datetime as dt
import math,struct
from urllib.parse import urlencode
from urllib.request import urlopen,Request
import xml.etree.ElementTree as ET

ROOT="https://maps.dwd.de/geoserver/dwd"
LAYERS=[
    "Icon-eu_reg00625_fd_sl_TOTPREC01H",
    "Icon-eu_reg00625_fd_sl_TOTPREC03H",
    "Icon-eu_reg00625_fd_sl_CLCT",
    "Icon-d2_reg002_fd_sl_TOTPREC01H",
    "Icon-d2_reg002_fd_sl_TOTPREC15M",
    "Icon-d2_reg002_fd_sl_CLCT",
]
def get(url,timeout=35,maxbytes=1_500_000):
    with urlopen(Request(url,headers={"User-Agent":"OpenWetter/0.3 (+https://github.com/e-kotov/OpenWetter)"}),timeout=timeout) as r:
        raw=r.read(maxbytes+1)
        if len(raw)>maxbytes:raise ValueError("over max response bytes")
        return r.status,r.headers.get("Content-Type"),raw
def nodes(parent,tag):
    return [x for x in parent.iter() if x.tag.split("}")[-1]==tag]
def fmt_meters(lon,lat):
    lat=max(-85.05,min(85.05,lat))
    return (6378137*math.radians(lon),6378137*math.log(math.tan(math.pi/4+math.radians(lat)/2)))
def run(layer):
    cap=ROOT+"/"+layer+"/wms?"+urlencode({"service":"WMS","request":"GetCapabilities","version":"1.3.0"})
    try: status,mime,payload=get(cap)
    except Exception as e:
        print(layer,"CAPS_FAIL",repr(e),flush=True)
        return
    print(layer,"CAPS",status,mime,len(payload),flush=True)
    root=ET.fromstring(payload)
    target=None
    for candidate in nodes(root,"Layer"):
        if any((n.text or "").strip().split(":")[-1]==layer for n in list(candidate) if n.tag.split("}")[-1]=="Name"):
            target=candidate;break
    if target is None:
        print(layer,"LAYER_NOT_PRESENT",[(e.text or "")[:80] for e in nodes(root,"ServiceException")],flush=True)
        return
    dims=[(x.attrib.get("name"),x.attrib.get("default"),(x.text or "").strip()[:300]) for x in nodes(target,"Dimension")]
    style=[(e.text or "") for e in nodes(target,"Name") if e is not target]
    print(layer,"DIMS",dims,"STYLES",style[:12],flush=True)
    now=dt.datetime.now(dt.timezone.utc)
    valid=now.replace(minute=0,second=0,microsecond=0)+dt.timedelta(hours=2)
    iso=valid.strftime("%Y-%m-%dT%H:%M:%SZ")
    x0,y0=fmt_meters(7.15,51.15)
    x1,y1=fmt_meters(8.00,51.78)
    args={"service":"WMS","request":"GetMap","version":"1.1.1",
          "layers":"dwd:"+layer,"styles":"","format":"image/png","transparent":"true",
          "srs":"EPSG:3857","bbox":",".join(str(round(z,2)) for z in (x0,y0,x1,y1)),
          "width":"256","height":"256","time":iso}
    for k,v in dims:
        if k and k.upper()=="REFERENCE_TIME" and v:args["DIM_REFERENCE_TIME"]=v
    try:
        status,mime,img=get(ROOT+"/wms?"+urlencode(args))
        print(layer,"IMAGE",status,mime,len(img),img[:10],"TIME",iso,flush=True)
    except Exception as e:
        print(layer,"IMAGE_FAIL",repr(e),flush=True)

if __name__=="__main__":
    for layer in LAYERS:run(layer)

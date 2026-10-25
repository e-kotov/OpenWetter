"""Diagnose public OpenWetter point sources without device data or secrets."""
import gzip,json,math,time
from urllib.parse import urlencode
from urllib.request import Request,urlopen

BASE="https://raw.githubusercontent.com/e-kotov/OpenWetter/icon-data/"
LAT,LON=51.5142,7.4653

def load(url,timeout=35):
    t=time.monotonic()
    with urlopen(Request(url,headers={"User-Agent":"OpenWetter public-source diagnostic/0.1"}),timeout=timeout) as resp:
        content=resp.read()
        print("HTTP",resp.status,"bytes",len(content),"seconds",round(time.monotonic()-t,2),
              "type",resp.headers.get("Content-Type"),flush=True)
        return content

try:
    manifest=json.loads(load(BASE+"manifest.json?t="+str(int(time.time()//300))))
    print("GRID",manifest["run"],"end",manifest["end"],"frames",manifest["precipitation"]["count"],flush=True)
    x=min(manifest["width"]-1,max(0,round((LON-manifest["bbox"][0])/
       (manifest["bbox"][2]-manifest["bbox"][0])*(manifest["width"]-1))))
    y=min(manifest["height"]-1,max(0,round((manifest["bbox"][3]-LAT)/
       (manifest["bbox"][3]-manifest["bbox"][1])*(manifest["height"]-1))))
    t=manifest["point_series"]
    tx=min(t["tiles_x"]-1,x//t["size"])
    ty=min(t["tiles_y"]-1,y//t["size"])
    path=t["path"].replace("{x:02d}",f"{tx:02d}").replace("{y:02d}",f"{ty:02d}")
    url=BASE+path+"?run="+manifest["run"]
    compressed=load(url)
    raw=gzip.decompress(compressed)
    n=min(t["size"]+(tx==t["tiles_x"]-1),manifest["width"]-tx*t["size"])*min(
      t["size"]+(ty==t["tiles_y"]-1),manifest["height"]-ty*t["size"])
    expected=n*(manifest["precipitation"]["count"]*2+manifest["cloud"]["count"]+
       manifest["temp"]["count"]*2)
    print("DWD_POINT_SERIES","gridcells",n,"decoded",len(raw),"expected",expected,
          "valid",len(raw)==expected,flush=True)
    if len(raw)!=expected:raise ValueError("DWD point-series binary size mismatch")
except Exception as exc:
    print("DWD_POINT_SERIES_ERROR",repr(exc),flush=True)
    raise

params={"latitude":LAT,"longitude":LON,
        "hourly":"temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover,relative_humidity_2m,pressure_msl",
        "models":"icon_d2","forecast_hours":48,"timezone":"auto","timeformat":"unixtime"}
url="https://api.open-meteo.com/v1/dwd-icon?"+urlencode(params)
try:
    body=json.loads(load(url,timeout=45))
    h=body.get("hourly") or {}
    print("OPEN_METEO_POINT",{"error":body.get("error"),"reason":body.get("reason"),
      "timezone":body.get("timezone"),"hours":len(h.get("time",[])),
      "wind":len(h.get("wind_speed_10m",[]))},flush=True)
except Exception as exc:
    print("OPEN_METEO_POINT_ERROR",repr(exc),flush=True)
    # Report, but do not fail the DWD data-source verification if the independent
    # Open-Meteo service is temporarily unreachable. D2 graphs use native grid.

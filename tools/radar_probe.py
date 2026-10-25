"""Inspect the current public DWD RY radar HDF5 feed without uploading weather data."""
from urllib.request import urlopen, Request
import h5py, io
URL="https://opendata.dwd.de/weather/radar/radolan/ry/raa01-ry_10000-latest-dwd---bin.hdf5"
print("Downloading", URL, flush=True)
with urlopen(Request(URL,headers={"User-Agent":"OpenWetter/0.2"}), timeout=90) as r:
    payload=r.read()
print("Downloaded bytes",len(payload),payload[:16],flush=True)
with h5py.File(io.BytesIO(payload),"r") as f:
    def display(name,obj):
        if len(name.split("/")) > 5:return
        print("NODE",name,"type",type(obj).__name__,"shape",getattr(obj,"shape",None),"dtype",getattr(obj,"dtype",None),flush=True)
        for k,v in obj.attrs.items():
            try:
                if hasattr(v,"tolist"): v=v.tolist()
                if isinstance(v,bytes):v=v.decode("utf-8",errors="replace")
            except Exception:pass
            print("ATTR",name,k,repr(v)[:500],flush=True)
        if isinstance(obj,h5py.Dataset) and obj.ndim >= 2:
            import numpy as np
            array=obj[:]
            print("DATA",name,"sample",array.ravel()[:12].tolist(),"min",np.nanmin(array),"max",np.nanmax(array),"shape",array.shape,flush=True)
    print("ROOT attrs",list(f.attrs.items()),flush=True)
    f.visititems(display)

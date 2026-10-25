"""Fast deterministic tests, including direct RADOLAN 1 km geometry."""
import io
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import numpy as np
import h5py
from pyproj import Transformer, CRS
sys.path.insert(0, str(Path(__file__).parent))
import produce_icon
import produce_radar

class TestModelGrids(unittest.TestCase):
    def test_native_precision_and_fill(self):
        native=np.array([[0.,.126,1.5,np.nan,99]],dtype='f4')
        q=produce_icon.encode_native(native,'precip')
        self.assertEqual(q.dtype,np.dtype('uint16'))
        self.assertEqual(q[0,:4].tolist(),[0,13,150,65535])
        self.assertEqual(produce_icon.encode_native(native,'cloud')[0,1],0)
    def test_kelvin_converts_to_celsius(self):
        values=np.array([[273.15, 280.65, np.nan]],dtype='f4')
        q=produce_icon.encode_native(values,'temp')
        self.assertEqual(q[0,:2].tolist(),[10000,10750])
        self.assertEqual(q[0,2],65535)
    def test_series_tile_boundaries(self):
        self.assertEqual(produce_icon.block_bounds(0,0),(0,80,0,80))
        self.assertEqual(produce_icon.block_bounds(11,8),(640,721,880,961))
    def test_native_observed_radar_index(self):
        p='+proj=stere +lat_0=90 +lat_ts=60 +lon_0=10 +a=6378137 +b=6356752.3142451802 +no_defs +x_0=543196.83521776402 +y_0=3622588.8619310018 +units=m'
        transform=Transformer.from_crs(CRS.from_proj4(p),CRS.from_epsg(4326),always_xy=True)
        lon,lat=transform.transform([0,500000], [0,-600000])
        r,c,ok=produce_radar.radar_index(p,np.array(lat),np.array(lon))
        self.assertEqual(c.tolist(),[0,500])
        self.assertEqual(r.tolist(),[0,600])
        self.assertTrue(np.all(ok))
    def test_read_odim_native_rates(self):
        p='+proj=stere +lat_0=90 +lat_ts=60 +lon_0=10 +a=6378137 +b=6356752.3142451802 +no_defs +x_0=543196.83521776402 +y_0=3622588.8619310018 +units=m'
        ioobj=io.BytesIO()
        with h5py.File(ioobj,'w') as f:
            d=f.create_dataset('dataset1/data1/data', data=np.full((1200,1100),37,dtype='u2'))
            w=f.create_group('dataset1/data1/what')
            w.attrs['quantity']='RATE';w.attrs['gain']=.01;w.attrs['offset']=0.;w.attrs['nodata']=65535.
            geo=f.create_group('where');geo.attrs['xscale']=1000.;geo.attrs['yscale']=1000.;geo.attrs['projdef']=p
        array,geo=produce_radar.metadata_and_values(ioobj.getvalue())
        self.assertEqual(array[0,0],37)
        self.assertEqual(geo,p)
if __name__ == '__main__':unittest.main()

"""Verify six hours of available, genuine five-minute radar records."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
import produce_radar as p

def fake_directory(count=110, missing=None):
    origin=datetime(2026,10,25,0,0,tzinfo=timezone.utc)
    missing=set(missing or [])
    links=[]
    for i in range(count):
        if i in missing:continue
        timestamp=(origin+timedelta(minutes=5*i)).strftime('%y%m%d%H%M')
        links.append(f'<a href="raa01-ry_10000-{timestamp}-dwd---bin.hdf5">file</a>')
    return ('<html><body>'+''.join(links)+'</body></html>').encode('utf-8')

def main():
    assert p.KEEP==73,"One six-hour window requires 73 five-minute observations"
    with patch.object(p,"get_bytes",return_value=fake_directory()):
        frames=p.observations()
    assert len(frames)==73
    assert frames[-1][0]-frames[0][0]==21600
    assert all(b[0]-a[0]==300 for a,b in zip(frames,frames[1:]))
    with patch.object(p,"get_bytes",return_value=fake_directory(missing={75,76,77})):
        frames=p.observations()
    assert len(frames)==73
    # Missing source observations stay missing; publishing does not synthesize
    # data at absent timestamps to create a cosmetically smooth timeline.
    assert any(b[0]-a[0]>300 for a,b in zip(frames,frames[1:]))
    print("Six-hour observed radar retention and missing-frame integrity: PASS")

if __name__=='__main__':
    main()

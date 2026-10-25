import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseNativeManifest,findRasterFile,gridPixel,parsePointSeries,rgbaForField,interpolatePointField} from '../native-fields.mjs';
const start=1792908000;
const icon=parseNativeManifest({schema:2,provider:'DWD',model:'ICON-D2',run:'2026-10-25T06:00',bbox:[4,47,16,56],width:961,height:721,
 start,end:start+48*3600,precipitation:{interval_minutes:15,count:193,path:'frames/precip/{index:03d}.bin.gz'},
 cloud:{interval_minutes:60,count:49,path:'frames/cloud/{index:03d}.bin.gz'},temp:{interval_minutes:60,count:49,path:'frames/temp/{index:03d}.bin.gz'},point_series:{size:80,tiles_x:12,tiles_y:9,path:'series/{x:02d}/{y:02d}.bin.gz'}},'icon');
const radar=parseNativeManifest({schema:1,product:'RADOLAN-RY',provider:'DWD',bbox:[4,47,16,56],width:2401,height:1801,
 frames:[{time:start-300,file:`frames/${start-300}.bin.gz`},{time:start,file:`frames/${start}.bin.gz`}]},'radar');
test('true 15-minute DWD precipitation and hourly cloud frames are independently indexed',()=>{
 assert.match(findRasterFile(icon,'precip',start+900).url,/frames\/precip\/001\.bin\.gz/);
 assert.match(findRasterFile(icon,'precip',start+1800).url,/frames\/precip\/002\.bin\.gz/);
 assert.match(findRasterFile(icon,'cloud',start+2700).url,/frames\/cloud\/000\.bin\.gz/);
 assert.match(findRasterFile(icon,'cloud',start+3600).url,/frames\/cloud\/001\.bin\.gz/);
 assert.equal(findRasterFile(icon,'precip',start-3600),null);
});
test('rain radar resolves genuine five-minute observations without forecast fallback',()=>{
 assert.match(findRasterFile(radar,'radar',start-300).url,/frames\//);
 assert.equal(findRasterFile(radar,'radar',start+3600),null);
 assert.equal(findRasterFile(radar,'cloud',start),null);
});
test('native high-resolution raster indexes map positions safely',()=>{
 assert.deepEqual(gridPixel(icon,56,4),{row:0,col:0});
 assert.deepEqual(gridPixel(icon,47,16),{row:720,col:960});
 assert.equal(gridPixel(icon,46,10),null);
});
test('point series is derived from the same 15-minute map pixel',()=>{
 const tx=0,ty=0,n=80*80,pixel=0,q=193,h=49;
 const buf=new ArrayBuffer(n*(q*2+h+49*2));const dv=new DataView(buf);
 for(let frame=0;frame<q;frame++)dv.setUint16((frame*n+pixel)*2,frame===0?0:25,true);
 const cloudBase=q*n*2,tempBase=cloudBase+h*n;
 for(let hour=0;hour<h;hour++){
  dv.setUint8(cloudBase+hour*n+pixel,53);
  dv.setUint16(tempBase+(hour*n+pixel)*2, 10875,true);
 }
 const result=parsePointSeries(icon,56,4,buf);
 assert.equal(result.precipitation_15min[1],.25);
 assert.equal(result.precipitation[4],1);
 assert.equal(result.temperature_2m[3],8.75);
 assert.equal(result.cloud_cover[7],53);
 assert.equal(result.time[4],start+3600);
});
test('precipitation and observed radar use physically different intensity scaling',()=>{
 assert.deepEqual(rgbaForField('radar',100),rgbaForField('precip',25));
 assert.equal(rgbaForField('radar',65535)[3],0);
});
test('wind values interpolate from DWD model point data without new weather generation',()=>{
 assert.equal(interpolatePointField({time:[start,start+3600],wind_speed_10m:[10,20]},'wind_speed_10m',start+900),12.5);
});

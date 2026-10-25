import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIconGrid,gridValue,gridIndex,colorPixel} from '../icon-grid.mjs';
const enc=a=>Buffer.from(a).toString('base64');
function tiny(){
  const frame=(t,cloud,precip,temp)=>({time:t,cloud:enc(cloud),precip:enc(precip),temp:enc(temp)});
  return {schema:1,model:'ICON-D2',run:'2026-10-25T00:00',width:10,height:10,bbox:[4,47,16,56],frames:[
    frame(1792886400,Array(100).fill(50),Array(100).fill(10),Array(100).fill(120)),
    frame(1792890000,Array(100).fill(90),Array(100).fill(25),Array(100).fill(124))]};
}
test('ICON grid time changes return native-sampled spatial data',()=>{
  const grid=parseIconGrid(tiny());
  assert.equal(gridIndex(grid,56,4),0);
  assert.equal(gridIndex(grid,47,16),99);
  assert.equal(gridValue(grid,'cloud',51,7,grid.times[0]),50);
  assert.equal(gridValue(grid,'cloud',51,7,grid.times[1]),90);
  assert.equal(gridValue(grid,'precip',51,7,grid.times[0]),1);
  assert.equal(gridValue(grid,'precip',51,7,grid.times[1]),2.5);
  assert.equal(gridValue(grid,'temp',51,7,grid.times[0]),10);
  assert.equal(gridValue(grid,'temp',51,7,grid.times[1]),12);
  assert.equal(gridValue(grid,'cloud',51,7,grid.times[1]+3600),null);
  assert.equal(gridValue(grid,'cloud',60,7,grid.times[0]),null);
});
test('Missing cells never become precipitation or cloud cover',()=>{
  const d=tiny();d.frames[0].precip=enc(Array(100).fill(255));
  assert.equal(gridValue(parseIconGrid(d),'precip',51,7,d.frames[0].time),null);
  assert.deepEqual(colorPixel('precip',255),[0,0,0,0]);
  assert.deepEqual(colorPixel('precip',0),[0,0,0,0]);
});
test('Corrupt grid data is rejected instead of substituted',()=>{
  const d=tiny();d.frames[1].cloud='bad';assert.throws(()=>parseIconGrid(d));
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {continuousWeatherTimeline,continuousCursorIndex} from '../continuous-timeline.mjs';
const now=1800000000;
const scans=[now-3600,now-3300,now-3000,now-2700,now-2400].map(time=>({time}));
test('source-labelled observations transition directly into predictions with no invented scans',()=>{
 const frames=continuousWeatherTimeline([...scans,scans[2]],{now,start:now-900,end:now+2700,step:900});
 assert.equal(frames.filter(f=>f.kind==='radar').length,scans.length);
 assert.deepEqual(frames.slice(0,5).map(f=>f.time),scans.map(f=>f.time));
 assert.equal(frames[5].kind,'forecast');
 assert.equal(frames[5].time,Math.ceil(now/900)*900);
 for(let i=1;i<frames.length;i++)assert.ok(frames[i].time>frames[i-1].time);
 assert.equal(continuousCursorIndex(frames,frames[4]),4);
 assert.equal(continuousCursorIndex(frames,null),4);
});
test('stale observations remain timestamped; no fictional now radar frame',()=>{
 const old=[{time:now-8*3600},{time:now-7*3600},{time:now-6*3600}];
 const frames=continuousWeatherTimeline(old,{now,start:now,end:now+1800});
 assert.equal(frames[0].time,now-8*3600);
 assert.equal(frames[2].time,now-6*3600);
 assert.equal(frames[3].kind,'forecast');
 assert.ok(frames[3].time>=now);
});
test('missing observed scans are not reconstructed',()=>{
 const frames=continuousWeatherTimeline([{time:now-3600},{time:now-2400},{time:now-300}],{now,start:now,end:now+900});
 assert.deepEqual(frames.filter(f=>f.kind==='radar').map(f=>f.time),[now-3600,now-2400,now-300]);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mayBlendWeatherFrames} from '../frame-transition.mjs';

test('crossfade only between distinct timestamps at an identical map view',()=>{
  const scene='radar|390|844|2|7|51.51|7.46|observed';
  assert.equal(mayBlendWeatherFrames(null,null,'observed:300',scene),false);
  assert.equal(mayBlendWeatherFrames('observed:300',scene,'observed:600',scene),true);
  assert.equal(mayBlendWeatherFrames('observed:300',scene,'observed:300',scene),false);
  assert.equal(mayBlendWeatherFrames('observed:300',scene,'observed:600','other center'),false);
  assert.equal(mayBlendWeatherFrames('observed:300',scene,'observed:600',scene,{resized:true}),false);
  assert.equal(mayBlendWeatherFrames('observed:300',scene,'observed:600',scene,{enabled:false}),false);
  assert.equal(mayBlendWeatherFrames('observed:300',scene,'observed:600',scene,{enabled:true}),true);
});
test('forecast-vs-radar, different model runs, pan and zoom never crossfade',()=>{
  const a='forecast|390|844|2|7|51.51|7.46|icon_d2|runA';
  const b='forecast|390|844|2|7|51.51|7.46|icon_d2|runB';
  const c='forecast|390|844|2|8|51.51|7.46|icon_d2|runA';
  assert.equal(mayBlendWeatherFrames('D2:1',a,'D2:2',a),true);
  assert.equal(mayBlendWeatherFrames('D2:1',a,'D2:2',b),false);
  assert.equal(mayBlendWeatherFrames('D2:1',a,'D2:2',c),false);
  assert.equal(mayBlendWeatherFrames('D2:1',a,'radar:time',a),true,
    'Caller encodes layer identity in view key, so this is a generic transition helper');
});

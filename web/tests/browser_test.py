"""Mocked Chromium UI tests for touch scrubbing, stacked charts, model comparison and places.

The development sandbox blocks outbound HTTP and even localhost navigation, so
this test inlines exactly the app's HTML/CSS/ES modules and substitutes external
API responses and raster tiles. It does NOT prove production network access.
"""
import base64
import pathlib
import shutil
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
CAPTURES = ROOT.parent / 'screenshots'
CAPTURES.mkdir(exist_ok=True)
HTML = (ROOT/'index.html').read_text()
CSS = (ROOT/'styles.css').read_text()
LOGIC = (ROOT/'logic.mjs').read_text()
APP = (ROOT/'app.js').read_text()
logic_url = 'data:text/javascript;base64,'+base64.b64encode(LOGIC.encode()).decode()
GRID = (ROOT/'icon-grid.mjs').read_text()
NATIVE = (ROOT/'native-fields.mjs').read_text()
SPATIAL = (ROOT/'spatial-icon.mjs').read_text()
WMS_EU = (ROOT/'wms-eu.mjs').read_text()
TRANSITION = (ROOT/'frame-transition.mjs').read_text()
FRAME_CACHE = (ROOT/'frame-cache.mjs').read_text()
frame_cache_url = 'data:text/javascript;base64,'+base64.b64encode(FRAME_CACHE.encode()).decode()
GRID = GRID.replace("from './logic.mjs'", f"from '{logic_url}'")
grid_url = 'data:text/javascript;base64,'+base64.b64encode(GRID.encode()).decode()
NATIVE = NATIVE.replace("from './logic.mjs'", f"from '{logic_url}'")
NATIVE = NATIVE.replace("from './frame-cache.mjs'", f"from '{frame_cache_url}'")
native_url = 'data:text/javascript;base64,'+base64.b64encode(NATIVE.encode()).decode()
SPATIAL = SPATIAL.replace("from './native-fields.mjs'", f"from '{native_url}'")
spatial_url = 'data:text/javascript;base64,'+base64.b64encode(SPATIAL.encode()).decode()
WMS_EU = WMS_EU.replace("from './logic.mjs'", f"from '{logic_url}'")
WMS_EU = WMS_EU.replace("from './frame-cache.mjs'", f"from '{frame_cache_url}'")
wms_url = 'data:text/javascript;base64,'+base64.b64encode(WMS_EU.encode()).decode()
transition_url = 'data:text/javascript;base64,'+base64.b64encode(TRANSITION.encode()).decode()
APP = APP.replace("from './logic.mjs'", f"from '{logic_url}'")
APP = APP.replace("from './icon-grid.mjs'", f"from '{grid_url}'")
APP = APP.replace("from './native-fields.mjs'", f"from '{native_url}'")
APP = APP.replace("from './spatial-icon.mjs'", f"from '{spatial_url}'")
APP = APP.replace("from './wms-eu.mjs'", f"from '{wms_url}'")
APP = APP.replace("from './frame-transition.mjs'", f"from '{transition_url}'")
APP = APP.replace("if(new URLSearchParams(location.search).has('test'))window.openwetterTest=", "window.openwetterTest=")
APP_B64 = base64.b64encode(APP.encode()).decode()
HTML = HTML.replace('<link rel="stylesheet" href="styles.css"/>', '<style>'+CSS+'</style>')
HTML = HTML.replace('<script type="module" src="app.js"></script>', '')
HTML = HTML.replace('<link rel="manifest" href="manifest.webmanifest"/>', '')
HTML = HTML.replace('<link rel="icon" href="icons/icon.svg" type="image/svg+xml"/>', '')

BOOTSTRAP = r'''async (app64) => {
  const store=new Map();
  Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)}});
  const counters={forecast:{},radar:0,geocode:0,wmsMetadata:0,wmsTiles:0};
  const now=Math.floor(Date.now()/3600000)*3600;
  const forecast=(url)=>{
    const model=new URL(url).searchParams.get('models');
    const count=model==='icon_d2'?48:120;
    const n=Array.from({length:count},(_,i)=>i);
    const offset={icon_d2:0,icon_eu:4,icon_global:-2}[model];
    return {latitude:51.51,longitude:7.46,timezone:'Europe/Berlin',hourly:{
      time:n.map(i=>now+3600*i),
      temperature_2m:n.map(i=>Math.round((12+offset+6*Math.sin(i/6))*10)/10),
      precipitation:n.map(i=>Math.round(Math.max(0,2*Math.sin((i+offset)/4))*10)/10),
      wind_speed_10m:n.map(i=>Math.round(12+4*Math.cos(i/7))),
      wind_direction_10m:n.map(()=>180),
      cloud_cover:n.map(i=>Math.round(55+40*Math.sin(i/5))),
      relative_humidity_2m:n.map(()=>70),pressure_msl:n.map(()=>1013),
    }};
  };
  const frameCalls=new Map(),diskStores=new Map();
  Object.defineProperty(window,'caches',{configurable:true,value:{
    async open(name){
      if(!diskStores.has(name)){
        const map=new Map();
        diskStores.set(name,{
          async match(k){return map.get(String(k.url||k))?.clone();},
          async put(k,response){map.set(String(k.url||k),response.clone());},
          async keys(){return [...map.keys()].map(k=>new Request(k));},
          async delete(k){return map.delete(String(k.url||k));},
        });
      }
      return diskStores.get(name);
    }
  }});
  window.__mockCounts=()=>({...counters,radarFiles:Object.fromEntries(frameCalls)});
  window.__delayRadarFrames=false;
  const radarWaiters=[];
  window.__releaseRadarFrames=()=>{window.__delayRadarFrames=false;while(radarWaiters.length)radarWaiters.shift()();};
  window.fetch=async (arg)=>{
    const url=String(arg);let body;
    if(url.includes('/v1/dwd-icon')){
      const model=new URL(url).searchParams.get('models');
      counters.forecast[model]=(counters.forecast[model]||0)+1;
      if(window.__mockD2OfflinePoint&&model==='icon_d2')
        throw new DOMException('signal is aborted without reason','AbortError');
      body=forecast(url);
    }else if(url.includes('geocoding-api.open-meteo.com')){
      counters.geocode++;body={results:[{latitude:50.7374,longitude:7.0982,name:'Bonn',country:'Germany'}]};
    }else if(url.includes('/icon-data/manifest.json')){
       if(!window.__mockD2OfflinePoint)return new Response('Test offline ICON dataset',{status:404});
       body={schema:2,provider:'DWD',model:'ICON-D2',run:'2026-10-25T09:00',
         bbox:[4,47,16,56],width:80,height:80,start:now,end:now+48*3600,
         precipitation:{count:193,interval_minutes:15,path:'frames/precip/{index:03d}.bin.gz'},
         cloud:{count:49,interval_minutes:60,path:'frames/cloud/{index:03d}.bin.gz'},
         temp:{count:49,interval_minutes:60,path:'frames/temp/{index:03d}.bin.gz'},
         point_series:{size:80,tiles_x:1,tiles_y:1,path:'series/{x:02d}/{y:02d}.bin.gz'}};
     }else if(url.includes('/icon-data/series/')){
       const n=80*80,q=193,h=49;
       const bytes=new ArrayBuffer(n*(q*2+h+h*2));
       new Uint16Array(bytes,0,q*n).fill(20);
       new Uint8Array(bytes,q*n*2,h*n).fill(60);
       new Uint16Array(bytes,q*n*2+h*n,h*n).fill(11100);
       const gz=new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
       return new Response(gz,{status:200,headers:{'Content-Type':'application/octet-stream'}});
     }else if(url.includes('/radar-data/manifest.json')){
       counters.radar++;const t=Math.floor(Date.now()/300000)*300;
       body={schema:1,provider:'DWD',product:'RADOLAN-RY',bbox:[4,47,16,56],width:64,height:48,
         frames:Array.from({length:12},(_,i)=>({time:t-(11-i)*300,file:'frames/'+(t-(11-i)*300)+'.bin.gz'}))};
     }else if(url.includes('/Icon-eu_reg00625_fd_sl_TOTPREC01H/wms?')){
       counters.wmsMetadata++;
       const past=new Date((now-86400)*1000).toISOString();
       const future=new Date((now+78*3600)*1000).toISOString();
       const run=new Date((now-6*3600)*1000).toISOString();
       const xml='<WMS_Capabilities><Capability><Layer><Layer><Name>dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H</Name>'+
         '<Dimension name="time" units="ISO8601">'+past+'/'+future+'/PT1H</Dimension>'+
         '<Dimension name="REFERENCE_TIME" units="ISO8601" default="'+run+'">'+run+'</Dimension>'+
         '</Layer></Layer></Capability></WMS_Capabilities>';
       return new Response(xml,{status:200,headers:{'content-type':'text/xml'}});
     }else if(url.startsWith('https://maps.dwd.de/geoserver/dwd/wms?')&&
       new URL(url).searchParams.get('LAYERS')==='dwd:Icon-eu_reg00625_fd_sl_TOTPREC01H'){
       counters.wmsTiles++;
       const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
       const c=canvas.getContext('2d');c.fillStyle='rgba(48,145,231,.65)';c.fillRect(0,0,256,256);
       const binary=atob(canvas.toDataURL('image/png').split(',')[1]);
       const bytes=Uint8Array.from(binary,ch=>ch.charCodeAt(0));
       return new Response(bytes,{status:200,headers:{'content-type':'image/png'}});
     }else if(url.includes('/radar-data/frames/')){
       frameCalls.set(url,(frameCalls.get(url)||0)+1);
       if(window.__delayRadarFrames)await new Promise(resolve=>radarWaiters.push(resolve));
       const array=new Uint16Array(64*48);array.fill(200);
       const gz=new Blob([array]).stream().pipeThrough(new CompressionStream('gzip'));
       return new Response(gz,{status:200,headers:{'Content-Type':'application/octet-stream'}});
    }else throw new Error('Unexpected request: '+url);
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const old=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  const ground='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#bed3cb"/><path d="M-20 70Q70 44 160 110T300 90" stroke="#9ecad7" fill="none" stroke-width="26"/><path d="M0 220Q140 157 256 225" fill="none" stroke="#e4e7d9" stroke-width="20"/><path d="M80 0L150 256 M0 126L256 152 M220 0L28 256" fill="none" stroke="#f8f7e9" stroke-width="7"/></svg>';
  const rain='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><ellipse cx="120" cy="128" rx="87" ry="58" fill="#3d83d7" fill-opacity="0.65"/><ellipse cx="110" cy="128" rx="45" ry="24" fill="#4ae5ed" fill-opacity="0.6"/></svg>';
  Object.defineProperty(HTMLImageElement.prototype,'src',{
    configurable:true,
    set(value){this.dataset.sourceUrl=value;old.set.call(this,'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(String(value).includes('rainviewer')?rain:ground));},
    get(){return this.dataset.sourceUrl||old.get.call(this);}
  });
  await import('data:text/javascript;base64,'+app64);
}'''


def input_range(page,selector,value):
    page.locator(selector).evaluate('(input,value)=>{input.value=String(value);input.dispatchEvent(new Event("input",{bubbles:true}));}',value)


def touch_drag(page,dx,dy):
    b=page.locator('#map').bounding_box()
    x=b['x']+b['width']*.43;y=b['y']+b['height']*.56
    c=page.context.new_cdp_session(page)
    c.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':1}]})
    c.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+dx/2,'y':y+dy/2,'id':1}]})
    c.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+dx,'y':y+dy,'id':1}]})
    c.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    page.wait_for_timeout(50)


def two_finger_pan_and_pinch(page):
    b=page.locator('#map').bounding_box()
    x=b['x']+b['width']*.5;y=b['y']+b['height']*.65
    c=page.context.new_cdp_session(page)
    start=[{'x':x-22,'y':y,'id':1},{'x':x+22,'y':y,'id':2}]
    end=[{'x':x-68,'y':y+18,'id':1},{'x':x+68,'y':y+18,'id':2}]
    c.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':start})
    c.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':end})
    c.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    page.wait_for_timeout(60)


def ui(kind,viewport,browser):
    page=browser.new_page(viewport=viewport,device_scale_factor=1,has_touch=kind=='mobile',is_mobile=kind=='mobile')
    errors=[]
    page.on('pageerror',lambda error: errors.append(str(error)))
    page.set_content(HTML,wait_until='load')
    page.evaluate(BOOTSTRAP,APP_B64)
    page.wait_for_function('window.openwetterTest?.state.forecast?.hourly?.time?.length===48')
    state=lambda expr: page.evaluate('window.openwetterTest.state.'+expr)
    assert page.locator('#locationName').inner_text()=='Dortmund, Germany'
    assert page.locator('#graphStack .plot-row').count()==4
    assert page.locator('#graphStack .plot-cursor').count()==4
    assert state('model')=='icon_d2'
    assert '°' in page.locator('#heroTemp').inner_text()
    assert page.evaluate('window.__mockCounts().forecast.icon_d2')==1
    # Android 15+ uses a native inset-aware container. Simulate its reduced
    # viewport and ensure app controls stay in a non-overlapping header row.
    if kind=='mobile':
      geometry=page.evaluate('''()=>{
        const row=document.querySelector('.header-line');
        const children=[...row.children].map(x=>x.getBoundingClientRect());
        return {width:innerWidth,rects:children.map(x=>({left:x.left,right:x.right,top:x.top,bottom:x.bottom}))};
      }''')
      bounds=geometry['rects']
      assert all(0<=v['left'] and v['right']<=geometry['width']+1 for v in bounds),geometry
      assert all(bounds[i]['right']<=bounds[i+1]['left']+2 for i in range(len(bounds)-1)),geometry
      # Check the most constrained phones as well; the status bar is inset natively.
      for width in [320,360,390]:
        page.set_viewport_size({'width':width,'height':844})
        measurements=page.evaluate('''()=>[...document.querySelector('.header-line').children].map(x=>({left:x.getBoundingClientRect().left,right:x.getBoundingClientRect().right}))''')
        assert all(0<=v['left'] and v['right']<=width+1 for v in measurements),(width,measurements)
        assert all(measurements[i]['right']<=measurements[i+1]['left']+2 for i in range(len(measurements)-1)),(width,measurements)
    assert not errors, errors

    # Time indicator moves, the four plotted graphs do not scroll.
    input_range(page,'#timeSlider',20)
    assert (state('selectedTime')-state('anchor'))/3600==20
    page.wait_for_function('Math.abs(parseFloat(document.querySelector(".plot-cursor").style.left)-41.6667)<0.05')
    positions=page.locator('.plot-cursor').evaluate_all('(els)=>els.map(e=>e.style.left)')
    assert len(set(positions))==1,positions
    input_range(page,'#timeSlider',0)
    if kind=='mobile':
      touch_drag(page,100,0)
      slow=(state('selectedTime')-state('anchor'))/3600
      assert 3<=slow<=5,f'Horizontal scrub expected ≈4h, got {slow}'
      input_range(page,'#timeSlider',0)
      touch_drag(page,0,-100)
      fast=(state('selectedTime')-state('anchor'))/3600
      assert 22<=fast<=26,f'Vertical scrub expected ≈24h, got {fast}'
      assert fast>slow*4,(slow,fast)
      input_range(page,'#timeSlider',0)
      old_zoom=state('map.zoom')
      two_finger_pan_and_pinch(page)
      assert state('map.zoom')>old_zoom,'Two-finger pinch did not zoom the map'
    else:
      start=state('map.longitude')
      b=page.locator('#map').bounding_box()
      x=b['x']+b['width']*.45;y=b['y']+b['height']*.57
      page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+120,y+18,steps=4);page.mouse.up()
      assert abs(state('map.longitude')-start)>.01

    # Clicking a fixed graph selects its absolute forecast time without scrolling it.
    row=page.locator('#graphStack .plot-body').first
    rect=row.bounding_box()
    page.mouse.click(rect['x']+rect['width']*.6,rect['y']+rect['height']*.5)
    assert 28<=(state('selectedTime')-state('anchor'))/3600<=30
    input_range(page,'#timeSlider',0)

    # Independent sensitivity sliders persist and affect gestures immediately.
    page.locator('#settingsBtn').click()
    assert page.locator('#settingsPanel').is_visible()
    input_range(page,'#horizontalSpeed',10)
    input_range(page,'#verticalSpeed',48)
    assert state('horizontalHours')==10 and state('verticalHours')==48
    assert '"horizontalHours":10' in page.evaluate('localStorage.getItem("openwetter.settings.v2")')
    page.locator('#settingsBtn').click()
    if kind=='mobile':
      touch_drag(page,100,0)
      assert 9<=(state('selectedTime')-state('anchor'))/3600<=11
      input_range(page,'#timeSlider',0)
      touch_drag(page,0,-100)
      assert state('selectedTime')==state('anchor')+48*3600
      input_range(page,'#timeSlider',0)

    # Compare models: same timestamp + same cursor across three different forecasts.
    page.locator('#viewCompare').click()
    page.wait_for_function('Object.keys(openwetterTest.state.forecasts).length===3')
    assert page.locator('.compare-row').count()==3
    assert page.locator('#map').is_hidden()
    assert 'icon_d2' in page.evaluate('window.__mockCounts().forecast')
    for model in ['icon_eu','icon_global']:
      assert state(f'forecasts.{model}.hourly.time.length')==120
    input_range(page,'#timeSlider',10)
    compare_times=page.locator('.plot-cursor').evaluate_all('(els)=>els.map(e=>e.style.left)')
    assert len(set(compare_times))==1,compare_times
    assert state('selectedTime')==state('anchor')+36000
    assert state('forecasts.icon_eu.hourly.temperature_2m[0]')!=state('forecasts.icon_d2.hourly.temperature_2m[0]')
    page.screenshot(path=str(CAPTURES/f'{kind}_compare.png'),full_page=True)

    page.locator('#horizon120').click()
    input_range(page,'#timeSlider',100)
    assert state('selectedTime')==state('anchor')+100*3600
    vals=page.locator('.compare-values').all_inner_texts()
    assert vals[0].startswith('—'),vals
    assert not vals[1].startswith('—'),vals
    assert state('forecastIndex')>=0

    # Drawer: switch an actual saved city, and search for a new city.
    page.locator('#placesBtn').click()
    assert page.locator('#placesDrawer').is_visible()
    page.locator('#placesList .choose-place',has_text='Rostock').click()
    page.wait_for_function('openwetterTest.state.place.name.includes("Rostock")')
    assert page.locator('#placesDrawer').is_hidden()
    page.wait_for_function('Object.keys(openwetterTest.state.forecasts).length===3')
    page.locator('#citySearch').fill('Bonn')
    page.locator('#searchForm').evaluate('(form)=>form.requestSubmit()')
    page.wait_for_function('openwetterTest.state.place.name.startsWith("Bonn")')
    page.locator('#placesBtn').click()
    page.locator('#savePlace').click()
    assert page.locator('#placesList .choose-place',has_text='Bonn').count()==1
    page.locator('#closePlaces').click()

    # Switching models should not shift the chosen common timestamp.
    page.locator('#modelSelect').select_option('icon_eu')
    assert state('model')=='icon_eu'
    assert state('selectedTime')==state('anchor')
    page.locator('#viewForecast').click()
    assert page.locator('#graphStack .plot-row').count()==4
    assert page.locator('#map').is_visible()
    assert page.locator('#modelDescription').inner_text().startswith('ICON-EU')
    # The native ICON-EU selection now has a lightweight official DWD hourly
    # precipitation WMS map, never mislabeled as an ICON-D2 grid.
    page.wait_for_function('openwetterTest.state.euWms?.kind==="icon_eu_wms"')
    page.wait_for_function('window.__mockCounts().wmsTiles>0')
    assert 'ICON-EU hourly rain' in page.locator('#mapLayerName').inner_text()
    assert page.locator('#toggleForecastClouds').is_disabled()
    assert 'ICON-EU' in page.locator('#timeRange').inner_text()

    # Independent map switches show real observed layers; unlike point graphs,
    # their timestamps must NOT pretend to track the ICON forecast slider.
    previous_time=state('selectedTime')
    page.locator('#toggleClouds').click()
    assert page.locator('#toggleClouds').get_attribute('aria-pressed')=='true'
    page.wait_for_function('document.querySelectorAll("#cloudTiles img").length>0')
    url=page.locator('#cloudTiles img').first.get_attribute('data-source-url')
    assert 'maps.dwd.de/geoserver/dwd/wms?' in url,url
    assert 'Satellite_meteosat_1km_euat_rgb_clouds_day_and_night' in url,url
    assert 'Satellite © DWD' in page.locator('#radarAttribution').inner_text()
    assert state('selectedTime')==previous_time
    page.locator('#toggleClouds').click()
    assert page.locator('#toggleClouds').get_attribute('aria-pressed')=='false'
    page.wait_for_function('document.querySelectorAll("#cloudTiles img").length===0')
    page.locator('#toggleRain').click()
    assert page.locator('#toggleRain').get_attribute('aria-pressed')=='true'
    page.wait_for_function('document.querySelector("#radarCanvas").width>0')
    assert 'Radar © DWD' in page.locator('#radarAttribution').inner_text()
    assert 'Observations do not follow ICON time' in page.locator('#mapModelName').inner_text()
    assert state('selectedTime')==previous_time
    page.locator('#toggleRain').click()
    assert page.locator('#toggleRain').get_attribute('aria-pressed')=='false'
    page.wait_for_function('document.querySelector("#radarCanvas").hidden')

    # Radar and forecast are explicitly separate: observation history has
    # its own time controls, while forecasts retain their future window.
    page.locator('#modeRadar').click()
    assert 'OBSERVED RADAR' in page.locator('#mapLayerName').inner_text()
    assert 'Forecast graphs' in page.locator('#plotsHeading').inner_text()
    assert page.locator('#forecastHorizonButtons').is_hidden()
    assert page.locator('#radarHistoryButtons').is_visible()
    assert page.locator('#toggleForecastRain').is_hidden()
    assert page.locator('#toggleRain').is_hidden()
    assert 'Radar · past 6h' in page.locator('#modeRadar').inner_text()
    page.locator('#radarHours2').click()
    assert state('radarHours')==2
    assert 'Radar · past 2h' in page.locator('#modeRadar').inner_text()
    page.locator('#radarHours6').click()
    assert state('radarHours')==6
    page.wait_for_function('openwetterTest.state.radar?.frames?.length===12')
    page.wait_for_function('openwetterTest.state.displayedRadarTime === openwetterTest.state.radar.frames.at(-1).time')
    page.wait_for_function('''(()=>{
       const canvas=document.querySelector('#radarCanvas');
       const rgba=canvas.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data;
       return rgba[3]>0;
    })()''')
    assert 'OBSERVED' in page.locator('#timeRange').inner_text()
    # A previous visible radar bitmap must actually have been committed before
    # the delayed next scan arrives; otherwise an initial load isn't a fade.
    page.wait_for_function('''()=>{
      const el=document.querySelector('#radarCanvas');
      return el.dataset.weatherFrame==='observed:'+openwetterTest.state.radar.frames.at(-1).time;
    }''')
    assert page.locator('#smoothFrames').is_checked()
    assert page.locator('#radarTransitionCanvas').is_hidden()
    # Delay an uncached radar frame. The old image must stay in place during scrubbing.
    before=page.locator('#radarCanvas').evaluate('(canvas)=>canvas.toDataURL()')
    page.evaluate('window.__delayRadarFrames=true')
    input_range(page,'#timeSlider',5)
    assert state('radarIndex')==5
    page.wait_for_timeout(240)
    assert state('displayedRadarTime')!=state('radar.frames[5].time')
    during=page.locator('#radarCanvas').evaluate('(canvas)=>canvas.toDataURL()')
    assert before==during, 'Radar must not disappear while a new frame is in transit'
    assert 'loading' in page.locator('#mapModelName').inner_text()
    page.evaluate('window.__releaseRadarFrames()')
    page.wait_for_function('openwetterTest.state.displayedRadarTime === openwetterTest.state.radar.frames[5].time')
    assert 'loading' not in page.locator('#mapModelName').inner_text()
    assert state('radarIndex')==5
    print("RADAR FADE DIAGNOSTICS",page.evaluate("""()=>{
      const fade=document.querySelector('#radarTransitionCanvas');
      const front=document.querySelector('#radarCanvas');
      return {from:fade.dataset.fromFrame,to:fade.dataset.toFrame,attempt:fade.dataset.lastAttempt,
        hidden:fade.hidden,active:front.dataset.weatherFrame,frontOpacity:getComputedStyle(front).opacity,
        fadeOpacity:getComputedStyle(fade).opacity,media:matchMedia('(prefers-reduced-motion: reduce)').matches,
        sceneMode:openwetterTest.state.mode};
    }"""),flush=True)
    page.wait_for_function('''()=>{
      const old=document.querySelector('#radarTransitionCanvas');
      return old.dataset.fromFrame&&old.dataset.toFrame==='observed:'+openwetterTest.state.radar.frames[5].time;
    }''')
    assert page.locator('#radarTransitionCanvas').is_visible()
    assert page.locator('#radarCanvas').get_attribute('data-weather-frame')=='observed:'+str(state('radar.frames[5].time'))
    assert '260ms' in page.locator('#radarTransitionCanvas').evaluate('(c)=>c.style.transition')
    # Animated outgoing weather should fade to zero without hiding the
    # incoming real scan or changing its five-minute timestamp.
    page.wait_for_timeout(310)
    assert page.locator('#radarTransitionCanvas').evaluate('(c)=>getComputedStyle(c).opacity') in ('0','0.0')
    page.locator('#settingsBtn').click()
    page.locator('#smoothFrames').uncheck()
    assert state('smoothFrames') is False
    page.locator('#settingsBtn').click()
    input_range(page,'#timeSlider',4)
    page.wait_for_function('openwetterTest.state.displayedRadarTime === openwetterTest.state.radar.frames[4].time')
    assert page.locator('#radarTransitionCanvas').is_hidden(), 'Reduced animation mode must be an instant swap'
    # Walk beyond the eight-frame decoded-RAM LRU, then return to an old frame:
    # it must use persistent compressed storage without a second network fetch.
    for ix in range(11,-1,-1):
      input_range(page,'#timeSlider',ix)
      page.wait_for_function(f'openwetterTest.state.displayedRadarTime === openwetterTest.state.radar.frames[{ix}].time')
    oldest=state('radar.frames[0].time')
    oldest_url=f'https://raw.githubusercontent.com/e-kotov/OpenWetter/radar-data/frames/{oldest}.bin.gz'
    initial_downloads=page.evaluate('(url)=>window.__mockCounts().radarFiles[url]||0',oldest_url)
    assert initial_downloads==1,initial_downloads
    input_range(page,'#timeSlider',11)
    page.wait_for_function('openwetterTest.state.displayedRadarTime === openwetterTest.state.radar.frames[11].time')
    input_range(page,'#timeSlider',0)
    page.wait_for_function('openwetterTest.state.displayedRadarTime === openwetterTest.state.radar.frames[0].time')
    assert page.evaluate('(url)=>window.__mockCounts().radarFiles[url]||0',oldest_url)==1,'Previously viewed radar frame was downloaded twice'
    assert 'Radar © DWD' in page.locator('#radarAttribution').inner_text()
    page.locator('#modeForecast').click()  # Explicitly switch back to future model predictions.
    assert state('mode')=='forecast'
    assert page.locator('#forecastHorizonButtons').is_visible()
    assert page.locator('#radarHistoryButtons').is_hidden()
    assert 'FORECAST' in page.locator('#mapLayerName').inner_text()
    page.wait_for_function('document.querySelector("#radarCanvas").hidden')
    page.locator('#modelSelect').select_option('icon_d2')
    page.locator('#horizon48').click()
    input_range(page,'#timeSlider',12)
    page.evaluate('''()=>{
      const s=openwetterTest.state;
      s.place={latitude:51.5142,longitude:7.4653,name:'Dortmund, Germany'};
      s.map={latitude:51.5142,longitude:7.4653,zoom:7};
      document.getElementById('locationName').textContent=s.place.name;
      document.getElementById('headerPlace').textContent='Dortmund';
      document.getElementById('citySearch').value='Dortmund, Germany';
      openwetterTest.renderMap();openwetterTest.drawGraphs();
    }''')
    page.screenshot(path=str(CAPTURES/f'{kind}.png'),full_page=True)
    assert not errors,errors
    print(f'{kind}: OK | '+str(page.evaluate('window.__mockCounts()')))
    page.close()


def verify_grids_survive_point_api_abort(browser):
    page=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1,has_touch=True,is_mobile=True)
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content(HTML,wait_until='load')
    page.evaluate('window.__mockD2OfflinePoint=true')
    page.evaluate(BOOTSTRAP,APP_B64)
    page.wait_for_function('''()=>{
      const f=openwetterTest?.state?.forecasts?.icon_d2;
      return f?.fromRawGrid===true&&f?.gridOnly===true&&f?.hourly?.time?.length===193;
    }''')
    assert 'signal is aborted' not in page.locator('#message').inner_text().lower()
    assert 'ready' in page.locator('#message').inner_text().lower()
    assert page.locator('#graphStack .plot-row').count()==4
    assert page.locator('#heroTemp').inner_text()=='11°'
    assert page.locator('#quickCloud').inner_text()=='60%'
    page.evaluate('openwetterTest.setSelectedTime(openwetterTest.state.anchor+3600)')
    assert page.locator('#quickRain').inner_text()=='0.8 mm'
    assert page.locator('#quickWind').inner_text()=='— km/h'
    assert page.evaluate('openwetterTest.state.forecasts.icon_d2.hourly.cloud_cover[10]')==60
    assert page.evaluate('openwetterTest.state.forecasts.icon_d2.hourly.temperature_2m[10]')==11
    # Restore the point API; it must enrich the same grid graphs with wind,
    # not replace their genuine DWD-derived rain/cloud/temperature.
    page.evaluate('window.__mockD2OfflinePoint=false')
    page.evaluate('openwetterTest.selectModel("icon_d2")')
    page.wait_for_function('''()=>{
      const f=openwetterTest.state.forecasts.icon_d2;
      return f?.fromRawGrid===true&&f?.gridOnly===false&&
        f.hourly.wind_speed_10m.some(v=>typeof v==='number'&&v>0);
    }''')
    assert page.locator('#heroTemp').inner_text()=='11°'
    assert page.locator('#quickCloud').inner_text()=='60%'
    assert page.locator('#quickWind').inner_text()!='— km/h'
    # Time-packed D2 map frames crossfade visually without generating
    # additional forecast frames or altering published 15-minute data.
    page.wait_for_function('''()=>document.querySelector('#iconCanvas').dataset.weatherFrame?.startsWith('icon-d2:')''')
    page.evaluate('openwetterTest.setSelectedTime(openwetterTest.state.anchor+900)')
    page.wait_for_function('''()=>{
      const c=document.querySelector('#iconTransitionCanvas');
      return c.dataset.toFrame?.endsWith(':'+openwetterTest.state.selectedTime);
    }''')
    assert page.locator('#iconTransitionCanvas').is_visible()
    assert page.evaluate('openwetterTest.state.forecasts.icon_d2.hourly.time.length')==193
    assert not errors,errors
    print('D2 point API abort and grid-only forecast recovery: OK')
    page.close()


def main():
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=shutil.which('chromium') or shutil.which('chromium-browser') or shutil.which('google-chrome') or p.chromium.executable_path,args=['--no-sandbox','--disable-dev-shm-usage'])
        ui('mobile',{'width':390,'height':844},browser)
        ui('desktop',{'width':1440,'height':900},browser)
        verify_grids_survive_point_api_abort(browser)
        browser.close()

if __name__=='__main__':main()

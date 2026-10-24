"""Chromium mobile/desktop smoke tests with inline source and mocked weather APIs.

The sandbox blocks even localhost navigation; loading identical app JS/CSS inline
preserves real rendering and event handlers without relying on network.
"""
import base64
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
CAPTURES = pathlib.Path(__file__).resolve().parents[2] / 'screenshots'
CAPTURES.mkdir(exist_ok=True)

HTML = (ROOT/'index.html').read_text()
CSS = (ROOT/'styles.css').read_text()
LOGIC = (ROOT/'logic.mjs').read_text()
APP = (ROOT/'app.js').read_text()
logic_url = 'data:text/javascript;base64,'+base64.b64encode(LOGIC.encode()).decode()
APP = APP.replace("from './logic.mjs'",f"from '{logic_url}'")
APP = APP.replace("if(new URLSearchParams(location.search).has('test')) window.openwetterTest=", "window.openwetterTest=")
APP_B64 = base64.b64encode(APP.encode()).decode()
HTML=HTML.replace('<link rel="stylesheet" href="styles.css" />', '<style>'+CSS+'</style>')
HTML=HTML.replace('<script type="module" src="app.js"></script>', '')
HTML=HTML.replace('<link rel="manifest" href="manifest.webmanifest" />','')
HTML=HTML.replace('<link rel="icon" href="icons/icon.svg" type="image/svg+xml" />','')

# The app's real fetch calls are replaced with local fake responses, since browser
# network navigation is disallowed in the development sandbox.
MOCK_BOOTSTRAP = r'''async (appBase64) => {
  let forecastCalls=0,radarCalls=0,geoCalls=0;
  const now=Math.floor(Date.now()/3600000)*3600;
  const makeForecast=(url)=>{
    const model=new URL(url).searchParams.get('models');
    const count=model==='icon_d2'?48:120;
    const n=Array.from({length:count},(_,i)=>i);
    return {latitude:51.51,longitude:7.46,timezone:'Europe/Berlin',
      hourly:{time:n.map(i=>now+3600*i),
        temperature_2m:n.map(i=>Math.round((12+6*Math.sin(i/6))*10)/10),
        precipitation:n.map(i=>Math.round(Math.max(0,2*Math.sin(i/4))*10)/10),
        wind_speed_10m:n.map(i=>Math.round(12+4*Math.cos(i/7))),
        wind_direction_10m:n.map(()=>180),
        cloud_cover:n.map(i=>Math.round(55+40*Math.sin(i/5))),
        relative_humidity_2m:n.map(()=>70), pressure_msl:n.map(()=>1013)}};
  };
  window.__mockCounts=()=>({forecastCalls,radarCalls,geoCalls});
  window.fetch=async (url)=>{
    url=String(url);
    let body;
    if(url.includes('/v1/dwd-icon')){forecastCalls++;body=makeForecast(url);}
    else if(url.includes('geocoding-api.open-meteo.com')){
      geoCalls++;body={results:[{latitude:50.7374,longitude:7.0982,name:'Bonn',country:'Germany'}]};
    } else if(url.includes('weather-maps.json')) {
      radarCalls++;const t=Math.floor(Date.now()/600000)*600;
      body={host:'https://tilecache.rainviewer.com',radar:{past:Array.from({length:12},(_,i)=>({time:t-(11-i)*600,path:'/v2/radar/'+(t-(11-i)*600)}))}};
    } else throw new Error('Unmocked fetch URL: '+url);
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const original=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  const simpleMap='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#bccbc9"/><path d="M0 70Q60 44 120 88T256 61" fill="none" stroke="#c3d8e1" stroke-width="28"/><path d="M0 200Q140 157 256 215" fill="none" stroke="#dee2d1" stroke-width="17"/><path d="M70 0L150 256 M0 126L256 152 M220 0L28 256" fill="none" stroke="#f5f4e8" stroke-width="10"/><path d="M70 0L150 256 M0 126L256 152 M220 0L28 256" fill="none" stroke="#dce8ea" stroke-width="1"/></svg>';
  const radarMap='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><ellipse cx="120" cy="128" rx="87" ry="58" fill="#3d83d7" fill-opacity="0.5"/><ellipse cx="110" cy="128" rx="45" ry="24" fill="#4ae5ed" fill-opacity="0.52"/></svg>';
  Object.defineProperty(HTMLImageElement.prototype,'src',{
    configurable:true,
    set(value){this.dataset.sourceUrl=value;original.set.call(this,'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(String(value).includes('rainviewer')?radarMap:simpleMap));},
    get(){return this.dataset.sourceUrl || original.get.call(this);}
  });
  await import('data:text/javascript;base64,'+appBase64);
}'''


def main():
  with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=(__import__('shutil').which('chromium') or p.chromium.executable_path),args=['--no-sandbox','--disable-dev-shm-usage'])
    for kind,viewport in [('mobile',{'width':390,'height':844}),('desktop',{'width':1440,'height':900})]:
      page=browser.new_page(viewport=viewport,device_scale_factor=1,has_touch=kind=='mobile',is_mobile=kind=='mobile')
      js_errors=[]
      page.on('pageerror',lambda error:js_errors.append(str(error)))
      page.set_content(HTML,wait_until='load')
      page.evaluate(MOCK_BOOTSTRAP,APP_B64)
      page.wait_for_function('window.openwetterTest?.state.forecast?.hourly?.time?.length > 0')
      assert page.locator('#locationName').inner_text()=='Dortmund, Germany'
      assert page.locator('#heroTemp').inner_text()!='—'
      assert '°C' in page.locator('#quickTemp').inner_text()
      assert page.evaluate('window.__mockCounts().forecastCalls')==1
      assert not js_errors,js_errors
      if kind=='mobile':
        client=page.context.new_cdp_session(page)
        bounds=page.locator('#map').bounding_box()
        mx=bounds['x']+bounds['width']*.4
        my=bounds['y']+bounds['height']*.42
        before=page.evaluate('openwetterTest.state.forecastIndex')
        client.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':mx,'y':my,'id':1}]})
        client.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':mx+95,'y':my,'id':1}]})
        client.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
        after=page.evaluate('openwetterTest.state.forecastIndex')
        assert after>before, f'Touch scrubbing failed: {before} -> {after}'
      else:
        before=page.evaluate('openwetterTest.state.map.longitude')
        bounds=page.locator('#map').bounding_box()
        mx=bounds['x']+bounds['width']*.3
        my=bounds['y']+bounds['height']*.55
        page.mouse.move(mx,my);page.mouse.down();page.mouse.move(mx+110,my+20,steps=4);page.mouse.up()
        after=page.evaluate('openwetterTest.state.map.longitude')
        assert abs(after-before)>.01, f'Mouse map drag failed: {before} -> {after}'
      page.locator('button[data-metric="wind"]').click()
      assert page.locator('#heroUnit').inner_text()=='km/h'
      page.locator('#timeSlider').evaluate('(input)=>{input.value="5";input.dispatchEvent(new Event("input", {bubbles:true}));}')
      assert page.evaluate('openwetterTest.state.forecastIndex')==5
      page.locator('#modelSelect').select_option('icon_eu')
      page.wait_for_function('openwetterTest.state.forecast?.hourly?.time?.length === 120')
      assert page.evaluate('window.__mockCounts().forecastCalls')>=2
      page.locator('#modeRadar').click()
      page.wait_for_function('openwetterTest.state.radar?.frames?.length===12')
      page.wait_for_function('document.querySelectorAll("#radarTiles img").length > 0')
      assert 'OBSERVED' in page.locator('#timeRange').inner_text()
      page.locator('#timeSlider').evaluate('(input)=>{input.value="6";input.dispatchEvent(new Event("input",{bubbles:true}));}')
      assert page.evaluate('openwetterTest.state.radarIndex')==6
      assert 'RainViewer' in page.locator('#radarAttribution').inner_text()
      page.locator('#settingsBtn').click()
      assert page.locator('#settingsPanel').is_visible()
      page.locator('#opacitySlider').evaluate('(input)=>{input.value="60";input.dispatchEvent(new Event("input",{bubbles:true}));}')
      assert page.locator('#opacityOutput').inner_text()=='60%'
      page.locator('#settingsBtn').click()
      page.locator('#citySearch').fill('Bonn')
      page.locator('#searchForm').evaluate('(form)=>form.requestSubmit()')
      page.wait_for_function('openwetterTest.state.place.name.startsWith("Bonn")')
      assert page.evaluate('window.__mockCounts().geoCalls')==1
      page.locator('#modeForecast').click()
      page.locator('#modelSelect').select_option('icon_d2')
      page.wait_for_function('openwetterTest.state.forecast?.hourly?.time?.length===48')
      # Put it back at Dortmund to capture a clear UI preview.
      page.evaluate('''()=>{
        const s=openwetterTest.state;
        s.place={latitude:51.5142,longitude:7.4653,name:'Dortmund, Germany'};
        s.map={latitude:51.5142,longitude:7.4653,zoom:7};
        document.getElementById('citySearch').value='Dortmund';
        openwetterTest.selectMetric('temperature');
        document.getElementById('locationName').textContent='Dortmund, Germany';
        openwetterTest.renderMap();openwetterTest.drawChart();
      }''')
      page.screenshot(path=str(CAPTURES/f'{kind}.png'),full_page=True)
      assert not js_errors,js_errors
      print(f'{kind}: OK | '+str(page.evaluate('window.__mockCounts()')))
      page.close()
    browser.close()

if __name__=='__main__':main()

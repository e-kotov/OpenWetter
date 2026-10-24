/* Pure application logic. No browser globals: safe to unit-test in Node. */
export const MODELS = Object.freeze({
  icon_d2: { label: 'ICON-D2', subtitle: 'DWD · ~2 km · 48 h' },
  icon_eu: { label: 'ICON-EU', subtitle: 'DWD · ~7 km · 5 days' },
  icon_global: { label: 'ICON Global', subtitle: 'DWD · ~11 km · 7 days' },
});

export const VARIABLES = Object.freeze({
  temperature: { key: 'temperature_2m', unit: '°C', name: 'Temperature', color: '#f7b267', chart: 'line' },
  precipitation: { key: 'precipitation', unit: 'mm', name: 'Rain', color: '#58c4ef', chart: 'bar' },
  wind: { key: 'wind_speed_10m', unit: 'km/h', name: 'Wind', color: '#a5a8ff', chart: 'line' },
  cloud: { key: 'cloud_cover', unit: '%', name: 'Clouds', color: '#b6cedc', chart: 'area' },
});

export const HOURLY = 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover,relative_humidity_2m,pressure_msl';
export const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
export const wrappedLongitude = (lon) => ((lon + 180) % 360 + 360) % 360 - 180;
export const clampLatitude = (lat) => clamp(lat, -85.05112878, 85.05112878);

export function forecastURL({ latitude, longitude, model }) {
  if (!Object.hasOwn(MODELS, model)) throw new RangeError(`Unknown model ${model}`);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new RangeError('Invalid coordinates');
  }
  const params = new URLSearchParams({
    latitude: String(latitude), longitude: String(longitude), hourly: HOURLY,
    models: model, forecast_hours: model === 'icon_d2' ? '48' : '120',
    timezone: 'auto', timeformat: 'unixtime',
  });
  return `https://api.open-meteo.com/v1/dwd-icon?${params}`;
}

export function parseForecast(data) {
  if (!data || data.error || !data.hourly || !Array.isArray(data.hourly.time)) {
    throw new Error(data?.reason || 'Missing hourly forecast');
  }
  const times = data.hourly.time;
  if (!times.length || times.some(t => typeof t !== 'number')) throw new Error('Malformed forecast timestamps');
  for (const { key } of Object.values(VARIABLES)) {
    if (!Array.isArray(data.hourly[key]) || data.hourly[key].length !== times.length) {
      throw new Error(`Missing ${key} data`);
    }
  }
  return data;
}

export function nearestIndex(timestamps, targetSeconds) {
  if (!timestamps?.length) return 0;
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const delta = Math.abs(timestamps[i] - targetSeconds);
    if (delta < dist) { best = i; dist = delta; }
  }
  return best;
}

export function safeRadarMetadata(payload) {
  const host = payload?.host;
  const frames = payload?.radar?.past;
  try {
    const domain = new URL(host);
    if (domain.protocol !== 'https:' || !(domain.hostname === 'rainviewer.com' || domain.hostname.endsWith('.rainviewer.com'))) {
      throw new Error('Invalid radar host');
    }
    if (!Array.isArray(frames) || !frames.length) throw new Error('No radar frames');
    const clean = frames.filter(f => Number.isSafeInteger(f.time) && /^\/v2\/radar\/\d+$/.test(f.path));
    if (!clean.length) throw new Error('No valid radar frames');
    return {host: domain.origin, frames: clean.sort((a,b)=>a.time-b.time)};
  } catch { throw new Error('Invalid radar response'); }
}

export function radarTileURL(radar, frameIndex, z, x, y) {
  const frame = radar.frames[clamp(frameIndex,0,radar.frames.length-1)];
  const rz = clamp(Math.floor(z), 0, 7);
  const max = 2**rz;
  if (!frame || !Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= max) return null;
  return `${radar.host}${frame.path}/256/${rz}/${((x % max) + max) % max}/${y}/2/1_1.png`;
}

// Web Mercator projections for a small dependency-free tiled map.
export function mercator(lat, lon, zoom) {
  const scale = 256 * 2**zoom;
  const theta = clampLatitude(lat)*Math.PI/180;
  return {
    x: (wrappedLongitude(lon) + 180)/360 * scale,
    y: (1-Math.log(Math.tan(theta) + 1/Math.cos(theta))/Math.PI)/2*scale,
  };
}
export function unmercator(x, y, zoom) {
  const scale = 256*2**zoom;
  return { lon: wrappedLongitude(x/scale*360-180), lat: Math.atan(Math.sinh(Math.PI*(1-2*y/scale)))*180/Math.PI };
}

export function valueAt(forecast, variable, index) {
  if (!forecast) return null;
  const key = VARIABLES[variable].key;
  const value = forecast.hourly?.[key]?.[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function axisLimits(values, variable) {
  const valid = values.filter(v=>typeof v === 'number' && Number.isFinite(v));
  if (!valid.length) return {min:0,max:1};
  let min = Math.min(...valid), max = Math.max(...valid);
  if (variable === 'precipitation' || variable === 'cloud') min = 0;
  if (variable === 'cloud') max = 100;
  else if (max-min < .01) { min -= 1; max += 1; }
  else { const pad = (max-min)*.13; min -= pad; max += pad; }
  return {min,max};
}

/** Point forecasts for the charts: ICON-D2 values sampled from the same
 * published grid as the map (tile service `series` blocks), enriched by the
 * Open-Meteo DWD point API for anything the grid series does not contain.
 */
import {nearestIndex} from './logic.mjs';
import {seriesLocation,parseSeriesBlock,seriesToChart} from './tile-service.mjs';
import {seriesBytes} from './tile-loader.mjs';

export const GRID_KEYS=Object.freeze(['temperature_2m','precipitation','cloud_cover','wind_speed_10m',
  'wind_direction_10m','relative_humidity_2m','pressure_msl']);

export function interpolatePointField(hourly,field,time){
  if(!hourly?.time?.length||!Array.isArray(hourly[field]))return null;
  const index=nearestIndex(hourly.time,time);
  if(index<0)return null;
  const one=hourly[field][index];
  if(Math.abs(hourly.time[index]-time)<1||time<=hourly.time[0]||time>=hourly.time.at(-1))return one??null;
  const other=hourly.time[index]>time?index-1:index+1;
  const a=Math.min(index,other),b=Math.max(index,other);
  const va=hourly[field][a],vb=hourly[field][b];
  if(!Number.isFinite(va)||!Number.isFinite(vb))return one??null;
  const frac=Math.max(0,Math.min(1,(time-hourly.time[a])/(hourly.time[b]-hourly.time[a])));
  return va+(vb-va)*frac;
}
/** Merge grid series (authoritative where present) with the optional point
 * API. Grid values are never overwritten; absent fields come from the point
 * API, else stay null. */
export function composeIconD2Forecast(series,pointForecast=null,{fetchedAt=Date.now()}={}){
  if(!series||!Array.isArray(series.time)||!series.time.length||
     !GRID_KEYS.some(k=>Array.isArray(series[k])))
    throw new Error('Invalid ICON-D2 grid point series');
  for(const k of GRID_KEYS)if(Array.isArray(series[k])&&series[k].length!==series.time.length)
    throw new Error('Invalid ICON-D2 grid point series');
  const hourly={time:series.time};
  const point=pointForecast?.hourly;
  for(const key of GRID_KEYS){
    if(Array.isArray(series[key]))hourly[key]=series[key];
    else hourly[key]=Array.isArray(point?.[key])&&point[key].length===point.time?.length
      ? series.time.map(t=>interpolatePointField(point,key,t))
      : Array(series.time.length).fill(null);
  }
  return {
    ...(pointForecast||{}),
    hourly,timezone:pointForecast?.timezone||'Europe/Berlin',
    fetchedAt:pointForecast?.fetchedAt||fetchedAt,
    rawPointForecast:pointForecast,
    fromRawGrid:true,
    gridKeys:GRID_KEYS.filter(k=>Array.isArray(series[k])),
    gridOnly:!pointForecast,
  };
}
/** One download per tapped place: the 32x32-cell series block containing it.
 * Returns null when the manifest has no series or the point is outside. */
export async function downloadGridSeries(manifest,latitude,longitude){
  const location=seriesLocation(manifest,latitude,longitude);
  if(!location)return null;
  const bytes=await seriesBytes(location.url);
  return seriesToChart(parseSeriesBlock(manifest,location,bytes));
}

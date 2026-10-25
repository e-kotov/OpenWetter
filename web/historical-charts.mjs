/**
 * Historical ICON point data are archived/modelled estimates, NOT observations.
 * The present/future ICON fields remain separate, so native ICON-D2 grids can
 * supersede forecasts without discarding the past or mixing model sources.
 */
export const ICON_HISTORY_HOURS=9;

function subsetHourly(hourly,indices){
  return Object.fromEntries(Object.entries(hourly).map(([key,values])=>[
    key,Array.isArray(values)?indices.map(i=>values[i]):values,
  ]));
}
export function splitModelHistory(model,anchor,{historyHours=ICON_HISTORY_HOURS}={}){
  if(!model?.hourly?.time||!Number.isFinite(anchor))throw new TypeError('Invalid model history');
  const past=[],future=[],since=anchor-historyHours*3600;
  model.hourly.time.forEach((time,index)=>{
    if(time>=since&&time<anchor)past.push(index);
    if(time>=anchor)future.push(index);
  });
  return {
    forecast:{...model,hourly:subsetHourly(model.hourly,future)},
    past:past.length?{...model,hourly:subsetHourly(model.hourly,past),source:'ARCHIVED_ICON_MODEL'}:null,
  };
}
export function chartSeries(forecast,past,key,min,max,now){
  const collect=(source,predicate)=>!source?.hourly?.time?[]:
    source.hourly.time.flatMap((time,i)=>{
      const v=source.hourly[key]?.[i];
      return predicate(time)&&time>=min&&time<=max?
        [{t:time,v:Number.isFinite(v)?v:null}]:[];
    });
  return {
    // Current-hour model values can precede wall-clock now even though the
    // API classifies them as forecast output. Display them on the past side.
    past:[...collect(past,t=>t<now),...collect(forecast,t=>t<now)].sort((a,b)=>a.t-b.t),
    future:collect(forecast,t=>t>=now),
  };
}

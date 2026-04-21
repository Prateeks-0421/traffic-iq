'use strict';
/* ─── CONSTANTS ──────────────────────── */
const TT       = 'JYLPYdfRXX7Z0Ww1jpWLOtKqWqcVDdoj';
const NOM      = 'https://nominatim.openstreetmap.org';
const OSRM     = 'https://router.project-osrm.org/route/v1';
const WX       = 'https://api.open-meteo.com/v1/forecast';
const AQIEP    = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TT_ROUTE = 'https://api.tomtom.com/routing/1/calculateRoute';
const UA       = 'TrafficIQ/5.0 (production)';

/* WMO weather codes */
const WMO = {0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Icy fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',61:'Light rain',63:'Moderate rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',80:'Rain showers',81:'Showers',82:'Heavy showers',95:'Thunderstorm',96:'Thunderstorm + hail',99:'Severe thunderstorm'};

/*
 * BASE_SPEED: realistic average speeds by mode (km/h).
 * Car:     70 km/h — good road conditions, moderate traffic.
 * Bicycle: 40 km/h — road bicycle on clear roads.
 * Walking:  5 km/h — normal walking pace.
 * These are used as fallback when TomTom live traffic is unavailable
 * and to sanity-check OSRM-reported durations.
 */
const BASE_SPEED   = {driving:70, cycling:40, foot:5};

/*
 * TRAFFIC_FACTOR: congestion multipliers applied to free-flow time
 * when TomTom is unavailable but local incidents are known.
 * light → ×1.15, moderate → ×1.40, heavy → ×1.75
 */
const TRAFFIC_FACTOR = {clear:1.0, light:1.15, moderate:1.40, heavy:1.75};

const MODE_LABEL   = {driving:'By Car — Live Traffic', cycling:'By Bicycle', foot:'On Foot'};

/* ─── STATE ──────────────────────────── */
let lmap, landMap;
let tileLt, tileDk, tileSat;
let selMk=null, routeLine=null, wptMks=[];
let incMks=[], heatMks=[];
let selMode=false;
let curLat=28.6139, curLng=77.2090, curTZ='Asia/Kolkata', curCity='New Delhi';
let layers={inc:true,heat:false,sat:false, dark : false  };
let trend=[], tChartInst;
let incData=[], filtData=[];
let prevTot=null, prevSev=null;
let filt='all', travelMode='driving';
let rt, ct, csec=10, clockId;
let sTimer;
let gcache={};
let inited=false;
let clickLat=null, clickLng=null;
let sheetOpen=false;

/* ─── LANDING MAP ─────────────────────── */
document.addEventListener('DOMContentLoaded',()=>{
  landMap=L.map('landing-map',{
    zoomControl:false,attributionControl:false,
    dragging:true,scrollWheelZoom:true,doubleClickZoom:true,touchZoom:true,keyboard:false
  }).setView([20.5937,78.9629],4);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:18}).addTo(landMap);
  landMap.on('click',()=>{
    document.getElementById('landing-map').classList.add('active');
    setTimeout(startApp,600);
  });
  setTimeout(()=>document.getElementById('landing-map').classList.add('active'),1000);
  document.getElementById('aModal').addEventListener('click',e=>{if(e.target===document.getElementById('aModal'))closeMod();});
});

/* ─── NAV ────────────────────────────── */
function startApp(){
  document.getElementById('landing').style.display='none';
  document.getElementById('app').style.display='flex';
  if(!inited){inited=true;initMap();}
}
function showLanding(){
  document.getElementById('landing').style.display='flex';
  document.getElementById('app').style.display='none';
}
function showDevPage(){
  document.getElementById('devPage').classList.add('open');
}
function hideDevPage(){
  document.getElementById('devPage').classList.remove('open');
}

/* ─── MAP INIT ───────────────────────── */
function initMap(){
  lmap=L.map('map',{zoomControl:false,attributionControl:true}).setView([curLat,curLng],13);
  tileLt=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:19});
  tileDk=L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{attribution:'&copy; CartoDB',maxZoom:19});
  tileSat=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'&copy; Esri',maxZoom:19});
  // tileDk.addTo(lmap);
  tileLt.addTo(lmap) ; 
  lmap.on('click',onMapClick);
  lmap.on('mousemove',e=>{
    document.getElementById('msCoords').textContent=`${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
  });
  setupSearch();
  initTChart();
  fetchTraffic();
  fetchWxAQI(curLat,curLng,curCity);
  startTimer();
  startClock();
}

function swapTile(tile){
  [tileLt,tileDk,tileSat].forEach(t=>{if(lmap.hasLayer(t))lmap.removeLayer(t);});
  lmap.addLayer(tile);
}

/* ─── CLOCK ──────────────────────────── */
function startClock(){
  clearInterval(clockId);
  clockId=setInterval(()=>{
    try{
      const now=new Date();
      document.getElementById('ltTime').textContent=now.toLocaleTimeString('en-GB',{timeZone:curTZ,hour:'2-digit',minute:'2-digit',second:'2-digit'});
      document.getElementById('ltDate').textContent=now.toLocaleDateString('en-GB',{timeZone:curTZ,day:'numeric',month:'short',year:'numeric'});
    }catch{}
  },1000);
}

/* ─── WEATHER + AQI ──────────────────── */
async function fetchWxAQI(lat,lng,cityName){
  try{
    const[wxr,aqr]=await Promise.all([
      fetch(`${WX}?latitude=${lat}&longitude=${lng}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weathercode,windspeed_10m&timezone=auto`),
      fetch(`${AQIEP}?latitude=${lat}&longitude=${lng}&current=us_aqi&timezone=auto`)
    ]);
    const wx=await wxr.json();
    const aq=await aqr.json();
    const c=wx.current;
    const tempVal=Math.round(c.temperature_2m)+'°';
    document.getElementById('wxTemp').textContent=tempVal;
    document.getElementById('wxDesc').textContent=(WMO[c.weathercode]||'—')+' · Feels '+Math.round(c.apparent_temperature)+'°';
    document.getElementById('wxWind').textContent=Math.round(c.windspeed_10m)+' km/h';
    document.getElementById('wxHumid').textContent=c.relative_humidity_2m+'% RH';
    document.getElementById('msbTemp').textContent=tempVal;
    if(wx.timezone){curTZ=wx.timezone;startClock();}
    if(cityName){
      curCity=cityName;
      document.getElementById('ltPlace').textContent=cityName;
      document.getElementById('msbCity').textContent=cityName.split(',')[0];
    }
    const aqi=aq.current?.us_aqi??null;
    const aqiEl=document.getElementById('wxAqi');
    if(aqi!==null){
      const{lbl,col}=aqiCat(aqi);
      aqiEl.textContent=`AQI ${aqi} — ${lbl}`;
      aqiEl.style.display='inline-flex';
      aqiEl.style.background=col+'18';
      aqiEl.style.color=col;
      aqiEl.style.border=`1px solid ${col}30`;
    }else{aqiEl.style.display='none';}
  }catch(e){
    console.warn('Weather error',e);
    document.getElementById('wxDesc').textContent='Weather unavailable';
  }
}
function aqiCat(v){
  if(v<=50)  return{lbl:'Good',col:'#2DD4BF'};
  if(v<=100) return{lbl:'Moderate',col:'#FB923C'};
  if(v<=150) return{lbl:'Unhealthy (SG)',col:'#F97316'};
  if(v<=200) return{lbl:'Unhealthy',col: '#B91C1C'};
  if(v<=300) return{lbl:'Very Unhealthy',col:'#B91C1C'};
  return{lbl:'Hazardous',col:'#B91C1C'};
}

/* ─── SEARCH ─────────────────────────── */
function setupSearch(){
  const inp=document.getElementById('searchInput');
  const drop=document.getElementById('sugDrop');
  inp.addEventListener('input',e=>{
    const q=e.target.value.trim();
    document.getElementById('sClear').style.display=q?'flex':'none';
    clearTimeout(sTimer);
    if(q.length<2){drop.style.display='none';return;}
    sTimer=setTimeout(()=>nomSuggest(q),320);
  });
  inp.addEventListener('keydown',e=>{
    if(e.key==='Enter'){drop.style.display='none';nomSearch(inp.value.trim());}
    if(e.key==='Escape')drop.style.display='none';
  });
  document.addEventListener('click',e=>{if(!e.target.closest('.search-shell'))drop.style.display='none';});
}

async function nomSuggest(q){
  showSpin(true);
  try{
    const r=await fetch(`${NOM}/search?q=${encodeURIComponent(q)}&format=json&limit=10&addressdetails=1&namedetails=1`,{headers:{'Accept-Language':'en','User-Agent':UA}});
    const data=await r.json();
    if(!data||!data.length){document.getElementById('sugDrop').style.display='none';return;}
    const qMain=q.toLowerCase().split(',')[0].trim();
    const sorted=data.map(d=>{
      let s=0;
      const type=(d.type||'').toLowerCase();
      const cls=(d.class||'').toLowerCase();
      const rank=parseInt(d.place_rank||99);
      const name=((d.namedetails&&(d.namedetails['name:en']||d.namedetails.name))||d.display_name||'').toLowerCase();
      if(type==='city'||type==='metropolis') s+=25;
      else if(type==='town') s+=18;
      else if(type==='municipality'||type==='administrative') s+=14;
      else if(type==='village') s+=10;
      else if(cls==='place') s+=6;
      else if(cls==='boundary'||cls==='administrative') s+=8;
      else s-=10;
      if(rank>=8&&rank<=12) s+=15;
      else if(rank>12&&rank<=16) s+=10;
      else if(rank>16&&rank<=20) s+=5;
      if(name===qMain) s+=40;
      else if(name.startsWith(qMain)) s+=20;
      else if(name.includes(qMain)) s+=8;
      return{...d,_s:s};
    }).sort((a,b)=>b._s-a._s).slice(0,6);
    renderSugs(sorted);
  }catch{}finally{showSpin(false);}
}

function renderSugs(data){
  const drop=document.getElementById('sugDrop');
  if(!data||!data.length){drop.style.display='none';return;}
  drop.innerHTML=data.map(r=>{
    const p=r.display_name.split(',');
    return`<div class="sug-row" onclick="pickSug(${r.lat},${r.lon},\`${r.display_name.replace(/`/g,"'")}\`)">
      <div class="sug-icon"></div>
      <div><div class="sug-main">${p[0]}</div><div class="sug-sub">${p.slice(1,3).join(',').trim()}</div></div>
    </div>`;
  }).join('');
  drop.style.display='block';
}

function pickSug(lat,lng,name){
  document.getElementById('sugDrop').style.display='none';
  document.getElementById('searchInput').value=name.split(',')[0];
  document.getElementById('sClear').style.display='flex';
  moveTo(parseFloat(lat),parseFloat(lng),name,13);
}

async function nomSearch(q){
  if(!q)return;
  showSpin(true);
  try{
    const r=await fetch(`${NOM}/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1&namedetails=1`,{headers:{'Accept-Language':'en','User-Agent':UA}});
    const data=await r.json();
    const qMain=q.toLowerCase().split(',')[0].trim();
    const scored=data.map(d=>{
      let s=0;
      const type=(d.type||'').toLowerCase();
      const cls=(d.class||'').toLowerCase();
      const rank=parseInt(d.place_rank||99);
      const name=((d.namedetails&&(d.namedetails['name:en']||d.namedetails.name))||d.display_name||'').toLowerCase();
      if(type==='city'||type==='metropolis') s+=25;
      else if(type==='town') s+=18;
      else if(type==='municipality'||type==='administrative') s+=14;
      else if(type==='village') s+=10;
      else if(cls==='place') s+=6;
      if(rank>=8&&rank<=12) s+=15;
      else if(rank>12&&rank<=16) s+=10;
      if(name===qMain) s+=40;
      else if(name.startsWith(qMain)) s+=20;
      else if(name.includes(qMain)) s+=8;
      return{...d,_s:s};
    }).sort((a,b)=>b._s-a._s);
    const best=scored[0];
    if(best) pickSug(parseFloat(best.lat),parseFloat(best.lon),best.display_name);
    else toast('err','Not Found',`"${q}" not found. Try adding state or country.`);
  }catch{toast('err','Error','Search failed. Check connection.');}
  finally{showSpin(false);}
}

function clearSearch(){
  document.getElementById('searchInput').value='';
  document.getElementById('sClear').style.display='none';
  document.getElementById('sugDrop').style.display='none';
}
function qs(q){document.getElementById('searchInput').value=q;document.getElementById('sClear').style.display='flex';nomSearch(q);}

/* ─── MOVE TO ─────────────────────────── */
function moveTo(lat,lng,label,zoom=13){
  curLat=lat;curLng=lng;
  lmap.setView([lat,lng],zoom);
  placeSelMk(lat,lng);
  const parts=label.split(',');
  const cityName=parts[0].trim();
  curCity=cityName;
  document.getElementById('ltPlace').textContent=cityName;
  document.getElementById('msbCity').textContent=cityName;
  document.getElementById('msCoords').textContent=`${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  clearAll();
  fetchTraffic();
  fetchWxAQI(lat,lng,cityName);
  toast('ok','Location Set',parts.slice(0,2).join(','));
}

function clearAll(){
  incMks.forEach(m=>lmap.removeLayer(m));
  heatMks.forEach(m=>lmap.removeLayer(m));
  incMks=[];heatMks=[];incData=[];filtData=[];
  document.getElementById('bsBody').innerHTML='<div class="empty-inc">Loading incidents…</div>';
  document.getElementById('bsCount').textContent='loading…';
  document.getElementById('fabCount').textContent='—';
  ['sTotal','sSevere'].forEach(id=>document.getElementById(id).textContent='—');
  document.getElementById('msTotal').textContent='—';
  document.getElementById('cRing').textContent='—';
  document.getElementById('cStat').textContent='—';
  document.getElementById('msStatus').textContent='—';
  document.getElementById('msbInc').textContent='—';
  document.getElementById('msbSev').textContent='—';
  document.getElementById('msbStatus').textContent='—';
}

function placeSelMk(lat,lng){
  if(selMk)lmap.removeLayer(selMk);
  selMk=L.circleMarker([lat,lng],{radius:8,color:'#D4943A',fillColor:'#D4943A',fillOpacity:.15,weight:2,dashArray:'5 4'}).addTo(lmap);
}

/* ─── MAP CLICK ──────────────────────── */
async function onMapClick(e){
  clickLat=e.latlng.lat;clickLng=e.latlng.lng;
  const panel=document.getElementById('locReveal');
  panel.style.display='block';
  if(window.innerWidth>768){
    const mp=lmap.latLngToContainerPoint(e.latlng);
    const pw=226,ph=140;
    let px=mp.x+16,py=mp.y-ph/2;
    const ctr=lmap.getContainer();
    if(px+pw>ctr.offsetWidth-16) px=mp.x-pw-16;
    if(py<10) py=10;
    if(py+ph>ctr.offsetHeight-30) py=ctr.offsetHeight-ph-30;
    panel.style.left=px+'px';panel.style.top=py+'px';
    panel.style.bottom='auto';panel.style.right='auto';
  }
  document.getElementById('lrCoord').textContent=`${clickLat.toFixed(5)}, ${clickLng.toFixed(5)}`;
  document.getElementById('lrPlace').textContent='Looking up address…';
  try{
    const r=await fetch(`${NOM}/reverse?lat=${clickLat}&lon=${clickLng}&format=json&zoom=17`,{headers:{'Accept-Language':'en','User-Agent':UA}});
    const d=await r.json();
    if(!d.error){
      const a=d.address||{};
      const parts=[a.road||a.pedestrian||a.path,a.neighbourhood||a.suburb||a.city_district,a.city||a.town||a.village].filter(Boolean);
      document.getElementById('lrPlace').textContent=parts.length?parts.join(', '):(d.display_name?.split(',').slice(0,2).join(',')||'Unknown');
    }else{
      document.getElementById('lrPlace').textContent=`${clickLat.toFixed(4)}, ${clickLng.toFixed(4)}`;
    }
  }catch{document.getElementById('lrPlace').textContent=`${clickLat.toFixed(4)}, ${clickLng.toFixed(4)}`;}
}

function closeLR(){document.getElementById('locReveal').style.display='none';clickLat=null;clickLng=null;}
function lrSetOrigin(){
  const p=document.getElementById('lrPlace').textContent;
  document.getElementById('rFrom').value=`${clickLat.toFixed(6)},${clickLng.toFixed(6)}`;
  document.getElementById('hFrom').textContent='Resolved: '+p;
  document.getElementById('hFrom').style.display='block';
  document.getElementById('routePanel').classList.add('open');
  document.getElementById('routeTopBtn').classList.add('on');
  closeLR();toast('ok','Origin Set',p);
}
function lrSetDest(){
  const p=document.getElementById('lrPlace').textContent;
  document.getElementById('rTo').value=`${clickLat.toFixed(6)},${clickLng.toFixed(6)}`;
  document.getElementById('hTo').textContent='Resolved: '+p;
  document.getElementById('hTo').style.display='block';
  document.getElementById('routePanel').classList.add('open');
  document.getElementById('routeTopBtn').classList.add('on');
  closeLR();toast('ok','Destination Set',p);
}
function lrLoadTraffic(){
  if(clickLat&&clickLng){moveTo(clickLat,clickLng,`${clickLat.toFixed(4)}, ${clickLng.toFixed(4)}`,14);closeLR();}
}

/* ─── GEOCODE ─────────────────────────── */
async function geocode(q){
  const cm=q.trim().match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if(cm)return{lat:parseFloat(cm[1]),lon:parseFloat(cm[2]),name:q.trim()};
  const key=q.toLowerCase().trim();
  if(gcache[key])return gcache[key];
  try{
    const r=await fetch(`${NOM}/search?q=${encodeURIComponent(q)}&format=json&limit=10&addressdetails=1&namedetails=1`,{headers:{'Accept-Language':'en','User-Agent':UA}});
    const data=await r.json();
    if(!data||!data.length)return null;
    const qMain=q.toLowerCase().split(',')[0].trim();
    const scored=data.map(d=>{
      let s=0;
      const type=(d.type||'').toLowerCase();
      const cls=(d.class||'').toLowerCase();
      const rank=parseInt(d.place_rank||99);
      const name=((d.namedetails&&(d.namedetails['name:en']||d.namedetails.name))||'').toLowerCase();
      const dispName=(d.display_name||'').toLowerCase();
      if(type==='city'||type==='metropolis') s+=30;
      else if(type==='town') s+=22;
      else if(type==='municipality') s+=18;
      else if(type==='administrative') s+=16;
      else if(type==='village') s+=12;
      else if(cls==='place') s+=8;
      else if(cls==='boundary') s+=10;
      else s-=15;
      if(rank>=8&&rank<=12) s+=20;
      else if(rank>12&&rank<=16) s+=14;
      else if(rank>16&&rank<=20) s+=6;
      else if(rank>20) s-=5;
      if(name===qMain||dispName.split(',')[0].trim()===qMain) s+=50;
      else if(name.startsWith(qMain)) s+=25;
      else if(name.includes(qMain)) s+=10;
      else if(dispName.includes(qMain)) s+=5;
      return{...d,_s:s};
    }).sort((a,b)=>b._s-a._s);
    const best=scored[0];
    if(best){
      const res={lat:parseFloat(best.lat),lon:parseFloat(best.lon),name:best.display_name};
      gcache[key]=res;return res;
    }
  }catch(e){console.warn('Geocode error',e);}
  return null;
}

/* ─── TRAFFIC DATA ───────────────────── */
async function fetchTraffic(){
  const d=0.065;
  const bbox=`${curLng-d},${curLat-d},${curLng+d},${curLat+d}`;
  const url=`https://api.tomtom.com/traffic/services/5/incidentDetails?bbox=${bbox}&key=${TT}&fields={incidents{type,geometry{type,coordinates},properties{id,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}`;
  showLoad(true,'Fetching live incidents…');
  try{
    const r=await fetch(url);
    if(!r.ok)throw new Error('API '+r.status);
    const data=await r.json();
    incData=data.incidents||[];
    applyFilt(filt);
    updateStats(incData);
    addTrend(incData.length);
    const t=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    document.getElementById('msTime').textContent=t;
    document.getElementById('msTotal').textContent=incData.length;
    document.getElementById('fabCount').textContent=incData.length;
    const hi=incData.filter(i=>(i.properties.magnitudeOfDelay||0)>=4).length;
    const fabDot=document.getElementById('fabDot');
    if(hi>0){fabDot.style.background='var(--danger)';document.getElementById('fabLabel').textContent=`${hi} Severe`;}
    else if(incData.length>0){fabDot.style.background='var(--warn)';document.getElementById('fabLabel').textContent='Incidents';}
    else{fabDot.style.background='var(--ok)';document.getElementById('fabLabel').textContent='All Clear';}
    updNearby();
  }catch(e){
    console.error(e);
    document.getElementById('bsBody').innerHTML='<div class="empty-inc">Traffic data unavailable. Retrying…</div>';
    toast('err','API Error','Could not load traffic data.');
  }finally{showLoad(false);csec=10;}
}

/* ─── FILTER + RENDER ────────────────── */
function setFilt(f,el){
  filt=f;
  document.querySelectorAll('.bs-chip').forEach(c=>c.classList.remove('on'));
  el.classList.add('on');applyFilt(f);
}
function applyFilt(f){
  const s=i=>i.properties.magnitudeOfDelay||0;
  if(f==='all')      filtData=incData;
  else if(f==='high')filtData=incData.filter(i=>s(i)>=4);
  else if(f==='med') filtData=incData.filter(i=>s(i)>=2&&s(i)<4);
  else if(f==='low') filtData=incData.filter(i=>s(i)<2);
  renderInc(filtData);
}

function renderInc(incidents){
  incMks.forEach(m=>lmap.removeLayer(m));
  heatMks.forEach(m=>lmap.removeLayer(m));
  incMks=[];heatMks=[];
  const body=document.getElementById('bsBody');
  document.getElementById('bsCount').textContent=`${incidents.length} found`;
  body.innerHTML='';
  if(!incidents.length){
    body.innerHTML=`<div class="empty-inc">${incData.length?'No incidents match this filter.':'No incidents in this area — roads are clear.'}</div>`;
    return;
  }
  incidents.forEach((inc,idx)=>{
    const c=inc.geometry.coordinates[0];
    const lat=c[1],lng=c[0];
    const sev=inc.properties.magnitudeOfDelay||0;
    const desc=inc.properties.events?.[0]?.description||'Traffic Incident';
    const from=inc.properties.from||'';
    const to=inc.properties.to||'';
    const delay=inc.properties.delay?Math.round(inc.properties.delay/60):0;
    const col=sev<2?'#2DD4BF':sev<4?'#FB923C':'#F43F5E';
    const bg=sev<2?'rgba(45,212,191,.1)':sev<4?'rgba(251,146,60,.1)':'rgba(244,63,94,.1)';
    const lbl=sev<2?'LOW':sev<4?'MED':'HIGH';
    if(layers.inc){
      const mk=L.circleMarker([lat,lng],{radius:6+sev*2.5,color:'rgba(255,255,255,.2)',weight:1.5,fillColor:col,fillOpacity:.85});
      mk.bindPopup(`<div class="mp">
        <span class="mp-badge" style="background:${bg};color:${col}">${lbl}</span>
        <h3>${desc.length>48?desc.slice(0,48)+'…':desc}</h3>
        ${from?`<div class="mp-from">${from}${to?' → '+to:''}</div>`:''}
        <div class="mp-stats">
          <div>Delay: <b style="color:${delay>10?'#F43F5E':delay>3?'#FB923C':'#2DD4BF'}">${delay} min</b></div>
          <div>Severity: <b style="color:${col}">${sev}/6</b></div>
        </div>
      </div>`,{maxWidth:250});
      mk.addTo(lmap);incMks.push(mk);
    }
    if(layers.heat){
      const h=L.circle([lat,lng],{radius:220+sev*90,color:col,fillColor:col,fillOpacity:.05,weight:0}).addTo(lmap);
      heatMks.push(h);
    }
    const div=document.createElement('div');
    div.className='inc-row';
    const dCol=delay>10?'#F43F5E':delay>3?'#FB923C':'#2DD4BF';
    div.innerHTML=`<div class="inc-sev-bar" style="background:${col}"></div>
    <div class="inc-body">
      <div class="inc-title-txt">${desc}</div>
      <div class="inc-meta-txt">${from?from.slice(0,38):`${lat.toFixed(3)}, ${lng.toFixed(3)}`}</div>
    </div>
    <div class="inc-delay-badge" style="background:${dCol}18;color:${dCol};border:1px solid ${dCol}30">${delay}m</div>`;
    div.onclick=()=>{lmap.setView([lat,lng],15);if(incMks[idx])incMks[idx].openPopup();};
    body.appendChild(div);
  });
}

/* ─── STATS ──────────────────────────── */
function updateStats(inc){
  const tot=inc.length;
  const hi=inc.filter(i=>(i.properties.magnitudeOfDelay||0)>=4).length;
  const md=inc.filter(i=>{const s=i.properties.magnitudeOfDelay||0;return s>=2&&s<4;}).length;
  const lo=inc.filter(i=>(i.properties.magnitudeOfDelay||0)<2).length;
  document.getElementById('sTotal').textContent=tot;
  document.getElementById('sSevere').textContent=hi;
  document.getElementById('msbInc').textContent=tot;
  document.getElementById('msbSev').textContent=hi;
  const dT=document.getElementById('sdTotal'),dS=document.getElementById('sdSevere');
  if(prevTot!==null){const d=tot-prevTot;dT.textContent=d===0?'No change':d>0?`+${d} new`:`${Math.abs(d)} cleared`;dT.className='lp-delta '+(d>0?'delta-up':d<0?'delta-dn':'delta-eq');}
  else{dT.textContent='First poll';dT.className='lp-delta delta-eq';}
  if(prevSev!==null){const d=hi-prevSev;dS.textContent=d===0?'Same':d>0?`+${d}`:String(Math.abs(d));dS.className='lp-delta '+(d>0?'delta-up':d<0?'delta-dn':'delta-eq');}
  else{dS.textContent='—';dS.className='lp-delta delta-eq';}
  prevTot=tot;prevSev=hi;
  const mx=Math.max(tot,1);
  document.getElementById('sfH').style.width=(hi/mx*100)+'%';
  document.getElementById('sfM').style.width=(md/mx*100)+'%';
  document.getElementById('sfL').style.width=(lo/mx*100)+'%';
  document.getElementById('snH').textContent=hi;
  document.getElementById('snM').textContent=md;
  document.getElementById('snL').textContent=lo;
  const st=document.getElementById('msStatus');
  let statusTxt='';
  if(!tot){st.textContent='Clear';st.style.color='var(--ok)';statusTxt='Clear';}
  else if(tot<5){st.textContent='Light';st.style.color='var(--ok)';statusTxt='Light';}
  else if(tot<14){st.textContent='Moderate';st.style.color='var(--warn)';statusTxt='Moderate';}
  else{st.textContent='Heavy';st.style.color='var(--danger)';statusTxt='Heavy';}
  document.getElementById('msbStatus').textContent=statusTxt;
  const score=tot?Math.min(99,Math.round((hi*4+md*2+lo*0.5)/Math.max(tot*0.6,1)*10)):0;
  const ring=document.getElementById('cRing'),cstat=document.getElementById('cStat');
  ring.textContent=score;
  if(score<30){ring.style.color='var(--ok)';ring.style.borderColor='var(--ok)';cstat.textContent='Flowing well';}
  else if(score<65){ring.style.color='var(--warn)';ring.style.borderColor='var(--warn)';cstat.textContent='Moderate';}
  else{ring.style.color='var(--danger)';ring.style.borderColor='var(--danger)';cstat.textContent='Congested';}
}

function addTrend(n){
  const t=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  trend.push({t,n});if(trend.length>10)trend.shift();
  tChartInst.data.labels=trend.map(d=>d.t);
  tChartInst.data.datasets[0].data=trend.map(d=>d.n);
  tChartInst.update('none');
}

function updNearby(){
  const el=document.getElementById('nearbyDiv');
  if(!incData.length){el.innerHTML='<div style="font-size:12px;color:var(--text-3);padding:10px 0">No incidents near current area.</div>';return;}
  const srt=[...incData].sort((a,b)=>(b.properties.magnitudeOfDelay||0)-(a.properties.magnitudeOfDelay||0));
  el.innerHTML=srt.slice(0,4).map(inc=>{
    const desc=inc.properties.events?.[0]?.description||'Incident';
    const delay=inc.properties.delay?Math.round(inc.properties.delay/60):0;
    const sev=inc.properties.magnitudeOfDelay||0;
    const col=sev<2?'var(--ok)':sev<4?'var(--warn)':'var(--danger)';
    const c=inc.geometry.coordinates[0];
    return`<div class="nearby-row" onclick="lmap.setView([${c[1]},${c[0]}],15)">
      <div class="nr-title">${desc}</div>
      <div class="nr-meta" style="color:${col}">${delay} min delay &middot; severity ${sev}/6</div>
    </div>`;
  }).join('');
}

/* ─── CHART ──────────────────────────── */
function initTChart(){
  const ctx=document.getElementById('tChart').getContext('2d');
  tChartInst=new Chart(ctx,{
    type:'line',
    data:{labels:[],datasets:[{data:[],borderColor:'#D4943A',backgroundColor:'rgba(212,148,58,0.08)',fill:true,tension:.4,pointRadius:2,pointBackgroundColor:'#D4943A',borderWidth:1.5}]},
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#0D1220',borderColor:'rgba(212,148,58,0.2)',borderWidth:1,titleColor:'#5C6B8A',bodyColor:'#EAF0FB',titleFont:{family:'DM Mono',size:9},bodyFont:{family:'DM Mono',size:11}}},
      scales:{x:{display:false},y:{display:true,grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#5C6B8A',font:{size:9,family:'DM Mono'},maxTicksLimit:4}}}
    }
  });
}

/* ─── LAYERS ─────────────────────────── */
function toggleLayers(){document.getElementById('layerFloat').classList.toggle('show');}
function togLayer(k){
  layers[k]=!layers[k];
  const id='t'+k.charAt(0).toUpperCase()+k.slice(1);
  document.getElementById(id).classList.toggle('on',layers[k]);
  if(k==='dark'){
    if(layers[k]){swapTile(tileDk);layers.sat=false;document.getElementById('tSat').classList.remove('on');}
    else swapTile(tileLt);return;
  }
  if(k==='sat'){
    if(layers[k]){swapTile(tileSat);layers.dark=false;document.getElementById('tDark').classList.remove('on');}
    else swapTile(layers.dark?tileDk:tileLt);return;
  }
  applyFilt(filt);
}

/* ─── CONTROLS ───────────────────────── */
function toggleSel(){
  selMode=!selMode;
  const b=document.getElementById('selBtn');
  b.classList.toggle('on',selMode);
  b.textContent=selMode?'Click on Map…':'Select Area';
  if(selMode)toast('ok','Selection Mode','Click anywhere on the map to set the focus area.');
}
function toggleRoute(){
  const rp=document.getElementById('routePanel');
  rp.classList.toggle('open');
  document.getElementById('routeTopBtn').classList.toggle('on',rp.classList.contains('open'));
}
function pickMode(el){
  document.querySelectorAll('.mode-opt').forEach(e=>e.classList.remove('on'));
  el.classList.add('on');
  travelMode=el.dataset.m;
}
function toggleSheet(){
  sheetOpen=!sheetOpen;
  document.getElementById('bottomSheet').classList.toggle('open',sheetOpen);
  const fab=document.getElementById('incFab');
  fab.style.bottom=sheetOpen?'310px':'16px';
  document.getElementById('fabArrow').textContent=sheetOpen?'▼':'▲';
}

function goMyLoc(){
  if(!navigator.geolocation){toast('err','Not Supported','Geolocation not available.');return;}
  navigator.geolocation.getCurrentPosition(
    async pos=>{
      const lat=pos.coords.latitude,lng=pos.coords.longitude;
      try{
        const r=await fetch(`${NOM}/reverse?lat=${lat}&lon=${lng}&format=json`,{headers:{'Accept-Language':'en','User-Agent':UA}});
        const d=await r.json();
        const a=d.address||{};
        const name=a.city||a.town||a.village||a.county||'My Location';
        moveTo(lat,lng,name,14);
      }catch{moveTo(lat,lng,'My Location',14);}
    },
    err=>{
      const m={1:'Permission denied.',2:'Position unavailable.',3:'Timeout.'};
      toast('err','Location Error',m[err.code]||'Could not get position.');
    },
    {enableHighAccuracy:true,timeout:10000}
  );
}

function fitAll(){
  if(!incMks.length){toast('wrn','No Markers','No incidents loaded.');return;}
  try{lmap.fitBounds(L.featureGroup(incMks).getBounds().pad(.12));}catch{}
}

/* ═══════════════════════════════════════════════════════════
   ROUTE CALCULATION
   Priority:
     1. TomTom Routing API — live traffic, most accurate (like Google Maps)
     2. OSRM geometry + BASE_SPEED-derived time as fallback
   
   Speed assumptions (BASE_SPEED):
     Car:     70 km/h average on normal roads
     Bicycle: 40 km/h on road
     Walking:  5 km/h normal pace
   
   Traffic delay is applied on top of free-flow time using
   the congestion level derived from TomTom incident data.
═══════════════════════════════════════════════════════════ */
function dirSymbol(maneuver){
  const t=(maneuver?.type||'').toLowerCase();
  const m=(maneuver?.modifier||'').toLowerCase();
  const map={
    'turn left':'←','turn right':'→','turn sharp left':'↖','turn sharp right':'↘',
    'turn slight left':'↖','turn slight right':'↘','continue':'↑','continue straight':'↑',
    'merge':'↗','ramp':'↗','fork left':'←','fork right':'→','roundabout':'↺',
    'arrive':'●','depart':'↑'
  };
  return map[`${t} ${m}`.trim()]||map[t]||'↑';
}

/* Traffic congestion label based on delay ratio */
function conditionLabel(delayMin, totalMin){
  if(!totalMin||totalMin===0) return{label:'Unknown',col:'var(--text-3)',pct:50};
  const ratio=delayMin/(totalMin||1);
  if(ratio<0.05) return{label:'Free Flow',col:'var(--ok)',pct:10};
  if(ratio<0.15) return{label:'Light Traffic',col:'var(--ok)',pct:25};
  if(ratio<0.30) return{label:'Moderate Traffic',col:'var(--warn)',pct:50};
  if(ratio<0.50) return{label:'Heavy Traffic',col:'var(--warn)',pct:72};
  return{label:'Severe Congestion',col:'var(--danger)',pct:92};
}

/*
 * getTrafficMultiplier — derive congestion factor from live incident data
 * so the OSRM fallback still reflects real traffic conditions.
 */
function getTrafficMultiplier(){
  const tot=incData.length;
  const hi=incData.filter(i=>(i.properties.magnitudeOfDelay||0)>=4).length;
  if(!tot)                return TRAFFIC_FACTOR.clear;
  if(hi>=3||tot>=14)      return TRAFFIC_FACTOR.heavy;
  if(hi>=1||tot>=5)       return TRAFFIC_FACTOR.moderate;
  return TRAFFIC_FACTOR.light;
}

async function calcRoute(){
  const fromQ=document.getElementById('rFrom').value.trim();
  const toQ=document.getElementById('rTo').value.trim();
  if(!fromQ||!toQ){toast('wrn','Required','Enter both origin and destination.');return;}

  const btn=document.getElementById('calcBtn');
  btn.disabled=true;btn.textContent='Calculating…';
  const rc=document.getElementById('routeCard');
  rc.style.display='block';
  rc.innerHTML='<div class="rc-head">Resolving locations…</div>';

  if(routeLine){lmap.removeLayer(routeLine);routeLine=null;}
  wptMks.forEach(m=>lmap.removeLayer(m));wptMks=[];

  try{
    const[gA,gB]=await Promise.all([geocode(fromQ),geocode(toQ)]);

    document.getElementById('hFrom').textContent=(gA?gA.name.split(',').slice(0,3).join(','):'Not found');
    document.getElementById('hFrom').style.display='block';
    document.getElementById('hTo').textContent= (gB?gB.name.split(',').slice(0,3).join(','):'Not found');
    document.getElementById('hTo').style.display='block';

    if(!gA)throw new Error(`Origin not found: "${fromQ}"\nTip: Include state/country — e.g. "Ludhiana, Punjab, India"`);
    if(!gB)throw new Error(`Destination not found: "${toQ}"\nTip: Include state/country name.`);

    rc.innerHTML='<div class="rc-head">Computing route with live traffic data…</div>';

    /* API mode mappings */
    const ttModeMap={driving:'car',cycling:'bicycle',foot:'pedestrian'};
    const ttMode=ttModeMap[travelMode]||'car';
    const osrmMode=travelMode;

    /* Parallel fetch: TomTom (live traffic) + OSRM (geometry & turn-by-turn) */
    const ttUrl=`${TT_ROUTE}/${gA.lat},${gA.lon}:${gB.lat},${gB.lon}/json?key=${TT}&travelMode=${ttMode}&routeType=fastest&traffic=true&computeTravelTimeFor=all`;
    const osrmUrl=`${OSRM}/${osrmMode}/${gA.lon},${gA.lat};${gB.lon},${gB.lat}?overview=full&geometries=geojson&steps=true`;

    const[ttResult,osrmResult]=await Promise.allSettled([
      fetch(ttUrl).then(r=>{if(!r.ok)throw new Error('TomTom '+r.status);return r.json();}),
      fetch(osrmUrl).then(r=>{if(!r.ok)throw new Error('OSRM '+r.status);return r.json();})
    ]);

    let finalMin=null, freeFlowMin=null, distKm=null, trafficDelayMin=0;
    let coords=null, steps=[];
    let ttOk=false, osrmOk=false;

    /* ── OSRM: geometry + steps, distance ── */
    if(osrmResult.status==='fulfilled'&&osrmResult.value?.code==='Ok'&&osrmResult.value.routes?.length){
      const or=osrmResult.value.routes[0];
      distKm=(or.distance/1000).toFixed(1);
      coords=or.geometry.coordinates.map(c=>[c[1],c[0]]);
      steps=or.legs[0]?.steps||[];
      osrmOk=true;
      /* Do NOT use OSRM duration directly — we compute from BASE_SPEED below */
    }

    /* ── TomTom: live-traffic travel time (primary, most accurate) ── */
    if(ttResult.status==='fulfilled'&&ttResult.value?.routes?.length){
      const tr=ttResult.value.routes[0];
      const sum=tr.summary;
      finalMin=Math.round(sum.travelTimeInSeconds/60);
      freeFlowMin=Math.round((sum.noTrafficTravelTimeInSeconds||sum.travelTimeInSeconds)/60);
      trafficDelayMin=Math.max(0,Math.round((sum.trafficDelayInSeconds||0)/60));
      if(!distKm) distKm=(sum.lengthInMeters/1000).toFixed(1);
      /* Use TomTom geometry if OSRM did not return one */
      if(!coords&&tr.legs?.length){
        coords=tr.legs.flatMap(leg=>(leg.points||[]).map(p=>[p.latitude,p.longitude]));
      }
      ttOk=true;
    }

    /* ── Fallback: BASE_SPEED + traffic multiplier when TomTom unavailable ── */
    if(!ttOk&&distKm){
      const dist=parseFloat(distKm);
      const spd=BASE_SPEED[travelMode]||50;
      /* Free-flow time based on mode's average road speed */
      freeFlowMin=Math.round((dist/spd)*60);
      /* Apply congestion factor from live incident data */
      const mlt=travelMode==='driving'?getTrafficMultiplier():1.0;
      finalMin=Math.round(freeFlowMin*mlt);
      trafficDelayMin=Math.max(0,finalMin-freeFlowMin);
    }

    if(finalMin===null||!coords)
      throw new Error('No route found. Try different locations or transport mode.');

    /* ── Derived metrics ── */
    const distNum=parseFloat(distKm);
    const h=Math.floor(finalMin/60), m=finalMin%60;
    const timeStr=h>0?`${h}h ${m}m`:`${finalMin} min`;
    const eta=new Date(Date.now()+finalMin*60000);
    const etaStr=eta.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});

    /* Average speed = distance / actual travel time */
    const avgSpd=distNum>0&&finalMin>0?Math.round(distNum/(finalMin/60)):0;

    /* Free-flow time string */
    const ffH=Math.floor(freeFlowMin/60), ffM=freeFlowMin%60;
    const ffStr=ffH>0?`${ffH}h ${ffM}m`:`${freeFlowMin} min`;

    /* Road condition */
    const cond=conditionLabel(trafficDelayMin,freeFlowMin);

    /* Delay colour */
    const dCol=trafficDelayMin===0?'var(--ok)':trafficDelayMin<8?'var(--warn)':'var(--danger)';

    /* Turn-by-turn (skip depart, limit 6) */
    const filteredSteps=steps.filter(s=>s.maneuver?.type!=='depart').slice(0,6);

    /* Data source note */
    const srcNote=ttOk
      ?'<div class="rc-data-source"><div class="rc-src-dot"></div>Real-time traffic data — TomTom Routing API</div>'
      :'<div class="rc-data-source"><div class="rc-src-dot" style="background:var(--warn)"></div>Estimated via road network + live incident data</div>';

    rc.innerHTML=`
      <div class="rc-head">${MODE_LABEL[travelMode]||travelMode}</div>
      <div class="rc-row"><span class="rc-key">Travel Time</span><span class="rc-val" style="color:var(--a)">${timeStr}</span></div>
      ${travelMode==='driving'&&freeFlowMin!==finalMin?`<div class="rc-row"><span class="rc-key">Without Traffic</span><span class="rc-val">${ffStr}</span></div>`:''}
      <div class="rc-row"><span class="rc-key">Distance</span><span class="rc-val">${distKm} km</span></div>
      <div class="rc-row"><span class="rc-key">Avg Speed</span><span class="rc-val">${avgSpd} km/h</span></div>
      ${travelMode==='driving'?`<div class="rc-row"><span class="rc-key">Traffic Delay</span><span class="rc-val" style="color:${dCol}">${trafficDelayMin>0?'+'+trafficDelayMin+' min':'None detected'}</span></div>`:''}
      ${travelMode==='driving'?`<div class="rc-row"><span class="rc-key">Road Condition</span><span class="rc-val" style="color:${cond.col};font-size:10px">${cond.label}</span></div>`:''}
      <div class="rc-row"><span class="rc-key">ETA</span><span class="rc-val" style="color:var(--ok)">${etaStr}</span></div>
      <div class="rc-row"><span class="rc-key">From</span><span class="rc-val" style="font-size:10px;color:var(--text-2)">${gA.name.split(',').slice(0,2).join(', ')}</span></div>
      <div class="rc-row"><span class="rc-key">To</span><span class="rc-val" style="font-size:10px;color:var(--text-2)">${gB.name.split(',').slice(0,2).join(', ')}</span></div>
      ${travelMode==='driving'?`<div style="padding:8px 13px 4px;border-top:1px solid var(--border)">
        <div style="font-size:9px;color:var(--text-3);font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px">Traffic Load</div>
        <div class="route-cond-bar"><div class="route-cond-fill" style="width:${cond.pct}%;background:${cond.col}"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-3);font-family:var(--mono);margin-top:3px"><span>Free</span><span>Congested</span></div>
      </div>`:''}
      ${srcNote}
      ${filteredSteps.length?`<div class="steps-section"><div class="steps-lbl">Turn-by-Turn (${filteredSteps.length} steps)</div>${filteredSteps.map(s=>`<div class="step-item"><span class="step-arrow">${dirSymbol(s.maneuver)}</span><span>${s.name&&s.name!=='(unnamed road)'?'onto '+s.name:'continue'}${s.distance?' ('+Math.round(s.distance/1000*10)/10+' km)':''}</span></div>`).join('')}</div>`:''}`;

    /* Draw route line */
    const modeColor={driving:'#D4943A',cycling:'#2DD4BF',foot:'#A78BFA'};
    routeLine=L.polyline(coords,{
      color:modeColor[travelMode]||'#D4943A',weight:5,opacity:.92,
      dashArray:travelMode==='foot'?'7 9':null,lineJoin:'round',lineCap:'round'
    }).addTo(lmap);

    /* Origin / Destination markers */
    const mkIco=(letter,col)=>L.divIcon({
      html:`<div style="width:28px;height:28px;background:${col};border:2.5px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:12px;box-shadow:0 3px 12px rgba(0,0,0,.4);font-family:'DM Sans',sans-serif">${letter}</div>`,
      iconSize:[28,28],iconAnchor:[14,14],className:''
    });
    const mA=L.marker([gA.lat,gA.lon],{icon:mkIco('A','#2DD4BF')})
      .bindPopup(`<div style="padding:10px 13px;font-family:'DM Sans',sans-serif"><b style="color:#2DD4BF;font-size:9px;font-family:'DM Mono',monospace">ORIGIN</b><br><span style="font-size:13px;font-weight:700;color:#EAF0FB">${gA.name.split(',').slice(0,2).join(', ')}</span></div>`)
      .addTo(lmap);
    const mB=L.marker([gB.lat,gB.lon],{icon:mkIco('B','#D4943A')})
      .bindPopup(`<div style="padding:10px 13px;font-family:'DM Sans',sans-serif"><b style="color:#D4943A;font-size:9px;font-family:'DM Mono',monospace">DESTINATION</b><br><span style="font-size:13px;font-weight:700;color:#EAF0FB">${gB.name.split(',').slice(0,2).join(', ')}</span></div>`)
      .addTo(lmap);
    wptMks.push(mA,mB);

    lmap.fitBounds(routeLine.getBounds().pad(.1));
    toast('ok','Route Calculated',`${distKm} km — ${timeStr}${trafficDelayMin>0?' — +'+trafficDelayMin+'m delay':''}`);

  }catch(e){
    const msg=e.message||'Unknown error';
    rc.innerHTML=`<div class="rc-head err-head">Route Calculation Failed</div><div style="padding:12px 13px;font-size:12px;color:var(--danger);line-height:1.7">${msg}</div>`;
    toast('err','Route Failed',msg.slice(0,100));
  }finally{
    btn.disabled=false;
    btn.textContent='Calculate Fastest Route';
  }
}

/* ─── ANALYSIS MODAL ─────────────────── */
function showAnalysis(){
  document.getElementById('aModal').classList.add('open');
  const tot=incData.length;
  if(!tot){document.getElementById('mBody').innerHTML='<div style="color:var(--text-3);text-align:center;padding:20px">Search a city first.</div>';return;}
  const hi=incData.filter(i=>(i.properties.magnitudeOfDelay||0)>=4).length;
  const md=incData.filter(i=>{const s=i.properties.magnitudeOfDelay||0;return s>=2&&s<4;}).length;
  const lo=incData.filter(i=>(i.properties.magnitudeOfDelay||0)<2).length;
  const avgD=Math.round(incData.reduce((a,b)=>a+(b.properties.delay||0),0)/tot/60);
  const maxD=Math.round(Math.max(...incData.map(i=>i.properties.delay||0))/60);
  const cats={};
  incData.forEach(i=>{const c=i.properties.events?.[0]?.description?.split(' ')[0]||'Other';cats[c]=(cats[c]||0)+1;});
  const top=Object.entries(cats).sort((a,b)=>b[1]-a[1]).slice(0,5);
  document.getElementById('mBody').innerHTML=`
    <div class="m2-grid">
      ${[['Total Incidents',tot,'var(--text)'],['Avg Delay',avgD+'m','var(--warn)'],['Worst Delay',maxD+'m','var(--danger)'],['Severe',hi,'var(--danger)']].map(([l,v,c])=>`
      <div class="m2-card"><div class="m2-label">${l}</div><div class="m2-val" style="color:${c}">${v}</div></div>`).join('')}
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:9px;color:var(--text-3);font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px">Severity Breakdown</div>
      ${[['High',hi,'var(--danger)'],['Medium',md,'var(--warn)'],['Low',lo,'var(--ok)']].map(([l,v,c])=>`
      <div class="pct-r">
        <span class="pct-n" style="color:${c}">${l}</span>
        <div class="pct-trk"><div class="pct-f" style="width:${tot?Math.round(v/tot*100):0}%;background:${c}"></div></div>
        <span class="pct-p">${tot?Math.round(v/tot*100):0}%</span>
      </div>`).join('')}
    </div>
    ${top.length?`<div style="font-size:9px;color:var(--text-3);font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px">Top Incident Types</div>
    ${top.map(([cat,cnt])=>`<div class="type-r"><span style="font-size:13px;font-weight:600;color:var(--text)">${cat}</span><span style="font-family:var(--mono);font-size:12px;color:var(--a);font-weight:700">${cnt}</span></div>`).join('')}`:''}`;
}
function closeMod(){document.getElementById('aModal').classList.remove('open');}

/* ─── EXPORT ─────────────────────────── */
function doExport(){
  if(!incData.length){toast('wrn','No Data','Load traffic data first.');return;}
  const rows=[['Severity(0-6)','Description','From','To','Delay(min)','Latitude','Longitude']];
  incData.forEach(inc=>{
    const c=inc.geometry.coordinates[0];
    rows.push([inc.properties.magnitudeOfDelay||0,inc.properties.events?.[0]?.description||'',inc.properties.from||'',inc.properties.to||'',Math.round((inc.properties.delay||0)/60),c[1].toFixed(6),c[0].toFixed(6)]);
  });
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  a.download=`trafficiq-${new Date().toISOString().slice(0,10)}-${incData.length}inc.csv`;
  a.click();
  toast('ok','Exported',`${incData.length} incidents saved to CSV.`);
}

/* ─── TIMER + UTILS ──────────────────── */
function startTimer(){
  clearInterval(rt);clearInterval(ct);csec=10;
  rt=setInterval(fetchTraffic,10000);
  ct=setInterval(()=>{csec--;if(csec<=0)csec=10;document.getElementById('cdown').textContent=`↻ ${csec}s`;},1000);
}
function showLoad(on,txt='Loading…'){
  document.getElementById('loadOv').style.display=on?'flex':'none';
  if(txt)document.getElementById('loadTxt').textContent=txt;
}
function showSpin(on){document.getElementById('sSpin').style.display=on?'block':'none';}

let _tt;
function toast(type,title,body){
  const el=document.getElementById('toast');
  el.className=`toast ${type}`;
  document.getElementById('tT').textContent=title;
  document.getElementById('tB').textContent=body;
  el.classList.add('show');
  clearTimeout(_tt);_tt=setTimeout(()=>el.classList.remove('show'),4500);
}
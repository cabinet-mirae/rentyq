/* ============================================================
   RentyQ — auth.js
   EVA Scanner V1 : cartographie + scoring emplacement
   ============================================================ */


/* ===== EVA SCANNER V1 — cartographie + scoring ===== */
let evaScannerMap=null;
let evaScannerLayer=null;

const EVA_POI_CONFIG={
  transport:{label:'Transports',icon:'🚉',color:'#7C3AED',score:30,terms:['bus_stop','tram_stop','station','subway_entrance','aerodrome']},
  food:{label:'Restaurants & sorties',icon:'🍽️',color:'#EC4899',score:16,terms:['restaurant','cafe','bar','pub','fast_food']},
  shops:{label:'Commerces',icon:'🛍️',color:'#F97316',score:16,terms:['supermarket','bakery','mall','convenience','clothes','chemist']},
  tourism:{label:'Attractivité',icon:'📍',color:'#0EA5E9',score:12,terms:['attraction','museum','hotel','viewpoint','gallery']},
  parking:{label:'Accès & parking',icon:'🅿️',color:'#10B981',score:8,terms:['parking']},
  prestige:{label:'Adresse premium',icon:'⭐',color:'#F59E0B',score:18,terms:[]},
  localMarket:{label:'Signal Orléans',icon:'🏙️',color:'#7C3AED',score:18,terms:[]},
  events:{label:'Événements',icon:'🎉',color:'#F59E0B',score:14,terms:[]}
};

function scannerApartments(){
  try{
    return (Array.isArray(apparts)?apparts:[]).filter(a=>a&&a.id!=null);
  }catch(e){return []}
}

function scannerAptTitle(a){
  return `${a.emoji||'🏠'} ${a.name||a.title||'Appartement'}`;
}

function scannerAptPlace(a){
  return a.address||a.zone||a.city||'adresse à compléter';
}

function scannerAptHasCoords(a){
  return !!(aptLat(a)&&aptLng(a));
}

function renderScannerPage(){
  // Scanner V2 : outil de prospection libre, sans biens du parc
}

function aptLat(a){return parseFloat(a.lat||a.latitude||a.y||0)}
function aptLng(a){return parseFloat(a.lng||a.lon||a.longitude||a.x||0)}

// Autocomplete adresse libre pour le scanner
let scannerAddressTimer=null;
function scannerAddressSearch(val){
  clearTimeout(scannerAddressTimer);
  const box=document.getElementById('scanner-address-results');
  if(!val||val.length<4){if(box)box.style.display='none';return;}
  scannerAddressTimer=setTimeout(async()=>{
    try{
      const r=await fetch('https://api-adresse.data.gouv.fr/search/?q='+encodeURIComponent(val)+'&limit=5');
      const d=await r.json();
      if(!d.features||!d.features.length){box.style.display='none';return;}
      box.innerHTML=d.features.map(f=>`<div onclick="scannerSelectAddress('${f.properties.label.replace(/'/g,"\\'")}',${f.geometry.coordinates[1]},${f.geometry.coordinates[0]})"
        style="padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #F0F0F5;color:#1A1A2E"
        onmouseover="this.style.background='#F5F4FF'" onmouseout="this.style.background=''">${f.properties.label}</div>`).join('');
      box.style.display='block';
    }catch(e){box.style.display='none';}
  },280);
}

function scannerSelectAddress(label,lat,lng){
  const inp=document.getElementById('scanner-free-address');
  const box=document.getElementById('scanner-address-results');
  const latEl=document.getElementById('scanner-free-lat');
  const lngEl=document.getElementById('scanner-free-lng');
  if(inp)inp.value=label;
  if(latEl)latEl.value=lat;
  if(lngEl)lngEl.value=lng;
  if(box)box.style.display='none';
}

async function runEvaScannerFree(){
  const address=(document.getElementById('scanner-free-address')?.value||'').trim();
  const priceInput=+(document.getElementById('scanner-free-price')?.value||0);
  const res=document.getElementById('scanner-result');
  const latEl=document.getElementById('scanner-free-lat');
  const lngEl=document.getElementById('scanner-free-lng');
  if(!address){res.innerHTML='<div class="scanner-warning">Entrez une adresse pour lancer l\'analyse EVA.</div>';return;}
  let lat=parseFloat(latEl?.value||0),lng=parseFloat(lngEl?.value||0);
  if(!lat||!lng){
    res.innerHTML='<div class="ai-bubble"><div class="ai-bubble-head"><div class="ai-dot"></div> EVA localise l\'adresse\u2026</div><div class="ai-bubble-text"><div class="typing"><span></span><span></span><span></span></div></div></div>';
    try{
      const r=await fetch('https://api-adresse.data.gouv.fr/search/?q='+encodeURIComponent(address)+'&limit=1');
      const d=await r.json();
      const feat=d.features?.[0];
      if(!feat){res.innerHTML='<div class="scanner-warning">Adresse introuvable. V\u00e9rifiez et r\u00e9essayez.</div>';return;}
      lat=feat.geometry.coordinates[1];lng=feat.geometry.coordinates[0];
      if(latEl)latEl.value=lat;if(lngEl)lngEl.value=lng;
    }catch(e){res.innerHTML='<div class="scanner-warning">Impossible de g\u00e9olocaliser cette adresse.</div>';return;}
  }
  res.innerHTML='<div class="ai-bubble"><div class="ai-bubble-head"><div class="ai-dot"></div> EVA scanne l\'environnement local\u2026</div><div class="ai-bubble-text"><div class="typing"><span></span><span></span><span></span></div></div></div>';
  const fakeApt={id:'scanner-free',name:address,address,lat,lng,price:priceInput||null,comp:null,city:address.split(',').slice(-1)[0]?.trim()||'',zone:'',emoji:'\uD83D\uDD0D'};
  let rawPois=[];
  try{rawPois=await fetchEvaNearbyPois(lat,lng);}catch(e){console.warn('Overpass indisponible',e);}
  try{
    const pois=enrichEvaLocalPois(fakeApt,rawPois);
    const analysis=computeEvaScannerAnalysis(fakeApt,pois);
    renderEvaScannerFreeResult(fakeApt,analysis,pois,address,priceInput);
    setTimeout(()=>drawEvaScannerMap(fakeApt,analysis,pois),120);
  }catch(e){
    console.error('Scanner EVA error',e);
    document.getElementById('scanner-result').innerHTML='<div class="scanner-warning">EVA a rencontré une erreur lors de l\'analyse. Vérifiez l\'adresse et réessayez. (' + e.message + ')</div>';
  }
}

async function runEvaScanner(){runEvaScannerFree();}

function renderEvaScannerFreeResult(a,analysis,pois,address,priceInput){
  const topPois=pois.filter(p=>['transport','food','shops','tourism','parking'].includes(p.type)).slice(0,9);
  const scoreColor=analysis.locationScore>=75?'#059669':analysis.locationScore>=55?'#D97706':'#DC2626';
  const verdictIcon=analysis.locationScore>=75?'\u2705':analysis.locationScore>=55?'\u26A0\uFE0F':'\u274C';
  const decision=analysis.locationScore>=75?'Potentiel fort \u2014 \u00e0 prendre en gestion':analysis.locationScore>=55?'Potentiel correct \u2014 \u00e0 n\u00e9gocier selon les conditions':'Emplacement difficile \u2014 conditions favorables indispensables';
  document.getElementById('scanner-result').innerHTML=`
    <div class="scanner-score-grid">
      <div class="scanner-kpi"><div class="scanner-kpi-label">Score emplacement</div><div class="scanner-kpi-value" style="color:${scoreColor}">${analysis.locationScore}/100</div><div class="scanner-kpi-desc">Potentiel locatif de l'adresse</div></div>
      ${priceInput?`<div class="scanner-kpi"><div class="scanner-kpi-label">Prix envisag\u00e9</div><div class="scanner-kpi-value">${priceInput}\u20ac</div><div class="scanner-kpi-desc">Tarif saisi</div></div>
      <div class="scanner-kpi"><div class="scanner-kpi-label">Reco EVA</div><div class="scanner-kpi-value" style="color:#7C3AED">${analysis.recommended}\u20ac</div><div class="scanner-kpi-desc">${analysis.diff>=0?'+':''}${analysis.diff}\u20ac / nuit \u00b7 ${analysis.diffPct>=0?'+':''}${analysis.diffPct}%</div></div>`
      :`<div class="scanner-kpi"><div class="scanner-kpi-label">Prix march\u00e9 EVA</div><div class="scanner-kpi-value" style="color:#7C3AED">${analysis.recommended}\u20ac</div><div class="scanner-kpi-desc">Estimation EVA pour cette adresse</div></div>`}
      <div class="scanner-kpi" style="background:${analysis.locationScore>=75?'#ECFDF5':analysis.locationScore>=55?'#FFFBEB':'#FEF2F2'}">
        <div class="scanner-kpi-label">D\u00e9cision EVA</div>
        <div class="scanner-kpi-value" style="font-size:18px">${verdictIcon}</div>
        <div class="scanner-kpi-desc" style="font-weight:700;color:${scoreColor}">${decision}</div>
      </div>
    </div>
    <div class="scanner-grid">
      <div class="scanner-map-card"><div id="scanner-map"></div></div>
      <div>
        <div class="scanner-diagnostic">
          <div class="scanner-verdict">
            <div class="scanner-verdict-icon">${verdictIcon}</div>
            <div><div class="scanner-verdict-title">Diagnostic EVA : ${escapeHtml(address)}</div><div class="scanner-verdict-text">${analysis.verdict}</div></div>
          </div>
          <div class="scanner-breakdown">
            ${Object.entries(analysis.sub).map(([k,v])=>`<div class="scanner-row"><div class="scanner-row-label">${EVA_POI_CONFIG[k]?.label||k}</div><div class="scanner-bar"><span style="width:${Math.round(v/(EVA_POI_CONFIG[k]?.score||20)*100)}%"></span></div><div class="scanner-row-score">${Math.round(v)}</div></div>`).join('')}
          </div>
        </div>
        <div class="scanner-diagnostic">
          <div class="card-title">Ce qu'EVA a d\u00e9tect\u00e9 autour de l'adresse</div>
          <div class="scanner-poi-list">
            ${topPois.length?topPois.map(p=>`<div class="scanner-poi-item"><strong>${EVA_POI_CONFIG[p.type]?.icon||'\uD83D\uDCCD'} ${escapeHtml(p.name)}</strong><span>${p.distance} m</span></div>`).join(''):'<div class="scanner-warning">Peu de points d\'int\u00e9r\u00eat d\u00e9tect\u00e9s \u00e0 moins de 1,5 km. EVA consid\u00e8re l\'emplacement comme plus difficile \u00e0 valoriser.</div>'}
          </div>
        </div>
      </div>
    </div>`;
}

async function fetchEvaNearbyPois(lat,lng){
  const radius=2000;
  const query=`[out:json][timeout:18];(
    nwr(around:${radius},${lat},${lng})["highway"="bus_stop"];
    nwr(around:${radius},${lat},${lng})["public_transport"~"station|stop_position|platform"];
    nwr(around:${radius},${lat},${lng})["railway"~"station|tram_stop|subway_entrance|halt|platform"];
    nwr(around:${radius},${lat},${lng})["aeroway"~"aerodrome|terminal"];
    nwr(around:${radius},${lat},${lng})["amenity"~"restaurant|cafe|bar|pub|fast_food|parking|theatre|cinema|marketplace"];
    nwr(around:${radius},${lat},${lng})["shop"];
    nwr(around:${radius},${lat},${lng})["tourism"~"attraction|museum|hotel|viewpoint|gallery|artwork"];
    nwr(around:${radius},${lat},${lng})["leisure"~"park|garden|sports_centre|stadium"];
    nwr(around:${radius},${lat},${lng})["historic"];
  );out center 180;`;
  const url='https://overpass-api.de/api/interpreter?data='+encodeURIComponent(query);
  const ctrl=new AbortController();
  const tid=setTimeout(()=>ctrl.abort(),22000);
  let r;
  try{r=await fetch(url,{signal:ctrl.signal});}finally{clearTimeout(tid);}
  if(!r.ok)throw new Error('Overpass indisponible');
  const data=await r.json();
  const seen=new Set();
  return (data.elements||[]).map(el=>{
    const tags=el.tags||{}; const pLat=el.lat||el.center?.lat; const pLng=el.lon||el.center?.lon;
    const key=[Math.round((pLat||0)*100000),Math.round((pLng||0)*100000),tags.name||labelPoi(tags)].join('|');
    if(seen.has(key))return null; seen.add(key);
    return {lat:pLat,lng:pLng,name:tags.name||labelPoi(tags),type:typePoi(tags),tags,distance:distanceMeters(lat,lng,pLat,pLng)};
  }).filter(p=>p&&p.lat&&p.lng).sort((a,b)=>a.distance-b.distance);
}

function labelPoi(tags){
  if(tags.highway==='bus_stop')return 'Arrêt de bus';
  if(tags.public_transport)return 'Transport public';
  if(tags.railway==='tram_stop')return 'Tramway';
  if(tags.railway==='station')return 'Gare / station';
  if(tags.railway==='subway_entrance')return 'Métro';
  if(tags.aeroway==='aerodrome')return 'Aéroport / aérodrome';
  if(tags.amenity)return tags.amenity.replace('_',' ');
  if(tags.shop)return 'Commerce';
  if(tags.tourism)return tags.tourism.replace('_',' ');
  if(tags.leisure)return tags.leisure.replace('_',' ');
  if(tags.historic)return 'Lieu historique';
  return 'Point d’intérêt';
}
function typePoi(tags){
  if(tags.highway==='bus_stop'||tags.public_transport||['station','tram_stop','subway_entrance','halt','platform'].includes(tags.railway)||['aerodrome','terminal'].includes(tags.aeroway))return 'transport';
  if(['restaurant','cafe','bar','pub','fast_food'].includes(tags.amenity))return 'food';
  if(tags.shop)return 'shops';
  if(['attraction','museum','hotel','viewpoint','gallery','artwork'].includes(tags.tourism)||tags.leisure||tags.historic)return 'tourism';
  if(tags.amenity==='parking')return 'parking';
  return 'other';
}
function distanceMeters(lat1,lon1,lat2,lon2){
  const R=6371000,rad=Math.PI/180; const dLat=(lat2-lat1)*rad,dLon=(lon2-lon1)*rad;
  const s=Math.sin(dLat/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)**2;
  return Math.round(2*R*Math.asin(Math.sqrt(s)));
}

function scannerAddressText(a){
  return String([a.name,a.address,a.zone,a.city,a.postal_code,a.cp].filter(Boolean).join(' ')).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}


const ORLEANS_MARKET_ANCHORS=[
  {name:'Cathédrale Sainte-Croix',type:'tourism',lat:47.90292,lng:1.90925,weight:18,keywords:/cathedrale|sainte.?croix|hotel groslot/},
  {name:'Place du Martroi',type:'tourism',lat:47.90245,lng:1.90418,weight:18,keywords:/martroi|rue royale|jeanne d.arc/},
  {name:'Gare d’Orléans',type:'transport',lat:47.90642,lng:1.90472,weight:15,keywords:/gare d.?orleans|gare sncf|avenue de paris/},
  {name:'Rue de Bourgogne',type:'food',lat:47.90058,lng:1.91235,weight:14,keywords:/rue de bourgogne|bourgogne|bars|sorties/},
  {name:'Halles Châtelet',type:'shops',lat:47.89985,lng:1.90385,weight:12,keywords:/chatelet|halles|halle|march[eé]/},
  {name:'Bords de Loire',type:'tourism',lat:47.89750,lng:1.90590,weight:12,keywords:/loire|quai|bords de loire|pont george.?v/},
  {name:'Tram A/B — centre',type:'transport',lat:47.90230,lng:1.90460,weight:14,keywords:/tram|tramway|ligne a|ligne b/},
  {name:'CO’Met / Zénith / Parc Expo',type:'tourism',lat:47.87895,lng:1.91220,weight:10,keywords:/comet|co.?met|zenith|z[eé]nith|parc expo|parc des expositions/}
];

function isOrleansApt(a){
  const t=scannerAddressText(a);
  return /orleans|orl[eé]ans|45000|45100|45100/.test(t);
}

function orleansMicroMarketSignal(a,pois=[]){
  if(!isOrleansApt(a))return {score:0,minScore:0,label:'',signals:[]};
  const t=scannerAddressText(a);
  const lat=aptLat(a),lng=aptLng(a);
  const signals=[];
  let score=0,minScore=54,label='Orléans — potentiel à qualifier';

  ORLEANS_MARKET_ANCHORS.forEach(anchor=>{
    let hit=false,dist=99999;
    if(anchor.keywords.test(t))hit=true;
    if(lat&&lng){dist=distanceMeters(lat,lng,anchor.lat,anchor.lng); if(dist<=900)hit=true;}
    if(hit){signals.push({...anchor,distance:dist}); score+=anchor.weight;}
  });

  if(/hyper.?centre|centre.?ville|centre ville|carmes|republique|r[eé]publique|martroi|cathedrale|bourgogne|chatelet/.test(t)){
    score+=22; minScore=82; label='Orléans hyper-centre — très fort potentiel courte durée';
  }else if(/gare|avenue de paris|dunois/.test(t)){
    score+=18; minScore=74; label='Orléans gare / Dunois — fort potentiel mobilité';
  }else if(/loire|quai|bords de loire|saint marceau|st marceau/.test(t)){
    score+=15; minScore=70; label='Orléans Loire / Saint-Marceau — bon potentiel séjour';
  }else if(/comet|co.?met|zenith|z[eé]nith|parc expo|olivet/.test(t)){
    score+=14; minScore=66; label='Orléans CO’Met / Parc Expo — potentiel événementiel';
  }

  const density=pois.filter(p=>p.distance<=900).length;
  if(density>=22){score+=10; minScore=Math.max(minScore,78);}
  else if(density>=12){score+=6; minScore=Math.max(minScore,70);}

  score=Math.min(18,Math.round(score/4));
  return {score,minScore,label,signals};
}

function enrichEvaLocalPois(a,pois=[]){
  if(!isOrleansApt(a))return pois;
  const lat=aptLat(a),lng=aptLng(a);
  if(!lat||!lng)return pois;
  const enriched=[...pois];
  ORLEANS_MARKET_ANCHORS.forEach(anchor=>{
    const dist=distanceMeters(lat,lng,anchor.lat,anchor.lng);
    if(dist<=2200 && !enriched.some(p=>String(p.name).toLowerCase()===anchor.name.toLowerCase())){
      enriched.push({lat:anchor.lat,lng:anchor.lng,name:anchor.name,type:anchor.type,tags:{source:'eva-orleans'},distance:dist,local:true});
    }
  });
  return enriched.sort((a,b)=>a.distance-b.distance);
}

function prestigeAddressScore(a,pois){
  const t=scannerAddressText(a);
  let score=0;
  if(/champs.?elysees|elysee|avenue montaigne|faubourg saint.?honore|george v|arc de triomphe|triangle d.or/.test(t))score=18;
  else if(/paris/.test(t)&&/(1er|2e|3e|4e|5e|6e|7e|8e|7500[1-8]|marais|saint.?germain|opera|louvre|trocadero|tour eiffel|montmartre)/.test(t))score=14;
  else if(/orleans|orl[eé]ans|45000/.test(t)&&/martroi|cathedrale|sainte.?croix|bourgogne|chatelet|hyper.?centre|centre.?ville|gare d.?orleans|loire/.test(t))score=14;
  else if(/centre.?ville|hyper.?centre|gare|cathedrale|vieux.?port|presqu.ile|croisette|promenade des anglais/.test(t))score=10;
  const namedLandmarks=(pois||[]).filter(p=>p.distance<=1200&&['tourism','transport'].includes(p.type)&&p.name&&!/^Point|Transport|Commerce|Lieu/.test(p.name)).length;
  score=Math.max(score,Math.min(12,namedLandmarks*3));
  return Math.min(18,score);
}

function computeEvaScannerAnalysis(a,pois){
  const city=a.city||((typeof extractCity==='function')?extractCity(a.zone,null):'')||a.zone||'';
  const cityEvents=(typeof eventsCache!=='undefined'&&eventsCache&&city&&eventsCache[city])?eventsCache[city]:[];
  const hotEvents=cityEvents.filter(e=>e.hot);
  const count=(type,dist=1500)=>pois.filter(p=>p.type===type&&p.distance<=dist).length;
  const nearest=(type)=>pois.filter(p=>p.type===type)[0];
  const dense300=pois.filter(p=>p.distance<=300).length;
  const dense800=pois.filter(p=>p.distance<=800).length;
  const dense1500=pois.filter(p=>p.distance<=1500).length;
  const sub={};
  sub.transport=Math.min(30, count('transport',250)*18 + count('transport',600)*7 + count('transport',1200)*2.5);
  sub.food=Math.min(16, count('food',250)*5 + count('food',700)*2 + count('food',1400)*.7);
  sub.shops=Math.min(16, count('shops',250)*5 + count('shops',700)*2 + count('shops',1400)*.7);
  sub.tourism=Math.min(12, count('tourism',500)*5 + count('tourism',1200)*2 + count('tourism',2000)*.8);
  sub.parking=Math.min(8, count('parking',500)*5 + count('parking',1200)*2);
  const orleansSignal=orleansMicroMarketSignal(a,pois);
  sub.prestige=prestigeAddressScore(a,pois);
  sub.localMarket=orleansSignal.score;
  sub.events=Math.min(14, hotEvents.length*7 + cityEvents.length*1.6);
  let locationScore=Math.round(Object.values(sub).reduce((s,v)=>s+v,0));

  // Correctif V2 : l'absence de POI Overpass ne doit pas condamner une adresse premium.
  // Certaines zones très denses sont mal remontées si l'API renvoie peu de nodes/ways.
  const t=scannerAddressText(a);
  if(dense800>=35)locationScore+=8;
  else if(dense800>=20)locationScore+=5;
  else if(dense800<5 && sub.prestige<10)locationScore-=8;
  if(/champs.?elysees|avenue montaigne|george v|arc de triomphe|triangle d.or/.test(t))locationScore=Math.max(locationScore,92);
  else if(/paris/.test(t)&&sub.prestige>=14)locationScore=Math.max(locationScore,82);
  else if(/centre.?ville|hyper.?centre|cathedrale|gare/.test(t)&&sub.prestige>=10)locationScore=Math.max(locationScore,70);
  if(orleansSignal.minScore)locationScore=Math.max(locationScore,orleansSignal.minScore);
  if(/orleans|orl[eé]ans|45000/.test(t)&&/martroi|cathedrale|sainte.?croix|rue de bourgogne|bourgogne|chatelet|halles|hyper.?centre/.test(t))locationScore=Math.max(locationScore,86);
  locationScore=Math.max(18,Math.min(100,locationScore));

  const current=Number(a.price||0);
  const comp=Number(a.comp||a.competitor||0);
  const eventBoost=hotEvents.length?Math.min(.18,hotEvents.reduce((s,e)=>s+(Number(e.boost||8)/100),0)/2):0;
  const prestigeBoost=sub.prestige>=16?.14:sub.prestige>=12?.09:sub.prestige>=8?.05:0;
  const locCoef=0.84+(locationScore/100)*0.46+prestigeBoost;
  let anchor=current||comp||90;
  if(comp&&current)anchor=(current*.55+comp*.45);
  else if(comp)anchor=comp;
  let recommended=Math.round(anchor*locCoef*(1+eventBoost));
  if(current&&recommended>current*1.38)recommended=Math.round(current*1.38);
  if(current&&recommended<current*.80)recommended=Math.round(current*.80);
  recommended=Math.max((typeof floor==='function'?floor(a):0)||35,recommended||Math.round(((typeof floor==='function'?floor(a):0)||55)*1.35));
  const diff=current?recommended-current:0;
  const diffPct=current?Math.round(diff/current*100):0;
  const priceScore=current?Math.max(0,Math.min(100,100-Math.abs(diffPct)*1.7)):55;
  const status=diffPct>=8?'sous-évalué':diffPct<=-8?'trop élevé':'cohérent';
  const verdict=buildEvaScannerVerdict(locationScore,priceScore,status,diffPct,nearest,hotEvents,pois,sub);
  return {sub,locationScore,priceScore,current,recommended,diff,diffPct,status,verdict,hotEvents,cityEvents,nearestTransport:nearest('transport'),nearestFood:nearest('food'),nearestShop:nearest('shops'),poiDensity:{dense300,dense800,dense1500},orleansSignal};
}

function buildEvaScannerVerdict(locationScore,priceScore,status,diffPct,nearest,hotEvents,pois,sub={}){
  let level=locationScore>=85?'Adresse premium très forte':locationScore>=75?'Très bon potentiel locatif':locationScore>=55?'Potentiel locatif correct':'Potentiel à surveiller';
  let env=pois.filter(p=>p.distance<=800).length>=18?'l’environnement est très dense, vivant et facilement valorisable':pois.filter(p=>p.distance<=800).length>=7?'l’environnement est correctement équipé':'l’environnement détecté par la cartographie reste limité';
  if(sub.localMarket>=10)env='EVA reconnaît un signal local orléanais fort : hyper-centre, mobilité, commerces, sorties et attractivité patrimoniale renforcent la valeur courte durée';
  if(sub.prestige>=16)env='l’adresse bénéficie d’un signal premium exceptionnel, avec une forte attractivité touristique, business et commerciale';
  let price=status==='sous-évalué'?`Le prix actuel semble trop bas : EVA détecte une marge de hausse d’environ +${Math.abs(diffPct)}%.`:status==='trop élevé'?`Le prix actuel semble ambitieux : EVA recommande de réduire ou de justifier le tarif par la qualité du logement.`:`Le prix actuel est proche de la zone recommandée par EVA.`;
  let ev=hotEvents.length?` Des événements chauds proches renforcent temporairement la demande.`:'';
  return `${level}. À cette adresse, ${env}. ${price}${ev}`;
}

function renderEvaScannerResult(a,analysis,pois){
  const topPois=pois.filter(p=>['transport','food','shops','tourism','parking'].includes(p.type)).slice(0,9);
  const scoreColor=analysis.locationScore>=75?'#059669':analysis.locationScore>=55?'#D97706':'#DC2626';
  document.getElementById('scanner-result').innerHTML=`
    <div class="scanner-score-grid">
      <div class="scanner-kpi"><div class="scanner-kpi-label">Score emplacement</div><div class="scanner-kpi-value" style="color:${scoreColor}">${analysis.locationScore}/100</div><div class="scanner-kpi-desc">Potentiel de l’adresse</div></div>
      <div class="scanner-kpi"><div class="scanner-kpi-label">Score prix actuel</div><div class="scanner-kpi-value">${analysis.priceScore}/100</div><div class="scanner-kpi-desc">Cohérence avec EVA</div></div>
      <div class="scanner-kpi"><div class="scanner-kpi-label">Prix actuel</div><div class="scanner-kpi-value">${analysis.current||0}€</div><div class="scanner-kpi-desc">Tarif saisi utilisateur</div></div>
      <div class="scanner-kpi"><div class="scanner-kpi-label">Reco EVA</div><div class="scanner-kpi-value" style="color:#7C3AED">${analysis.recommended}€</div><div class="scanner-kpi-desc">${analysis.diff>=0?'+':''}${analysis.diff}€ / nuit · ${analysis.diffPct>=0?'+':''}${analysis.diffPct}%</div></div>
    </div>
    <div class="scanner-grid">
      <div class="scanner-map-card"><div id="scanner-map"></div></div>
      <div>
        <div class="scanner-diagnostic">
          <div class="scanner-verdict"><div class="scanner-verdict-icon">${analysis.status==='sous-évalué'?'📈':analysis.status==='trop élevé'?'⚠️':'✅'}</div><div><div class="scanner-verdict-title">Diagnostic EVA : ${analysis.status}</div><div class="scanner-verdict-text">${analysis.verdict}</div></div></div>
          <div class="scanner-breakdown">
            ${Object.entries(analysis.sub).map(([k,v])=>`<div class="scanner-row"><div class="scanner-row-label">${EVA_POI_CONFIG[k]?.label||k}</div><div class="scanner-bar"><span style="width:${Math.round(v/(EVA_POI_CONFIG[k]?.score||20)*100)}%"></span></div><div class="scanner-row-score">${Math.round(v)}</div></div>`).join('')}
          </div>
        </div>
        <div class="scanner-diagnostic">
          <div class="card-title">Ce que EVA a détecté autour de l’adresse</div>
          <div class="scanner-poi-list">
            ${topPois.length?topPois.map(p=>`<div class="scanner-poi-item"><strong>${EVA_POI_CONFIG[p.type]?.icon||'📍'} ${escapeHtml(p.name)}</strong><span>${p.distance} m</span></div>`).join(''):'<div class="scanner-warning">Peu de points d’intérêt détectés à moins de 1,5 km. EVA considère l’emplacement comme plus difficile à valoriser.</div>'}
          </div>
        </div>
      </div>
    </div>`;
}

function drawEvaScannerMap(a,analysis,pois){
  const lat=aptLat(a),lng=aptLng(a);
  const el=document.getElementById('scanner-map'); if(!el||!window.L)return;
  if(evaScannerMap){evaScannerMap.remove();evaScannerMap=null;}
  evaScannerMap=L.map('scanner-map',{scrollWheelZoom:false}).setView([lat,lng],14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(evaScannerMap);
  L.circle([lat,lng],{radius:300,color:'#EC4899',weight:1,fill:false,opacity:.55}).addTo(evaScannerMap);
  L.circle([lat,lng],{radius:800,color:'#8B5CF6',weight:1,fill:false,opacity:.38}).addTo(evaScannerMap);
  L.circle([lat,lng],{radius:1500,color:'#7C3AED',weight:1,fill:false,opacity:.22}).addTo(evaScannerMap);
  L.marker([lat,lng],{icon:L.divIcon({className:'',html:`<div class="scanner-map-marker">🏠</div>`,iconSize:[30,30],iconAnchor:[15,15]})}).addTo(evaScannerMap).bindPopup(`<strong>${escapeHtml(a.name||'Appartement')}</strong><br>Prix actuel : ${analysis.current||0}€<br>Reco EVA : ${analysis.recommended}€`);
  pois.filter(p=>['transport','food','shops','tourism','parking'].includes(p.type)).slice(0,40).forEach(p=>{
    const icon=EVA_POI_CONFIG[p.type]?.icon||'📍';
    L.marker([p.lat,p.lng],{icon:L.divIcon({className:'',html:`<div class="scanner-map-marker poi">${icon}</div>`,iconSize:[26,26],iconAnchor:[13,13]})}).addTo(evaScannerMap).bindPopup(`<strong>${escapeHtml(p.name)}</strong><br>${EVA_POI_CONFIG[p.type]?.label||'Point'} · ${p.distance} m`);
  });
  setTimeout(()=>evaScannerMap.invalidateSize(),180);
}

function escapeHtml(str){return String(str||'').replace(/[&<>"]/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));}
/* ===== end EVA SCANNER V1 ===== */



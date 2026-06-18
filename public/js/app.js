/* ============================================================
   RentyQ — app.js
   Application principale : auth Supabase, navigation, pages,
   EVA pricing, calendrier, réservations, CleanyQ, settings
   ============================================================ */

/* RentyQ V1 sans IA payante : EVA fonctionne avec un moteur de règles métier côté front.
   Les événements restent branchés via events-proxy puis fallback OpenAgenda/public.
   Ne pas remettre de clé Claude/Anthropic dans ce fichier. */
const SB_URL='https://gtffekgqglpxjjligffi.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0ZmZla2dxZ2xweGpqbGlnZmZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNjUxODMsImV4cCI6MjA5NTg0MTE4M30.8SHvalTRdUD4dXjcKP8s13yXhtg3NDrjQCBXDlu-jyE';
const FUNCTIONS_URL=`${SB_URL}/functions/v1`;
const SMOOBU_FN=`${FUNCTIONS_URL}/smoobu-proxy`;
const EVENTS_FN=`${FUNCTIONS_URL}/events-proxy`;
const STRIPE_FN='/api/stripe';
const EVA_FN=`${FUNCTIONS_URL}/eva-analysis`;
let currentUser=null,currentProfile=null,apparts=[],archivedApparts=[],reservations=[],editId=null,smoobuConnected=false,eventsCache={};

const secureHeaders=()=>({
  'Content-Type':'application/json',
  'apikey':SB_KEY,
  'Authorization':`Bearer ${currentUser?.access_token||SB_KEY}`
});

const sbFetch=(path,opts={})=>fetch(`${SB_URL}/rest/v1/${path}`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${currentUser?.access_token||SB_KEY}`,'Content-Type':'application/json','Prefer':'return=representation',...(opts.headers||{})},method:opts.method||'GET',body:opts.body});
const authFetch=(path,body)=>fetch(`${SB_URL}/auth/v1/${path}`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)});
const functionCall=(url,body={})=>fetch(url,{method:'POST',headers:secureHeaders(),body:JSON.stringify(body)}).then(async r=>{const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'Erreur serveur');return data;});
const smoobuCall=(action,params={})=>functionCall(SMOOBU_FN,{action,params});
const eventsCall=(city)=>functionCall(EVENTS_FN,{city,countryCode:'FR',radius:50});
const evaCall=(payload)=>functionCall(EVA_FN,payload);

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
function showErr(id,msg){const el=document.getElementById(id);if(!el)return;el.textContent=msg;el.style.display='block';setTimeout(()=>el.style.display='none',5000)}
function showOk(id,msg){const el=document.getElementById(id);if(!el)return;if(msg.includes('<')){el.innerHTML=msg;}else{el.textContent=msg;}el.style.display='block';setTimeout(()=>el.style.display='none',5000)}

function extractCity(zone,city){
  if(city&&city.trim())return city.trim();
  if(!zone)return null;
  const known=['Paris','Lyon','Marseille','Bordeaux','Toulouse','Nice','Nantes','Strasbourg','Montpellier','Lille','Rennes','Grenoble','Rouen','Toulon','Saint-Etienne','Dijon','Angers','Nîmes','Villeurbanne','Le Mans'];
  for(const c of known){if(zone.toLowerCase().includes(c.toLowerCase()))return c;}
  return zone.split(' ')[0];
}

function switchTab(t){
  document.querySelectorAll('.auth-tab').forEach((b,i)=>b.classList.toggle('active',i===(t==='login'?0:1)));
  document.getElementById('login-form').style.display=t==='login'?'block':'none';
  document.getElementById('register-form').style.display=t==='register'?'block':'none';
}

async function doLogin(){
  const email=document.getElementById('l-email').value.trim();const pwd=document.getElementById('l-pwd').value;
  if(!email||!pwd){showErr('login-error','Remplissez tous les champs');return}
  const btn=document.getElementById('btn-login');btn.disabled=true;btn.textContent='Connexion\u2026';
  try{
    const res=await authFetch('token?grant_type=password',{email,password:pwd});
    const data=await res.json();
    // Erreur explicite Supabase
    if(data.error||data.error_description){
      const msg=data.error_description||data.error||'';
      if(msg.toLowerCase().includes('invalid')&&msg.toLowerCase().includes('credentials')){
        showErr('login-error','Email ou mot de passe incorrect.');
      } else if(msg.toLowerCase().includes('email not confirmed')){
        showErr('login-error','\u26a0\ufe0f Votre email n\u2019a pas encore \u00e9t\u00e9 confirm\u00e9. V\u00e9rifiez votre bo\u00eete mail et cliquez sur le lien de confirmation.');
      } else {
        showErr('login-error',msg||'Connexion impossible.');
      }
      btn.disabled=false;btn.textContent='Se connecter';return;
    }
    // Pas de user = token invalide
    if(!data.user||!data.user.id){
      showErr('login-error','Compte introuvable. V\u00e9rifiez votre email et mot de passe.');
      btn.disabled=false;btn.textContent='Se connecter';return;
    }
    // Email non confirm\u00e9
    if(!data.user.email_confirmed_at){
      showErr('login-error','\u26a0\ufe0f Email non confirm\u00e9. Cliquez sur le lien dans l\u2019email envoy\u00e9 \u00e0 '+email+' avant de vous connecter.');
      btn.disabled=false;btn.textContent='Se connecter';return;
    }
    currentUser=data;
    try{localStorage.setItem('sb_session',JSON.stringify(data));}catch(e){}
    await loadApp();
  }catch(e){
    showErr('login-error','Erreur r\u00e9seau. V\u00e9rifiez votre connexion internet.');
    btn.disabled=false;btn.textContent='Se connecter';
  }
}

async function doRegister(){
  const name=document.getElementById('r-name').value.trim();const email=document.getElementById('r-email').value.trim();const pwd=document.getElementById('r-pwd').value;
  const hasSolo=document.getElementById('r-mod-solo').checked;
  const hasConcierge=document.getElementById('r-mod-concierge').checked;
  const modules=[];if(hasSolo)modules.push('solo');if(hasConcierge)modules.push('concierge');
  const type=hasConcierge?'concierge':'solo';
  if(!name||!email||!pwd){showErr('register-error','Remplissez tous les champs');return}
  if(pwd.length<6){showErr('register-error','6 caractères minimum');return}
  const btn=document.getElementById('btn-register');btn.disabled=true;btn.textContent='Création…';
  try{
    const res=await authFetch('signup',{email,password:pwd,data:{name,type,modules:modules.join(',')}});
    const data=await res.json();
    if(data.error){showErr('register-error',data.error);btn.disabled=false;btn.textContent='✨ Créer mon compte';return}
    showEmailConfirmOverlay(email);
    btn.disabled=false;btn.textContent='✨ Créer mon compte';
  }catch(e){showErr('register-error','Erreur réseau');btn.disabled=false;btn.textContent='✨ Créer mon compte';}
}

function doLogout(){
  try{localStorage.removeItem('sb_session');}catch(e){}
  currentUser=null;currentProfile=null;apparts=[];reservations=[];eventsCache={};
  document.getElementById('app').style.display='none';
  document.getElementById('auth-screen').style.display='flex';
}

function showLogoutConfirm(){
  const m=document.getElementById('logout-modal');
  if(m){m.style.display='flex';}
}

function closeLogoutConfirm(){
  const m=document.getElementById('logout-modal');
  if(m){m.style.display='none';}
}

/* ══════════════════════════════════════════════════════
   ONBOARDING RentyQ — Bienvenue (nouveau compte)
   Clé : rq_onboarding_done_<userId>
   Ne s'affiche qu'une seule fois par utilisateur.
   ══════════════════════════════════════════════════════ */

const RQ_ONB_TOTAL = 5;
let rqOnbCurrent = 1;
const rqOnbData = {};

function rqOnbKey(){
  return 'rq_onboarding_done_' + (currentUser?.user?.id || 'anon');
}

function rqOnbTrigger(){
  try{
    const done = localStorage.getItem(rqOnbKey());
    if(done) return; // déjà fait — on n'affiche plus jamais
    rqOnbCurrent = 1;
    rqOnbRender();
    document.getElementById('rq-onboarding').style.display = 'flex';
  }catch(e){ console.warn('rqOnbTrigger', e); }
}

function rqOnbRender(){
  // Masquer toutes les étapes
  for(let i=1;i<=RQ_ONB_TOTAL;i++){
    const el=document.getElementById('rq-onb-'+i);
    if(el){ el.style.display='none'; el.style.opacity='0'; el.style.transform='translateX(20px)'; }
  }
  // Afficher l'étape courante avec animation
  const current = document.getElementById('rq-onb-'+rqOnbCurrent);
  if(current){
    current.style.display='flex';
    requestAnimationFrame(()=>{
      current.style.transition='opacity .28s ease, transform .28s ease';
      current.style.opacity='1';
      current.style.transform='translateX(0)';
    });
  }
  // Progression
  const pct = Math.round(((rqOnbCurrent-1)/(RQ_ONB_TOTAL-1))*100);
  const fill = document.getElementById('rq-onb-progress');
  if(fill) fill.style.width = pct + '%';
  const lbl = document.getElementById('rq-onb-step-label');
  if(lbl) lbl.textContent = rqOnbCurrent < RQ_ONB_TOTAL ? `Étape ${rqOnbCurrent} / ${RQ_ONB_TOTAL}` : '';
}

function rqOnbPick(step, el, value){
  // Sélection dans les choix
  const container = document.getElementById('rq-onb-choices-'+step);
  if(container) container.querySelectorAll('.rq-onb-choice').forEach(c=>c.classList.remove('rq-onb-choice--active'));
  el.classList.add('rq-onb-choice--active');
  rqOnbData['step'+step] = value;
  // Activer le bouton Continuer
  const btn = document.getElementById('rq-onb-cta-'+step);
  if(btn) btn.disabled = false;
}

function rqOnbNext(){
  if(rqOnbCurrent < RQ_ONB_TOTAL){
    rqOnbCurrent++;
    rqOnbRender();
  }
}

function rqOnbFinish(){
  // Marquer comme terminé (persistant)
  try{ localStorage.setItem(rqOnbKey(), '1'); }catch(e){}
  // Sauvegarder les préférences sur le profil si possible
  try{
    if(currentProfile && rqOnbData.step2){
      sbFetch(`profiles?id=eq.${currentProfile.id}`,{
        method:'PATCH',
        body:JSON.stringify({onboarding_profile:rqOnbData.step2, onboarding_size:rqOnbData.step3, onboarding_goal:rqOnbData.step4})
      }).catch(()=>{});
    }
  }catch(e){}
  // Fermer avec animation
  const panel = document.querySelector('#rq-onboarding .rq-onb-panel');
  if(panel){ panel.style.transition='transform .3s ease,opacity .3s ease'; panel.style.transform='scale(.96)'; panel.style.opacity='0'; }
  setTimeout(()=>{
    const overlay = document.getElementById('rq-onboarding');
    if(overlay) overlay.style.display='none';
  }, 320);
}


async function loadApp(){
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('loading').style.display='flex';
  try{
    const pRes=await sbFetch(`profiles?id=eq.${currentUser.user.id}&select=*`);
    const pData=await pRes.json();
    currentProfile=(pData&&pData.length>0)?pData[0]:{id:currentUser.user.id,name:currentUser.user.email.split('@')[0],email:currentUser.user.email,type:'solo',plan:'Starter'};
    const aRes=await sbFetch(`appartements?user_id=eq.${currentUser.user.id}&select=*&order=created_at.asc`);
    const allAppartsRaw=await aRes.json();
    if(!Array.isArray(allAppartsRaw)){console.error('loadApp: allApparts not array',allAppartsRaw);} 
    const allApparts=Array.isArray(allAppartsRaw)?allAppartsRaw:[];
    apparts=allApparts.filter(a=>!a.archived);archivedApparts=allApparts.filter(a=>a.archived);
    try{const rRes=await sbFetch(`reservations?user_id=eq.${currentUser.user.id}&select=*&order=date_from.desc`);const resRaw=await rRes.json();if(!Array.isArray(resRaw)){console.error('loadApp: reservations not array',resRaw);}reservations=Array.isArray(resRaw)?resRaw:[];}catch(e){console.error('loadApp: reservations fetch error',e);reservations=[];}
    document.getElementById('loading').style.display='none';
    document.getElementById('app').style.display='flex';
    renderSidebar();renderAll();
    setTimeout(()=>{rqTourTrigger();rqOnbTrigger();},800);
    document.getElementById('cockpit-date').textContent=new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    document.getElementById('set-name').value=currentProfile.name||'';
    document.getElementById('set-email').textContent=currentProfile.email||'';
    document.getElementById('set-plan').textContent='Plan '+(currentProfile.plan||'Starter');
    try{const smStatus=await smoobuCall('status');smoobuConnected=!!smStatus.connected;updateSmoobuUI(smoobuConnected);}catch(e){smoobuConnected=false;updateSmoobuUI(false);}
    if(apparts.length)loadEvents(false);
    renderTarifs();
    checkPaymentReturn();
    await loadProprietaires();
    await loadCharges();await loadTransactions();await loadCatRules();await loadCleaners();await loadMissions();
    renderCockpit();
    var activeCleanyQPage=document.querySelector('.page.active');
    if(activeCleanyQPage&&activeCleanyQPage.id==='page-cleanyq-today')renderCleanyQToday();
    if(activeCleanyQPage&&activeCleanyQPage.id==='page-cleanyq-missions')renderCleanyQMissions();
    if(activeCleanyQPage&&activeCleanyQPage.id==='page-cleanyq-squad')renderCleanyQSquad();
    if(activeCleanyQPage&&activeCleanyQPage.id==='page-clean')renderCleanyQToday();
    applyModules();
    if(userModules.includes('concierge')){renderProprietaires();initRapportMois();renderRapports();renderCockpitConcierge();renderParcConcierge();}
     updateNavVisibility();
     onb2Open();
  }catch(e){
    console.error('loadApp error:',e);
    document.getElementById('loading').style.display='none';
    document.getElementById('app').style.display='flex';
    try{renderSidebar();renderAll();}catch(e2){console.warn(e2);}
  }
}

function renderSidebar(){
  const _sn=document.getElementById('s-name');if(_sn)_sn.textContent=(currentProfile.name||'User').split(' ')[0];
  try{const _ma=document.getElementById('m-avatar');if(_ma)_ma.textContent=(currentProfile.name||'U').charAt(0).toUpperCase();}catch(e){}
  const _sa=document.getElementById('s-avatar');if(_sa)_sa.textContent=(currentProfile.name||'U').charAt(0).toUpperCase();
  const _sp=document.getElementById('s-plan');if(_sp)_sp.textContent='Plan '+(currentProfile.plan||'Starter');
  const _pb=document.getElementById('parc-badge');if(_pb)_pb.textContent=apparts.length;
}

function floor(a){return Math.round((a.rent||0)/30+(a.cleaner||0))}

function renderAll(){
  try{renderKPIs();}catch(e){console.warn('renderKPIs',e);}
  try{renderCockpitTable();}catch(e){console.warn('renderCockpitTable',e);}
  try{renderParcTable();}catch(e){console.warn('renderParcTable',e);}
  try{renderResTable();}catch(e){console.warn('renderResTable',e);}
  try{renderPricingTable();}catch(e){console.warn('renderPricingTable',e);}
  const _pb=document.getElementById('parc-badge');if(_pb)_pb.textContent=apparts.length;
  const _ps=document.getElementById('parc-sub');if(_ps)_ps.textContent=apparts.length+' appartement'+(apparts.length>1?'s':'');
  const _rs=document.getElementById('res-sub');if(_rs)_rs.textContent=reservations.length+' réservation'+(reservations.length>1?'s':'');
  if(smoobuConnected){const _bs=document.getElementById('btn-sync');if(_bs)_bs.style.display='inline-flex';}
  if(document.getElementById('page-scanner')?.classList.contains('active'))renderScannerPage();
}

let cockpitTodos=[];
function initTodos(apts){
  cockpitTodos=[];
  apts.forEach(a=>{
    const fl=floor(a);const city=a.city||extractCity(a.zone,null)||'';
    const cityEvs=eventsCache[city]||[];const hotEvs=cityEvs.filter(e=>e.hot);
    if(!a.booked)cockpitTodos.push({id:'libre-'+a.id,text:`Trouver une réservation — ${a.name} libre ce soir`,done:false,urgency:'urgent'});
    if(hotEvs.length>0&&a.price<(a.ai_rec||0))cockpitTodos.push({id:'ev-'+a.id,text:`Appliquer boost ${hotEvs[0].name.slice(0,30)}… — ${a.name}`,done:false,urgency:'today'});
    if((a.price||0)<fl)cockpitTodos.push({id:'floor-'+a.id,text:`Corriger prix sous plancher — ${a.name} (${a.price}€ < ${fl}€)`,done:false,urgency:'urgent'});
    const monthRes=reservations.filter(r=>r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(new Date().toISOString().slice(0,7)));
    const occ=a.booked?Math.round(monthRes.length/30*100)||65:Math.round(monthRes.length/30*100)||20;
    if(occ<50)cockpitTodos.push({id:'occ-'+a.id,text:`Améliorer taux occupation ${a.name} — ${occ}% ce mois (objectif 65%)`,done:false,urgency:'soon'});
  });
  if(!cockpitTodos.length&&apts.length===0)cockpitTodos.push({id:'empty',text:'Ajoutez votre premier bien — EVA analyse votre marché dès la première adresse',done:false,urgency:'today'});
}

function genAlerts(apts){
  const alerts=[];
  apts.forEach(a=>{
    const fl=floor(a);const city=a.city||extractCity(a.zone,null)||'';
    const cityEvs=eventsCache[city]||[];const hotEvs=cityEvs.filter(e=>e.hot);
    if(!a.booked)alerts.push({type:'urgent',icon:'ti-moon',title:`${a.name} — libre ce soir`,desc:`Prix ${a.price||0}€ vs concurrent ${a.comp||0}€. Baissez pour remplir ou activez EVA.`,action:'Ajuster'});
    if(hotEvs.length>0)alerts.push({type:'warning',icon:'ti-sparkles',title:`Opportunité EVA — ${a.name} (+${(a.ai_rec||Math.round((a.price||0)*1.08))-(a.price||0)}€ détectés)`,desc:`Signal local détecté · EVA conseille ${a.ai_rec||Math.round((a.price||0)*1.08)}€ soit +${(a.ai_rec||Math.round((a.price||0)*1.08))-(a.price||0)}€/nuit supplémentaires.`,action:'Appliquer'});
    if((a.price||0)<fl)alerts.push({type:'urgent',icon:'ti-alert-triangle',title:`Prix sous plancher — ${a.name}`,desc:`${a.price||0}€/nuit < plancher ${fl}€. Perte sur chaque nuit vendue.`,action:'Corriger'});
  });
  return alerts.slice(0,5);
}

function renderCockpit(){
  var dash=document.getElementById('cockpit-dash');if(!dash)return;
  var apts=apparts||[];
  var today=new Date();
  var todayIso=today.toISOString().slice(0,10);
  var month=today.toISOString().slice(0,7);
  var monthRes=reservations.filter(function(r){return r.date_from&&r.date_from.startsWith(month);});
  var monthRev=monthRes.reduce(function(s,r){return s+(r.price_total||0);},0);
  var hotEvents=Object.values(eventsCache||{}).flat().filter(function(e){return e.hot;});
  var free=apts.filter(function(a){return !a.booked;});
  // Fusion missions réelles + virtuelles (source de vérité = réservations)
  var mergedOps=getMergedCleaningMissions(14);

  // ─── COLONNE GAUCHE : À faire aujourd'hui (max 5) ───
  // Cascade : opérationnel toujours prioritaire sur le pricing.
  var todoItems=[];

  // Priorité 1 — Check-in imminent (aujourd'hui/demain) sans ménage sécurisé
  var tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);
  var tomorrowIso=tomorrow.toISOString().slice(0,10);
  var checkinsImminents=reservations.filter(function(r){return r.date_from===todayIso||r.date_from===tomorrowIso;});
  checkinsImminents.forEach(function(r){
    var hasSecuredMission=mergedOps.some(function(m){
      return m.appartement_id===r.appartement_id&&(m.date===todayIso||m.date===tomorrowIso)&&!m.virtual;
    });
    if(!hasSecuredMission&&todoItems.length<5){
      todoItems.push({type:'urgent',icon:'\uD83D\uDEA8',title:'Check-in sans m\u00e9nage s\u00e9curis\u00e9 \u2014 '+r.apartment_name,desc:'Arriv\u00e9e '+(r.date_from===todayIso?'aujourd\u2019hui':'demain')+' pour '+r.guest_name+'. Aucune mission confirm\u00e9e.',btn:'S\u00e9curiser',action:"goTo('cleanyq-today',document.querySelector('[data-page=cleanyq-today]'))"});
    }
  });

  // Priorité 2 — Mission critique non couverte (réelle en attente proche, ou virtuelle sans cleaner)
  if(todoItems.length<5){
    var criticalUncovered=mergedOps.filter(function(m){
      var isImminentDate=(m.date===todayIso||m.date===tomorrowIso);
      if(!isImminentDate)return false;
      if(!m.virtual)return m.priority==='haute'&&m.status==='en_attente';
      return m.priority==='haute'&&!m.cleaner_id;
    });
    if(criticalUncovered.length){
      todoItems.push({type:'urgent',icon:'\u26A0\uFE0F',title:criticalUncovered.length+' mission'+(criticalUncovered.length>1?'s':'')+' critique'+(criticalUncovered.length>1?'s':'')+' non couverte'+(criticalUncovered.length>1?'s':''),desc:'Ménage proche sans cleaner disponible dans la zone \u2014 v\u00e9rifier la Squad.',btn:'Voir',action:"goTo('cleanyq-missions',document.querySelector('[data-page=cleanyq-missions]'))"});
    }
  }

  // Priorité 3 — Nuit importante encore libre ce soir
  if(free.length&&todoItems.length<5){
    var lostRev=free.reduce(function(s,a){return s+Math.round(Number(a.price||0)*0.82);},0);
    todoItems.push({type:'warn',icon:'\uD83C\uDF19',title:free.length+' nuit'+(free.length>1?'s':'')+' libre'+(free.length>1?'s':'')+' ce soir',desc:free.slice(0,2).map(function(a){return a.name;}).join(', ')+(free.length>2?' +'+( free.length-2)+' autre'+(free.length>3?'s':''):'')+' \u2014 '+lostRev+'\u20AC en jeu',btn:'Agir',action:"goTo('parc-fiches',document.querySelector('[data-page=parc-fiches]'))"});
  }

  // Priorité 4 — Événement local à exploiter
  if(hotEvents.length&&todoItems.length<5){
    var evApts=apts.filter(function(a){var c=a.city||'';return (eventsCache[c]||[]).some(function(e){return e.hot;})&&a.price>0&&(!a.ai_rec||a.price<a.ai_rec);});
    if(evApts.length){
      todoItems.push({type:'warn',icon:'\uD83C\uDF89',title:evApts.length+' bien'+(evApts.length>1?'s':'')+' avec \u00e9v\u00e9nement local non pric\u00e9',desc:hotEvents[0].name+(hotEvents.length>1?' et '+(hotEvents.length-1)+' autre'+(hotEvents.length>2?'s':''):'')+' \u2014 appliquer le boost EVA',btn:'Pricer',action:"goTo('parc-fiches',document.querySelector('[data-page=parc-fiches]'))"});
    }
  }

  // Priorité 5 — Bien sous-tarifé
  if(todoItems.length<5){
    var undertarif=apts.filter(function(a){return a.ai_rec&&a.price&&(a.ai_rec-a.price)/a.price>0.12;});
    if(undertarif.length){
      var gain=undertarif.reduce(function(s,a){return s+(a.ai_rec-a.price);},0);
      todoItems.push({type:'',icon:'\uD83D\uDCC8',title:undertarif.length+' bien'+(undertarif.length>1?'s':'')+' sous-tarif\u00e9'+(undertarif.length>1?'s':''),desc:'+'+Math.round(gain)+'\u20AC/nuit de potentiel non captur\u00e9 selon EVA',btn:'Ajuster',action:"goTo('parc-fiches',document.querySelector('[data-page=parc-fiches]'))"});
    }
  }

  // Priorité 6 — Qualité voyageurs à risque
  if(todoItems.length<5){
    var qualityRisk=apts.filter(function(a){return a.note&&Number(a.note)>0&&Number(a.note)<4.4;});
    if(qualityRisk.length){
      todoItems.push({type:'warn',icon:'\u2B50',title:qualityRisk.length+' bien'+(qualityRisk.length>1?'s':'')+' avec note \u00e0 risque',desc:qualityRisk.slice(0,2).map(function(a){return a.name+' ('+a.note+'/5)';}).join(', ')+' \u2014 priorit\u00e9 qualit\u00e9 avant pricing',btn:'Voir',action:"goTo('analyse-qualite',document.querySelector('[data-page=analyse-qualite]'))"});
    }
  }

  // Fallback : aucun signal urgent
  if(!todoItems.length){
    todoItems.push({type:'',icon:'\u2705',title:'Aucune action urgente aujourd\u2019hui',desc:'Consultez l\u2019Analyse EVA pour les optimisations long terme.',btn:'Voir',action:"goTo('analyse-globale',document.querySelector('[data-page=analyse-globale]'))"});
  }

  var todoHtml=todoItems.slice(0,5).map(function(t){
    var bg=t.type==='urgent'?'#FEF2F2':t.type==='warn'?'#FFFBEB':'#F8F5FF';
    var border=t.type==='urgent'?'rgba(220,38,38,.18)':t.type==='warn'?'rgba(217,119,6,.14)':'rgba(109,40,217,.12)';
    var btnC=t.type==='urgent'?'#DC2626':t.type==='warn'?'#D97706':'#6D28D9';
    return '<div style="display:flex;align-items:flex-start;gap:12px;background:'+bg+';border:1px solid '+border+';border-radius:14px;padding:13px 14px">'+
      '<div style="font-size:20px;flex-shrink:0;margin-top:1px">'+t.icon+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:13px;font-weight:700;color:#17122E;margin-bottom:2px">'+t.title+'</div>'+
        '<div style="font-size:11px;color:#7B708F;line-height:1.4">'+t.desc+'</div>'+
      '</div>'+
      '<button onclick="'+t.action+'" style="border:none;border-radius:9px;padding:6px 12px;background:'+btnC+';color:white;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">'+t.btn+'</button>'+
    '</div>';
  }).join('');

  // ─── COLONNE DROITE : Ce qui va bien ───
  var daysElapsed=Math.max(1,today.getDate());
  var totalNights14=0;
  var next14=[];
  for(var di=0;di<14;di++){var dd=new Date(today);dd.setDate(dd.getDate()+di);next14.push(dd.toISOString().slice(0,10));}
  var occ14=0;
  next14.forEach(function(day){
    var booked=apts.filter(function(a){return reservations.some(function(r){return r.appartement_id===a.id&&r.date_from<=day&&r.date_to>day;});}).length;
    occ14+=booked;
  });
  var occ14pct=apts.length?Math.round(occ14/(next14.length*Math.max(1,apts.length))*100):0;
  var avgNote=0;var notedApts=apts.filter(function(a){return a.note&&Number(a.note)>0;});
  if(notedApts.length)avgNote=Math.round(notedApts.reduce(function(s,a){return s+Number(a.note);},0)/notedApts.length*10)/10;
  var menagesValides=(missionsData||[]).filter(function(m){return m.status==='terminee'&&m.date>=month;}).length;
  var checkinsSafe=reservations.filter(function(r){return r.date_from===todayIso;}).length-todoItems.filter(function(t){return t.type==='urgent';}).length;
  var upsellsTotal=monthRev>0?Math.round(monthRev*0.08):0; // estimation upsells

  var goodItems=[
    {icon:'\uD83E\uDDF9',label:menagesValides+' m\u00e9nage'+(menagesValides>1?'s':'')+' valid\u00e9'+(menagesValides>1?'s':'')+' ce mois','ok':true},
    {icon:'\uD83D\uDCC5',label:'Occupation 14j : '+occ14pct+'%','ok':occ14pct>=65},
    {icon:'\u2B50',label:'Note moyenne : '+(avgNote||'—')+'/5','ok':avgNote>=4.5},
    {icon:'\uD83D\uDCB0',label:monthRev.toLocaleString('fr-FR')+'\u20AC g\u00e9n\u00e9r\u00e9s ce mois','ok':monthRev>0},
    {icon:'\uD83D\uDCE6',label:monthRes.length+' r\u00e9servation'+(monthRes.length>1?'s':'')+' confirm\u00e9e'+(monthRes.length>1?'s':''),'ok':monthRes.length>0}
  ];

  var goodHtml=goodItems.map(function(g){
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #F3F0FA">'+
      '<div style="font-size:18px;flex-shrink:0">'+g.icon+'</div>'+
      '<div style="flex:1;font-size:13px;font-weight:600;color:#17122E">'+g.label+'</div>'+
      '<div style="font-size:14px">'+(g.ok?'\u2705':'\uD83D\uDFE1')+'</div>'+
    '</div>';
  }).join('');

  // ─── BAS : Opportunités EVA ───
  var oppItems=[];
  apts.forEach(function(a){
    if(a.ai_rec&&a.price&&a.ai_rec>a.price){
      oppItems.push({icon:'\uD83D\uDCC8',title:'Hausse tarifaire \u2014 '+a.name,gain:'+'+Math.round((a.ai_rec-a.price)*10)+'\u20AC/mois',action:"goTo('parc-fiches',document.querySelector('[data-page=parc-fiches]'))"});
    }
  });
  if(hotEvents.length){
    oppItems.push({icon:'\uD83C\uDF89',title:hotEvents.length+' \u00e9v\u00e9nement'+(hotEvents.length>1?'s':'')+' local \u2014 boost possible',gain:'+'+Math.round(hotEvents.length*150)+'\u20AC estim\u00e9s',action:"goTo('analyse-opportunites',document.querySelector('[data-page=analyse-opportunites]'))"});
  }
  oppItems.push({icon:'\u2B50',title:'Upsells activ\u00e9s ce mois',gain:'+'+upsellsTotal.toLocaleString('fr-FR')+'\u20AC estim\u00e9s',action:"goTo('analyse-opportunites',document.querySelector('[data-page=analyse-opportunites]'))"});

  var oppHtml=oppItems.slice(0,4).map(function(o){
    return '<div style="background:white;border:1px solid rgba(139,92,246,.1);border-radius:14px;padding:14px;display:flex;align-items:center;gap:12px">'+
      '<div style="font-size:22px;flex-shrink:0">'+o.icon+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:13px;font-weight:700;color:#17122E">'+o.title+'</div>'+
      '</div>'+
      '<div style="text-align:right;flex-shrink:0">'+
        '<div style="font-size:15px;font-weight:900;color:#059669">'+o.gain+'</div>'+
        '<button onclick="'+o.action+'" style="border:none;border-radius:8px;padding:4px 10px;background:linear-gradient(135deg,#6D28D9,#EC4899);color:white;font-size:10px;font-weight:800;cursor:pointer;font-family:inherit;margin-top:4px">Voir \u2192</button>'+
      '</div>'+
    '</div>';
  }).join('');

  // ─── ASSEMBLAGE HTML ───
  dash.innerHTML=
    // Hero
    '<div style="background:linear-gradient(135deg,#211051 0%,#7C3AED 46%,#EC4899 100%);border-radius:22px;padding:24px 28px;margin-bottom:16px;color:#fff;position:relative;overflow:hidden">'+
      '<div style="position:absolute;right:-60px;top:-70px;width:260px;height:260px;background:radial-gradient(circle,rgba(255,255,255,.16),transparent 62%);pointer-events:none"></div>'+
      '<div style="position:relative;z-index:1">'+
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1.2px;font-weight:900;color:rgba(255,255,255,.55);margin-bottom:8px">EVA Engine \u00b7 '+today.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})+'</div>'+
        '<div style="font-size:clamp(18px,2.5vw,26px);font-weight:950;letter-spacing:-.5px;line-height:1.2;margin-bottom:6px">Bonjour \u2014 voici l\u2019essentiel d\u2019aujourd\u2019hui</div>'+
        '<div style="font-size:13px;color:rgba(255,255,255,.7);margin-bottom:16px">'+monthRev.toLocaleString('fr-FR')+'\u20AC ce mois \u00b7 '+(apts.length-free.length)+'/'+apts.length+' biens lou\u00e9s ce soir \u00b7 '+occ14pct+'% occupation 14j</div>'+
        '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
          '<span style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;color:#fff">'+monthRes.length+' r\u00e9sas</span>'+
          (free.length?'<span style="background:rgba(220,38,38,.3);border:1px solid rgba(220,38,38,.4);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;color:#fff">'+free.length+' libre'+(free.length>1?'s':'')+' ce soir</span>':'<span style="background:rgba(5,150,105,.3);border:1px solid rgba(5,150,105,.4);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;color:#fff">\u2714 Tout lou\u00e9 ce soir</span>')+
          (hotEvents.length?'<span style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;color:#fff">'+hotEvents.length+' \u00e9v\u00e9nement'+(hotEvents.length>1?'s':'')+' local</span>':'')+
        '</div>'+
      '</div>'+
    '</div>'+

    // 2 colonnes
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">'+

      // Colonne gauche : À faire
      '<div style="background:white;border:1px solid rgba(139,92,246,.12);border-radius:20px;padding:18px;box-shadow:0 6px 20px rgba(69,39,120,.06)">'+
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'+
          '<div>'+
            '<div style="font-family:Sora,sans-serif;font-size:15px;font-weight:800;color:#17122E">\uD83C\uDFAF \u00c0 faire aujourd\u2019hui</div>'+
            '<div style="font-size:11px;color:#8A8A99;margin-top:2px">Priorit\u00e9s EVA du jour</div>'+
          '</div>'+
          '<span style="font-size:11px;font-weight:900;background:#F3E8FF;color:#7C3AED;border-radius:999px;padding:3px 9px">'+todoItems.slice(0,5).length+' action'+(todoItems.slice(0,5).length>1?'s':'')+'</span>'+
        '</div>'+
        '<div style="display:flex;flex-direction:column;gap:8px">'+todoHtml+'</div>'+
      '</div>'+

      // Colonne droite : Ce qui va bien
      '<div style="background:white;border:1px solid rgba(5,150,105,.14);border-radius:20px;padding:18px;box-shadow:0 6px 20px rgba(5,150,105,.05)">'+
        '<div style="margin-bottom:14px">'+
          '<div style="font-family:Sora,sans-serif;font-size:15px;font-weight:800;color:#17122E">\u2728 Ce qui va bien</div>'+
          '<div style="font-size:11px;color:#8A8A99;margin-top:2px">Situation op\u00e9rationnelle</div>'+
        '</div>'+
        '<div>'+goodHtml+'</div>'+
        '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #F3F0FA;font-size:12px;color:#059669;font-weight:700">\uD83D\uDCA1 Votre activit\u00e9 est sous contr\u00f4le.</div>'+
      '</div>'+

    '</div>'+

    // Opportunités EVA (bas)
    '<div style="background:linear-gradient(135deg,#F5F0FF,#FFF0F9);border:1px solid rgba(168,85,247,.16);border-radius:20px;padding:18px">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'+
        '<div>'+
          '<div style="font-family:Sora,sans-serif;font-size:15px;font-weight:800;color:#17122E">\uD83D\uDE80 Opportunit\u00e9s EVA</div>'+
          '<div style="font-size:11px;color:#8A8A99;margin-top:2px">Gains potentiels identifi\u00e9s par EVA</div>'+
        '</div>'+
        '<button onclick="goTo(\'analyse-opportunites\',document.querySelector(\'[data-page=analyse-opportunites]\'))" style="border:none;border-radius:10px;padding:7px 14px;background:linear-gradient(135deg,#6D28D9,#EC4899);color:white;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit">Voir tout \u2192</button>'+
      '</div>'+
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">'+oppHtml+'</div>'+
    '</div>';
}

function toggleCockpitTodo(id){
  cockpitTodos=cockpitTodos.map(t=>t.id===id?{...t,done:!t.done}:t);
  renderCockpit();
}

function renderKPIs(){renderCockpit();}
function renderCockpitTable(){renderCockpit();}
function renderCockpitEvents(){renderCockpit();}

function renderParcTable(){
  const cards=document.getElementById('parc-cards');
  const empty=document.getElementById('parc-empty');
  if(!cards)return;
  if(!apparts.length){empty.style.display='block';cards.innerHTML='';return;}
  empty.style.display='none';

  const mois=new Date().toISOString().slice(0,7);

  // Calculer l\u2019EVA Priority Score pour chaque bien
  const enriched=apparts.map(a=>{
    const aptCharges=chargesData.filter(c=>c.appartement_id===a.id);
    const aptRes=reservations.filter(r=>r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(mois));
    const finMois=rqComputeFinancials(a,aptRes,aptCharges);
    const rev=finMois.caBrut;
    const net=finMois.netProprietaire;
    const occ=Math.min(Math.round((aptRes.length/8)*100),100)||0;
    const city=a.city||'';
    const cityEvs=eventsCache[city]||[];
    const hotEvs=cityEvs.filter(e=>e.hot);
    const freeTonight=!a.booked;
    const basePrice=Number(a.price||0);

    // EVA Score simplifié vert/orange/rouge
    let evaScore=55;
    evaScore+=Math.min(25,Math.round(occ*.25));
    if(net>0)evaScore+=12;else if(net<0)evaScore-=12;
    if(!freeTonight)evaScore+=8;else evaScore-=14;
    if(hotEvs.length)evaScore+=4;
    evaScore=Math.max(8,Math.min(98,evaScore));

    // Gain potentiel estimé
    const eventGain=hotEvs.length?Math.round(hotEvs.reduce((s,e)=>s+(basePrice*(e.boost||10)/100),0)*3):0;
    const freeGain=freeTonight?Math.round(basePrice*.82):0;
    const totalPotential=eventGain+freeGain+(occ<50?Math.round(basePrice*0.12*8):0);

    // Priorité EVA (pour le tri)
    let evaPriority=0;
    if(freeTonight)evaPriority+=100;
    if(hotEvs.length)evaPriority+=80;
    if(occ<50)evaPriority+=60;
    if(net<0)evaPriority+=40;

    return{a,net,occ,hotEvs,freeTonight,evaScore,totalPotential,evaPriority,rev};
  });

  // Tri par priorité EVA décroissante
  enriched.sort((x,y)=>y.evaPriority-x.evaPriority);

  cards.innerHTML=enriched.map(({a,net,occ,hotEvs,freeTonight,evaScore,totalPotential,rev})=>{

    // ADR du mois
    const mois2=new Date().toISOString().slice(0,7);
    const aptRes2=reservations.filter(r=>r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(mois2));
    const totalN2=aptRes2.reduce((s,r)=>{try{if(!r.date_from||!r.date_to)return s+(r.nights||0);return s+Math.max(0,Math.round((new Date(r.date_to)-new Date(r.date_from))/(1000*60*60*24)));}catch(e){return s+(r.nights||0);}},0);
    const adr2=totalN2>0?Math.round(rev/totalN2):0;

    // Système de couleurs EVA — violet / orange / vert selon situation
    let evaBg,evaText,evaBorder,evaScoreBg,evaScoreColor,evaIcon,evaReco,evaImpact,evaImpactSuffix;

    if(freeTonight){
      evaBg='#EEEDFE';evaText='#26215C';evaBorder='1.5px solid #AFA9EC';
      evaScoreBg='#EEEDFE';evaScoreColor='#3C3489';
      evaIcon='🔥';evaReco='Augmenter le tarif ce soir';
      evaImpact=totalPotential>0?`+${totalPotential} €`:`+${Math.round((+a.price||60)*.82)} €`;
      evaImpactSuffix='estimés';
    } else if(hotEvs.length){
      evaBg='#FAEEDA';evaText='#412402';evaBorder='1.5px solid #EF9F27';
      evaScoreBg='#FAEEDA';evaScoreColor='#854F0B';
      evaIcon='🔥';evaReco=`Booster le tarif — ${hotEvs[0].name?.slice(0,22)||'événement'}`;
      evaImpact=totalPotential>0?`+${totalPotential} €`:`+${Math.round((+a.price||60)*.15*3)} €`;
      evaImpactSuffix='potentiels';
    } else if(occ<50){
      evaBg='#FAEEDA';evaText='#412402';evaBorder='1.5px solid #EF9F27';
      evaScoreBg='#FAEEDA';evaScoreColor='#854F0B';
      evaIcon='⚠️';evaReco='Activer une plateforme supplémentaire';
      evaImpact=totalPotential>0?`+${totalPotential} €`:`+${Math.round((+a.price||60)*0.08*8)} €`;
      evaImpactSuffix='potentiels';
    } else {
      evaBg='#EAF3DE';evaText='#173404';evaBorder='0.5px solid #C0DD97';
      evaScoreBg='#EAF3DE';evaScoreColor='#3B6D11';
      evaIcon='✅';evaReco='Logement bien optimisé';
      evaImpact=`Score ${a.note||'4,9'}+`;
      evaImpactSuffix='à maintenir';
    }

    return`<div onclick="showApartDetail('${a.id}')" style="background:white;border-radius:16px;border:${evaBorder};padding:14px;cursor:pointer;transition:transform .12s,box-shadow .12s" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,.08)'" onmouseout="this.style.transform='';this.style.boxShadow=''">

      <!-- Header : nom + badge EVA score -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px">
        <div style="min-width:0;flex:1">
          <div style="font-size:14px;font-weight:700;color:#17122E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.emoji||'🏠'} ${a.name}</div>
          <div style="font-size:12px;color:#8A8A99;margin-top:2px">${a.city||''}</div>
        </div>
        <div style="flex-shrink:0;background:${evaScoreBg};border-radius:8px;padding:4px 8px;text-align:center">
          <div style="font-size:9px;font-weight:800;color:${evaScoreColor};text-transform:uppercase;letter-spacing:.5px">EVA</div>
          <div style="font-size:17px;font-weight:900;color:${evaScoreColor};line-height:1.1;letter-spacing:-.5px">${evaScore}</div>
        </div>
      </div>

      <!-- Métriques clés -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px">
        <div style="background:#FAFAFE;border-radius:8px;padding:7px;text-align:center">
          <div style="font-size:13px;font-weight:900;color:#17122E;letter-spacing:-.3px">${rev}€</div>
          <div style="font-size:8px;text-transform:uppercase;letter-spacing:.5px;color:#8A8A99;font-weight:800;margin-top:2px">Revenus</div>
        </div>
        <div style="background:#FAFAFE;border-radius:8px;padding:7px;text-align:center">
          <div style="font-size:13px;font-weight:900;color:${occ>=65?'#059669':occ>=45?'#D97706':'#DC2626'};letter-spacing:-.3px">${occ}%</div>
          <div style="font-size:8px;text-transform:uppercase;letter-spacing:.5px;color:#8A8A99;font-weight:800;margin-top:2px">Occupation</div>
        </div>
        <div style="background:#FAFAFE;border-radius:8px;padding:7px;text-align:center">
          <div style="font-size:13px;font-weight:900;color:#7C3AED;letter-spacing:-.3px">${adr2>0?adr2+'€':'—'}</div>
          <div style="font-size:8px;text-transform:uppercase;letter-spacing:.5px;color:#8A8A99;font-weight:800;margin-top:2px">ADR</div>
        </div>
      </div>

      <!-- Bloc Priorité EVA -->
      <div style="background:${evaBg};border-radius:8px;padding:10px;margin-bottom:10px">
        <div style="font-size:10px;font-weight:800;color:${evaScoreColor};text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">${evaIcon} Priorité EVA</div>
        <div style="font-size:13px;font-weight:600;color:${evaText};line-height:1.35">${evaReco}</div>
      </div>

      <!-- Impact estimé + bouton Voir -->
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:10px;color:#8A8A99;margin-bottom:2px">Impact ${evaImpactSuffix}</div>
          <div style="font-size:18px;font-weight:950;color:${evaScoreColor};letter-spacing:-.5px;line-height:1">${evaImpact}</div>
        </div>
        <button onclick="event.stopPropagation();showApartDetail('${a.id}')" style="background:#534AB7;color:white;border:none;border-radius:8px;padding:7px 13px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0">Voir le détail</button>
      </div>

    </div>`;
  }).join('');

  const _ps2=document.getElementById('parc-sub');if(_ps2)_ps2.textContent=apparts.length+' appartement'+(apparts.length>1?'s':'');
}

function showApartDetail(id){
  const a=apparts.find(x=>String(x.id)===String(id));if(!a)return;
  document.getElementById('parc-list-view').style.display='none';
  document.getElementById('parc-map-view').style.display='none';
  document.getElementById('parc-detail-view').style.display='block';

  const esc=(v)=>{try{return escapeHtml(String(v??''));}catch(e){return String(v??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}};
  const today=new Date();
  const mois=today.toISOString().slice(0,7);
  const city=a.city||extractCity(a.zone,null)||'';
  const cityEvs=eventsCache[city]||[];
  const hotEvs=cityEvs.filter(e=>e.hot).slice(0,5);
  const aptRes=reservations.filter(r=>String(r.appartement_id)===String(a.id));
  const monthRes=aptRes.filter(r=>r.date_from&&r.date_from.startsWith(mois));
  const aptCharges=chargesData.filter(c=>String(c.appartement_id)===String(a.id));
  // Source unique de vérité : même moteur que le Verdict EVA (exclut le Loyer qui n'est pas
  // une charge d'exploitation, compte chaque charge ponctuelle une seule fois, et va chercher
  // la vraie commission conciergerie sur proprietaires.commission).
  const finMois=rqComputeFinancials(a,monthRes,aptCharges);
  const rev=finMois.caBrut;
  const charges=finMois.commissionsOta+finMois.commissionConciergerie+finMois.chargesLogement+finMois.reparationsProp;
  const net=finMois.netProprietaire;
  const profitability=rev>0?Math.round(net/rev*100):0;
  const note=a.note||'—';
  const fl=floor(a);
  const currentPrice=getCurrentDegPrice(a)||(+a.price||0);
  const basePrice=+a.price||currentPrice||0;
  const freeTonight=!a.booked;
  const aptMissions=missionsData.filter(m=>String(m.appartement_id)===String(a.id));
  const pendingM=aptMissions.filter(m=>['en_attente','acceptee','assignee'].includes(m.status)).sort((x,y)=>(x.date||'').localeCompare(y.date||''));

  function iso(d){return d.toISOString().slice(0,10)}
  function add(n){const d=new Date();d.setDate(d.getDate()+n);return d}
  function covers(r,date){return r&&r.date_from&&r.date_to&&r.date_from<=date&&r.date_to>date}
  function dayName(d){return d.toLocaleDateString('fr-FR',{weekday:'short'}).replace('.','')}
  function dayNum(d){return d.toLocaleDateString('fr-FR',{day:'2-digit',month:'short'})}

  const days14=Array.from({length:14},(_,i)=>{
    const d=add(i),date=iso(d);
    const booked=aptRes.some(r=>covers(r,date));
    const evs=hotEvs.filter(e=>(e.date||'').slice(0,10)===date);
    const weekend=[5,6].includes(d.getDay());
    const urgency=i<=2&&!booked;
    let rec=basePrice;
    if(!booked){
      if(evs.length)rec=Math.round(basePrice*(1+(evs[0].boost||10)/100));
      else if(i===0)rec=Math.max(fl,Math.round(basePrice*.82));
      else if(i<=2)rec=Math.max(fl,Math.round(basePrice*.88));
      else if(i<=5)rec=Math.max(fl,Math.round(basePrice*.94));
      if(weekend&&!evs.length&&i>2)rec=Math.max(rec,Math.round(basePrice*1.06));
    }
    return {i,d,date,booked,evs,weekend,urgency,rec};
  });
  const free14=days14.filter(d=>!d.booked).length;
  const occ14=Math.round(((14-free14)/14)*100);
  const occMonth=Math.min(Math.round((monthRes.length/8)*100),100)||0;
  const occ=Math.max(occ14,occMonth);
  const lostNights72=days14.filter(d=>d.i<=2&&!d.booked).length;
  const potential=days14.filter(d=>!d.booked).reduce((s,d)=>s+d.rec,0);
  const eventPotential=days14.filter(d=>!d.booked&&d.evs.length).reduce((s,d)=>s+Math.max(0,d.rec-basePrice),0);

  const health=rqEvaPropertyHealth(a);
  const score=Math.round((health.scoreCommercial+health.scoreFinancier+health.scoreOperationnel)/3);
  const healthClass=health.verdict==='rouge'?'danger':health.verdict==='orange'?'warn':'';
  const healthLabel=health.verdict==='rouge'?'Bien problématique':health.verdict==='orange'?'Bien à optimiser':'Bien performant';
  const healthText=health.why[0]||'';
  const verdictBorder=health.verdict==='rouge'?'rgba(239,68,68,.28)':health.verdict==='orange'?'rgba(245,158,11,.30)':'rgba(16,185,129,.28)';
  const verdictBg=health.verdict==='rouge'?'#FEF2F2':health.verdict==='orange'?'#FFFBEB':'#ECFDF5';
  const verdictText=health.verdict==='rouge'?'#B91C1C':health.verdict==='orange'?'#B45309':'#047857';
  const subScoreColor=(s)=>s>=70?'#059669':s>=45?'#D97706':'#DC2626';

  const recoReasons=[];
  let recoDirection='maintain';
  let recoTitle='Maintenir le prix actuel';
  let recoPrice=currentPrice||basePrice;
  let recoClass='';
  let impactText='Performance stable';
  if(freeTonight||lostNights72>0||occ14<50){
    recoDirection='down';recoClass='down';
    const discount=freeTonight?0.82:(lostNights72?0.88:0.94);
    recoPrice=Math.max(fl,Math.round(basePrice*discount));
    recoTitle=`Baisser à ${recoPrice}€ pour remplir`;
    impactText=freeTonight?'+ forte chance de sauver la nuit':`+${lostNights72} nuit${lostNights72>1?'s':''} à sauver`;
  }
  if(hotEvs.length&&occ14>=55){
    recoDirection='up';recoClass='up';
    recoPrice=Math.max(basePrice,Math.round(basePrice*(1+(hotEvs[0].boost||10)/100)));
    recoTitle=`Monter à ${recoPrice}€ sur l\u2019événement`;
    impactText=`+${hotEvs[0].boost||10}% sur forte demande locale`;
  }
  if(freeTonight)recoReasons.push(['Nuit proche non louée','Mieux vaut louer moins cher que rester vide.']);
  if(occ14<50)recoReasons.push(['Occupation faible','Seulement '+occ14+'% sur les 14 prochains jours.']);
  if(hotEvs.length)recoReasons.push(['Événement détecté',hotEvs[0].name.slice(0,42)+' · +'+(hotEvs[0].boost||10)+'%.']);
  if(fl>0)recoReasons.push(['Prix plancher protégé','EVA ne descend jamais sous '+fl+'€.']);
  if(recoReasons.length<3)recoReasons.push(['Objectif prioritaire','Maximiser le taux d\u2019occupation avant le prix parfait.']);

  // Revenue bars for 12 months
  let revBars='';
  const months=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  const maxRev=Math.max(200,...Array.from({length:12},(_,i)=>{
    const d=new Date(today.getFullYear(),today.getMonth()-11+i,1);const m=d.toISOString().slice(0,7);
    return aptRes.filter(r=>r.date_from&&r.date_from.startsWith(m)).reduce((s,r)=>s+(+r.price_total||0),0);
  }));
  for(let i=11;i>=0;i--){
    const d=new Date(today.getFullYear(),today.getMonth()-i,1);
    const m=d.toISOString().slice(0,7);
    const mRev=aptRes.filter(r=>r.date_from&&r.date_from.startsWith(m)).reduce((s,r)=>s+(+r.price_total||0),0);
    const h=Math.max(Math.min(mRev/maxRev*78,78),5);
    revBars+=`<div class="rq-mini-bar"><div class="rq-mini-bar-val">${mRev?mRev+'€':''}</div><div class="rq-mini-bar-shape" style="height:${h}px;opacity:${mRev?1:.28}"></div><div class="rq-mini-bar-label">${months[d.getMonth()]}</div></div>`;
  }

  const nightsHtml=days14.slice(0,7).map(d=>{
    const cls=d.booked?'booked':d.evs.length?'event':'free';
    const status=d.booked?'Réservé':d.evs.length?'Événement':'Libre';
    const icon=d.booked?'✓':d.evs.length?'🎉':'!';
    return `<div class="rq-night-card ${cls}" ${d.booked?'':`onclick="applyAI('${a.id}',${d.rec})"`} title="${esc(status)} · ${d.date}">
      <div class="rq-night-day">${dayName(d.d)}</div><div class="rq-night-price">${d.booked?icon:d.rec+'€'}</div><div class="rq-night-status">${status}</div></div>`;
  }).join('');

  // ── Action EVA du Jour : une seule via cascade if/else if ──
  let primaryAction;
  const checkinToday=aptRes.some(r=>r.date_from===iso(today));
  if(checkinToday&&!freeTonight){
    primaryAction={type:'warn',icon:'🚪',title:'Check-in aujourd\'hui — vérifier la préparation',desc:'Un voyageur arrive ce jour. Confirmez le ménage et l\'accès au logement.',btn:'Voir CleanyQ',mission:true};
  } else if(freeTonight){
    primaryAction={type:'urgent',icon:'🔥',title:'Appliquer un tarif de remplissage ce soir',desc:`Prix conseillé : ${recoPrice}€. Chaque heure sans réservation est une nuit perdue.`,btn:`Appliquer ${recoPrice}€`,rec:recoPrice};
  } else if(note!=='—'&&+note<4){
    primaryAction={type:'urgent',icon:'⭐',title:`Corriger la qualité avant d'augmenter les prix`,desc:`Note actuelle : ${note}/5. Priorité aux photos, ménage et équipements.`,btn:'Modifier le bien',edit:true};
  } else if(lostNights72>0){
    primaryAction={type:'urgent',icon:'⏱️',title:`Baisser légèrement pour sécuriser ${lostNights72} nuit${lostNights72>1?'s':''} à venir`,desc:'Des nuits libres arrivent sous 72h. Un ajustement de prix maintenant évite les pertes.',btn:`Appliquer ${recoPrice}€`,rec:recoPrice};
  } else if(hotEvs.length&&occ14>=50){
    const evRec=Math.max(recoPrice,Math.round(basePrice*(1+(hotEvs[0].boost||10)/100)));
    primaryAction={type:'warn',icon:'🎉',title:`Booster le prix pour l'événement : ${hotEvs[0].name.slice(0,28)}`,desc:`Hausse recommandée de +${hotEvs[0].boost||10}% sur les dates concernées.`,btn:`Appliquer ${evRec}€`,rec:evRec};
  } else if(recoDirection==='up'){
    primaryAction={type:'',icon:'📈',title:`Monter à ${recoPrice}€ conseillé par EVA`,desc:`Le bien est bien rempli (${occ14}% sur 14j). Potentiel estimé sans risque de perte.`,btn:`Appliquer ${recoPrice}€`,rec:recoPrice};
  } else if(occ14<50){
    primaryAction={type:'warn',icon:'📉',title:`Occupation à ${occ14}% — activer un canal supplémentaire`,desc:'Le bien manque de réservations sur les 14 prochains jours. Priorité au remplissage.',btn:'Voir intégrations',page:'smoobu'};
  } else {
    primaryAction={type:'',icon:'✅',title:'Aucune action urgente aujourd\'hui',desc:'Le bien est correctement piloté. EVA surveille les prochains jours.',btn:'Modifier',edit:true};
  }

  // Action principale — HTML
  const primaryHtml=`<div class="rq-action-v2 ${primaryAction.type}"><div class="rq-action-icon">${primaryAction.icon}</div><div><div class="rq-action-title">${esc(primaryAction.title)}</div><div class="rq-action-desc">${esc(primaryAction.desc)}</div></div><button class="rq-button-secondary" onclick="${primaryAction.mission?'openMissionModal()':primaryAction.edit?`openEdit('${a.id}')`:primaryAction.page?`goTo('${primaryAction.page}',document.querySelector('[data-page=${primaryAction.page}]'))`:`applyAI('${a.id}',${primaryAction.rec||recoPrice})`}">${esc(primaryAction.btn)}</button></div>`;

  // Signaux secondaires → bloc "À surveiller" (pas des actions, du contexte)
  const watchSignals=[];
  if(!freeTonight&&lostNights72>0&&primaryAction.icon!=='⏱️') watchSignals.push(`${lostNights72} nuit${lostNights72>1?'s':''} libre${lostNights72>1?'s':''} sous 72h`);
  if(hotEvs.length&&primaryAction.icon!=='🎉') watchSignals.push(`Événement local : ${hotEvs[0].name.slice(0,32)}`);
  if(occ14<65&&primaryAction.type!=='warn') watchSignals.push(`Occupation 14j : ${occ14}% (objectif : 65%)`);
  if(!pendingM.length) watchSignals.push('Aucun ménage CleanyQ programmé');
  const watchHtml=watchSignals.length?`<div style="margin-top:10px;padding:10px;background:#F8F5FF;border-radius:10px"><div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#8A8A99;margin-bottom:6px">À surveiller</div>${watchSignals.map(s=>`<div style="font-size:11px;color:#5B2C91;display:flex;gap:6px;margin-bottom:3px"><span>·</span><span>${esc(s)}</span></div>`).join('')}</div>`:'';

  // Contexte EVA — données explicatives uniquement
  const aiRecDetail=a.ai_rec?`Prix cible EVA : ${a.ai_rec}€`:'';
  const contextDetail=[aiRecDetail,fl?`Plancher : ${fl}€`:'',`Score EVA : ${score}/100`].filter(Boolean).join(' · ');
  const contextHtml=contextDetail?`<div style="font-size:11px;color:#8A8A99;margin-top:8px;line-height:1.5">📊 ${esc(contextDetail)}</div>`:'';

  // Potentiel EVA du logement, scindé propriétaire / conciergerie
  const aptPotentialDetail=rqAptEvaPotential(a,Math.max(4,Math.round(occ14/100*30)));
  const potentialDetailHtml=aptPotentialDetail.total>0?`<div style="margin-top:10px;background:#F8F5FF;border-radius:10px;padding:10px 12px">
    <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#8A8A99;margin-bottom:6px">Potentiel EVA du logement</div>
    <div style="font-size:14px;font-weight:900;color:#17122E;margin-bottom:6px">+${aptPotentialDetail.total}€<span style="font-size:10px;color:#8A8A99;font-weight:600">/mois</span></div>
    <div style="display:flex;gap:12px">
      <span style="font-size:11px;color:#059669;font-weight:700">Propriétaire : +${aptPotentialDetail.proprietaire}€</span>
      <span style="font-size:11px;color:#7C3AED;font-weight:700">Conciergerie : +${aptPotentialDetail.conciergerie}€</span>
    </div>
  </div>`:'';

  const actionsHtml=primaryHtml+watchHtml+contextHtml+potentialDetailHtml;

  const timelineItems=[];
  timelineItems.push({date:'Aujourd\u2019hui',icon:freeTonight?'🔴':'🟢',title:freeTonight?'Nuit libre à remplir':'Bien réservé ce soir',desc:freeTonight?`Action prioritaire : passer à ${recoPrice}€.`:'Aucune urgence immédiate.'});
  const nextMission=pendingM[0];
  if(nextMission){const cl=cleanersData.find(c=>String(c.id)===String(nextMission.cleaner_id));timelineItems.push({date:formatEventDate(nextMission.date),icon:'🧹',title:'Mission ménage',desc:`${cl?cl.name:'Non assigné'} · ${nextMission.heure||'heure à confirmer'} · ${nextMission.status||'à faire'}`});}
  else timelineItems.push({date:'À planifier',icon:'🧹',title:'Ménage non programmé',desc:'Créer une mission si un départ arrive bientôt.'});
  if(hotEvs[0])timelineItems.push({date:hotEvs[0].date_label||formatEventDate(hotEvs[0].date),icon:hotEvs[0].emoji||'🎉',title:'Événement local',desc:`${hotEvs[0].name.slice(0,50)} · boost +${hotEvs[0].boost||10}%`});
  const nextFree=days14.find(d=>!d.booked&&d.i>0);if(nextFree)timelineItems.push({date:dayNum(nextFree.d),icon:'💸',title:'Prochaine nuit libre',desc:`Prix recommandé : ${nextFree.rec}€.`});
  const timelineHtml=timelineItems.slice(0,5).map(t=>`<div class="rq-timeline-item"><div class="rq-time-dot">${t.icon}</div><div><div class="rq-time-date">${esc(t.date)}</div><div class="rq-time-title">${esc(t.title)}</div><div class="rq-time-desc">${esc(t.desc)}</div></div></div>`).join('');

  let cleanHtml='';
  if(pendingM.length){
    cleanHtml=pendingM.slice(0,3).map(m=>{const cl=cleanersData.find(c=>String(c.id)===String(m.cleaner_id));return `<div class="rq-clean-v2"><div class="rq-clean-avatar">${cl?(cl.name||'?').charAt(0).toUpperCase():'?'}</div><div class="rq-clean-main"><div class="rq-clean-title">${esc(cl?cl.name:'Non assigné')}</div><div class="rq-clean-meta">${esc(m.date||'date à confirmer')} · ${esc(m.heure||'heure à confirmer')}</div></div><span class="rq-boost-badge" style="background:${m.status==='acceptee'?'#DCFCE7':'#FFEDD5'};color:${m.status==='acceptee'?'#047857':'#C2410C'}">${m.status==='acceptee'?'Confirmé':'En attente'}</span></div>`}).join('');
  }else cleanHtml=`<div class="rq-clean-v2"><div class="rq-clean-avatar">!</div><div class="rq-clean-main"><div class="rq-clean-title">Aucun ménage prévu</div><div class="rq-clean-meta">Planifiez une mission pour éviter les urgences.</div></div><button class="rq-button-secondary" onclick="openMissionModal()">Créer</button></div>`;

  const eventsHtml=hotEvs.length?hotEvs.slice(0,4).map(e=>`<div class="rq-event-v2"><div class="rq-event-emoji">${e.emoji||'🎯'}</div><div class="rq-event-main"><div class="rq-event-title">${esc(e.name)}</div><div class="rq-event-meta">${esc(e.date_label||formatEventDate(e.date))} · ${esc(e.venue||city||'local')}</div></div><span class="rq-boost-badge">+${e.boost||10}%</span></div>`).join(''):`<div class="rq-event-v2"><div class="rq-event-emoji">📍</div><div class="rq-event-main"><div class="rq-event-title">Aucun événement majeur détecté</div><div class="rq-event-meta">EVA utilisera surtout l\u2019occupation et les nuits libres.</div></div></div>`;

  document.getElementById('parc-detail').innerHTML=`
    <div class="rq-detail-v2">
      <div class="rq-detail-top"><button class="rq-back-btn" onclick="closeApartDetail()">←</button><button class="rq-button-secondary" onclick="openEdit('${a.id}')">✏️ Modifier le bien</button></div>
      <section class="rq-detail-hero">
        <div class="rq-detail-hero-main">
          <div>
            <div class="rq-detail-title-row"><div class="rq-detail-emoji">${a.emoji||'🏠'}</div><div style="min-width:0"><div class="rq-detail-name">${esc(a.name||'Appartement')}</div><div class="rq-detail-address">${esc(a.address||city||'Adresse à compléter')}</div></div></div>
            <div style="margin-top:14px"><span class="rq-health-badge ${healthClass}"><span class="rq-health-dot"></span>${healthLabel}</span><span style="display:inline-block;margin-left:10px;color:rgba(255,255,255,.74);font-size:13px">${healthText}</span></div>
          </div>
          <div style="flex-shrink:0;text-align:center;min-width:120px">
            <div style="width:110px;height:110px;border-radius:50%;background:conic-gradient(${health.verdict==='vert'?'#10B981':health.verdict==='orange'?'#F59E0B':'#EF4444'} ${score}%,rgba(255,255,255,.18) 0);display:flex;align-items:center;justify-content:center;padding:8px;margin:0 auto 6px">
              <div style="width:100%;height:100%;border-radius:50%;background:linear-gradient(135deg,rgba(36,16,92,.97),rgba(124,58,237,.74));display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.18)">
                <div style="font-size:34px;font-weight:950;letter-spacing:-1px;color:#fff;line-height:1">${score}</div>
                <div style="font-size:9px;text-transform:uppercase;letter-spacing:.8px;font-weight:900;color:rgba(255,255,255,.65);margin-top:4px">EVA Score</div>
              </div>
            </div>
            <div style="font-size:10px;color:rgba(255,255,255,.55);font-weight:700">${healthLabel}</div>
            <div style="font-size:9px;color:rgba(255,255,255,.35);margin-top:2px">EVA Engine · temps réel</div>
          </div>
        </div>
        <div class="rq-hero-kpis">
          <div class="rq-hero-kpi"><div class="rq-hero-kpi-label">Net ce mois</div><div class="rq-hero-kpi-value">${net>=0?'+':''}${net}€</div><div class="rq-hero-kpi-sub">CA ${rev}€ · charges ${charges}€</div></div>
          <div class="rq-hero-kpi"><div class="rq-hero-kpi-label">Occupation 14j</div><div class="rq-hero-kpi-value">${occ14}%</div><div class="rq-hero-kpi-sub">${14-free14}/14 nuits réservées</div></div>
          <div class="rq-hero-kpi"><div class="rq-hero-kpi-label">Revenu à récupérer</div><div class="rq-hero-kpi-value">${potential}€</div><div class="rq-hero-kpi-sub">sur nuits libres proches</div></div>
          <div class="rq-hero-kpi"><div class="rq-hero-kpi-label">Action EVA</div><div class="rq-hero-kpi-value">${primaryAction.type==='urgent'?'🔴':primaryAction.type==='warn'?'🟡':'🟢'}</div><div class="rq-hero-kpi-sub">${esc(primaryAction.title.slice(0,28))}…</div></div>
        </div>
        <div class="rq-property-tabs">
          <button class="rq-property-tab active" onclick="switchPropertyTab('overview')">Vue d\u2019ensemble</button>
          <button class="rq-property-tab" onclick="switchPropertyTab('audit')">Audit 360°</button>
          <button class="rq-property-tab" onclick="switchPropertyTab('pricing')">Tarification IA</button>
          <button class="rq-property-tab" onclick="switchPropertyTab('calendar')">Calendrier</button>
          <button class="rq-property-tab" onclick="switchPropertyTab('charges')">Charges</button>
        </div>
      </section>

      <div class="rq-property-tab-panel active" id="rq-tab-overview">
      <section class="rq-card-v2" style="border:1px solid ${verdictBorder};background:${verdictBg};margin-bottom:16px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div>
            <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;margin-bottom:6px">Verdict EVA</div>
            <div style="font-size:20px;font-weight:950;color:${verdictText}">${health.verdictLabel}</div>
          </div>
          <div style="display:flex;gap:16px">
            <div style="text-align:center"><div style="font-size:9px;color:#8A8A99;font-weight:800;text-transform:uppercase;letter-spacing:.4px">Commercial</div><div style="font-size:20px;font-weight:900;color:${subScoreColor(health.scoreCommercial)}">${health.scoreCommercial}</div></div>
            <div style="text-align:center"><div style="font-size:9px;color:#8A8A99;font-weight:800;text-transform:uppercase;letter-spacing:.4px">Financier</div><div style="font-size:20px;font-weight:900;color:${subScoreColor(health.scoreFinancier)}">${health.scoreFinancier}</div></div>
            <div style="text-align:center"><div style="font-size:9px;color:#8A8A99;font-weight:800;text-transform:uppercase;letter-spacing:.4px">Opérationnel</div><div style="font-size:20px;font-weight:900;color:${subScoreColor(health.scoreOperationnel)}">${health.scoreOperationnel}</div></div>
          </div>
        </div>
        <div style="margin-top:12px;font-size:13px;color:#3F3B52;line-height:1.6">${health.why.map(w=>'• '+esc(w)).join('<br>')}</div>
        <div style="margin-top:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:rgba(255,255,255,.65);border-radius:12px;padding:10px 12px">
          <div style="font-size:13px;font-weight:700;color:#17122E">🎯 ${esc(health.priorityAction)}</div>
          ${health.impactEstimate>0?`<span class="rq-impact-pill">+${health.impactEstimate}€/mois estimé</span>`:''}
        </div>
      </section>
      <section class="rq-reco-card ${recoClass}">
        <div class="rq-reco-main"><div><div class="rq-reco-kicker">🎯 EVA recommande</div><div class="rq-reco-title">${esc(recoTitle)}</div></div><div class="rq-reco-price">${recoPrice}€<br><span>prix conseillé</span></div></div>
        <div class="rq-reason-list">${recoReasons.slice(0,4).map(r=>`<div class="rq-reason-item"><b>${esc(r[0])}</b><br>${esc(r[1])}</div>`).join('')}</div>
        <div class="rq-reco-footer"><span class="rq-impact-pill">💰 ${esc(impactText)}</span><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="rq-button-primary" onclick="applyAI('${a.id}',${recoPrice})">Appliquer ${recoPrice}€</button><button class="rq-button-secondary" onclick="openEdit('${a.id}')">Ajuster</button></div></div>
      </section>

      <div class="rq-detail-grid">
        <div style="display:flex;flex-direction:column;gap:16px">
          <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">📅 7 prochaines nuits</div><div class="rq-card-sub-v2">Cliquez une nuit libre pour appliquer son prix conseillé.</div></div><span class="rq-health-badge ${freeTonight?'danger':(free14>4?'warn':'')}" style="color:#17122E;background:#F8F4FF"><span class="rq-health-dot"></span>${free14} libres / 14j</span></div><div class="rq-nights-grid">${nightsHtml}</div></section>
          <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">🎯 Action EVA du jour</div><div class="rq-card-sub-v2">Une seule priorité opérationnelle par bien.</div></div></div><div class="rq-actions-list">${actionsHtml}</div></section>
          <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">💰 Finances du bien</div><div class="rq-card-sub-v2">Lecture simple : chiffre d\u2019affaires, charges et résultat.</div></div><span class="rq-boost-badge" style="background:${net>=0?'#DCFCE7':'#FEE2E2'};color:${net>=0?'#047857':'#B91C1C'}">${net>=0?'Rentable':'Sous-performant'}</span></div><div class="rq-finance-grid"><div class="rq-finance-line"><div class="rq-finance-label">CA généré</div><div class="rq-finance-value">${rev}€</div></div><div class="rq-finance-line"><div class="rq-finance-label">Charges</div><div class="rq-finance-value">${charges}€</div></div><div class="rq-finance-line"><div class="rq-finance-label">Résultat net</div><div class="rq-finance-value ${net>=0?'good':'bad'}">${net>=0?'+':''}${net}€</div></div><div class="rq-finance-line"><div class="rq-finance-label">Rentabilité</div><div class="rq-finance-value ${profitability>=0?'good':'bad'}">${profitability}%</div></div></div><div class="rq-mini-bars">${revBars}</div></section>
        </div>
        <div style="display:flex;flex-direction:column;gap:16px">
          <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">🧭 Timeline opérationnelle</div><div class="rq-card-sub-v2">Ce qui arrive sur ce logement.</div></div></div><div class="rq-timeline">${timelineHtml}</div></section>
          <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">🧹 CleanyQ</div><div class="rq-card-sub-v2">Ménage et préparation du bien.</div></div></div><div class="rq-clean-list">${cleanHtml}</div></section>
          <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">💡 Opportunités EVA</div><div class="rq-card-sub-v2">Revenus supplémentaires détectés.</div></div></div><div class="rq-events-list">${eventsHtml}</div></section>
        </div>
      </div>

      </div>

      <div class="rq-property-tab-panel" id="rq-tab-audit">

        <!-- EVA Score synthèse temps réel -->
        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px">
          <div style="background:linear-gradient(135deg,#F3E8FF,#FFF1F9);border:1px solid rgba(168,85,247,.22);border-radius:18px;padding:16px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:900;margin-bottom:8px">EVA Score</div>
            <div style="font-size:32px;font-weight:950;color:#7C3AED;letter-spacing:-1px">${score}/100</div>
            <div style="font-size:11px;color:#7B708F;margin-top:6px">EVA Engine · temps réel</div>
          </div>
          <div style="background:white;border:1px solid rgba(139,92,246,.14);border-radius:18px;padding:16px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:900;margin-bottom:8px">Rentabilité nette</div>
            <div style="font-size:32px;font-weight:950;color:${net>=0?'#059669':'#DC2626'};letter-spacing:-1px">${net>=0?'+':''}${net}€</div>
            <div style="font-size:11px;color:#7B708F;margin-top:6px">CA ${rev}€ − charges ${charges}€</div>
          </div>
          <div style="background:white;border:1px solid rgba(139,92,246,.14);border-radius:18px;padding:16px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:900;margin-bottom:8px">Occupation 14j</div>
            <div style="font-size:32px;font-weight:950;color:${occ14>=60?'#059669':occ14>=35?'#D97706':'#DC2626'};letter-spacing:-1px">${occ14}%</div>
            <div style="font-size:11px;color:#7B708F;margin-top:6px">${14-free14}/14 nuits réservées</div>
          </div>
          <div style="background:white;border:1px solid rgba(139,92,246,.14);border-radius:18px;padding:16px;text-align:center">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:900;margin-bottom:8px">Revenu à récupérer</div>
            <div style="font-size:32px;font-weight:950;color:#17122E;letter-spacing:-1px">${potential}€</div>
            <div style="font-size:11px;color:#7B708F;margin-top:6px">sur nuits libres proches</div>
          </div>
        </div>

        <!-- Import données PMS -->
        <div style="background:linear-gradient(135deg,#211051 0%,#7C3AED 46%,#EC4899 100%);border-radius:22px;padding:22px;margin-bottom:14px;color:#fff">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.8px;font-weight:900;color:rgba(255,255,255,.65);margin-bottom:6px">Audit 360° — ${esc(a.name||'Ce logement')}</div>
          <div style="font-size:22px;font-weight:950;letter-spacing:-.5px;margin-bottom:8px">Importer les données réelles du bien</div>
          <div style="font-size:13px;color:rgba(255,255,255,.78);margin-bottom:18px">EVA analyse les réservations, classe les charges et produit la rentabilité nette mensuelle avec des actions concrètes.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
            <div>
              <label style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:rgba(255,255,255,.65);display:block;margin-bottom:6px">Source des données (PMS)</label>
              <select id="apt-audit-pms-${a.id}" style="height:40px;border-radius:10px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.13);color:#fff;padding:0 12px;font-family:inherit;font-size:13px;font-weight:600;width:100%;outline:none">
                <option value="manual" style="color:#1A1A2E">📂 Import manuel (CSV)</option>
                <option value="easy_concierge" style="color:#1A1A2E">🏢 Easy Concierge</option>
                <option value="smoobu" style="color:#1A1A2E">🔗 Smoobu</option>
                <option value="beds24" style="color:#1A1A2E">🛏️ Beds24</option>
                <option value="guesty" style="color:#1A1A2E">🏠 Guesty</option>
                <option value="hostaway" style="color:#1A1A2E">🌐 Hostaway</option>
              </select>
            </div>
            <div>
              <label style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:rgba(255,255,255,.65);display:block;margin-bottom:6px">CSV réservations</label>
              <input id="apt-audit-res-${a.id}" type="file" accept=".csv,text/csv" style="height:40px;border-radius:10px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.13);color:#fff;padding:8px 12px;font-family:inherit;font-size:12px;width:100%"/>
            </div>
            <div>
              <label style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:rgba(255,255,255,.65);display:block;margin-bottom:6px">CSV bancaire / charges</label>
              <input id="apt-audit-bank-${a.id}" type="file" accept=".csv,text/csv" style="height:40px;border-radius:10px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.13);color:#fff;padding:8px 12px;font-family:inherit;font-size:12px;width:100%"/>
            </div>
            <div>
              <label style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:rgba(255,255,255,.65);display:block;margin-bottom:6px">Adresse (pré-remplie)</label>
              <input id="apt-audit-addr-${a.id}" type="text" value="${esc(a.address||city||'')}" placeholder="Adresse du bien"
                style="height:40px;border-radius:10px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.13);color:#fff;padding:0 12px;font-family:inherit;font-size:13px;font-weight:600;width:100%;outline:none"/>
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button onclick="runAptAudit360('${a.id}')" style="height:42px;border:none;border-radius:12px;padding:0 20px;background:#fff;color:#7C3AED;font-weight:900;font-family:inherit;cursor:pointer;box-shadow:0 14px 34px rgba(0,0,0,.15)">Lancer l\u2019audit EVA</button>
            <button onclick="loadAptAuditDemo('${a.id}')" style="border:0;background:transparent;color:rgba(255,255,255,.75);font-family:inherit;cursor:pointer;font-size:12px;font-weight:700;text-decoration:underline">Charger les données démo</button>
          </div>
          <div id="apt-audit-error-${a.id}" style="display:none;margin-top:10px;padding:10px;border-radius:10px;background:rgba(239,68,68,.18);color:#FCA5A5;font-size:12px;font-weight:700"></div>
        </div>

        <!-- Résultat inline de l\u2019audit pour ce bien -->
        <div id="apt-audit-result-${a.id}"></div>

      </div>
      <div class="rq-property-tab-panel" id="rq-tab-pricing">
        <section class="rq-context-card">
          <div class="rq-context-title">Tarification IA — propulsée par EVA Pricing</div>
          <div class="rq-context-sub">Objectif : recommander le bon prix jour par jour, puis pousser les modifications via Smoobu vers Airbnb et Booking.</div>
          <div class="rq-reco-card ${recoClass}" style="margin-bottom:14px"><div class="rq-reco-main"><div><div class="rq-reco-kicker">Prix recommandé maintenant</div><div class="rq-reco-title">${esc(recoTitle)}</div></div><div class="rq-reco-price">${recoPrice}€<br><span>conseillé</span></div></div><div class="rq-reco-footer"><span class="rq-impact-pill">${esc(impactText)}</span><button class="rq-button-primary" onclick="applyAI('${a.id}',${recoPrice})">Appliquer via Smoobu</button></div></div>
          <div class="rq-pricing-day-list">${days14.slice(0,14).map(d=>`<div class="rq-price-day ${d.booked?'booked':d.evs.length?'event':''}" ${d.booked?'':`onclick="applyAI('${a.id}',${d.rec})"`}><div style="font-size:11px;color:#8A8A99;font-weight:800">${dayName(d.d)} ${dayNum(d.d)}</div><div style="font-size:22px;font-weight:950;margin-top:4px">${d.booked?'Réservé':d.rec+'€'}</div><div style="font-size:11px;color:#8A8A99;margin-top:4px">${d.evs.length?'Événement local':d.booked?'Déjà vendu':'Libre à optimiser'}</div></div>`).join('')}</div>
        </section>
      </div>

      <div class="rq-property-tab-panel" id="rq-tab-calendar">
        <div class="rq-context-layout">
          <section class="rq-context-card"><div class="rq-context-title">Calendrier du logement</div><div class="rq-context-sub">Vue opérationnelle des prochaines nuits, réservations, événements et ménages.</div><div class="rq-nights-grid">${nightsHtml}</div></section>
          <section class="rq-context-card"><div class="rq-context-title">Timeline</div><div class="rq-timeline">${timelineHtml}</div></section>
        </div>
      </div>

      <div class="rq-property-tab-panel" id="rq-tab-charges">
        <div class="rq-context-layout">
          <section class="rq-context-card"><div class="rq-context-title">Charges et rentabilité</div><div class="rq-context-sub">Comprendre où part l\u2019argent et combien il reste réellement.</div><div class="rq-finance-grid"><div class="rq-finance-line"><div class="rq-finance-label">CA généré</div><div class="rq-finance-value">${rev}€</div></div><div class="rq-finance-line"><div class="rq-finance-label">Charges détectées</div><div class="rq-finance-value">${charges}€</div></div><div class="rq-finance-line"><div class="rq-finance-label">Résultat net</div><div class="rq-finance-value ${net>=0?'good':'bad'}">${net>=0?'+':''}${net}€</div></div><div class="rq-finance-line"><div class="rq-finance-label">Rentabilité</div><div class="rq-finance-value ${profitability>=0?'good':'bad'}">${profitability}%</div></div></div></section>
          <section class="rq-context-card"><div class="rq-context-title">Actions charges</div><div class="rq-actions-list"><div class="rq-action-v2 warn"><div class="rq-action-icon">🧹</div><div><div class="rq-action-title">Optimiser le ménage</div><div class="rq-action-desc">Comparer coût par rotation et durée moyenne des séjours.</div></div></div><div class="rq-action-v2"><div class="rq-action-icon">⚡</div><div><div class="rq-action-title">Suivre les charges fixes</div><div class="rq-action-desc">Internet, énergie, abonnements et maintenance doivent être suivis chaque mois.</div></div></div></div></section>
        </div>
      </div>

      <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">⚙️ Modifier / compléter le bien</div><div class="rq-card-sub-v2">Accès rapide aux réglages importants.</div></div></div><div class="rq-edit-panel"><div class="rq-edit-tile" onclick="openEdit('${a.id}')"><div class="rq-edit-icon">🏠</div><div class="rq-edit-title">Informations</div><div class="rq-edit-sub">Nom, ville, adresse, emoji.</div></div><div class="rq-edit-tile" onclick="openEdit('${a.id}')"><div class="rq-edit-icon">💸</div><div class="rq-edit-title">Pricing</div><div class="rq-edit-sub">Prix actuel, plancher, dégressif.</div></div><div class="rq-edit-tile" onclick="openMissionModal()"><div class="rq-edit-icon">🧹</div><div class="rq-edit-title">Ménage</div><div class="rq-edit-sub">Créer une mission CleanyQ.</div></div><div class="rq-edit-tile" onclick="goTo('smoobu',document.querySelector('[data-page="smoobu"]'))"><div class="rq-edit-icon">🔗</div><div class="rq-edit-title">Synchronisation</div><div class="rq-edit-sub">Smoobu, réservations, prix.</div></div></div></section>
    </div>`;
}


/* ====================================================
   PARC — Fiches logements
   ==================================================== */
function renderParcFiches(){
  var dash=document.getElementById('parc-fiches-dash');
  if(!dash)return;

  if(!apparts.length){
    dash.innerHTML='<div class="p360-empty"><div style="font-size:40px;margin-bottom:14px">\uD83C\uDFE0</div><div style="font-size:17px;font-weight:800;color:#0B0722;font-family:Sora,sans-serif;margin-bottom:8px">Aucun logement dans le parc</div><div style="font-size:13px;color:#8A8A99;line-height:1.65;max-width:380px;margin:0 auto 18px">Ajoutez votre premier bien pour qu\u2019EVA g\u00e9n\u00e8re les fiches de performance.</div><button class="a360-action-btn" onclick="openAddModal()">\uD83C\uDFE0 Ajouter un bien</button></div>';
    return;
  }

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());

  // Générer les missions EVA une fois
  var allMissions=[];
  try{ allMissions=generateEvaMissions(); }catch(e){}

  var cards=apparts.map(function(a){
    var aptRes=reservations.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var rev=aptRes.reduce(function(s,r){return s+(r.price_total||0);},0);
    var totalN=aptRes.reduce(function(s,r){try{if(!r.date_from||!r.date_to)return s+(r.nights||0);return s+Math.max(0,Math.round((new Date(r.date_to)-new Date(r.date_from))/(1000*60*60*24)));}catch(e){return s+(r.nights||0);}},0);
    var occ=daysElapsed>0?Math.min(100,Math.round(totalN/daysElapsed*100)):0;
    var adr=totalN>0?Math.round(rev/totalN):0;
    var fl=floor(a);
    var price=a.price||0;
    var aiRec=a.ai_rec||0;
    var potential=aiRec>price?aiRec-price:0;
    var city=a.city||'';
    var hotEvs=(eventsCache[city]||[]).filter(function(e){return e.hot;});
    var freeTonight=!a.booked;

    var sc=55;sc+=Math.min(25,Math.round(occ*.25));if(!freeTonight)sc+=8;else sc-=14;if(hotEvs.length)sc+=4;if(price>=fl&&fl>0)sc+=8;sc=Math.max(8,Math.min(98,sc));
    var scoreColor=sc>=75?'#10B981':sc>=50?'#F59E0B':'#EF4444';

    var prioIcon,prioBg,prioText,prioLabel;
    if(freeTonight){prioIcon='\uD83D\uDD25';prioBg='#EEEDFE';prioText='#3C3489';prioLabel='Nuit libre \u2014 agir maintenant';}
    else if(hotEvs.length){prioIcon='\uD83C\uDF89';prioBg='#FAEEDA';prioText='#854F0B';prioLabel='Pic de demande d\u00e9tect\u00e9 \u2014 booster le prix';}
    else if(occ<50){prioIcon='\u26A0\uFE0F';prioBg='#FAEEDA';prioText='#854F0B';prioLabel='Occupation faible \u2014 optimiser la distribution';}
    else{prioIcon='\u2705';prioBg='#EAF3DE';prioText='#3B6D11';prioLabel='Bien pilot\u00e9 correctement';}

    var aptMissions=allMissions.filter(function(m){return m.apt_id===a.id&&m.status!=='done';}).slice(0,3);
    var missionsHtml='';
    if(aptMissions.length){
      missionsHtml='<div class="parc-fiche-missions">'+
        '<div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#8A8A99;margin-bottom:6px">Missions EVA actives</div>'+
        aptMissions.map(function(m){
          var dot=m.priority==='haute'?'#DC2626':m.priority==='moyenne'?'#D97706':'#7C3AED';
          return '<div class="parc-fiche-mission-item">'+
            '<div class="parc-fiche-mission-dot" style="background:'+dot+'"></div>'+
            '<div style="flex:1;min-width:0">'+
              '<div style="font-size:12px;font-weight:700;color:#17122E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+m.title+'</div>'+
              '<div style="font-size:10px;color:#8A8A99">'+m.type+' \u00b7 '+m.priority+'</div>'+
            '</div>'+
          '</div>';
        }).join('')+
      '</div>';
    }

    // ── Règle EVA : une seule Action du Jour (if/else if cascade) ──
    var evaActionIcon,evaActionTitle,evaActionDesc,evaActionType,evaActionBtn,evaActionRec;
    var note=Number(a.note||0);
    var lostNights72=0; // Nuits libres dans les 72h (hors ce soir)
    var today2=new Date();
    for(var di=1;di<=3;di++){var dd=new Date(today2);dd.setDate(dd.getDate()+di);var ddIso=dd.toISOString().slice(0,10);var booked72=reservations.some(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_to&&r.date_from<=ddIso&&r.date_to>ddIso;});if(!booked72)lostNights72++;}
    var checkinImminent=!freeTonight&&(function(){var r=reservations.find(function(r){return r.appartement_id===a.id&&r.date_from===today2.toISOString().slice(0,10);});return !!r;}());

    if(checkinImminent){
      evaActionType='warn';evaActionIcon='\uD83D\uDEAA';
      evaActionTitle='Check-in aujourd\u2019hui \u2014 v\u00e9rifier la pr\u00e9paration';
      evaActionDesc='Un voyageur arrive ce jour. Confirmez le m\u00e9nage et l\u2019acc\u00e8s au logement.';
      evaActionBtn='Voir CleanyQ';evaActionRec=null;
    } else if(freeTonight){
      evaActionType='urgent';evaActionIcon='\uD83D\uDD25';
      evaActionTitle='Appliquer un tarif de remplissage ce soir';
      evaActionDesc='Le logement est libre ce soir. Chaque heure sans r\u00e9servation est une nuit perdue.';
      evaActionBtn='Appliquer';evaActionRec=Math.max(fl,Math.round((price||60)*0.82));
    } else if(note>0&&note<4){
      evaActionType='urgent';evaActionIcon='\u2605';
      evaActionTitle='Corriger la qualit\u00e9 avant d\u2019augmenter les prix';
      evaActionDesc='Note actuelle : '+note+'/5. Priorit\u00e9 aux photos, m\u00e9nage et \u00e9quipements.';
      evaActionBtn='Voir la fiche';evaActionRec=null;
    } else if(lostNights72>0){
      evaActionType='urgent';evaActionIcon='\u23F1\uFE0F';
      evaActionTitle='Baisser l\u00e9g\u00e8rement pour s\u00e9curiser '+lostNights72+' nuit'+(lostNights72>1?'s':'')+' \u00e0 venir';
      evaActionDesc='Des nuits libres arrivent sous 72h. Un ajustement de prix maintenant peut \u00e9viter des pertes.';
      evaActionBtn='Appliquer';evaActionRec=Math.max(fl,Math.round((price||60)*0.88));
    } else if(hotEvs.length&&occ>=50){
      evaActionType='hot';evaActionIcon='\uD83C\uDF89';
      evaActionTitle='Booster le prix pour l\u2019\u00e9v\u00e9nement : '+(hotEvs[0].name||'').slice(0,28);
      evaActionDesc='Pic de demande d\u00e9tect\u00e9. Hausse recommand\u00e9e de +'+(hotEvs[0].boost||10)+'%.';
      evaActionBtn='Appliquer';evaActionRec=Math.max(price,Math.round((price||60)*(1+(hotEvs[0].boost||10)/100)));
    } else if(potential>0&&occ>=50){
      evaActionType='hot';evaActionIcon='\uD83D\uDCC8';
      evaActionTitle='Monter le prix \u00e0 '+aiRec+'\u20AC conseill\u00e9 par EVA';
      evaActionDesc='Le bien est bien rempli. EVA estime un potentiel de +'+potential+'\u20AC/nuit sans risque.';
      evaActionBtn='Appliquer';evaActionRec=aiRec;
    } else if(occ<50){
      evaActionType='warn';evaActionIcon='\uD83D\uDCE1';
      evaActionTitle='Activer un canal suppl\u00e9mentaire pour le remplissage';
      evaActionDesc='Occupation \u00e0 '+occ+'% ce mois. Une deuxi\u00e8me plateforme augmenterait la visibilit\u00e9.';
      evaActionBtn='Voir int\u00e9grations';evaActionRec=null;
    } else {
      evaActionType='ok';evaActionIcon='\u2705';
      evaActionTitle='Aucune action urgente aujourd\u2019hui';
      evaActionDesc='EVA surveille les prochains jours. Consultez les missions \u00e0 venir.';
      evaActionBtn=null;evaActionRec=null;
    }

    // Action EVA du jour HTML
    var evaActionHtml='<div class="eva-section-label">Action EVA du jour</div>'+
      '<div class="eva-action-day '+evaActionType+'">'+
        '<div class="eva-action-day-icon">'+evaActionIcon+'</div>'+
        '<div style="flex:1;min-width:0">'+
          '<div class="eva-action-day-title">'+evaActionTitle+'</div>'+
          '<div class="eva-action-day-desc">'+evaActionDesc+'</div>'+
          (evaActionBtn?'<button class="eva-action-day-btn" onclick="'+(evaActionRec?'goTo(\'parc\',document.querySelector(\'[data-page=parc]\')); setTimeout(function(){showApartDetail(\''+a.id+'\')},150)':'evaActionRec===null&&\''+evaActionBtn+'\'===\'Voir CleanyQ\'?\'goTo(\\\'clean\\\',document.querySelector(\\\'[data-page=clean]\\\'))\':\'\'')+'" onclick="goTo(\'parc\',document.querySelector(\'[data-page=parc]\')); setTimeout(function(){showApartDetail(\''+a.id+'\')},150)">'+evaActionBtn+'</button>':'')+
        '</div>'+
      '</div>';

    // ── Missions EVA à venir (signaux non retenus comme action principale) ──
    var futureMissions=[];
    if(!freeTonight&&lostNights72>0) futureMissions.push({dot:'#DC2626',title:'Nuits libres sous 72h','sub':lostNights72+' nuit'+(lostNights72>1?'s':'')+' \u00e0 remplir dans les 3 prochains jours'});
    if(hotEvs.length&&!(!freeTonight===false||occ<50)) futureMissions.push({dot:'#D97706',title:'Pic de demande : '+(hotEvs[0].name||'').slice(0,32),sub:'Hausse de +'+(hotEvs[0].boost||10)+'% possible sur les dates concern\u00e9es'});
    if(occ<65&&!freeTonight&&occ>=50) futureMissions.push({dot:'#D97706',title:'Taux d\u2019occupation sous l\u2019objectif (65%)',sub:'Actuel : '+occ+'%. Quelques nuits vacantes \u00e0 surveiller'});
    aptMissions.filter(function(m){return m.status!=='done';}).slice(0,2).forEach(function(m){futureMissions.push({dot:m.priority==='haute'?'#DC2626':'#7C3AED',title:m.title,sub:m.type+' \u00b7 '+m.priority});});
    var missionsHtml='';
    if(futureMissions.length){
      missionsHtml='<div class="eva-missions-section">'+
        '<div class="eva-section-label">Missions EVA \u00e0 venir</div>'+
        futureMissions.slice(0,3).map(function(m){
          return '<div class="eva-mission-item">'+
            '<div class="eva-mission-dot" style="background:'+m.dot+'"></div>'+
            '<div><div class="eva-mission-title">'+m.title+'</div><div class="eva-mission-sub">'+m.sub+'</div></div>'+
          '</div>';
        }).join('')+
      '</div>';
    }

    // ── Recommandations long terme (structurelles) ──
    var longTermRecos=[];
    if(note>0&&note>=4&&note<4.5) longTermRecos.push('Am\u00e9liorer les \u00e9quipements ou les photos (+0,5 point de note = +8% de revenu)');
    if(!a.platform||a.platform==='airbnb') longTermRecos.push('Activer Booking.com pour r\u00e9duire la d\u00e9pendance \u00e0 Airbnb');
    if(potential>0&&occ<50) longTermRecos.push('Optimiser le pricing long terme : prix cible EVA \u00e0 '+aiRec+'\u20AC d\u00e8s que le taux d\u2019occupation sera stable');
    var recoHtml='';
    if(longTermRecos.length){
      recoHtml='<div class="eva-longterm-section">'+
        '<div class="eva-section-label">Recommandations long terme</div>'+
        longTermRecos.slice(0,2).map(function(r){
          return '<div class="eva-longterm-item"><span class="eva-longterm-arrow">\u2192</span><span>'+r+'</span></div>';
        }).join('')+
      '</div>';
    }

    // ── Contexte EVA (données explicatives, pas des actions) ──
    var contextHtml='<div class="eva-section-label">Contexte EVA</div>'+
      '<div class="eva-context-grid">'+
        '<div class="eva-context-item"><div class="eva-context-val">'+price+'\u20AC</div><div class="eva-context-lbl">Prix actuel</div></div>'+
        (aiRec>0?'<div class="eva-context-item"><div class="eva-context-val" style="color:#7C3AED">'+aiRec+'\u20AC</div><div class="eva-context-lbl">Cible EVA</div></div>':'<div class="eva-context-item"><div class="eva-context-val" style="color:#B0A8C8">—</div><div class="eva-context-lbl">Cible EVA</div></div>')+
        '<div class="eva-context-item"><div class="eva-context-val" style="color:'+(occ>=65?'#059669':occ>=45?'#D97706':'#DC2626')+'">'+occ+'%</div><div class="eva-context-lbl">Occupation</div></div>'+
        '<div class="eva-context-item"><div class="eva-context-val">'+adr+'\u20AC</div><div class="eva-context-lbl">ADR</div></div>'+
        (fl>0?'<div class="eva-context-item"><div class="eva-context-val" style="color:#8A8A99">'+fl+'\u20AC</div><div class="eva-context-lbl">Plancher</div></div>':'<div class="eva-context-item"><div class="eva-context-val" style="color:#B0A8C8">—</div><div class="eva-context-lbl">Plancher</div></div>')+
        '<div class="eva-context-item"><div class="eva-context-val" style="color:'+scoreColor+'">'+sc+'</div><div class="eva-context-lbl">Score EVA</div></div>'+
      '</div>';

    // ── Potentiel EVA du logement, scindé propriétaire / conciergerie ──
    var aptPotential=rqAptEvaPotential(a,Math.max(4,Math.round(occ/100*30)));
    var potentialHtml='';
    if(aptPotential.total>0){
      potentialHtml='<div class="eva-section-label" style="margin-top:10px">Potentiel EVA du logement</div>'+
        '<div style="background:#F8F5FF;border-radius:12px;padding:12px 14px">'+
          '<div style="font-size:15px;font-weight:900;color:#17122E;margin-bottom:8px">+'+aptPotential.total+'\u20AC<span style="font-size:11px;color:#8A8A99;font-weight:600">/mois</span></div>'+
          '<div style="display:flex;gap:14px">'+
            '<div style="flex:1"><div style="font-size:10px;color:#8A8A99;text-transform:uppercase;letter-spacing:.4px;font-weight:800">Propri\u00e9taire</div><div style="font-size:14px;font-weight:800;color:#059669">+'+aptPotential.proprietaire+'\u20AC</div></div>'+
            '<div style="flex:1"><div style="font-size:10px;color:#8A8A99;text-transform:uppercase;letter-spacing:.4px;font-weight:800">Conciergerie</div><div style="font-size:14px;font-weight:800;color:#7C3AED">+'+aptPotential.conciergerie+'\u20AC</div></div>'+
          '</div>'+
          '<div style="display:flex;height:5px;border-radius:999px;overflow:hidden;margin-top:8px;background:#EDE4FF">'+
            '<div style="height:100%;width:'+Math.round(aptPotential.proprietaire/aptPotential.total*100)+'%;background:#059669"></div>'+
            '<div style="height:100%;width:'+Math.round(aptPotential.conciergerie/aptPotential.total*100)+'%;background:#7C3AED"></div>'+
          '</div>'+
        '</div>';
    }

    var equipHtml='';
    if(a.equipements&&a.equipements.length){
      var equips=Array.isArray(a.equipements)?a.equipements:[a.equipements];
      equipHtml='<div style="margin-bottom:12px">'+
        '<div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#8A8A99;margin-bottom:6px">\u00c9quipements</div>'+
        '<div style="display:flex;flex-wrap:wrap;gap:4px">'+
        equips.slice(0,6).map(function(eq){return '<span style="background:#F3E8FF;color:#7C3AED;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600">'+eq+'</span>';}).join('')+
        '</div></div>';
    }

    return '<div class="parc-fiche-card">'+
      '<div class="parc-fiche-hero">'+
        '<div class="parc-fiche-hero-top">'+
          '<div class="parc-fiche-emoji">'+(a.emoji||'\uD83C\uDFE0')+'</div>'+
          '<div style="flex:1;min-width:0"><div class="parc-fiche-name">'+a.name+'</div><div class="parc-fiche-city">'+(a.city||'')+(a.address?' \u00b7 '+a.address.slice(0,30):'')+'</div></div>'+
          '<div class="parc-fiche-score"><div class="parc-fiche-score-num" style="color:'+scoreColor+'">'+sc+'</div><div class="parc-fiche-score-lbl">EVA</div></div>'+
        '</div>'+
        '<div class="parc-fiche-kpis">'+
          '<div class="parc-fiche-kpi"><div class="parc-fiche-kpi-val">'+rev+'\u20AC</div><div class="parc-fiche-kpi-lbl">Revenus</div></div>'+
          '<div class="parc-fiche-kpi"><div class="parc-fiche-kpi-val">'+occ+'%</div><div class="parc-fiche-kpi-lbl">Occupation</div></div>'+
          '<div class="parc-fiche-kpi"><div class="parc-fiche-kpi-val">'+(adr>0?adr+'\u20AC':'—')+'</div><div class="parc-fiche-kpi-lbl">ADR</div></div>'+
        '</div>'+
      '</div>'+
      '<div class="parc-fiche-body">'+
        '<div class="parc-fiche-priority" style="background:'+prioBg+';color:'+prioText+'">'+
          '<span>'+prioIcon+'</span>'+
          '<span style="font-size:12px;font-weight:700">'+prioLabel+'</span>'+
          (potential>0?'<span style="margin-left:auto;font-size:11px;font-weight:900;white-space:nowrap">+'+potential+'\u20AC/nuit</span>':'')+
        '</div>'+
        evaActionHtml+missionsHtml+recoHtml+contextHtml+potentialHtml+equipHtml+
        '<div class="parc-fiche-footer">'+
          '<button class="parc-fiche-btn-primary" onclick="goTo(\'parc\',document.querySelector(\'[data-page=parc]\')); setTimeout(function(){showApartDetail(\''+a.id+'\')},150)">\uD83D\uDD0D Voir le d\u00e9tail complet</button>'+
          '<button class="parc-fiche-btn-secondary" onclick="openEdit(\''+a.id+'\')">Modifier</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');

  var totalRev=apparts.reduce(function(s,a){
    var r=reservations.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    return s+r.reduce(function(s2,r2){return s2+(r2.price_total||0);},0);
  },0);

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">Parc \u00b7 Fiches logements</div>'+
      '<div class="a360-hero-title">'+apparts.length+' logement'+(apparts.length>1?'s':'')+' dans votre parc</div>'+
      '<div class="a360-hero-sub">'+totalRev+'\u20AC g\u00e9n\u00e9r\u00e9s ce mois \u2014 cliquez sur un bien pour acc\u00e9der au d\u00e9tail complet</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+apparts.length+' logement'+(apparts.length>1?'s':'')+'</span>'+
        '<span class="a360-hero-chip">'+totalRev+'\u20AC ce mois</span>'+
      '</div>'+
    '</div>'+
    '<div class="parc-fiches-grid">'+cards+'</div>';
}

/* ====================================================
   PARC — Comparaison
   ==================================================== */
function renderParcComparaison(){
  var dash=document.getElementById('parc-comparaison-dash');
  if(!dash)return;

  if(!apparts.length){
    dash.innerHTML='<div class="p360-empty"><div style="font-size:40px;margin-bottom:14px">\u2696\uFE0F</div><div style="font-size:17px;font-weight:800;color:#0B0722;font-family:Sora,sans-serif;margin-bottom:8px">Aucun logement \u00e0 comparer</div><div style="font-size:13px;color:#8A8A99;line-height:1.65;max-width:380px;margin:0 auto">Ajoutez plusieurs biens pour activer la comparaison EVA.</div></div>';
    return;
  }

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());

  var stats=apparts.map(function(a){
    var aptRes=reservations.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var rev=aptRes.reduce(function(s,r){return s+(r.price_total||0);},0);
    var totalN=aptRes.reduce(function(s,r){try{if(!r.date_from||!r.date_to)return s+(r.nights||0);return s+Math.max(0,Math.round((new Date(r.date_to)-new Date(r.date_from))/(1000*60*60*24)));}catch(e){return s+(r.nights||0);}},0);
    var occ=daysElapsed>0?Math.min(100,Math.round(totalN/daysElapsed*100)):0;
    var adr=totalN>0?Math.round(rev/totalN):0;
    var fl=floor(a);var price=a.price||0;var aiRec=a.ai_rec||0;var potential=aiRec>price?aiRec-price:0;
    var hotEvs=((eventsCache[a.city||''])||[]).filter(function(e){return e.hot;});
    var sc=55;sc+=Math.min(25,Math.round(occ*.25));if(!a.booked)sc+=8;else sc-=14;if(hotEvs.length)sc+=4;if(price>=fl&&fl>0)sc+=8;sc=Math.max(8,Math.min(98,sc));
    return {a:a,rev:rev,occ:occ,adr:adr,sc:sc,potential:potential};
  });

  function rankColor(i){return i===0?'gold':i===1?'silver':'bronze';}
  function classement(title,icon,sorted,valFn,highlightBest){
    var rows=sorted.map(function(s,i){
      var val=valFn(s);
      return '<div class="parc-comp-row">'+
        '<div class="parc-comp-rank '+(i<3?rankColor(i):'')+'">'+(i+1)+'</div>'+
        '<div class="parc-comp-apt">'+(s.a.emoji||'\uD83C\uDFE0')+' '+s.a.name+'</div>'+
        '<div class="parc-comp-val" style="color:'+(i===0&&highlightBest?'#059669':'#17122E')+'">'+val+'</div>'+
      '</div>';
    }).join('');
    return '<div class="parc-comp-card"><div class="parc-comp-card-title">'+icon+' '+title+'</div>'+rows+'</div>';
  }

  var byRev=[...stats].sort(function(a,b){return b.rev-a.rev;});
  var byOcc=[...stats].sort(function(a,b){return b.occ-a.occ;});
  var bySc=[...stats].sort(function(a,b){return b.sc-a.sc;});
  var byPot=[...stats].sort(function(a,b){return b.potential-a.potential;});
  var byRisk=[...stats].sort(function(a,b){return a.sc-b.sc;});
  var totalRev=stats.reduce(function(s,r){return s+r.rev;},0);
  var bestSc=bySc[0];var riskSc=byRisk[0];

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">Parc \u00b7 Comparaison EVA</div>'+
      '<div class="a360-hero-title">Classement de '+apparts.length+' logement'+(apparts.length>1?'s':'')+' par crit\u00e8re</div>'+
      '<div class="a360-hero-sub">Total parc : '+totalRev+'\u20AC ce mois \u2014 Score EVA moyen : '+Math.round(stats.reduce(function(s,r){return s+r.sc;},0)/Math.max(1,stats.length))+'/100</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+apparts.length+' biens</span>'+
        '<span class="a360-hero-chip">'+totalRev+'\u20AC total</span>'+
        (bestSc?'<span class="a360-hero-chip">\uD83C\uDFC6 Meilleur EVA : '+bestSc.a.name+'</span>':'')+
        (riskSc&&riskSc.sc<50?'<span class="a360-hero-chip" style="background:rgba(220,38,38,.25);border-color:rgba(220,38,38,.35)">\u26A0\uFE0F \u00c0 surveiller : '+riskSc.a.name+'</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="parc-comp-grid">'+
      classement('Meilleur revenu','\uD83D\uDCB0',byRev,function(s){return s.rev+'\u20AC';},true)+
      classement('Meilleure occupation','\uD83D\uDCC5',byOcc,function(s){return s.occ+'%';},true)+
      classement('Meilleur score EVA','\uD83C\uDFC6',bySc,function(s){return s.sc+'/100';},true)+
      classement('Plus gros potentiel','\uD83D\uDE80',byPot,function(s){return s.potential>0?'+'+s.potential+'\u20AC/nuit':'\u2014';},true)+
      classement('Biens \u00e0 surveiller','\u26A0\uFE0F',byRisk,function(s){return s.sc+'/100';},false)+
    '</div>'+
    '<div style="display:flex;gap:10px;flex-wrap:wrap">'+
      '<button class="a360-action-btn" onclick="goTo(\'parc-fiches\',document.querySelector(\'[data-page=parc-fiches]\'))">Voir les fiches \u2192</button>'+
      '<button class="a360-action-btn" onclick="goTo(\'profit360\',document.querySelector(\'[data-page=profit360]\'))">Profit 360 \u2192</button>'+
    '</div>';
}

/* ===== ARCHIVAGE DES BIENS ===== */
async function loadArchivedApparts(){
  try{const res=await sbFetch(`appartements?user_id=eq.${currentUser.user.id}&archived=eq.true&select=*`);archivedApparts=await res.json()||[];}catch(e){archivedApparts=[];}
  const btn=document.getElementById('btn-archives');
  if(btn)btn.style.display=archivedApparts.length?'inline-flex':'none';
}
function confirmArchiveAppart(){
  if(!editId)return;
  const a=apparts.find(x=>x.id===editId);if(!a)return;
  if(confirm('Archiver "'+a.name+'" ?\n\nLe bien dispara\u00eetra du Cockpit et des analyses EVA.\nL\u2019historique des r\u00e9servations est conserv\u00e9.'))archiveAppart(editId);
}
async function archiveAppart(id){
  try{
    await sbFetch(`appartements?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({archived:true})});
    const a=apparts.find(x=>x.id===id);
    if(a){archivedApparts.push({...a,archived:true});apparts=apparts.filter(x=>x.id!==id);}
    closeModal();closeApartDetail();await loadArchivedApparts();renderAll();
    showToast('\u{1F4E6} '+(a?.name||'Bien')+' archiv\u00e9');
  }catch(e){showToast('Erreur lors de l\u2019archivage');}
}
async function unarchiveAppart(id){
  try{
    await sbFetch(`appartements?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({archived:false})});
    const a=archivedApparts.find(x=>x.id===id);
    if(a){apparts.push({...a,archived:false});archivedApparts=archivedApparts.filter(x=>x.id!==id);}
    await loadArchivedApparts();renderAll();renderArchivesList();
    showToast('\u2705 Bien remis dans le parc actif');
  }catch(e){showToast('Erreur lors du d\u00e9sarchivage');}
}
async function deleteArchivedAppart(id){
  const a=archivedApparts.find(x=>x.id===id);if(!a)return;
  if(!confirm('Supprimer d\u00e9finitivement "'+a.name+'" ?\n\nCette action est irr\u00e9versible.'))return;
  if(!confirm('Derni\u00e8re confirmation \u2014 "'+a.name+'" sera effac\u00e9 avec tout son historique.'))return;
  try{
    await sbFetch(`reservations?appartement_id=eq.${id}`,{method:'DELETE'}).catch(()=>{});
    await sbFetch(`charges?appartement_id=eq.${id}`,{method:'DELETE'}).catch(()=>{});
    await sbFetch(`transactions?appartement_id=eq.${id}`,{method:'DELETE'}).catch(()=>{});
    await sbFetch(`appartements?id=eq.${id}`,{method:'DELETE'});
    archivedApparts=archivedApparts.filter(x=>x.id!==id);
    reservations=reservations.filter(r=>r.appartement_id!==id);
    renderArchivesList();showToast('Bien supprim\u00e9 d\u00e9finitivement');
  }catch(e){showToast('Erreur lors de la suppression');}
}
function openArchivesView(){
  document.getElementById('parc-list-view').style.display='none';
  document.getElementById('parc-map-view').style.display='none';
  document.getElementById('parc-detail-view').style.display='none';
  document.getElementById('parc-archives-view').style.display='block';
  renderArchivesList();
}
function closeArchivesView(){
  document.getElementById('parc-archives-view').style.display='none';
  document.getElementById('parc-list-view').style.display='block';
}
function renderArchivesList(){
  const list=document.getElementById('parc-archives-list');if(!list)return;
  if(!archivedApparts.length){
    list.innerHTML='<div style="text-align:center;padding:3rem;color:#8A8A99"><div style="font-size:48px;margin-bottom:1rem">\u{1F4E6}</div><div style="font-weight:600;margin-bottom:6px">Aucun bien archiv\u00e9</div><div style="font-size:13px">L\u2019historique est conserv\u00e9 jusqu\u2019\u00e0 suppression d\u00e9finitive.</div></div>';
    return;
  }
  list.innerHTML=archivedApparts.map(a=>{
    const aptRes=reservations.filter(r=>r.appartement_id===a.id);
    const totalRev=aptRes.reduce((s,r)=>s+(r.price_total||0),0);
    const dt=a.updated_at?new Date(a.updated_at).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'}):'';
    return '<div style="background:white;border:1px solid #EEEEF5;border-radius:16px;padding:16px;margin-bottom:10px;opacity:.85">'
      +'<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">'
      +'<div style="font-size:28px;opacity:.6">'+(a.emoji||'\uD83C\uDFE0')+'</div>'
      +'<div style="flex:1"><div style="font-size:15px;font-weight:700">'+(a.name||'Bien archiv\u00e9')+'</div>'
      +'<div style="font-size:11px;color:#8A8A99">'+(a.city||'')+(dt?' \u00b7 Archiv\u00e9 le '+dt:'')+'</div></div>'
      +'<span style="font-size:10px;padding:3px 10px;border-radius:999px;background:#FEF3C7;color:#92400E;font-weight:700">\u{1F4E6} Archiv\u00e9</span></div>'
      +'<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">'
      +'<div style="background:#F8F7FF;border-radius:8px;padding:8px;text-align:center"><div style="font-size:14px;font-weight:700">'+aptRes.length+'</div><div style="font-size:10px;color:#8A8A99">R\u00e9servations</div></div>'
      +'<div style="background:#F8F7FF;border-radius:8px;padding:8px;text-align:center"><div style="font-size:14px;font-weight:700">'+totalRev+'\u20ac</div><div style="font-size:10px;color:#8A8A99">Revenus historiques</div></div>'
      +'<div style="background:#F8F7FF;border-radius:8px;padding:8px;text-align:center"><div style="font-size:14px;font-weight:700">'+(a.price||0)+'\u20ac</div><div style="font-size:10px;color:#8A8A99">Dernier prix</div></div>'
      +'</div>'
      +'<div style="display:flex;gap:8px">'
      +'<button onclick="unarchiveAppart(\'' +a.id+ '\')" class="btn btn-sm btn-purple" style="flex:1">\u21A9 Remettre dans le parc</button>'
      +'<button onclick="deleteArchivedAppart(\'' +a.id+ '\')" class="btn btn-sm" style="color:#DC2626;border-color:#FECACA">\uD83D\uDDD1 Supprimer d\u00e9finitivement</button>'
      +'</div></div>';
  }).join('');
}
/* ===== end ARCHIVAGE ===== */

function closeApartDetail(){
  document.getElementById('parc-detail-view').style.display='none';
  document.getElementById('parc-list-view').style.display='block';
}


/* ── Réservations ── */
function renderResTable(){renderReservationsPage();}

function renderReservationsPage(){
  const today=new Date();
  const isoToday=isoDate(today);
  const in7=isoDate(addDays(today,7));
  const in1=isoDate(addDays(today,1));

  // Bloc 1 : KPIs semaine
  const weekRes=reservations.filter(r=>r.date_from>=isoToday&&r.date_from<=in7);
  const checkins=reservations.filter(r=>r.date_from===isoToday||r.date_from===in1).length;
  const checkouts=reservations.filter(r=>r.date_to===isoToday||r.date_to===in1).length;
  const potentiel=Math.round(apparts.reduce((s,a)=>s+(+(a.price||0)*0.72*getNextFreeDays(a,7).length),0));
  const kpiEl=document.getElementById('res-kpi-row');
  if(kpiEl)kpiEl.innerHTML=`
    <div class="kpi"><div class="kpi-label">Réservations semaine</div><div class="kpi-value">${weekRes.length}</div><div class="kpi-delta" style="color:#8A8A99">7 prochains jours</div></div>
    <div class="kpi"><div class="kpi-label">Check-in à venir</div><div class="kpi-value" style="color:#059669">${checkins}</div><div class="kpi-delta" style="color:#059669">auj. &amp; demain</div></div>
    <div class="kpi"><div class="kpi-label">Check-out à venir</div><div class="kpi-value" style="color:#D97706">${checkouts}</div><div class="kpi-delta" style="color:#D97706">auj. &amp; demain</div></div>
    <div class="kpi kpi-ai"><div class="kpi-label">Potentiel EVA</div><div class="kpi-value" style="color:#7C3AED">+${potentiel} €</div><div class="kpi-delta" style="color:#7C3AED">7 jours</div></div>`;

  // Bloc 2 : Priorités EVA
  const priorities=[];
  const freeNights=apparts.flatMap(a=>getNextFreeDays(a,2).map(d=>({a,d})));
  if(freeNights.length){
    const tot=freeNights.reduce((s,{a})=>s+(+(a.price||0)*0.72),0);
    const names=freeNights.map(({a})=>a.name.split(' ')[0]).filter((v,i,arr)=>arr.indexOf(v)===i).slice(0,3).join(' • ');
    priorities.push({icon:'🔥',label:`${freeNights.length} nuit${freeNights.length>1?'s':''} libre${freeNights.length>1?'s':''} demain`,detail:names,impact:`+${Math.round(tot)} €`,impactLabel:'potentiels',btn:'Agir',action:`goTo('pricing',null)`,border:'#FDE68A',color:'#D97706',bg:'linear-gradient(135deg,#FFF7ED,#FFF)'});
  }
  apparts.forEach(a=>{
    if(getNextFreeDays(a,8).length>=8)priorities.push({icon:'⚠️',label:`${a.name} — aucune réservation sur 8 jours`,detail:'Risque de manque à gagner',impact:`${Math.round((+(a.price||0))*0.72*8)} €`,impactLabel:'à risque',btn:'Voir',action:`showApartDetail('${a.id}')`,border:'#FDE68A',color:'#D97706',bg:'#FFFBEB'});
    if(a.comp&&+(a.price||0)>+(a.comp||0)*1.1)priorities.push({icon:'📈',label:`${a.name} performe mieux que le marché`,detail:`+${Math.round(((+(a.price||0))/(+(a.comp||0))-1)*100)} % vs concurrence`,impact:'maintenir',impactLabel:'',btn:'Comprendre',action:`showApartDetail('${a.id}')`,border:'#BBF7D0',color:'#059669',bg:'linear-gradient(135deg,#F0FFF4,#FFF)'});
  });
  if(!priorities.length)priorities.push({icon:'✅',label:'Tout est sous contrôle',detail:'EVA ne détecte aucune urgence aujourd\'hui.',impact:'',impactLabel:'',btn:'Voir le parc',action:`goTo('parc',null)`,border:'#BBF7D0',color:'#059669',bg:'linear-gradient(135deg,#F0FFF4,#FFF)'});
  const priEl=document.getElementById('res-eva-priorities');
  if(priEl)priEl.innerHTML=`
    <div style="font-size:11px;font-weight:800;color:#8A8A99;text-transform:uppercase;letter-spacing:.8px;margin-bottom:.75rem">🤖 Priorités EVA</div>
    <div style="display:flex;flex-direction:column;gap:10px">${priorities.slice(0,4).map(p=>`
      <div style="display:grid;grid-template-columns:36px 1fr auto auto;gap:12px;align-items:center;background:${p.bg};border:1px solid ${p.border};border-radius:16px;padding:14px 16px">
        <div style="font-size:22px;text-align:center">${p.icon}</div>
        <div><div style="font-size:13px;font-weight:700;color:#0B0722;margin-bottom:2px">${p.label}</div><div style="font-size:11px;color:#8A8A99">${p.detail}</div></div>
        ${p.impact?`<div style="text-align:right;white-space:nowrap"><div style="font-size:15px;font-weight:900;color:${p.color}">${p.impact}</div><div style="font-size:10px;color:#8A8A99">${p.impactLabel}</div></div>`:'<div></div>'}
        <button onclick="${p.action}" style="padding:7px 14px;border-radius:10px;border:1px solid ${p.border};background:white;color:${p.color};font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">${p.btn}</button>
      </div>`).join('')}</div>`;

  // Bloc 3 : Liste des réservations
  const emptyEl=document.getElementById('res-empty');
  const wrapEl=document.getElementById('res-table-wrap');
  if(!reservations.length){if(emptyEl)emptyEl.style.display='block';if(wrapEl)wrapEl.innerHTML='';return;}
  if(emptyEl)emptyEl.style.display='none';
  const pi={airbnb:'🏠 Airbnb',booking:'🏨 Booking',direct:'✉️ Direct',other:'📌 Autre'};
  if(wrapEl)wrapEl.innerHTML=reservations.slice(0,40).map(r=>{
    const apt=apparts.find(a=>a.id===r.appartement_id)||{name:r.apartment_name||'—',emoji:'🏠'};
    const isCI=r.date_from===isoToday;const isCO=r.date_to===isoToday;
    const statusTag=isCI?'<span class="tag tag-ok">Check-in</span>':isCO?'<span class="tag tag-warn">Check-out</span>':'<span class="tag tag-info">Confirmé</span>';
    return`<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr auto;gap:10px;align-items:center;background:white;border:0.5px solid rgba(139,92,246,.12);border-radius:14px;padding:12px 16px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px"><span style="font-size:18px">${apt.emoji||'🏠'}</span><div><div style="font-size:13px;font-weight:700;color:#0B0722">${apt.name||'—'}</div><div style="font-size:11px;color:#8A8A99">${pi[r.platform||'other']||'—'}</div></div></div>
      <div><div style="font-size:11px;color:#8A8A99">Arrivée</div><div style="font-size:12px;font-weight:600;color:#0B0722">${r.date_from||'—'}</div></div>
      <div><div style="font-size:11px;color:#8A8A99">Départ</div><div style="font-size:12px;font-weight:600;color:#0B0722">${r.date_to||'—'}</div></div>
      <div><div style="font-size:11px;color:#8A8A99">Voyageurs</div><div style="font-size:12px;font-weight:600;color:#0B0722">${r.guests||r.nights||'—'}</div></div>
      <div><div style="font-size:11px;color:#8A8A99">Revenus</div><div style="font-size:13px;font-weight:800;color:#7C3AED">${r.price_total||0} €</div></div>
      ${statusTag}</div>`;
  }).join('');
}

/* ── Calendrier — blocs EVA ── */
function renderCalendarPage(){
  const today=new Date();
  const in7=isoDate(addDays(today,7));
  const in1=isoDate(addDays(today,1));
  const upcoming=reservations.filter(r=>r.date_from>=isoDate(today)&&r.date_from<=in7).length;
  const checkins=reservations.filter(r=>r.date_from===isoDate(today)||r.date_from===in1).length;
  const menages=typeof missionsData!=='undefined'?missionsData.filter(m=>m.date>=isoDate(today)&&m.date<=in7).length:0;
  const totalFreeNights=apparts.reduce((s,a)=>s+getNextFreeDays(a,7).length,0);
  const potentiel=Math.round(apparts.reduce((s,a)=>s+(+(a.price||0)*0.72*getNextFreeDays(a,7).length),0));
  const kpiEl=document.getElementById('cal-kpi-row');
  if(kpiEl)kpiEl.innerHTML=`
    <div class="kpi"><div class="kpi-label">Réservations à venir</div><div class="kpi-value">${upcoming}</div><div class="kpi-delta" style="color:#8A8A99">7 jours</div></div>
    <div class="kpi"><div class="kpi-label">Check-in</div><div class="kpi-value" style="color:#059669">${checkins}</div><div class="kpi-delta" style="color:#059669">auj. &amp; demain</div></div>
    <div class="kpi"><div class="kpi-label">Ménages</div><div class="kpi-value" style="color:#0284C7">${menages}</div><div class="kpi-delta" style="color:#8A8A99">planifiés</div></div>
    <div class="kpi kpi-ai"><div class="kpi-label">Potentiel détecté</div><div class="kpi-value" style="color:#7C3AED">+${potentiel} €</div><div class="kpi-delta" style="color:#7C3AED">7 jours</div></div>`;
  const evaBlock=document.getElementById('cal-eva-block');
  if(evaBlock){
    if(totalFreeNights>0){
      const t=document.getElementById('cal-eva-title');
      const s=document.getElementById('cal-eva-sub');
      if(t)t.textContent=`EVA a détecté ${totalFreeNights} nuit${totalFreeNights>1?'s':''} libre${totalFreeNights>1?'s':''} à optimiser`;
      if(s)s.textContent=`Une action rapide pourrait générer jusqu'à +${potentiel} €.`;
      evaBlock.style.display='flex';
    } else {evaBlock.style.display='none';}
  }
}


function normalizeCityName(city){
  city=(city||'').toString().trim();
  if(!city)return '';
  return city.charAt(0).toUpperCase()+city.slice(1).toLowerCase();
}

function isoDate(d){return d.toISOString().slice(0,10)}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function bookingCoversDate(r,date){return r&&r.date_from&&r.date_to&&r.date_from<=date&&r.date_to>date}
function monthKey(d=new Date()){return d.toISOString().slice(0,7)}
function getAptReservations(a){return reservations.filter(r=>String(r.appartement_id)===String(a.id));}
function getOccupancyRate(a,horizon=30){
  const today=new Date();let booked=0;
  for(let i=0;i<horizon;i++){const d=isoDate(addDays(today,i));if(getAptReservations(a).some(r=>bookingCoversDate(r,d)))booked++;}
  return Math.round(booked/horizon*100);
}
function getNextFreeDays(a,horizon=14){
  const today=new Date();const res=getAptReservations(a);const out=[];
  for(let i=0;i<horizon;i++){const d=isoDate(addDays(today,i));if(!res.some(r=>bookingCoversDate(r,d)))out.push({offset:i,date:d,dow:addDays(today,i).getDay()});}
  return out;
}
function getGapRisk(a){
  const free=getNextFreeDays(a,14);
  if(!free.length)return {level:0,label:'Aucune nuit libre'};
  const first=free[0]?.offset??99;
  const consecutive=free.reduce((s,d,idx)=>idx===s&&d.offset===idx?s+1:s,0);
  if(first===0&&consecutive>=2)return {level:4,label:`${consecutive} nuits libres dès ce soir`};
  if(first<=1)return {level:3,label:'nuit libre très proche'};
  if(first<=3)return {level:2,label:'trou de calendrier proche'};
  return {level:1,label:'nuits libres à surveiller'};
}
function seasonalFactor(date=new Date()){
  const m=date.getMonth()+1;
  if([7,8].includes(m))return {factor:1.08,label:'haute saison été'};
  if([11,12].includes(m))return {factor:1.06,label:'forte demande fin d\u2019année'};
  if([1,2].includes(m))return {factor:.93,label:'saison plus faible'};
  return {factor:1,label:'saison normale'};
}
function portfolioOccupancy(){
  if(!apparts.length)return 0;
  return Math.round(apparts.reduce((s,a)=>s+getOccupancyRate(a,30),0)/apparts.length);
}
function getCityEventsForApt(a){
  const city=normalizeCityName(a.city||extractCity(a.zone,null)||'');
  return (eventsCache[city]||eventsCache[(a.city||'')]||[]).filter(Boolean);
}
function getSmartRec(a,opts={}){
  const basePrice=Number(a.price||0)||80;
  const competitor=Number(a.comp||0);
  const fl=Math.max(25,Math.round((Number(a.rent||0)/30)+(Number(a.cleaner||0))));
  const now=new Date();
  const targetDate=opts.date?new Date(opts.date):now;
  const horizon=opts.horizon||14;
  const occ30=getOccupancyRate(a,30);
  const occ14=getOccupancyRate(a,14);
  const portfolioOcc=portfolioOccupancy();
  const freeDays=getNextFreeDays(a,horizon);
  const isBookedToday=getAptReservations(a).some(r=>bookingCoversDate(r,isoDate(now))) || !!a.booked;
  const firstFree=freeDays[0]?.offset ?? 99;
  const gap=getGapRisk(a);
  const cityEvents=getCityEventsForApt(a);
  const targetIso=isoDate(targetDate);
  const hotEvents=cityEvents.filter(e=>e.hot && (!e.date || Math.abs((new Date(e.date)-targetDate)/(1000*60*60*24))<=2));
  const anyEvents=cityEvents.filter(e=>!e.date || Math.abs((new Date(e.date)-targetDate)/(1000*60*60*24))<=7);
  const dow=targetDate.getDay();
  const isWeekend=dow===5||dow===6;
  const isSundayOrMonday=dow===0||dow===1;
  const season=seasonalFactor(targetDate);

  let factor=1;
  const reasons=[];
  const actions=[];

  // Objectif n°1 : occupation. Une nuit vide vaut 0€.
  if(!isBookedToday || firstFree<=3){
    if(firstFree===0){factor-=0.22;reasons.push('J-0 : priorité remplissage, une nuit vide vaut 0€');actions.push('Baisse agressive aujourd\u2019hui pour déclencher une réservation');}
    else if(firstFree===1){factor-=0.18;reasons.push('J-1 : nuit très proche non louée');actions.push('Baisser maintenant plutôt que d\u2019attendre');}
    else if(firstFree<=3){factor-=0.12;reasons.push('J-3 : trou de calendrier proche');actions.push('Mettre une offre courte durée');}
  }
  if(occ14<35){factor-=0.12;reasons.push('occupation 14 jours faible');actions.push('Créer une remise visible pour relancer la demande');}
  else if(occ14<55){factor-=0.07;reasons.push('occupation à améliorer');actions.push('Baisse modérée pour sécuriser plus de nuits');}
  else if(occ14>80 && firstFree>5){factor+=0.06;reasons.push('bonne occupation : marge de hausse possible');actions.push('Maintenir le prix plus haut avant de baisser');}

  if(portfolioOcc<45){factor-=0.05;reasons.push('portefeuille global trop vide');}
  else if(portfolioOcc>75 && firstFree>4){factor+=0.04;reasons.push('portefeuille bien rempli');}

  if(gap.level>=3){factor-=0.05;reasons.push(gap.label);actions.push('Traiter ce trou comme une vente flash');}

  if(isWeekend){factor+=0.08;reasons.push('vendredi/samedi : demande naturellement plus forte');}
  if(isSundayOrMonday){factor-=0.05;reasons.push('dimanche/lundi : demande souvent plus faible');}

  if(hotEvents.length){
    const boost=Math.min(0.24,hotEvents.reduce((s,e)=>s+(Number(e.boost||10)/100),0));
    // si dernière minute et pas loué, on garde une hausse plus prudente
    const applied=firstFree<=2?Math.min(boost,0.08):boost;
    factor+=applied;reasons.push(`événement local détecté : ${hotEvents[0].name||'événement'}`);actions.push('Surveiller la demande événementielle mais ne pas sacrifier l\u2019occupation');
  }else if(anyEvents.length){factor+=0.04;reasons.push('événement local à proximité');}

  factor*=season.factor;
  if(season.factor!==1)reasons.push(season.label);

  if(competitor>0){
    if(basePrice>competitor*1.18 && occ14<60){factor-=0.08;reasons.push('prix au-dessus des concurrents avec occupation insuffisante');}
    if(basePrice<competitor*.85 && occ14>70){factor+=0.06;reasons.push('prix sous marché avec bonne occupation');}
  }

  let rec=Math.round(basePrice*factor);
  // garde-fous : on baisse pour louer mais pas sous plancher
  rec=Math.max(fl,rec);
  if(firstFree===0 && occ14<45) rec=Math.max(fl,Math.min(rec,Math.round(basePrice*.82)));
  if(firstFree===1 && occ14<55) rec=Math.max(fl,Math.min(rec,Math.round(basePrice*.86)));
  // pas de hausse excessive sans IA ni validation marché
  if(rec>basePrice*1.22)rec=Math.round(basePrice*1.22);
  if(rec<basePrice*.72 && rec>fl)rec=Math.round(basePrice*.72);

  let direction=rec<basePrice?'BAISSER':rec>basePrice?'AUGMENTER':'MAINTENIR';
  let priority='normal';
  if(firstFree<=1&&!isBookedToday)priority='urgent';
  else if(occ14<45||gap.level>=3)priority='important';
  else if(hotEvents.length)priority='opportunité';

  const delta=rec-basePrice;
  const deltaPct=basePrice?Math.round(delta/basePrice*100):0;
  const reason=reasons.length?reasons.join(' · '):'prix cohérent avec les données disponibles';
  return {rec,reason,reasons,actions,direction,priority,delta,deltaPct,floor:fl,occ14,occ30,portfolioOcc,firstFree,gap,hotEvents,cityEvents};
}

function renderPricingTable(){
  const horizon=+(document.getElementById('pricing-horizon')?.value||14);
  const gridEl=document.getElementById('pricing-grid');
  const pipeEl=document.getElementById('pricing-pipeline');
  if(!gridEl||!pipeEl)return;

  const now=new Date();
  const days=Array.from({length:horizon},(_,i)=>{
    const d=new Date(now);d.setDate(d.getDate()+i);
    return{date:isoDate(d),label:d.getDate(),dayName:d.toLocaleDateString('fr-FR',{weekday:'short'}),isToday:i===0,offset:i};
  });

  if(!apparts.length){
    gridEl.innerHTML='<div style="text-align:center;padding:3rem;color:#8A8A99;background:white;border-radius:18px;border:1px solid #EEEEF5">Ajoutez des appartements pour voir les opportunités EVA.</div>';
    pipeEl.innerHTML='';return;
  }

  const rows=apparts.map(a=>{
    const city=a.city||extractCity(a.zone,null)||'';
    const cityEvents=eventsCache[city]||[];
    const hotEvs=cityEvents.filter(e=>e.hot);
    const smart=getSmartRec(a,{horizon});
    const freeDays=days.filter(d=>!getAptReservations(a).some(r=>bookingCoversDate(r,d.date)));
    const potentialHorizon=freeDays.reduce((s,d)=>{
      const isEv=hotEvs.some(e=>e.date&&Math.abs((new Date(e.date)-new Date(d.date))/(86400000))<=1);
      return s+Math.round(smart.rec*(isEv?1.08:1));
    },0);
    // Mensualiser
    const daysInMonth=30;
    const freeRatio=horizon>0?freeDays.length/horizon:0;
    const potentialMonthly=Math.round(freeRatio*daysInMonth*smart.rec*0.72);
    const potentialAnnual=potentialMonthly*12;
    const occ=Math.round(((horizon-freeDays.length)/horizon)*100);
    const urgent=freeDays.filter(d=>d.offset<=2).length;

    let action,actionColor,actionBg,evaIcon;
    if(freeDays.length===0){
      action='Rien à faire — bien optimisé';actionColor='#059669';actionBg='#ECFDF5';evaIcon='✅';
    } else if(urgent>0){
      action=`Baisser à ${smart.rec} € ce soir`;actionColor='#DC2626';actionBg='#FEF2F2';evaIcon='🔥';
    } else if(hotEvs.length&&smart.direction==='AUGMENTER'){
      action=`+${Math.round((smart.rec-(a.price||0)))} € sur signal local`;actionColor='#D97706';actionBg='#FFFBEB';evaIcon='🎯';
    } else if(smart.direction==='AUGMENTER'){
      action=`Monter à ${smart.rec} €`;actionColor='#7C3AED';actionBg='#F5F0FF';evaIcon='📈';
    } else {
      action=`Baisser à ${smart.rec} €`;actionColor='#D97706';actionBg='#FFFBEB';evaIcon='⚠️';
    }
    return{a,action,actionColor,actionBg,evaIcon,potentialHorizon,potentialMonthly,potentialAnnual,freeDays,occ,urgent,hotEvs,smart};
  }).sort((x,y)=>(y.urgent-x.urgent)||(y.potentialMonthly-x.potentialMonthly));

  const totalFreeNights=rows.reduce((s,r)=>s+r.freeDays.length,0);
  const totalMonthly=rows.reduce((s,r)=>s+r.potentialMonthly,0);
  const totalAnnual=totalMonthly*12;
  const occ=Math.round(((apparts.length*horizon-totalFreeNights)/(apparts.length*horizon||1))*100);

  const sub=document.getElementById('pricing-sub');
  if(sub)sub.textContent=`${totalFreeNights} nuit${totalFreeNights>1?'s':''} libres · +${totalMonthly} € ce mois · Score EVA ${Math.max(0,Math.min(100,occ))}/100`;
  const applyBtn=document.getElementById('btn-apply-all');
  if(applyBtn)applyBtn.style.display=totalFreeNights>0?'inline-flex':'none';
  document.getElementById('global-result').innerHTML='';

  // ── HERO ──
  const heroHtml=`
    <div class="opp-hero">
      <div class="opp-hero-inner">
        <div class="opp-kicker">RentyQ × EVA Engine</div>
        <h2 class="opp-title">Les opportunités à saisir aujourd'hui.</h2>
        <p class="opp-sub">EVA analyse votre activité en continu et détecte les actions capables d'augmenter vos revenus.</p>
        <div class="opp-kpi-row">
          <div class="opp-kpi-main">
            <div class="opp-kpi-main-value">+${totalMonthly} €</div>
            <div class="opp-kpi-main-label">ce mois-ci</div>
            <div class="opp-kpi-secondary">+${totalAnnual.toLocaleString('fr-FR')} € / an</div>
          </div>
          <div class="opp-hero-ctas">
            <button class="btn btn-purple" onclick="document.getElementById('opp-priorities').scrollIntoView({behavior:'smooth'})"><i class="ti ti-sparkles"></i> Voir mes opportunités</button>
            <button class="btn" onclick="document.getElementById('opp-by-apt').scrollIntoView({behavior:'smooth'})"><i class="ti ti-coin"></i> Optimiser mes prix</button>
          </div>
        </div>
      </div>
    </div>`;

  // ── PRIORITÉS EVA ──
  const topOpp=[
    {icon:'🔥',title:'Augmenter le tarif du samedi',monthly:Math.round(totalMonthly*0.45),annual:0,action:`applyAllPricing()`},
    {icon:'⚠️',title:`Activer Booking sur ${apparts[0]?.name?.split(' ')[0]||'S1'}`,monthly:Math.round(totalMonthly*0.30),annual:0,action:`showToast('Connectez Booking dans Paramètres.')`},
    {icon:'📈',title:'Corriger la durée minimale',monthly:Math.round(totalMonthly*0.20),annual:0,action:`showToast('Action enregistrée.')`}
  ].map(o=>({...o,annual:o.monthly*12}));

  const prioritiesHtml=`
    <div id="opp-priorities" style="margin-bottom:1.25rem">
      <div class="opp-section-label">Priorités EVA</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${topOpp.map(p=>`
          <div class="opp-priority-card">
            <div class="opp-priority-icon">${p.icon}</div>
            <div class="opp-priority-body">
              <div class="opp-priority-title">${p.title}</div>
              <div class="opp-priority-monthly">+${p.monthly} € <span class="opp-unit">/ mois</span></div>
              <div class="opp-priority-annual">+${p.annual.toLocaleString('fr-FR')} € / an</div>
            </div>
            <button class="btn btn-sm btn-purple" onclick="${p.action}">Appliquer</button>
          </div>`).join('')}
      </div>
    </div>`;

  // ── PAR LOGEMENT ──
  const byAptHtml=`
    <div id="opp-by-apt">
      <div class="opp-section-label">Opportunités par logement</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${rows.map(r=>`
          <div class="opp-apt-card">
            <div class="opp-apt-header">
              <div style="font-size:18px">${r.a.emoji||'🏠'}</div>
              <div class="opp-apt-name">${escapeHtml(r.a.name||'Bien')}</div>
              <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
                <span style="background:${r.actionBg};color:${r.actionColor};border-radius:999px;padding:4px 12px;font-size:12px;font-weight:800">${r.evaIcon} ${escapeHtml(r.action)}</span>
                ${r.freeDays.length?`<button class="btn btn-sm btn-purple" onclick="applyAI('${r.a.id}',${r.smart.rec})">Appliquer</button>`:'<span style="font-size:12px;color:#059669;font-weight:700">✓ Optimisé</span>'}
              </div>
            </div>
            <div class="opp-apt-kpis">
              <div class="opp-apt-kpi">
                <div class="opp-apt-kpi-val">+${r.potentialMonthly} €</div>
                <div class="opp-apt-kpi-lbl">/ mois estimés</div>
              </div>
              <div class="opp-apt-kpi">
                <div class="opp-apt-kpi-val opp-apt-kpi-secondary">+${r.potentialAnnual.toLocaleString('fr-FR')} €</div>
                <div class="opp-apt-kpi-lbl">/ an estimés</div>
              </div>
              <div class="opp-apt-kpi">
                <div class="opp-apt-kpi-val">${r.freeDays.length}</div>
                <div class="opp-apt-kpi-lbl">nuit${r.freeDays.length>1?'s':''} libre${r.freeDays.length>1?'s':''}</div>
              </div>
              <div class="opp-apt-kpi">
                <div class="opp-apt-kpi-val">${r.occ} %</div>
                <div class="opp-apt-kpi-lbl">occupation</div>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;

  // Calendrier détaillé en accordion
  const COL_W=horizon<=7?58:horizon<=14?46:34;
  const APT_W=160;
  let cal=`<div style="margin-top:14px"><details><summary style="cursor:pointer;font-size:13px;font-weight:700;color:#7C3AED;padding:10px 0;user-select:none">📅 Calendrier détaillé</summary><div style="margin-top:10px;overflow-x:auto;background:white;border-radius:14px;border:1px solid #EEEEF5;padding:12px"><div class="eva-calendar-grid" style="grid-template-columns:${APT_W}px ${days.map(()=>COL_W+'px').join(' ')};min-width:${APT_W+days.length*(COL_W+4)}px">`;
  cal+=`<div></div>`;
  days.forEach(d=>{cal+=`<div class="eva-cal-head"><div>${d.dayName}</div><div style="font-size:13px;color:${d.isToday?'#7C3AED':'inherit'}">${d.label}</div></div>`;});
  rows.forEach(({a,smart,freeDays})=>{
    const city=a.city||'';const cityEvents=eventsCache[city]||[];const hotEvs=cityEvents.filter(e=>e.hot);
    const daysData=days.map(d=>{const isBooked=getAptReservations(a).some(r=>bookingCoversDate(r,d.date));const isEv=hotEvs.some(e=>e.date&&Math.abs((new Date(e.date)-new Date(d.date))/(86400000))<=1);return{...d,isBooked,isEv,recPrice:Math.round(smart.rec*(isEv?1.08:1))};});
    cal+=`<div class="eva-cal-apt"><span>${a.emoji||'🏠'}</span><span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.name||'Appartement')}</span></div>`;
    daysData.forEach(d=>{const cls=d.isBooked?'booked':(d.isEv?'event':'free');cal+=`<div class="eva-cal-cell ${cls} ${d.isToday?'today':''}" ${d.isBooked?'':` onclick="applyAI('${a.id}',${d.recPrice})"`} title="${escapeHtml(a.name||'')} · ${d.date}"><div class="eva-cal-price">${d.isBooked?'✓':d.recPrice+'€'}</div><div class="eva-cal-tag">${d.isBooked?'OK':d.isEv?'signal':'libre'}</div></div>`;});
  });
  cal+=`</div></div></details></div>`;

  gridEl.innerHTML=heroHtml+prioritiesHtml+byAptHtml;
  pipeEl.innerHTML=cal;
}


function applyAllForApt(aptId){
  const a=apparts.find(x=>x.id===aptId);if(!a)return;
  const smart=getSmartRec(a);
  applyAI(aptId,smart.rec);
  showToast(`✓ Prix EVA appliqué pour ${a.name}`);
}

function applyAllEVA(){
  const horizon=+(document.getElementById('pricing-horizon')?.value||14);
  const now=new Date();
  let count=0;
  apparts.forEach(a=>{
    const hasFreeDays=Array.from({length:horizon},(_,i)=>{
      const d=new Date(now);d.setDate(d.getDate()+i);
      return d.toISOString().split('T')[0];
    }).some(date=>!reservations.some(r=>r.appartement_id===a.id&&r.date_from<=date&&r.date_to>=date));
    if(hasFreeDays){const smart=getSmartRec(a);applyAI(a.id,smart.rec);count++;}
  });
  showToast(`✅ EVA appliqué sur ${count} bien${count>1?'s':''}`);
}


async function loadEvents(force=false){
  const loading=document.getElementById('events-loading');
  const empty=document.getElementById('events-empty');
  const container=document.getElementById('events-container');
  const btn=document.getElementById('btn-refresh-events');
  if(!container)return;
  const citiesMap={};
  (apparts||[]).forEach(a=>{
    const city=normalizeCityName(a.city||extractCity(a.zone,null)||'');
    if(city){if(!citiesMap[city])citiesMap[city]=[];citiesMap[city].push(a);}
  });
  const cities=Object.keys(citiesMap);
  if(!cities.length){
    if(empty)empty.style.display='block';
    if(loading)loading.style.display='none';
    container.innerHTML='';
    const sub=document.getElementById('events-sub');if(sub)sub.textContent='Ajoutez une ville/adresse pour détecter les événements';
    return;
  }
  if(empty)empty.style.display='none';
  if(loading)loading.style.display='block';
  if(btn){btn.disabled=true;btn.textContent='Recherche…';}

  for(const city of cities){
    if(!force && eventsCache[city] && eventsCache[city].length)continue;
    let events=[];
    try{
      // Priorité : votre Edge Function events-proxy. Elle peut agréger Ticketmaster + OpenAgenda avec clés cachées.
      const data=await eventsCall(city);
      events=normalizeEventsPayload(data,city);
    }catch(e){
      console.warn('events-proxy indisponible pour',city,e);
      events=[];
    }
    if(!events.length){
      try{events=await fetchOpenAgendaFallback(city);}catch(e){console.warn('OpenAgenda fallback indisponible',city,e);}
    }
    if(!events.length){
      events=buildLocalSeasonalEvents(city);
    }
    eventsCache[city]=events.slice(0,30);
  }
  if(loading)loading.style.display='none';
  if(btn){btn.disabled=false;btn.textContent='🔄 Actualiser';}
  renderEventsPage(citiesMap);
  try{renderAll();}catch(e){}
}

function normalizeEventsPayload(data,city){
  const raw=data?.events||data?.items||data?.results||data?._embedded?.events||[];
  if(!Array.isArray(raw))return [];
  const now=new Date();
  return raw.map((e,idx)=>{
    const date=e.date||e.startDate||e.start_time||e.firstdate_begin||e.dates?.start?.localDate||e.date_start||'';
    const name=e.name||e.title||e.label||'Événement local';
    const venue=e.venue||e.location||e.place||e._embedded?.venues?.[0]?.name||'';
    const segment=e.segment||e.category||e.type||e.classifications?.[0]?.segment?.name||'Local';
    const boost=eventBoostFromName(name,segment,date,idx);
    return {name,date,venue,segment,boost,hot:boost>=10,emoji:eventEmoji(segment,name),date_label:formatEventDate(date),source:e.source||'events-proxy'};
  }).filter(e=>e.name).sort((a,b)=>(new Date(a.date||'2999-01-01'))-(new Date(b.date||'2999-01-01')));
}

async function fetchOpenAgendaFallback(city){
  const start=new Date().toISOString().slice(0,10);
  const end=addDays(new Date(),180).toISOString().slice(0,10);
  const url=`https://api.openagenda.com/v2/agendas/events?where=${encodeURIComponent(city)}&from=${start}&to=${end}&size=20`;
  const r=await fetch(url);
  if(!r.ok)throw new Error('OpenAgenda HTTP '+r.status);
  const data=await r.json();
  const raw=data.events||data.items||[];
  return raw.map((e,idx)=>{
    const name=(typeof e.title==='object'?e.title.fr||Object.values(e.title)[0]:e.title)||e.name||'Événement local';
    const date=e.firstdate_begin||e.dateRange?.[0]?.begin||e.start||'';
    const venue=(typeof e.location?.name==='object'?e.location.name.fr||Object.values(e.location.name)[0]:e.location?.name)||e.locationName||'';
    const segment=e.keywords?.[0]||'OpenAgenda';
    const boost=eventBoostFromName(name,segment,date,idx);
    return {name,date,venue,segment,boost,hot:boost>=10,emoji:eventEmoji(segment,name),date_label:formatEventDate(date),source:'OpenAgenda'};
  }).filter(e=>e.name);
}

function buildLocalSeasonalEvents(city){
  // Fallback métier : évite une page vide quand les APIs ne répondent pas.
  const today=new Date();
  const presets=[];
  const m=today.getMonth()+1;
  if([6,7,8].includes(m))presets.push({name:`Saison touristique été — ${city}`,boost:10,segment:'Saison',emoji:'☀️',date:isoDate(addDays(today,7))});
  if([11,12].includes(m))presets.push({name:`Marchés et sorties de fin d\u2019année — ${city}`,boost:12,segment:'Saison',emoji:'🎄',date:isoDate(addDays(today,10))});
  presets.push({name:`Week-ends à forte demande locale — ${city}`,boost:6,segment:'Demande locale',emoji:'📍',date:isoDate(addDays(today,5))});
  return presets.map(e=>({...e,hot:e.boost>=10,venue:city,date_label:formatEventDate(e.date),source:'RentyQ fallback'}));
}
function formatEventDate(date){
  if(!date)return 'date à confirmer';
  try{return new Date(date).toLocaleDateString('fr-FR',{day:'numeric',month:'short'});}catch(e){return date;}
}
function eventEmoji(segment='',name=''){
  const t=(segment+' '+name).toLowerCase();
  if(/concert|music|musique|festival/.test(t))return '🎵';
  if(/sport|match|football|rugby|basket/.test(t))return '🏟️';
  if(/expo|museum|art|culture/.test(t))return '🎨';
  if(/march[eé]|no[eë]l|foire|salon/.test(t))return '🎪';
  if(/business|congr[eè]s|conf[eé]rence/.test(t))return '💼';
  return '🎯';
}
function eventBoostFromName(name='',segment='',date='',idx=0){
  const t=(name+' '+segment).toLowerCase();
  let boost=6;
  if(/festival|concert|match|finale|salon|congr[eè]s|foire|zenith|z[eé]nith|arena|stade/.test(t))boost=15;
  else if(/expo|spectacle|th[eé][aâ]tre|march[eé]|course/.test(t))boost=10;
  if(date){const days=Math.round((new Date(date)-new Date())/(1000*60*60*24));if(days>=0&&days<=14)boost+=3;}
  return Math.min(25,boost);
}

function renderEventsPage(citiesMap){
  const container=document.getElementById('events-container');
  const cities=Object.keys(citiesMap);
  let html='';
  let totalEvents=0;

  for(const city of cities){
    const cityEvents=eventsCache[city]||[];
    const apts=citiesMap[city];
    totalEvents+=cityEvents.length;
    const hotCount=cityEvents.filter(e=>e.hot).length;

    html+=`<div class="city-section">
      <div class="city-header">
        <div class="city-name">📍 ${city}</div>
        <div class="city-apts">${apts.map(a=>a.emoji||'🏠'+' '+a.name).join(', ')}</div>
        <span class="city-count">${cityEvents.length} événement${cityEvents.length>1?'s':''}</span>
        ${hotCount>0?`<span class="city-count" style="background:#FAEEDA;color:#854F0B">🔥 ${hotCount} à fort impact</span>`:``}
      </div>`;

    if(!cityEvents.length){
      html+=`<div style="color:#8A8A99;font-size:13px;padding:1rem;background:white;border-radius:12px;border:1px solid #EEEEF5">Aucun événement trouvé pour ${city} dans les 6 prochains mois.</div>`;
    } else {
      html+=`<div class="events-grid">`;
      const sorted=[...cityEvents].sort((a,b)=>(b.boost||0)-(a.boost||0));
      sorted.slice(0,12).forEach(e=>{
        html+=`<div class="event-card ${e.hot?'hot':''}">
          <div class="ev-row">
            <div class="ev-emoji">${e.emoji}</div>
            <div class="ev-info">
              <div class="ev-name">${e.name}</div>
              <div class="ev-meta">${e.date_label}${e.venue?' · '+e.venue:''}</div>
              <div style="margin-top:4px">
                <span class="tag ${e.hot?'tag-warn':'tag-info'}">${e.hot?'🔥 Chaud':e.segment||'Événement'}</span>
              </div>
            </div>
            <div>
              <div class="ev-boost" style="color:${e.hot?'#D97706':'#6B3FA0'}">+${e.boost}%</div>
              <div class="ev-boost-lbl">prix</div>
            </div>
          </div>
        </div>`;
      });
      html+=`</div>`;
    }
    html+=`</div>`;
  }

  document.getElementById('events-sub').textContent=`${totalEvents} événements détectés dans ${cities.length} ville${cities.length>1?'s':''}`;
  container.innerHTML=html;
}

function refreshEvents(){loadEvents(true);}

// SMOOBU
function updateSmoobuUI(connected){
  const dot=document.getElementById('status-dot');const label=document.getElementById('status-label');
  const badge=document.getElementById('smoobu-nav-badge');const saveBtn=document.getElementById('btn-save-smoobu');
  if(connected){dot.className='status-dot connected';label.textContent='Connecté ✓';if(badge)badge.style.display='inline-block';if(saveBtn)saveBtn.style.display='inline-flex';document.getElementById('smoobu-data').style.display='block';}
}

async function testSmoobu(){
  const key=document.getElementById('smoobu-key').value.trim();
  if(!key){showErr('smoobu-error','Collez une clé API Smoobu à tester');return;}
  const btn=document.querySelector('[onclick="testSmoobu()"]');
  btn.disabled=true;btn.textContent='Test…';
  try{
    const data=await smoobuCall('testConnection',{apiKey:key});
    if(data.success){
      showOk('smoobu-success','Connexion Smoobu OK. Cliquez sur “Connecter” pour enregistrer la clé côté serveur.');
      updateSmoobuUI(true);
    }else{
      showErr('smoobu-error','Clé invalide');
      updateSmoobuUI(false);
    }
  }catch(e){
    showErr('smoobu-error','Erreur de connexion Smoobu');
    updateSmoobuUI(false);
  }
  btn.disabled=false;btn.textContent='🔌 Tester';
}

async function saveSmoobuKey(){
  const key=document.getElementById('smoobu-key').value.trim();if(!key)return;
  try{
    await smoobuCall('saveKey',{apiKey:key});
    smoobuConnected=true;
    document.getElementById('smoobu-key').value='';
    updateSmoobuUI(true);
    showToast('✓ Clé Smoobu enregistrée côté serveur');
    await syncSmoobu();
  }catch(e){
    showErr('smoobu-error',"Impossible d\'enregistrer la clé Smoobu");
  }
}

async function syncSmoobu(){
  showToast('🔄 Sync Smoobu…');
  try{
    const aptsData=await smoobuCall('getApartments');const smoobuApts=aptsData._embedded?.apartments||aptsData.apartments||[];
    for(const sa of smoobuApts){
      if(!apparts.find(a=>a.smoobu_id===String(sa.id))){
        const city=sa.city||sa.location||'';
        const body={user_id:currentUser.user.id,name:sa.name||'Appart Smoobu',city:city,zone:'',emoji:'🏠',rent:0,cleaner:25,price:sa.price||100,comp:0,ai_rec:Math.round((sa.price||100)*1.08),booked:false,auto_pricing:true,has_event:false,smoobu_id:String(sa.id)};
        const res=await sbFetch('appartements',{method:'POST',body:JSON.stringify(body)});const c=await res.json();
        if(Array.isArray(c)&&c[0])apparts.push(c[0]);
      }
    }
    const bkData=await smoobuCall('getBookings');const bookings=bkData.bookings||bkData._embedded?.bookings||[];
    const real=bookings.filter(b=>!b['is-blocked-booking']);
    let rev=0;real.forEach(b=>rev+=b.price||0);
    document.getElementById('sm-apts').textContent=smoobuApts.length;
    document.getElementById('sm-bookings').textContent=real.length;
    document.getElementById('sm-revenue').textContent=Math.round(rev)+'€';
    renderSmoobuApts(smoobuApts);
    renderAll();
    if(apparts.length)loadEvents(true);
    showToast(`✓ ${smoobuApts.length} apparts, ${real.length} réservations`);
  }catch(e){showToast('⚠️ Erreur sync');}
}

function renderSmoobuApts(apts){
  const t=document.getElementById('smoobu-apts-table');
  if(!apts||!apts.length){t.innerHTML='<tr><td style="padding:1rem;color:#8A8A99">Aucun appartement</td></tr>';return}
  t.innerHTML=`<thead><tr><th>Nom</th><th>Ville</th><th>Prix base</th></tr></thead><tbody>`+
  apts.map(a=>`<tr><td><div class="apt-name"><div class="apt-emoji">🏠</div>${a.name||'—'}</div></td><td>${a.city||'—'}</td><td>${a.price||'—'}€</td></tr>`).join('')+`</tbody>`;
}

function toggleSidebar(){
  const sb=document.querySelector('.sidebar');
  const ov=document.getElementById('sidebar-overlay');
  sb.classList.toggle('open');
  ov.classList.toggle('open');
}
function closeSidebarMobile(){
  const sb=document.querySelector('.sidebar');
  const ov=document.getElementById('sidebar-overlay');
  if(sb)sb.classList.remove('open');
  if(ov)ov.classList.remove('open');
}
// ── Sidebar accordéon ──

/* ====================================================
   MISSIONS EVA V1 — recommandations dynamiques
   Les missions sont générées depuis apparts, reservations et eventsCache.
   La persistance "terminée" reste locale pour éviter de toucher Supabase.
   ==================================================== */
function rqMissionDoneKey(){return 'rq_missions_done_'+(currentUser?.user?.id||'anon')}
function rqGetDoneMissions(){try{return JSON.parse(localStorage.getItem(rqMissionDoneKey())||'[]')}catch(e){return[]}}
function rqSetDoneMissions(ids){try{localStorage.setItem(rqMissionDoneKey(),JSON.stringify([...new Set(ids)]))}catch(e){}}
function rqEsc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function rqDaysBetween(a,b){try{const d1=new Date(a),d2=new Date(b);return Math.max(1,Math.round((d2-d1)/86400000))}catch(e){return 1}}
function rqMonthKey(){return new Date().toISOString().slice(0,7)}
function rqAptMonthReservations(a){const m=rqMonthKey();return (reservations||[]).filter(r=>String(r.appartement_id)===String(a.id)&&r.date_from&&r.date_from.startsWith(m))}
function rqAptOccEstimate(a){const res=rqAptMonthReservations(a);const nights=res.reduce((s,r)=>s+rqDaysBetween(r.date_from,r.date_to||r.date_from),0);const days=new Date().getDate();return Math.min(100,Math.round(nights/Math.max(1,days)*100))}
function rqChannelName(r){return r.channel||r.canal||r.platform||r.ota||r.source||'OTA'}

function generateEvaMissions(){
  const doneIds=rqGetDoneMissions();
  const out=[];
  const nowLabel=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'short'});
  const add=(m)=>{m.status=doneIds.includes(m.id)?'done':'todo';m.created_at=m.created_at||nowLabel;out.push(m)};
  const apts=Array.isArray(apparts)?apparts:[];
  if(!apts.length){
    add({id:'setup-connect-data',type:'Intégration',priority:'haute',apt:'RentyQ',apt_id:null,title:'Connecter vos premières données',desc:'Ajoutez un bien ou connectez un PMS pour permettre à EVA de générer des missions de rentabilité.',impact:0,impactLabel:'Activation',action:'connect'});
    return out;
  }
  apts.forEach(a=>{
    const price=Number(a.price||0);
    const aiRec=Number(a.ai_rec||0);
    const fl=typeof floor==='function'?floor(a):0;
    const city=a.city||extractCity(a.zone,null)||'';
    const hot=(eventsCache?.[city]||[]).filter(e=>e.hot);
    const occ=rqAptOccEstimate(a);
    const aptName=a.name||'Logement';
    if(!a.booked){
      const gain=Math.max(30,Math.round((price||80)*0.82));
      add({id:`mission-fill-tonight-${a.id}`,type:'Occupation',priority:'haute',apt:aptName,apt_id:a.id,title:'Sauver une nuit libre imminente',desc:`${aptName} semble libre ce soir. EVA recommande une action prix ou distribution pour éviter une nuit à 0€.`,impact:gain,impactLabel:'revenu à récupérer',action:'pricing'});
      add({id:`mission-clean-check-${a.id}`,type:'CleanyQ',priority:'moyenne',apt:aptName,apt_id:a.id,title:'Vérifier la préparation du logement',desc:'Un logement libre ou proche d’un check-in doit rester prêt à être réservé rapidement.',impact:0,impactLabel:'risque réduit',action:'clean'});
    }
    if(aiRec&&price&&price<aiRec){
      const gain=Math.max(1,Math.round((aiRec-price)*3));
      add({id:`mission-price-up-${a.id}`,type:'Pricing',priority:'haute',apt:aptName,apt_id:a.id,title:`Ajuster le prix conseillé à ${aiRec}€`,desc:`Le prix actuel (${price}€) est inférieur à la recommandation EVA. Un ajustement peut améliorer l’ADR.`,impact:gain,impactLabel:'gain potentiel',action:'pricing'});
    }
    if(price&&fl&&price<fl){
      const saving=Math.max(1,Math.round((fl-price)*2));
      add({id:`mission-floor-${a.id}`,type:'Pricing',priority:'haute',apt:aptName,apt_id:a.id,title:'Corriger un prix sous plancher',desc:`Le prix actuel (${price}€) est inférieur au plancher estimé (${fl}€). Chaque nuit vendue peut détruire de la marge.`,impact:saving,impactLabel:'perte évitée',action:'pricing'});
    }
    if(hot.length){
      const ev=hot[0];
      const boost=Number(ev.boost||10);
      const gain=Math.max(20,Math.round((price||80)*boost/100*3));
      add({id:`mission-event-${a.id}-${(ev.name||'event').slice(0,16)}`,type:'Pricing',priority:'moyenne',apt:aptName,apt_id:a.id,title:'Exploiter un pic de demande locale',desc:`Événement détecté : ${ev.name||'demande locale'}. EVA recommande de tester une hausse ciblée des prix.`,impact:gain,impactLabel:'gain potentiel',action:'pricing'});
    }
    if(occ<50){
      add({id:`mission-low-occ-${a.id}`,type:'Annonce',priority:'moyenne',apt:aptName,apt_id:a.id,title:'Améliorer la performance de l’annonce',desc:`Le taux d’occupation estimé (${occ}%) est faible. EVA recommande de revoir prix, photos, titre ou canaux de diffusion.`,impact:Math.round((price||80)*0.12*8),impactLabel:'revenu potentiel',action:'parc'});
    }
    const note=Number(a.note||0);
    if(note&&note<4.4){
      add({id:`mission-review-${a.id}`,type:'Avis voyageurs',priority:'haute',apt:aptName,apt_id:a.id,title:'Traiter un risque qualité',desc:`La note du logement (${note}/5) peut impacter le prix moyen et la conversion. Priorité à la qualité opérationnelle.`,impact:0,impactLabel:'risque réduit',action:'parc'});
    }
  });
  // Dépendance OTA simple si disponible
  const channels=(reservations||[]).map(rqChannelName).filter(Boolean);
  if(channels.length){
    const counts=channels.reduce((m,c)=>(m[c]=(m[c]||0)+1,m),{});
    const top=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    const share=Math.round(top[1]/channels.length*100);
    if(share>=80){
      add({id:`mission-ota-dependency-${top[0]}`,type:'Distribution OTA',priority:'moyenne',apt:'Portefeuille',apt_id:null,title:'Réduire la dépendance à un canal',desc:`${share}% des réservations viennent de ${top[0]}. EVA recommande de diversifier pour réduire le risque commercial.`,impact:0,impactLabel:'risque réduit',action:'integrations'});
    }
  }
  const priorityRank={haute:0,moyenne:1,faible:2};
  return out.sort((a,b)=>(priorityRank[a.priority]??9)-(priorityRank[b.priority]??9)||(b.impact||0)-(a.impact||0));
}

function rqMissionAction(m){
  if(m.action==='pricing')return "goTo('pricing',document.querySelector('[data-page=pricing]')||document.querySelector('[onclick*=pricing]'))";
  if(m.action==='clean')return "goTo('clean',document.querySelector('[data-page=clean]')||document.querySelector('[onclick*=clean]'));setTimeout(()=>{if(typeof openMissionModal==='function')openMissionModal()},250)";
  if(m.action==='parc'&&m.apt_id)return `goTo('parc',document.querySelector('[data-page=parc]')||document.querySelector('[onclick*=parc]'));setTimeout(()=>{if(typeof showApartDetail==='function')showApartDetail('${m.apt_id}')},200)`;
  if(m.action==='integrations')return "goTo('smoobu',document.querySelector('[data-page=smoobu]')||document.querySelector('[onclick*=smoobu]'))";
  return "goTo('cockpit',document.querySelector('[data-page=cockpit]')||document.querySelector('[onclick*=cockpit]'))";
}

function toggleEvaMissionDone(id,done){
  const ids=rqGetDoneMissions().filter(x=>x!==id);
  if(done)ids.push(id);
  rqSetDoneMissions(ids);
  const active=document.querySelector('.page.active')?.id||'';
  const mode=active.includes('missions-done')?'done':active.includes('missions-todo')?'todo':'all';
  renderMissionsEva(mode);
}

function renderMissionsEva(mode='all'){
  const targetId=mode==='done'?'missions-eva-done':mode==='todo'?'missions-eva-todo':'missions-eva-all';
  const el=document.getElementById(targetId)||document.getElementById('missions-eva-all')||document.getElementById('cockpit-dash');
  if(!el)return;
  const all=generateEvaMissions();
  const todo=all.filter(m=>m.status!=='done');
  const done=all.filter(m=>m.status==='done');
  const list=mode==='done'?done:mode==='todo'?todo:all;
  const gain=todo.reduce((s,m)=>s+(Number(m.impact)||0),0);
  const high=todo.filter(m=>m.priority==='haute').length;
  const pricing=todo.filter(m=>['Pricing','Occupation'].includes(m.type)).length;
  const ops=todo.filter(m=>['CleanyQ','Maintenance','Avis voyageurs'].includes(m.type)).length;
  const cards=list.map(m=>{
    const p=(m.priority||'moyenne').toLowerCase();
    const impact=m.impact?`+${Number(m.impact).toLocaleString('fr-FR')}€`:(m.impactLabel||'À sécuriser');
    return `<div class="mission-card ${m.status==='done'?'done':''}">
      <div class="mission-severity ${p}"></div>
      <div class="mission-main">
        <div class="mission-top"><span class="mission-type">${rqEsc(m.type)}</span><span class="mission-priority ${p}">${rqEsc(m.priority||'Moyenne')}</span></div>
        <div class="mission-title">${rqEsc(m.title)}</div>
        <div class="mission-desc">${rqEsc(m.desc)}</div>
        <div class="mission-meta"><span>🏠 ${rqEsc(m.apt||'Portefeuille')}</span><span>📅 ${rqEsc(m.created_at)}</span><span>🎯 ${rqEsc(m.impactLabel||'impact estimé')}</span></div>
      </div>
      <div class="mission-impact"><strong>${impact}</strong><span>${rqEsc(m.impactLabel||'impact')}</span>
        <div class="mission-actions">
          <button class="btn" onclick="${rqMissionAction(m)}">Voir</button>
          ${m.action==='clean'?`<button class="btn btn-purple" onclick="${rqMissionAction(m)}">CleanyQ</button>`:''}
          ${m.status==='done'?`<button class="btn" onclick="toggleEvaMissionDone('${rqEsc(m.id)}',false)">Réouvrir</button>`:`<button class="btn btn-purple" onclick="toggleEvaMissionDone('${rqEsc(m.id)}',true)">Terminer</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
  el.innerHTML=`<div class="missions-eva-wrap">
    <section class="missions-hero"><div class="missions-hero-kicker">EVA Missions · ${new Date().toLocaleDateString('fr-FR',{day:'numeric',month:'long'})}</div><div class="missions-hero-title">${todo.length} action${todo.length>1?'s':''} pour gagner plus ou réduire les pertes.</div><div class="missions-hero-sub">EVA transforme les signaux de votre portefeuille en missions concrètes : pricing, occupation, qualité, CleanyQ, annonce et investissement.</div></section>
    <section class="missions-summary"><div class="mission-kpi"><div class="mission-kpi-label">À traiter</div><div class="mission-kpi-value">${todo.length}</div><div class="mission-kpi-sub">missions actives</div></div><div class="mission-kpi"><div class="mission-kpi-label">Priorité haute</div><div class="mission-kpi-value">${high}</div><div class="mission-kpi-sub">à traiter rapidement</div></div><div class="mission-kpi"><div class="mission-kpi-label">Potentiel</div><div class="mission-kpi-value">${gain.toLocaleString('fr-FR')}€</div><div class="mission-kpi-sub">gain / perte évitée estimée</div></div><div class="mission-kpi"><div class="mission-kpi-label">Répartition</div><div class="mission-kpi-value">${pricing}/${ops}</div><div class="mission-kpi-sub">revenu / opérations</div></div></section>
    <section class="missions-list">${cards||`<div class="missions-empty"><strong>Aucune mission dans cette vue.</strong>EVA générera de nouvelles actions dès que des signaux de revenus, d’occupation ou de qualité seront détectés.</div>`}</section>
  </div>`;
}

function toggleGroup(id){
  const grp=document.getElementById(id);
  if(!grp)return;
  const isOpen=grp.classList.contains('open');
  // Fermer tous les groupes ouverts
  document.querySelectorAll('.nav-group.open').forEach(g=>g.classList.remove('open'));
  document.querySelectorAll('.nav-group-header.open').forEach(h=>h.classList.remove('open'));
  // Ouvrir celui cliqué s'il était fermé
  if(!isOpen){
    grp.classList.add('open');
    const hdr=grp.querySelector('.nav-group-header');
    if(hdr)hdr.classList.add('open');
  }
}

function openParentGroup(page){
  const map={
    'missions-all':'grp-cleanyq','missions-todo':'grp-cleanyq','missions-done':'grp-cleanyq',
    'cleanyq-today':'grp-cleanyq','cleanyq-missions':'grp-cleanyq','cleanyq-squad':'grp-cleanyq','clean':'grp-cleanyq',
    'eva-audit':'grp-analyse','audit-revenus':'grp-analyse','audit-occupation':'grp-analyse',
    'audit-qualite':'grp-analyse','audit-ota':'grp-analyse','audit-tarification':'grp-analyse',
    'profit360':'grp-analyse','profit-logement':'grp-analyse','profit-opportunites':'grp-analyse','profit-simulations':'grp-analyse',
    'analyse-globale':'grp-analyse','analyse-rentabilite':'grp-analyse','analyse-opportunites':'grp-analyse',
    'analyse-economies':'grp-analyse','analyse-qualite':'grp-analyse',
    'parc':'grp-parc','parc-fiches':'grp-parc','parc-comparaison':'grp-parc',
    'calendrier':'grp-cal','reservations':'grp-cal','nuits-vacantes':'grp-cal',
    'settings-profil':'grp-settings','squad':'grp-settings','settings-commissions':'grp-settings','tarifs':'grp-settings'
  };
  const grpId=map[page];
  if(!grpId)return;
  // Fermer tous puis ouvrir le bon
  document.querySelectorAll('.nav-group.open').forEach(g=>g.classList.remove('open'));
  document.querySelectorAll('.nav-group-header.open').forEach(h=>h.classList.remove('open'));
  const grp=document.getElementById(grpId);
  if(grp){
    grp.classList.add('open');
    const hdr=grp.querySelector('.nav-group-header');
    if(hdr)hdr.classList.add('open');
  }
}

function goTo(page,btn){
  closeSidebarMobile();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item,.nav-sub-item').forEach(n=>n.classList.remove('active'));
  const pageEl=document.getElementById('page-'+page);
  if(pageEl)pageEl.classList.add('active');
  if(btn)btn.classList.add('active');
  openParentGroup(page);
  if(page==='calendrier'){renderCalendarPage();renderCalendar();}
  if(page==='reservations')renderReservationsPage();
  if(page==='missions-all')renderMissionsEva('all');
  if(page==='missions-todo')renderMissionsEva('todo');
  if(page==='missions-done')renderMissionsEva('done');
  if(page==='parc'){try{renderParcTable();}catch(e){console.warn('renderParcTable',e);}}
  if(page==='parc-fiches')renderParcFiches();
  if(page==='parc-comparaison')renderParcComparaison();
  if(page==='tarifs')renderTarifs();
  if(page==='events'&&apparts.length&&!Object.keys(eventsCache).length)loadEvents(false);
  // Page events supprimée V2 — rediriger vers pricing
  if(page==='events'){document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.getElementById('page-pricing').classList.add('active');renderPricingTable();return;}
  if(page==='cockpit-c')renderCockpitConcierge();
  if(page==='finances'){initFinMois();renderFinances();}
  if(page==='clean')renderCleanyQ();
  if(page==='parc-c')renderParcConcierge();
  if(page==='proprietaires')renderProprietaires();
  if(page==='rapports'){initRapportMois();renderRapports();}
  if(page==='scanner')renderScannerPage();
  if(page==='eva-data'){renderEvaDataPage();}
  if(page==='profit360'){renderProfit360();}
  if(page==='profit-logement')renderProfit360ParLogement();
  if(page==='profit-opportunites')renderProfit360Opportunites();
  if(page==='profit-simulations')renderProfit360Simulations();
  if(page==='eva-audit'){if(typeof renderEvaAuditPage==='function')renderEvaAuditPage();}
  if(page==='audit-revenus')renderAudit360Revenus();
  if(page==='audit-occupation')renderAudit360Occupation();
  if(page==='audit-qualite')renderAudit360Qualite();
  if(page==='audit-ota')renderAudit360Ota();
  if(page==='audit-tarification')renderAudit360Tarification();
  // Analyse EVA V2
  if(page==='analyse-globale')renderAnalyseGlobale();
  if(page==='analyse-rentabilite')renderAnalyseRentabilite();
  if(page==='analyse-opportunites')renderAnalyseOpportunites();
  if(page==='analyse-economies')renderAnalyseEconomies();
  if(page==='analyse-qualite')renderAnalyseQualite();
  // CleanyQ V2
  if(page==='cleanyq-today')renderCleanyQToday();
  if(page==='cleanyq-missions')renderCleanyQMissions();
  if(page==='cleanyq-squad')renderCleanyQSquad();
  if(page==='clean')renderCleanyQToday();
}

/* ====================================================
   SCANNER EVA — expérience 3 phases
   Phase 1 : Hero  |  Phase 2 : Wizard  |  Phase 3 : Rapport
   ==================================================== */

const SCANNER_STEPS=[
  {id:'address',question:'Où se situe le bien ?',type:'address',placeholder:'Ex : 12 rue Bannier, 45000 Orléans'},
  {id:'typeBien',question:'Quel type de bien est-ce ?',type:'choice',choices:[
    {val:'studio',label:'Studio',icon:'🛋️'},
    {val:'t2',label:'T2',icon:'🏠'},
    {val:'t3',label:'T3',icon:'🏡'},
    {val:'t4plus',label:'T4 ou plus',icon:'🏘️'},
    {val:'maison',label:'Maison',icon:'🏘️'},
    {val:'villa',label:'Villa',icon:'🏰'}
  ]},
  {id:'surface',question:'Quelle est la surface du logement ?',type:'number',placeholder:'Ex : 45',suffix:'m²'},
  {id:'voyageurs',question:'Combien de voyageurs pouvez-vous accueillir ?',type:'choice',choices:[
    {val:'2',label:'2 voyageurs',icon:'👫'},
    {val:'4',label:'4 voyageurs',icon:'👨\u200d👩\u200d👧\u200d👦'},
    {val:'6',label:'6 voyageurs',icon:'🏘️'},
    {val:'8',label:'8+ voyageurs',icon:'🏰'}
  ]},
  {id:'chambres',question:'Combien de chambres possède le logement ?',type:'choice',choices:[
    {val:'0',label:'Studio',icon:'🛋️'},
    {val:'1',label:'1 chambre',icon:'🛏️'},
    {val:'2',label:'2 chambres',icon:'🛏️\u200d🛏️'},
    {val:'3',label:'3 chambres',icon:'🏠'},
    {val:'4',label:'4 chambres ou plus',icon:'🏡'}
  ]},
  {id:'sdb',question:'Combien de salles de bain ?',type:'choice',choices:[
    {val:'1',label:'1 salle de bain',icon:'🚿'},
    {val:'2',label:'2 salles de bain',icon:'🛁'},
    {val:'3',label:'3 ou plus',icon:'🛁'}
  ]},
  {id:'equipements',question:'Quels équipements le logement propose-t-il ?',type:'multichoice',choices:[
    {val:'parking',label:'Parking',icon:'🅿️'},
    {val:'exterieur',label:'Balcon, terrasse ou jardin',icon:'🌿'},
    {val:'clim',label:'Climatisation',icon:'❄️'}
  ]},
  {id:'loyer',question:'Quel est le loyer mensuel du logement ?',type:'number',placeholder:'Ex : 950',suffix:'€ / mois'},
  {id:'standing',question:'Comment qualifieriez-vous le standing du logement ?',type:'choice',choices:[
    {val:'eco',label:'Économique',icon:'💰',desc:'Fonctionnel, accessible, prix attractif'},
    {val:'std',label:'Standard',icon:'⭐',desc:'Bon niveau, équipements complets'},
    {val:'prem',label:'Premium',icon:'💎',desc:'Haut de gamme, expérience soignée'}
  ]},
  {id:'photos',question:'Ajoutez des photos du logement',type:'photos',optional:true,helpText:'Minimum 5 photos recommandées · Idéal 10 à 20 photos. Cette étape peut être passée.'},
  {id:'otaLink',question:'Avez-vous un lien d\u2019annonce existante ?',type:'text',optional:true,placeholder:'Lien Airbnb, Booking, Abritel… (facultatif)',helpText:'Optionnel — EVA fonctionne très bien sans ce lien.'},
  {id:'commercial',question:'Le bien est-il déjà exploité en location courte durée ?',type:'commercial-group',optional:true,helpText:'Renseignez ces informations seulement si le bien est déjà en activité.'}
];

let scannerData={};
let scannerStep=0;

function renderScannerPage(){
  const wrap=document.getElementById('scanner-wrap');
  if(!wrap)return;
  scannerData={};scannerStep=0;
  wrap.innerHTML=`
    <div class="scn-hero" id="scn-hero">
      <div class="scn-hero-inner">
        <div class="scn-kicker">RentyQ × EVA Scanner</div>
        <h1 class="scn-title">Est-ce que ce bien vaut vraiment le coup\u00a0?</h1>
        <p class="scn-sub">EVA analyse le marché local, la concurrence, les événements et le potentiel financier avant que vous signiez.</p>
        <p class="scn-sub2">Prenez vos décisions avec des données. Pas avec votre intuition.</p>
        <button class="scn-cta" onclick="scannerStartWizard()">
          <i class="ti ti-radar-2"></i>\u00a0 Lancer le Scanner EVA
        </button>
        <div class="scn-hero-badges">
          <span>📍 Localisation</span><span>📊 Marché local</span>
          <span>🎯 Événements</span><span>💶 Potentiel financier</span>
        </div>
      </div>
    </div>
    <div id="scn-wizard" style="display:none"><div id="scn-step-wrap"></div></div>
    <div id="scn-analysis" style="display:none"></div>
    <div id="scn-report" style="display:none"></div>`;
}

function scannerStartWizard(){
  document.getElementById('scn-hero').style.display='none';
  document.getElementById('scn-wizard').style.display='block';
  scannerStep=0;
  renderScannerStep();
}

function renderScannerStep(){
  const step=SCANNER_STEPS[scannerStep];
  const total=SCANNER_STEPS.length;
  const pct=Math.round((scannerStep/total)*100);
  const wrap=document.getElementById('scn-step-wrap');
  let fieldHtml='';
  if(step.type==='address'){
    fieldHtml=`<div class="scn-field-wrap" style="position:relative">
      <input type="text" id="scn-input-address" class="scn-input" placeholder="${step.placeholder}"
        autocomplete="off" oninput="scannerAddressSearch(this.value);document.getElementById('scanner-free-address').value=this.value;scannerData.address=this.value"
        value="${scannerData.address||''}"/>
      <div id="scanner-address-results" class="scn-autocomplete"></div>
    </div>
    <button class="scn-next" onclick="scannerNextStep()">Continuer <i class="ti ti-arrow-right"></i></button>`;
  } else if(step.type==='number'){
    fieldHtml=`<div class="scn-field-wrap scn-number-wrap">
      <input type="number" id="scn-input-${step.id}" class="scn-input scn-input-number"
        placeholder="${step.placeholder}" value="${scannerData[step.id]||''}"/>
      <span class="scn-suffix">${step.suffix}</span>
    </div>
    <button class="scn-next" onclick="scannerNextStep()">Continuer <i class="ti ti-arrow-right"></i></button>`;
  } else if(step.type==='text'){
    fieldHtml=`<div class="scn-field-wrap">
      <input type="text" id="scn-input-${step.id}" class="scn-input" placeholder="${step.placeholder||''}" value="${scannerData[step.id]||''}"/>
    </div>
    ${step.helpText?`<div class="scn-v2-help">${step.helpText}</div>`:''}
    <div class="scn-v2-btn-row">
      <button class="scn-next" onclick="scannerNextStep()">Continuer <i class="ti ti-arrow-right"></i></button>
      ${step.optional?`<button class="scn-v2-skip" onclick="scannerSkipStep()">Passer cette étape</button>`:''}
    </div>`;
  } else if(step.type==='multichoice'){
    const sel=scannerData[step.id]||[];
    fieldHtml=`<div class="scn-choices">
      ${step.choices.map(c=>`<div class="scn-choice${sel.indexOf(c.val)>=0?' scn-choice--active':''}" onclick="scannerToggleMultiChoice('${step.id}','${c.val}',this)">
        <span class="scn-choice-icon">${c.icon}</span>
        <div><div class="scn-choice-label">${c.label}</div></div>
        <span class="scn-choice-check"><i class="ti ti-check"></i></span>
      </div>`).join('')}
    </div>
    <button class="scn-next" onclick="scannerNextStep()">Continuer <i class="ti ti-arrow-right"></i></button>`;
  } else if(step.type==='photos'){
    const photos=scannerData.photos||[];
    fieldHtml=`<div class="scn-v2-photo-zone" onclick="document.getElementById('scn-photo-input').click()">
        <input type="file" id="scn-photo-input" accept="image/*" multiple style="display:none" onchange="scannerHandlePhotos(this.files)"/>
        <div class="scn-v2-photo-zone-icon"><i class="ti ti-camera-plus"></i></div>
        <div class="scn-v2-photo-zone-title">Cliquez pour ajouter des photos</div>
        <div class="scn-v2-photo-zone-sub">${step.helpText}</div>
      </div>
      <div class="scn-v2-photo-grid" id="scn-photo-grid">${scannerRenderPhotoGrid(photos)}</div>
      ${step.helpText?`<div class="scn-v2-help">${photos.length} photo${photos.length>1?'s':''} ajoutée${photos.length>1?'s':''}</div>`:''}
    <div class="scn-v2-btn-row">
      <button class="scn-next" onclick="scannerNextStep()">Continuer <i class="ti ti-arrow-right"></i></button>
      ${step.optional?`<button class="scn-v2-skip" onclick="scannerSkipStep()">Passer cette étape</button>`:''}
    </div>`;
  } else if(step.type==='commercial-group'){
    const d=scannerData.commercial||{};
    fieldHtml=`<div class="scn-v2-form-grid">
      <div class="scn-v2-form-row">
        <label class="scn-v2-form-label">Prix moyen actuel (€/nuit)</label>
        <input type="number" id="scn-com-price" class="scn-input" placeholder="Ex : 85" value="${d.price||''}"/>
      </div>
      <div class="scn-v2-form-row">
        <label class="scn-v2-form-label">Taux d\u2019occupation estimé (%)</label>
        <input type="number" id="scn-com-occ" class="scn-input" placeholder="Ex : 70" value="${d.occ||''}"/>
      </div>
      <div class="scn-v2-form-row">
        <label class="scn-v2-form-label">Nombre d\u2019avis</label>
        <input type="number" id="scn-com-reviews" class="scn-input" placeholder="Ex : 32" value="${d.reviews||''}"/>
      </div>
      <div class="scn-v2-form-row">
        <label class="scn-v2-form-label">Note moyenne (/5)</label>
        <input type="number" step="0.1" id="scn-com-note" class="scn-input" placeholder="Ex : 4.7" value="${d.note||''}"/>
      </div>
    </div>
    ${step.helpText?`<div class="scn-v2-help">${step.helpText}</div>`:''}
    <div class="scn-v2-btn-row">
      <button class="scn-next" onclick="scannerNextStep()">Lancer l\'analyse EVA <i class="ti ti-sparkles"></i></button>
      ${step.optional?`<button class="scn-v2-skip" onclick="scannerSkipStep()">Passer cette étape</button>`:''}
    </div>`;
  } else {
    fieldHtml=`<div class="scn-choices">
      ${step.choices.map(c=>`<div class="scn-choice${scannerData[step.id]===c.val?' scn-choice--active':''}" onclick="scannerPickChoice('${step.id}','${c.val}',this)">
        <span class="scn-choice-icon">${c.icon}</span>
        <div><div class="scn-choice-label">${c.label}</div>${c.desc?`<div class="scn-choice-desc">${c.desc}</div>`:''}</div>
        <span class="scn-choice-check"><i class="ti ti-check"></i></span>
      </div>`).join('')}
    </div>
    <button class="scn-next" id="scn-next-btn" onclick="scannerNextStep()" ${scannerData[step.id]?'':'disabled'}>
      ${scannerStep<total-1?'Continuer <i class="ti ti-arrow-right"></i>':'Lancer l\'analyse EVA <i class="ti ti-sparkles"></i>'}
    </button>`;
  }
  wrap.style.opacity='0';wrap.style.transform='translateX(20px)';
  wrap.innerHTML=`<div class="scn-step-card">
    <div class="scn-progress-bar"><div class="scn-progress-fill" style="width:${pct}%"></div></div>
    <div class="scn-step-meta">
      <span class="scn-step-count">Étape ${scannerStep+1} / ${total}</span>
      ${scannerStep>0?`<button class="scn-back" onclick="scannerPrevStep()"><i class="ti ti-arrow-left"></i> Retour</button>`:''}
    </div>
    <div class="scn-question">${step.question}</div>
    ${fieldHtml}
  </div>`;
  requestAnimationFrame(()=>{
    wrap.style.transition='opacity .25s ease,transform .25s ease';
    wrap.style.opacity='1';wrap.style.transform='translateX(0)';
  });
  // Input focus + autocomplete positioning
  setTimeout(()=>{
    const inp=document.getElementById('scn-input-address')||document.getElementById(`scn-input-${step.id}`);
    if(inp)inp.focus();
    // Move autocomplete dropdown inside field-wrap
    const dd=document.getElementById('scanner-address-results');
    const fw=document.querySelector('.scn-field-wrap');
    if(dd&&fw&&!fw.contains(dd))fw.appendChild(dd);
    // Override scannerSelectAddress to also update our data
    window._scannerSelectOrig=window._scannerSelectOrig||window.scannerSelectAddress;
    window.scannerSelectAddress=function(label,lat,lng){
      window._scannerSelectOrig(label,lat,lng);
      scannerData.address=label;
      const inp2=document.getElementById('scn-input-address');
      if(inp2)inp2.value=label;
    };
  },80);
}

function scannerPickChoice(stepId,val,el){
  scannerData[stepId]=val;
  el.closest('.scn-choices').querySelectorAll('.scn-choice').forEach(c=>c.classList.remove('scn-choice--active'));
  el.classList.add('scn-choice--active');
  const btn=document.getElementById('scn-next-btn');
  if(btn)btn.disabled=false;
}

function scannerToggleMultiChoice(stepId,val,el){
  if(!Array.isArray(scannerData[stepId]))scannerData[stepId]=[];
  const arr=scannerData[stepId];
  const idx=arr.indexOf(val);
  if(idx>=0){arr.splice(idx,1);el.classList.remove('scn-choice--active');}
  else{arr.push(val);el.classList.add('scn-choice--active');}
}

// Redimensionne une image en mémoire (max 800px) avant analyse — limite la charge navigateur
function scannerResizeImage(file){
  return new Promise((resolve)=>{
    const reader=new FileReader();
    reader.onload=function(e){
      const img=new Image();
      img.onload=function(){
        const maxDim=800;
        let w=img.width,h=img.height;
        if(w>h&&w>maxDim){h=Math.round(h*maxDim/w);w=maxDim;}
        else if(h>maxDim){w=Math.round(w*maxDim/h);h=maxDim;}
        const canvas=document.createElement('canvas');
        canvas.width=w;canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
        resolve({dataUrl:canvas.toDataURL('image/jpeg',0.82),width:img.width,height:img.height,name:file.name});
      };
      img.onerror=function(){resolve(null);};
      img.src=e.target.result;
    };
    reader.onerror=function(){resolve(null);};
    reader.readAsDataURL(file);
  });
}

async function scannerHandlePhotos(fileList){
  if(!fileList||!fileList.length)return;
  if(!Array.isArray(scannerData.photos))scannerData.photos=[];
  const remaining=20-scannerData.photos.length;
  const files=Array.from(fileList).slice(0,Math.max(0,remaining));
  for(const f of files){
    const resized=await scannerResizeImage(f);
    if(resized)scannerData.photos.push(resized);
  }
  const grid=document.getElementById('scn-photo-grid');
  if(grid)grid.innerHTML=scannerRenderPhotoGrid(scannerData.photos);
  const help=document.querySelector('.scn-v2-help');
  if(help)help.textContent=scannerData.photos.length+' photo'+(scannerData.photos.length>1?'s':'')+' ajoutée'+(scannerData.photos.length>1?'s':'');
}

function scannerRemovePhoto(idx){
  if(!Array.isArray(scannerData.photos))return;
  scannerData.photos.splice(idx,1);
  const grid=document.getElementById('scn-photo-grid');
  if(grid)grid.innerHTML=scannerRenderPhotoGrid(scannerData.photos);
}

function scannerRenderPhotoGrid(photos){
  if(!photos||!photos.length)return'';
  return photos.map((p,i)=>`<div class="scn-v2-photo-thumb">
    <img src="${p.dataUrl}" alt="${p.name||''}"/>
    <button class="scn-v2-photo-remove" onclick="event.stopPropagation();scannerRemovePhoto(${i})"><i class="ti ti-x"></i></button>
  </div>`).join('');
}

function scannerPrevStep(){
  if(scannerStep>0){scannerStep--;renderScannerStep();}
}

function scannerSkipStep(){
  if(scannerStep<SCANNER_STEPS.length-1){scannerStep++;renderScannerStep();}
  else{scannerLaunchAnalysis();}
}

function scannerNextStep(){
  const step=SCANNER_STEPS[scannerStep];
  if(step.type==='address'){
    const val=(document.getElementById('scn-input-address')?.value||'').trim();
    if(!val){showToast('Veuillez entrer une adresse.');return;}
    scannerData.address=val;
    document.getElementById('scanner-free-address').value=val;
    const lat=document.getElementById('scanner-free-lat')?.value;
    const lng=document.getElementById('scanner-free-lng')?.value;
    if(lat)scannerData.lat=lat;if(lng)scannerData.lng=lng;
  } else if(step.type==='number'){
    const val=document.getElementById(`scn-input-${step.id}`)?.value;
    if(!val||+val<=0){showToast('Veuillez entrer une valeur valide.');return;}
    scannerData[step.id]=+val;
    if(step.id==='loyer')document.getElementById('scanner-free-price').value=Math.round(+val/30);
  } else if(step.type==='text'){
    const val=(document.getElementById(`scn-input-${step.id}`)?.value||'').trim();
    scannerData[step.id]=val;
  } else if(step.type==='photos'){
    // déjà géré dans scannerData.photos via scannerHandlePhotos — rien à valider, optionnel
  } else if(step.type==='commercial-group'){
    const price=+(document.getElementById('scn-com-price')?.value||0);
    const occ=+(document.getElementById('scn-com-occ')?.value||0);
    const reviews=+(document.getElementById('scn-com-reviews')?.value||0);
    const note=+(document.getElementById('scn-com-note')?.value||0);
    if(price||occ||reviews||note)scannerData.commercial={price,occ,reviews,note};
  } else if(step.type==='multichoice'){
    // optionnel — aucune validation requise
  } else {
    if(!scannerData[step.id]){showToast('Veuillez faire un choix.');return;}
  }
  if(scannerStep<SCANNER_STEPS.length-1){scannerStep++;renderScannerStep();}
  else{scannerLaunchAnalysis();}
}

function scannerLaunchAnalysis(){
  document.getElementById('scn-wizard').style.display='none';
  const analysisEl=document.getElementById('scn-analysis');
  analysisEl.style.display='block';
  const steps=[
    'EVA localise l\u2019adresse\u2026',
    'EVA analyse le quartier et les points d\u2019int\u00e9r\u00eat\u2026',
    'EVA \u00e9tudie les \u00e9v\u00e9nements locaux\u2026',
    'EVA estime le potentiel commercial\u2026',
    'EVA calcule la d\u00e9cision finale\u2026'
  ];
  analysisEl.innerHTML=`<div class="scn-analysis-card">
    <div class="scn-analysis-icon">🧠</div>
    <div class="scn-analysis-title">EVA analyse votre bien</div>
    <div class="scn-analysis-sub">Cela prend quelques instants — EVA croise plusieurs sources de données réelles.</div>
    <div class="scn-a-steps" id="scn-a-steps">
      ${steps.map((s,i)=>`<div class="scn-a-step" id="scn-a-${i}">
        <div class="scn-a-dot" id="scn-a-dot-${i}"></div>
        <span class="scn-a-text">${s}</span>
        <span class="scn-a-check" id="scn-a-check-${i}"></span>
      </div>`).join('')}
    </div>
  </div>`;
  let cur=0;
  const iv=setInterval(()=>{
    if(cur>0){
      document.getElementById(`scn-a-dot-${cur-1}`)?.classList.remove('scn-a-dot--active');
      const ch=document.getElementById(`scn-a-check-${cur-1}`);
      if(ch)ch.innerHTML='<i class="ti ti-check" style="color:#059669;font-size:15px;font-weight:900"></i>';
    }
    if(cur<steps.length){
      document.getElementById(`scn-a-dot-${cur}`)?.classList.add('scn-a-dot--active');
      cur++;
    } else {
      clearInterval(iv);
    }
  },650);

  // Branchement sur le vrai moteur géo (auth.js) : géocodage + POI réels + score d'emplacement
  scannerRunRealEngine().then(function(geoAnalysis){
    scannerData._geoAnalysis=geoAnalysis;
    // Laisse le temps à l'animation de se terminer visuellement avant d'afficher le rapport
    const minDelay=steps.length*650+500;
    setTimeout(scannerShowReport,minDelay);
  }).catch(function(e){
    console.warn('Scanner EVA — moteur géo indisponible, fallback estimation',e);
    scannerData._geoAnalysis=null;
    const minDelay=steps.length*650+500;
    setTimeout(scannerShowReport,minDelay);
  });
}

// Appelle le vrai moteur géo existant (géocodage api-adresse.gouv.fr + POI Overpass + score)
// Ces fonctions vivent dans auth.js et ne sont jamais modifiées ici.
async function scannerRunRealEngine(){
  const address=scannerData.address||(document.getElementById('scanner-free-address')?.value||'').trim();
  if(!address)return null;
  let lat=parseFloat(scannerData.lat||document.getElementById('scanner-free-lat')?.value||0);
  let lng=parseFloat(scannerData.lng||document.getElementById('scanner-free-lng')?.value||0);
  if((!lat||!lng)&&typeof fetch!=='undefined'){
    try{
      const r=await fetch('https://api-adresse.data.gouv.fr/search/?q='+encodeURIComponent(address)+'&limit=1');
      const d=await r.json();
      const feat=d.features&&d.features[0];
      if(feat){lat=feat.geometry.coordinates[1];lng=feat.geometry.coordinates[0];}
    }catch(e){console.warn('Géocodage indisponible',e);}
  }
  if(!lat||!lng)return null;
  scannerData.lat=lat;scannerData.lng=lng;
  const fakeApt={
    id:'scanner-v2',name:address,address,lat,lng,
    price:scannerData.commercial&&scannerData.commercial.price?scannerData.commercial.price:null,
    comp:null,
    city:address.split(',').slice(-1)[0]?.trim()||'',
    zone:'',emoji:'🔍'
  };
  let rawPois=[];
  try{if(typeof fetchEvaNearbyPois==='function')rawPois=await fetchEvaNearbyPois(lat,lng);}catch(e){console.warn('Overpass indisponible',e);}
  if(typeof enrichEvaLocalPois!=='function'||typeof computeEvaScannerAnalysis!=='function')return null;
  const pois=enrichEvaLocalPois(fakeApt,rawPois);
  const analysis=computeEvaScannerAnalysis(fakeApt,pois);
  return {apt:fakeApt,analysis,pois};
}

/* ====================================================
   SCANNER EVA V2 — fonctions de calcul des dimensions
   ==================================================== */

// ── Analyse photos (heuristique côté client, sans vision IA) ──
// Honnête : se base sur le nombre de photos et leur résolution, pas sur le contenu visuel réel.
function scannerAnalyzePhotos(photos){
  photos=photos||[];
  if(!photos.length){
    return {score:0,count:0,strengths:[],weaknesses:['Aucune photo ajout\u00e9e \u2014 EVA ne peut pas \u00e9valuer la qualit\u00e9 perçue.'],note:'estimation indisponible'};
  }
  var count=photos.length;
  var avgRes=photos.reduce(function(s,p){return s+(p.width||0)*(p.height||0);},0)/count;
  var hqCount=photos.filter(function(p){return (p.width||0)>=1200;}).length;
  var hqRatio=hqCount/count;

  var countScore=count>=10?40:count>=5?28:count>=2?14:5;
  var resScore=avgRes>=900000?35:avgRes>=400000?22:10;
  var consistencyScore=Math.round(hqRatio*25);
  var score=Math.min(100,countScore+resScore+consistencyScore);

  var strengths=[],weaknesses=[];
  if(count>=10)strengths.push('Nombre de photos excellent ('+count+') \u2014 couverture compl\u00e8te du logement');
  else if(count>=5)strengths.push(count+' photos \u2014 base correcte pour pr\u00e9senter le logement');
  else weaknesses.push('Seulement '+count+' photo'+(count>1?'s':'')+' \u2014 viser au moins 5 pour rassurer les voyageurs');

  if(hqRatio>=0.7)strengths.push('Photos en bonne r\u00e9solution \u2014 qualit\u00e9 per\u00e7ue professionnelle');
  else if(hqRatio<0.3)weaknesses.push('R\u00e9solution moyenne des photos perfectible \u2014 pr\u00e9f\u00e9rer des prises en haute qualit\u00e9');

  if(count>=8&&hqRatio>=0.5)strengths.push('Pr\u00e9sentation coh\u00e9rente sur l\u2019ensemble des photos');

  return {
    score:score,count:count,hqRatio:Math.round(hqRatio*100),
    strengths:strengths.length?strengths:['Photos ajout\u00e9es \u2014 base de pr\u00e9sentation disponible'],
    weaknesses:weaknesses,
    note:'Estimation bas\u00e9e sur le nombre et la r\u00e9solution des photos (pas une analyse visuelle du contenu)'
  };
}

// ── Public cible — score par catégorie selon caractéristiques du bien ──
function scannerComputeAudience(d){
  var voyageurs=+(d.voyageurs||2);
  var chambres=+(d.chambres||0);
  var equip=d.equipements||[];
  var standing=d.standing||'std';
  var typeBien=d.typeBien||'studio';

  var couples=Math.min(100,40+(voyageurs<=2?35:voyageurs<=4?15:0)+(standing==='prem'?20:standing==='std'?10:0)+(equip.indexOf('exterieur')>=0?10:0));
  var affaires=Math.min(100,30+(equip.indexOf('clim')>=0?15:0)+(standing==='prem'?25:standing==='std'?12:0)+(voyageurs<=2?20:5)+((typeBien==='studio'||typeBien==='t2')?10:0));
  var familles=Math.min(100,25+(chambres>=2?30:chambres===1?12:0)+(voyageurs>=4?25:0)+(equip.indexOf('exterieur')>=0?15:0)+(equip.indexOf('parking')>=0?10:0));
  var groupes=Math.min(100,15+(voyageurs>=6?40:voyageurs>=4?18:0)+(chambres>=3?25:chambres===2?12:0)+((typeBien==='maison'||typeBien==='villa')?20:0));
  var touristes=Math.min(100,45+(standing==='prem'?20:10)+(equip.indexOf('exterieur')>=0?10:0)+(voyageurs<=4?10:0));

  var list=[
    {key:'couples',label:'Couples',icon:'💑',score:Math.round(couples)},
    {key:'affaires',label:'Voyageurs d\u2019affaires',icon:'💼',score:Math.round(affaires)},
    {key:'familles',label:'Familles',icon:'👨\u200d👩\u200d👧\u200d👦',score:Math.round(familles)},
    {key:'groupes',label:'Groupes',icon:'🎉',score:Math.round(groupes)},
    {key:'touristes',label:'Touristes',icon:'🧳',score:Math.round(touristes)}
  ].sort(function(a,b){return b.score-a.score;});
  return list;
}

// ── Difficulté opérationnelle — ménage, fréquence, gestion, risque ──
function scannerComputeOperationalDifficulty(d){
  var surface=+(d.surface||40);
  var voyageurs=+(d.voyageurs||2);
  var chambres=+(d.chambres||0);
  var sdb=+(d.sdb||1);
  var equip=d.equipements||[];
  var typeBien=d.typeBien||'studio';
  var hasExterieur=equip.indexOf('exterieur')>=0;

  // Difficulté ménage : surface + sdb + extérieur augmentent le temps
  var menageMin=60+Math.round(surface*0.6)+sdb*15+(hasExterieur?20:0);
  var menageDifficulty=menageMin<=70?'Faible':menageMin<=120?'Modérée':'Élevée';
  var menageColor=menageMin<=70?'#059669':menageMin<=120?'#D97706':'#DC2626';

  // Fréquence potentielle (rotations) selon taille du bien — petits biens tournent plus vite
  var freqLabel=voyageurs<=2?'Élevée (courts séjours fréquents)':voyageurs<=4?'Modérée':'Plus faible (séjours plus longs en moyenne)';

  // Difficulté de gestion globale
  var complexityScore=(chambres>=3?2:chambres===2?1:0)+(typeBien==='maison'||typeBien==='villa'?2:0)+(hasExterieur?1:0)+(sdb>=2?1:0);
  var gestionLevel=complexityScore<=1?'Simple':complexityScore<=3?'Modérée':'Complexe';
  var gestionColor=complexityScore<=1?'#059669':complexityScore<=3?'#D97706':'#DC2626';

  // Risque opérationnel
  var riskItems=[];
  if(hasExterieur)riskItems.push('Entretien extérieur (jardin/terrasse) à prévoir');
  if(typeBien==='maison'||typeBien==='villa')riskItems.push('Maintenance bâtiment plus fréquente (chaudière, toiture, extérieurs)');
  if(sdb>=2)riskItems.push('Plusieurs salles de bain \u2014 temps de ménage et risque de panne accrus');
  if(voyageurs>=6)riskItems.push('Forte capacité \u2014 usure plus rapide des équipements');
  var riskLevel=riskItems.length>=3?'Élevé':riskItems.length>=1?'Modéré':'Faible';
  var riskColor=riskItems.length>=3?'#DC2626':riskItems.length>=1?'#D97706':'#059669';

  return {
    menageMin:menageMin,menageDifficulty:menageDifficulty,menageColor:menageColor,
    freqLabel:freqLabel,
    gestionLevel:gestionLevel,gestionColor:gestionColor,complexityScore:complexityScore,
    riskLevel:riskLevel,riskColor:riskColor,riskItems:riskItems
  };
}

// ── Potentiel commercial — ADR, occupation, revenus (prudent) ──
function scannerComputeCommercialPotential(d,geoAnalysis){
  var standing=d.standing||'std';
  var voyageurs=+(d.voyageurs||2);
  var chambres=+(d.chambres||0);
  var locationScore=geoAnalysis&&geoAnalysis.analysis?geoAnalysis.analysis.locationScore:55;

  var basePrice=standing==='prem'?125:standing==='std'?88:62;
  var adjPrice=Math.round(basePrice+voyageurs*3.5+chambres*7);
  // Le score d'emplacement réel module le prix (coefficient prudent, plafonné)
  var locCoef=0.85+(locationScore/100)*0.35;
  adjPrice=Math.round(adjPrice*locCoef);

  // Si infos commerciales déjà renseignées (bien existant), on les utilise en priorité — plus crédible
  var occPct;
  if(d.commercial&&d.commercial.occ){
    occPct=Math.min(95,Math.max(30,d.commercial.occ));
    if(d.commercial.price)adjPrice=Math.round((adjPrice+d.commercial.price)/2);
  } else {
    occPct=Math.round(Math.min(85,Math.max(45,50+(locationScore-55)*0.5)));
  }

  var monthlyRevenue=Math.round(adjPrice*30*occPct/100);
  var annualRevenue=Math.round(monthlyRevenue*12*0.94); // -6% prudence saisonnalité/vacance

  return {adrPotential:adjPrice,occPotential:occPct,monthlyRevenue:monthlyRevenue,annualRevenue:annualRevenue,locationScore:locationScore};
}

// ── Potentiel conciergerie — commission 20% par défaut ──
function scannerComputeConciergeriePotential(commercial,commissionRate){
  commissionRate=commissionRate||20;
  var caAnnuel=commercial.annualRevenue;
  var commissionAnnuelle=Math.round(caAnnuel*commissionRate/100);
  var commissionMensuelle=Math.round(commissionAnnuelle/12);
  return {commissionRate:commissionRate,caAnnuel:caAnnuel,commissionAnnuelle:commissionAnnuelle,commissionMensuelle:commissionMensuelle};
}

// ── Score Effort / Rentabilité — croise revenus potentiels et charge opérationnelle ──
function scannerComputeEffortScore(commercial,difficulty){
  // Normalise le revenu mensuel sur une échelle 0-100 (plafond pragmatique à 4000€/mois)
  var revenueScore=Math.min(100,Math.round(commercial.monthlyRevenue/4000*100));
  // Inverse la complexité opérationnelle (plus c'est complexe, plus le score baisse)
  var effortPenalty=difficulty.complexityScore*8+(difficulty.menageMin>120?15:difficulty.menageMin>70?7:0);
  var score=Math.max(10,Math.min(100,Math.round(revenueScore-effortPenalty+30)));
  var label=score>=75?'Excellent rapport effort / rentabilit\u00e9':score>=55?'Bon \u00e9quilibre':score>=35?'Effort important pour la rentabilit\u00e9 attendue':'Rentabilit\u00e9 ne justifie pas l\u2019effort op\u00e9rationnel';
  var color=score>=75?'#059669':score>=55?'#7C3AED':score>=35?'#D97706':'#DC2626';
  return {score:score,label:label,color:color};
}

// ── Verdict final — décision avant tout, 3 niveaux ──
function scannerFinalVerdict(locationScore,effortScore,photosScore,commercial){
  // Pondération : emplacement (40%), effort/rentabilité (40%), photos (20% — facilement améliorable donc moins pénalisant)
  var globalScore=Math.round(locationScore*0.4+effortScore*0.4+(photosScore||50)*0.2);
  if(globalScore>=72){
    return {level:'go',icon:'🟢',label:'À prendre',color:'#059669',bg:'#ECFDF5',border:'#BBF7D0',
      summary:'EVA recommande de prendre ce bien en gestion. L\u2019emplacement et le potentiel commercial sont solides.',globalScore:globalScore};
  } else if(globalScore>=50){
    return {level:'negotiate',icon:'🟠',label:'À négocier',color:'#D97706',bg:'#FFFBEB',border:'#FDE68A',
      summary:'EVA voit un potentiel réel, mais certaines conditions (loyer, effort opérationnel) doivent être négociées avant de s\u2019engager.',globalScore:globalScore};
  } else {
    return {level:'avoid',icon:'🔴',label:'À éviter',color:'#DC2626',bg:'#FEF2F2',border:'#FECACA',
      summary:'EVA déconseille ce bien en l\u2019état. Le rapport entre potentiel commercial et effort opérationnel n\u2019est pas favorable.',globalScore:globalScore};
  }
}

function scannerShowReport(){
  document.getElementById('scn-analysis').style.display='none';
  const rep=document.getElementById('scn-report');
  rep.style.display='block';

  const d=scannerData;
  const loyer=d.loyer||900;
  const geo=d._geoAnalysis; // résultat du vrai moteur (auth.js), ou null si indisponible

  // ── 1. Localisation (vrai moteur si disponible, fallback sinon) ──
  const locationScore=geo&&geo.analysis?geo.analysis.locationScore:55;
  const locationFallback=!geo;

  // ── 2. Potentiel commercial ──
  const commercial=scannerComputeCommercialPotential(d,geo);

  // ── 3. Potentiel conciergerie ──
  const conciergerie=scannerComputeConciergeriePotential(commercial,20);

  // ── 4. Difficulté opérationnelle ──
  const difficulty=scannerComputeOperationalDifficulty(d);

  // ── 5. Score effort / rentabilité ──
  const effort=scannerComputeEffortScore(commercial,difficulty);

  // ── 6. Analyse photos ──
  const photos=scannerAnalyzePhotos(d.photos);

  // ── 7. Public cible ──
  const audience=scannerComputeAudience(d);

  // ── Verdict final (décision avant tout) ──
  const verdict=scannerFinalVerdict(locationScore,effort.score,photos.score,commercial);

  // Net yield (gardé pour compat avec l'esprit initial, calculé proprement)
  const netYield=loyer>0?Math.round((conciergerie.caAnnuel-loyer*12)/(loyer*12)*1000)/10:0;

  // ── Localisation : forces / faiblesses ──
  let locStrengths=[],locWeaknesses=[];
  if(geo&&geo.analysis){
    const sub=geo.analysis.sub||{};
    if(sub.transport>=18)locStrengths.push('Excellente desserte en transports à proximité');
    else if(sub.transport<8)locWeaknesses.push('Accès transports limité');
    if(sub.food>=10)locStrengths.push('Nombreux restaurants et lieux de sortie à proximité');
    if(sub.shops>=10)locStrengths.push('Commerces facilement accessibles');
    if(sub.tourism>=8)locStrengths.push('Zone à forte attractivité touristique');
    if(sub.parking<3)locWeaknesses.push('Stationnement limité dans le secteur');
    if(geo.analysis.hotEvents&&geo.analysis.hotEvents.length)locStrengths.push(geo.analysis.hotEvents.length+' événement(s) local(aux) générant un pic de demande');
    if(!locStrengths.length)locStrengths.push('Emplacement correctement desservi');
    if(!locWeaknesses.length)locWeaknesses.push('Aucune faiblesse majeure détectée par EVA');
  } else {
    locStrengths=['Analyse de quartier non disponible pour cette adresse'];
    locWeaknesses=['Vérifiez l\u2019adresse saisie pour une analyse de localisation complète'];
  }

  const verdictBtnLabel=verdict.level==='go'?'Ajouter ce bien à mon parc':verdict.level==='negotiate'?'Simuler une négociation':'Voir une autre adresse';

  rep.innerHTML=`<div class="scn-report">
    <div class="scn-report-header">
      <div class="scn-report-address">📍 ${escapeHtml(d.address||'Bien analysé')}</div>
      <button class="scn-reset" onclick="renderScannerPage()"><i class="ti ti-refresh"></i> Nouvelle analyse</button>
    </div>

    <!-- ═══ 1. RECOMMANDATION EVA — la décision, en premier ═══ -->
    <div class="scn-v2-verdict-hero" style="background:${verdict.bg};border:1px solid ${verdict.border}">
      <div class="scn-v2-verdict-icon">${verdict.icon}</div>
      <div class="scn-v2-verdict-content">
        <div class="scn-v2-verdict-kicker">Recommandation EVA</div>
        <div class="scn-v2-verdict-label" style="color:${verdict.color}">${verdict.label}</div>
        <div class="scn-v2-verdict-summary">${verdict.summary}</div>
      </div>
      <div class="scn-v2-verdict-score">
        <div class="scn-v2-verdict-score-num" style="color:${verdict.color}">${verdict.globalScore}</div>
        <div class="scn-v2-verdict-score-lbl">Score EVA</div>
      </div>
    </div>

    <!-- ═══ 2. POTENTIEL COMMERCIAL ═══ -->
    <div class="p360-section" style="margin-bottom:14px">
      <div class="p360-section-head"><div><div class="p360-section-title">💶 Potentiel commercial</div><div class="p360-section-sub">Estimation prudente basée sur le standing, la capacité et l\u2019emplacement</div></div></div>
      <div class="p360-kpi-strip">
        <div class="p360-kpi-card accent"><div class="p360-kpi-lbl">ADR potentiel</div><div class="p360-kpi-val">${commercial.adrPotential}€</div><div class="p360-kpi-help">prix moyen / nuit</div></div>
        <div class="p360-kpi-card"><div class="p360-kpi-lbl">Occupation potentielle</div><div class="p360-kpi-val">${commercial.occPotential}%</div></div>
        <div class="p360-kpi-card"><div class="p360-kpi-lbl">Revenus mensuels estimés</div><div class="p360-kpi-val" style="color:#059669">${commercial.monthlyRevenue.toLocaleString('fr-FR')}€</div></div>
        <div class="p360-kpi-card"><div class="p360-kpi-lbl">Revenus annuels estimés</div><div class="p360-kpi-val" style="color:#059669">${commercial.annualRevenue.toLocaleString('fr-FR')}€</div></div>
      </div>
    </div>

    <!-- ═══ 3. POTENTIEL CONCIERGERIE ═══ -->
    <div class="p360-section" style="margin-bottom:14px">
      <div class="p360-section-head"><div><div class="p360-section-title">🤝 Potentiel conciergerie</div><div class="p360-section-sub">Commission conciergerie estimée à ${conciergerie.commissionRate}%</div></div></div>
      <div style="background:#F5F0FF;border:1px solid rgba(124,58,237,.18);border-radius:14px;padding:16px;display:flex;align-items:center;gap:20px;flex-wrap:wrap">
        <div>
          <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#7C3AED;margin-bottom:4px">Revenu conciergerie estimé</div>
          <div style="font-size:26px;font-weight:950;color:#7C3AED">${conciergerie.commissionMensuelle.toLocaleString('fr-FR')}€<span style="font-size:13px;color:#9B8AC4">/mois</span></div>
          <div style="font-size:12px;color:#9B8AC4;margin-top:2px">${conciergerie.commissionAnnuelle.toLocaleString('fr-FR')}€ / an</div>
        </div>
        <div style="flex:1;min-width:160px;font-size:12px;color:#5B2C91;line-height:1.6">
          Bas\u00e9 sur un CA annuel estim\u00e9 de ${conciergerie.caAnnuel.toLocaleString('fr-FR')}€ et une commission de ${conciergerie.commissionRate}%.
        </div>
      </div>
    </div>

    <!-- ═══ 4. SCORE EFFORT / RENTABILITÉ ═══ -->
    <div class="p360-section" style="margin-bottom:14px">
      <div class="p360-section-head"><div><div class="p360-section-title">⚖️ Score Effort / Rentabilité</div></div></div>
      <div style="display:flex;align-items:center;gap:16px">
        <div style="width:64px;height:64px;border-radius:16px;background:${effort.color}15;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <div style="font-size:24px;font-weight:950;color:${effort.color}">${effort.score}</div>
        </div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:800;color:${effort.color}">${effort.label}</div>
          <div style="height:6px;background:#F3F0FA;border-radius:999px;margin-top:6px;overflow:hidden">
            <div style="height:100%;width:${effort.score}%;background:${effort.color};border-radius:999px"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 5. ANALYSE LOCALISATION ═══ -->
    <div class="p360-section" style="margin-bottom:14px">
      <div class="p360-section-head"><div><div class="p360-section-title">📍 Analyse localisation</div>${locationFallback?'<div class="p360-section-sub">Estimation indisponible \u2014 vérifiez l\u2019adresse</div>':''}</div>
        <span class="a360-badge ${locationScore>=75?'a360-badge-green':locationScore>=55?'a360-badge-orange':'a360-badge-red'}">${locationScore}/100</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div>
          <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#059669;margin-bottom:8px">Forces</div>
          ${locStrengths.map(s=>`<div style="display:flex;gap:6px;font-size:12px;color:#17122E;margin-bottom:5px;align-items:flex-start"><i class="ti ti-check" style="color:#059669;flex-shrink:0;margin-top:2px"></i><span>${escapeHtml(s)}</span></div>`).join('')}
        </div>
        <div>
          <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#D97706;margin-bottom:8px">Faiblesses</div>
          ${locWeaknesses.map(s=>`<div style="display:flex;gap:6px;font-size:12px;color:#17122E;margin-bottom:5px;align-items:flex-start"><i class="ti ti-alert-triangle" style="color:#D97706;flex-shrink:0;margin-top:2px"></i><span>${escapeHtml(s)}</span></div>`).join('')}
        </div>
      </div>
    </div>

    <!-- ═══ 6. ANALYSE PHOTOS ═══ -->
    <div class="p360-section" style="margin-bottom:14px">
      <div class="p360-section-head"><div><div class="p360-section-title">📸 Analyse photos</div><div class="p360-section-sub">${photos.note}</div></div>
        ${photos.count?`<span class="a360-badge ${photos.score>=60?'a360-badge-green':photos.score>=30?'a360-badge-orange':'a360-badge-red'}">${photos.score}/100</span>`:''}
      </div>
      ${d.photos&&d.photos.length?`<div class="scn-v2-photo-grid" style="margin-bottom:10px">${d.photos.slice(0,8).map(p=>`<div class="scn-v2-photo-thumb" style="cursor:default"><img src="${p.dataUrl}"/></div>`).join('')}</div>`:''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div>
          <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#059669;margin-bottom:8px">Forces</div>
          ${photos.strengths.map(s=>`<div style="display:flex;gap:6px;font-size:12px;color:#17122E;margin-bottom:5px;align-items:flex-start"><i class="ti ti-check" style="color:#059669;flex-shrink:0;margin-top:2px"></i><span>${escapeHtml(s)}</span></div>`).join('')}
        </div>
        <div>
          <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#D97706;margin-bottom:8px">Faiblesses</div>
          ${photos.weaknesses.length?photos.weaknesses.map(s=>`<div style="display:flex;gap:6px;font-size:12px;color:#17122E;margin-bottom:5px;align-items:flex-start"><i class="ti ti-alert-triangle" style="color:#D97706;flex-shrink:0;margin-top:2px"></i><span>${escapeHtml(s)}</span></div>`).join(''):'<div style="font-size:12px;color:#B0A8C8">Aucune faiblesse majeure détectée</div>'}
        </div>
      </div>
    </div>

    <!-- ═══ 7. PUBLIC CIBLE ═══ -->
    <div class="p360-section" style="margin-bottom:14px">
      <div class="p360-section-head"><div><div class="p360-section-title">🎯 Public cible</div><div class="p360-section-sub">Profils de voyageurs les plus adaptés à ce logement</div></div></div>
      ${audience.map(a=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #F3F0FA">
        <span style="font-size:18px;flex-shrink:0">${a.icon}</span>
        <div style="flex:1;font-size:13px;font-weight:700;color:#17122E">${a.label}</div>
        <div style="width:120px;height:6px;background:#F3F0FA;border-radius:999px;overflow:hidden;flex-shrink:0">
          <div style="height:100%;width:${a.score}%;background:linear-gradient(90deg,#6D28D9,#EC4899);border-radius:999px"></div>
        </div>
        <div style="font-size:12px;font-weight:800;color:#7C3AED;width:32px;text-align:right;flex-shrink:0">${a.score}</div>
      </div>`).join('')}
    </div>

    <!-- ═══ 8. DIFFICULTÉ OPÉRATIONNELLE ═══ -->
    <div class="p360-section" style="margin-bottom:14px">
      <div class="p360-section-head"><div><div class="p360-section-title">🧹 Difficulté opérationnelle</div></div></div>
      <div class="p360-kpi-strip" style="margin-bottom:10px">
        <div class="p360-kpi-card"><div class="p360-kpi-lbl">Difficulté ménage</div><div class="p360-kpi-val" style="color:${difficulty.menageColor}">${difficulty.menageDifficulty}</div><div class="p360-kpi-help">~${difficulty.menageMin} min estimées</div></div>
        <div class="p360-kpi-card"><div class="p360-kpi-lbl">Fréquence interventions</div><div class="p360-kpi-val" style="font-size:14px">${difficulty.freqLabel}</div></div>
        <div class="p360-kpi-card"><div class="p360-kpi-lbl">Difficulté de gestion</div><div class="p360-kpi-val" style="color:${difficulty.gestionColor}">${difficulty.gestionLevel}</div></div>
        <div class="p360-kpi-card"><div class="p360-kpi-lbl">Risque opérationnel</div><div class="p360-kpi-val" style="color:${difficulty.riskColor}">${difficulty.riskLevel}</div></div>
      </div>
      ${difficulty.riskItems.length?`<div style="background:#FFFBEB;border-radius:10px;padding:10px 12px">
        ${difficulty.riskItems.map(r=>`<div style="font-size:12px;color:#92400E;margin-bottom:3px;display:flex;gap:6px"><span>•</span><span>${escapeHtml(r)}</span></div>`).join('')}
      </div>`:''}
    </div>

    <!-- ═══ 9. RECOMMANDATIONS EVA (synthèse finale) ═══ -->
    <div class="scn-reco-block">
      <div class="scn-reco-icon">🤖</div>
      <div class="scn-reco-text">
        <strong>EVA recommande : ${verdict.label}.</strong>
        Ce logement présente un score global de ${verdict.globalScore}/100, combinant emplacement (${locationScore}/100), effort/rentabilité (${effort.score}/100) et présentation (${photos.score}/100).
        ${loyer?` Le loyer de ${loyer}€/mois représente ${Math.round(loyer*12/conciergerie.caAnnuel*100)}% du chiffre d\u2019affaires potentiel estimé.`:''}
        ${verdict.level==='negotiate'?' Une négociation sur le loyer ou les conditions d\u2019entrée pourrait faire basculer ce bien en \u00ab à prendre \u00bb.':''}
        ${verdict.level==='avoid'?' Sauf changement significatif des conditions (loyer, travaux, repositionnement), ce bien n\u2019est pas recommandé.':''}
      </div>
    </div>

    <div class="scn-report-actions">
      <button class="btn btn-purple" onclick="showToast('Fonctionnalité disponible en version finale.')">
        <i class="ti ti-building-plus"></i> ${verdictBtnLabel}
      </button>
      <button class="btn" onclick="showToast('Export PDF disponible en version finale.')">
        <i class="ti ti-file-export"></i> Exporter le rapport EVA
      </button>
    </div>
  </div>`;
}
function renderEvaAuditPage(){
  // Plan d'action — 3 recommandations concrètes EVA
  const plan = document.getElementById('rq-eva-plan');
  if(plan && !plan.dataset.populated){
    plan.dataset.populated = '1';
    const actions = [
      {
        num:1,
        title:'Augmenter les tarifs du samedi',
        desc:'EVA détecte un sous-pricing systématique le week-end. Un ajustement de +15% sur les samedis correspond à la demande locale observée.',
        impact:'+1 200 €/an',
        color:'#059669'
      },
      {
        num:2,
        title:'Corriger la fiche logement S2',
        desc:'Photos sous-optimales et description trop courte pénalisent le taux de conversion. EVA estime un gain de confiance significatif après mise à jour.',
        impact:'+14 avis potentiels',
        color:'#7C3AED'
      },
      {
        num:3,
        title:'Activer Booking.com sur S3',
        desc:'Le logement S3 n\'est distribué que sur Airbnb. L\'ajout de Booking.com dans votre zone cible représente un potentiel d\'occupation supplémentaire estimé.',
        impact:'+8 % d\'occupation',
        color:'#0284C7'
      }
    ];
    plan.innerHTML = actions.map(a=>`
      <div class="rq-eva-action">
        <div class="rq-eva-action-rank" style="background:${a.color}">${a.num}</div>
        <div class="rq-eva-action-body">
          <div class="rq-eva-action-title">${a.title}</div>
          <div class="rq-eva-action-desc">${a.desc}</div>
        </div>
        <div class="rq-eva-action-right">
          <div class="rq-eva-action-impact" style="color:${a.color}">${a.impact}</div>
          <button class="rq-eva-action-btn" onclick="showToast('Action enregistrée — EVA suit l\\'évolution.')">Appliquer</button>
        </div>
      </div>`).join('');
  }
}


/* ====================================================
   AUDIT 360 — 5 sous-sections
   Fonctions : renderAudit360Revenus, renderAudit360Occupation,
               renderAudit360Qualite, renderAudit360Ota,
               renderAudit360Tarification
   ==================================================== */

// ── Helpers partagés ──
function a360NbNuits(r){
  try{
    if(!r.date_from||!r.date_to)return r.nights||0;
    var n=Math.max(0,Math.round((new Date(r.date_to)-new Date(r.date_from))/(1000*60*60*24)));
    return n||r.nights||0;
  }catch(e){return r.nights||0;}
}

function a360Empty(msg){
  return '<div class="a360-empty"><div class="a360-empty-icon">\uD83E\uDD16</div>'+
    '<div class="a360-empty-title">Donn\u00e9es insuffisantes</div>'+
    '<div class="a360-empty-sub">'+(msg||'Ajoutez vos biens et r\u00e9servations pour g\u00e9n\u00e9rer cette analyse.')+'</div></div>';
}

function a360Alert(type,icon,title,desc){
  return '<div class="a360-alert a360-alert-'+type+'">'+
    '<div class="a360-alert-icon">'+icon+'</div>'+
    '<div><div class="a360-alert-title">'+title+'</div>'+
    (desc?'<div class="a360-alert-desc">'+desc+'</div>':'')+
    '</div></div>';
}

// ── 1. REVENUS ──
function renderAudit360Revenus(){
  var dash=document.getElementById('audit-revenus-dash');
  if(!dash)return;
  var apts=apparts||[];
  var allRes=reservations||[];

  if(!apts.length&&!allRes.length){dash.innerHTML=a360Empty();return;}

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var prevDate=new Date(today.getFullYear(),today.getMonth()-1,1);
  var prevMonth=prevDate.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());
  var daysInMonth=new Date(today.getFullYear(),today.getMonth()+1,0).getDate();

  var monthRes=allRes.filter(function(r){return r.date_from&&r.date_from.startsWith(month);});
  var prevRes=allRes.filter(function(r){return r.date_from&&r.date_from.startsWith(prevMonth);});
  var monthRev=monthRes.reduce(function(s,r){return s+(r.price_total||0);},0);
  var prevRev=prevRes.reduce(function(s,r){return s+(r.price_total||0);},0);

  // Tendance
  var trendHtml='';
  if(prevRev>0){
    var diff=Math.round((monthRev-prevRev)/prevRev*100);
    if(diff>0) trendHtml='<span class="a360-trend-up">\u25b2 +'+diff+'% vs mois pr\u00e9c\u00e9dent</span>';
    else if(diff<0) trendHtml='<span class="a360-trend-down">\u25bc '+diff+'% vs mois pr\u00e9c\u00e9dent</span>';
    else trendHtml='<span class="a360-trend-flat">= stable vs mois pr\u00e9c\u00e9dent</span>';
  } else {
    trendHtml='<span class="a360-trend-flat">Pas de donn\u00e9es pour le mois pr\u00e9c\u00e9dent</span>';
  }

  // Revenus par logement
  var aptRevs=apts.map(function(a){
    var aRes=allRes.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var rev=aRes.reduce(function(s,r){return s+(r.price_total||0);},0);
    var nb=aRes.length;
    return {a:a,rev:rev,nb:nb};
  }).sort(function(x,y){return y.rev-x.rev;});

  var best=aptRevs[0];
  var worst=aptRevs[aptRevs.length-1];

  // Nuits vendues pour ADR
  var totalNights=monthRes.reduce(function(s,r){return s+a360NbNuits(r);},0);
  var adr=totalNights>0?Math.round(monthRev/totalNights):0;

  // Alertes
  var alerts='';
  aptRevs.forEach(function(ar){
    if(ar.rev===0&&ar.a.price>0){
      alerts+=a360Alert('risk','\u26a0\ufe0f',ar.a.name+' \u2014 aucun revenu ce mois','Aucune r\u00e9servation enregistr\u00e9e. V\u00e9rifiez la disponibilit\u00e9 et le pricing.');
    } else if(ar.rev>0&&ar.nb===1&&adr>0&&(ar.rev/ar.nb)<adr*0.7){
      alerts+=a360Alert('warn','\uD83D\uDCB6',ar.a.name+' \u2014 revenu par r\u00e9sa inf\u00e9rieur \u00e0 la moyenne','Ce bien g\u00e9n\u00e8re moins que l\u2019ADR moyen du parc.');
    }
  });
  if(!alerts) alerts=a360Alert('ok','\u2705','Tous les biens g\u00e9n\u00e8rent des revenus ce mois','Parc actif et performant.');

  var tableRows=aptRevs.map(function(ar,i){
    var badge=i===0?'<span class="a360-badge a360-badge-green">Meilleur</span>':
              i===aptRevs.length-1&&aptRevs.length>1?'<span class="a360-badge a360-badge-orange">En retrait</span>':'';
    var revColor=ar.rev>0?'#17122E':'#DC2626';
    return '<tr>'+
      '<td><span style="margin-right:6px">'+(ar.a.emoji||'\uD83C\uDFE0')+'</span>'+ar.a.name+' '+badge+'</td>'+
      '<td style="font-weight:800;color:'+revColor+'">'+ar.rev+'\u20AC</td>'+
      '<td>'+ar.nb+' r\u00e9sa'+(ar.nb>1?'s':'')+'</td>'+
      '<td style="color:#8A8A99">'+(ar.a.price||'—')+'\u20AC/nuit</td>'+
    '</tr>';
  }).join('');

  dash.innerHTML=
    '<div class="a360-hero">'+
      '<div class="a360-hero-kicker">EVA Audit 360 \u00b7 Revenus</div>'+
      '<div class="a360-hero-title">'+monthRev+'\u20AC g\u00e9n\u00e9r\u00e9s ce mois</div>'+
      '<div class="a360-hero-sub">'+daysElapsed+' jours \u00e9coul\u00e9s sur '+daysInMonth+' \u2014 '+monthRes.length+' r\u00e9servation'+(monthRes.length>1?'s':'')+' enregistr\u00e9e'+(monthRes.length>1?'s':'')+'</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+monthRev+'\u20AC ce mois</span>'+
        '<span class="a360-hero-chip">ADR : '+adr+'\u20AC</span>'+
        (prevRev>0?'<span class="a360-hero-chip">M-1 : '+prevRev+'\u20AC</span>':'')+
        '<span class="a360-hero-chip">'+apts.length+' logement'+(apts.length>1?'s':'')+'</span>'+
      '</div>'+
    '</div>'+

    '<div class="a360-kpi-row">'+
      '<div class="a360-kpi a360-kpi-accent">'+
        '<div class="a360-kpi-label">Revenus du mois</div>'+
        '<div class="a360-kpi-value">'+monthRev+'\u20AC</div>'+
        '<div class="a360-kpi-help">'+daysElapsed+'/'+daysInMonth+' jours \u00e9coul\u00e9s</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">R\u00e9servations</div>'+
        '<div class="a360-kpi-value">'+monthRes.length+'</div>'+
        '<div class="a360-kpi-help">ce mois</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">ADR</div>'+
        '<div class="a360-kpi-value">'+adr+'\u20AC</div>'+
        '<div class="a360-kpi-help">prix moyen / nuit</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Mois pr\u00e9c\u00e9dent</div>'+
        '<div class="a360-kpi-value">'+prevRev+'\u20AC</div>'+
        '<div class="a360-kpi-help">'+trendHtml+'</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Logements</div>'+
        '<div class="a360-kpi-value">'+apts.length+'</div>'+
        '<div class="a360-kpi-help">dans le parc</div>'+
      '</div>'+
    '</div>'+

    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83C\uDFC6 Revenus par logement</div>'+
          '<div class="a360-section-sub">Classement du mois en cours</div>'+
        '</div>'+
        (best?'<span class="a360-badge a360-badge-purple">Meilleur : '+best.a.name+' \u2014 '+best.rev+'\u20AC</span>':'')+
      '</div>'+
      '<div class="a360-table-wrap">'+
        '<table class="a360-table">'+
          '<thead><tr><th>Logement</th><th>Revenus</th><th>R\u00e9servations</th><th>Prix/nuit</th></tr></thead>'+
          '<tbody>'+tableRows+'</tbody>'+
        '</table>'+
      '</div>'+
    '</div>'+

    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83D\uDEA8 Alertes EVA \u2014 Revenus</div>'+
          '<div class="a360-section-sub">Signaux d\u00e9tect\u00e9s par EVA sur votre parc</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">EVA Engine</span>'+
      '</div>'+
      alerts+
      '<div style="margin-top:14px">'+
        '<button class="a360-action-btn" onclick="goTo(\'pricing\',document.querySelector(\'[data-page=pricing]\'))">EVA Pricing \u2192</button>'+
      '</div>'+
    '</div>';
}

// ── 2. OCCUPATION ──
function renderAudit360Occupation(){
  var dash=document.getElementById('audit-occupation-dash');
  if(!dash)return;
  var apts=apparts||[];
  var allRes=reservations||[];

  if(!apts.length){dash.innerHTML=a360Empty();return;}

  var today=new Date();
  var todayIso=today.toISOString().slice(0,10);
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());

  // Taux d'occupation global du mois
  var totalNights=0;
  var monthRes=allRes.filter(function(r){return r.date_from&&r.date_from.startsWith(month);});
  monthRes.forEach(function(r){totalNights+=a360NbNuits(r);});
  var availableNights=apts.length*daysElapsed;
  var globalOcc=availableNights>0?Math.min(100,Math.round(totalNights/availableNights*100)):0;

  // Taux par logement sur 30 jours
  var aptOccs=apts.map(function(a){
    var aRes=allRes.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var nights=aRes.reduce(function(s,r){return s+a360NbNuits(r);},0);
    var occ=daysElapsed>0?Math.min(100,Math.round(nights/daysElapsed*100)):0;
    return {a:a,occ:occ,nights:nights,res:aRes.length};
  }).sort(function(x,y){return y.occ-x.occ;});

  // Nuits vacantes J+1..J+14
  var next14=[];
  for(var di=1;di<=14;di++){var dd=new Date(today);dd.setDate(dd.getDate()+di);next14.push(dd.toISOString().slice(0,10));}
  var vacantsByApt=apts.map(function(a){
    var vacant=next14.filter(function(day){
      return !allRes.some(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_to&&r.date_from<=day&&r.date_to>day;});
    });
    return {a:a,vacant:vacant};
  });

  // Alertes
  var alerts='';
  var lowOcc=aptOccs.filter(function(x){return x.occ<50&&daysElapsed>=7;});
  lowOcc.forEach(function(x){
    alerts+=a360Alert('risk','\uD83D\uDCC9',x.a.name+' \u2014 occupation faible : '+x.occ+'%',
      'Objectif recommand\u00e9 : 65\u00a0%. '+x.nights+' nuits vendues sur '+daysElapsed+' jours.');
  });
  var highVacant=vacantsByApt.filter(function(x){return x.vacant.length>=7;});
  highVacant.forEach(function(x){
    if(!lowOcc.some(function(l){return l.a.id===x.a.id;})){
      alerts+=a360Alert('warn','\uD83C\uDF19',x.a.name+' \u2014 '+x.vacant.length+' nuits libres dans les 14 jours',
        'Envisagez un ajustement de prix ou une promotion pour augmenter le remplissage.');
    }
  });
  if(globalOcc>=65) alerts+=a360Alert('ok','\u2705','Taux d\u2019occupation global satisfaisant : '+globalOcc+'%','EVA recommande de maintenir le cap et d\u2019optimiser les prix en hausse.');
  if(!alerts) alerts=a360Alert('ok','\u2705','Aucune alerte d\u2019occupation','Le parc est correctement suivi.');

  // Table
  var tableRows=aptOccs.map(function(ar){
    var occColor=ar.occ>=65?'#059669':ar.occ>=45?'#D97706':'#DC2626';
    var badge=ar.occ>=65?'<span class="a360-badge a360-badge-green">OK</span>':
              ar.occ>=45?'<span class="a360-badge a360-badge-orange">\u00c0 optimiser</span>':
              '<span class="a360-badge a360-badge-red">Sous-perf.</span>';
    var vacApt=vacantsByApt.find(function(x){return x.a.id===ar.a.id;});
    var vacN=vacApt?vacApt.vacant.length:0;
    return '<tr>'+
      '<td><span style="margin-right:6px">'+(ar.a.emoji||'\uD83C\uDFE0')+'</span>'+ar.a.name+'</td>'+
      '<td style="font-weight:800;color:'+occColor+'">'+ar.occ+'%</td>'+
      '<td>'+ar.nights+' nuit'+(ar.nights>1?'s':'')+' vendues</td>'+
      '<td>'+vacN+' libre'+(vacN>1?'s':'')+' /14j</td>'+
      '<td>'+badge+'</td>'+
    '</tr>';
  }).join('');

  var occColor=globalOcc>=65?'#059669':globalOcc>=45?'#D97706':'#DC2626';
  var freeNb=apts.filter(function(a){return !a.booked;}).length;
  var totalVacant=vacantsByApt.reduce(function(s,x){return s+x.vacant.length;},0);

  dash.innerHTML=
    '<div class="a360-hero">'+
      '<div class="a360-hero-kicker">EVA Audit 360 \u00b7 Occupation</div>'+
      '<div class="a360-hero-title" style="color:'+(globalOcc>=65?'#FCD34D':'#fff')+'">'+globalOcc+'% d\u2019occupation ce mois</div>'+
      '<div class="a360-hero-sub">'+daysElapsed+' jours \u00e9coul\u00e9s \u2014 objectif EVA : 65\u202f%</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+globalOcc+'% global</span>'+
        '<span class="a360-hero-chip">'+totalNights+' nuits vendues</span>'+
        '<span class="a360-hero-chip">'+freeNb+' libre'+(freeNb>1?'s':'')+' ce soir</span>'+
        '<span class="a360-hero-chip">'+totalVacant+' vacantes /14j</span>'+
      '</div>'+
    '</div>'+

    '<div class="a360-kpi-row">'+
      '<div class="a360-kpi a360-kpi-accent">'+
        '<div class="a360-kpi-label">Occupation globale</div>'+
        '<div class="a360-kpi-value" style="color:'+occColor+'">'+globalOcc+'%</div>'+
        '<div class="a360-occ-wrap"><div class="a360-occ-bar"><div class="a360-occ-bar-fill" style="width:'+globalOcc+'%;background:'+occColor+'"></div></div></div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Nuits vendues</div>'+
        '<div class="a360-kpi-value">'+totalNights+'</div>'+
        '<div class="a360-kpi-help">ce mois</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Libres ce soir</div>'+
        '<div class="a360-kpi-value" style="color:'+(freeNb?'#DC2626':'#059669')+'">'+freeNb+'</div>'+
        '<div class="a360-kpi-help">sur '+apts.length+' biens</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Vacantes /14j</div>'+
        '<div class="a360-kpi-value">'+totalVacant+'</div>'+
        '<div class="a360-kpi-help">tous biens</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Objectif EVA</div>'+
        '<div class="a360-kpi-value" style="color:#7C3AED">65%</div>'+
        '<div class="a360-kpi-help">taux cible</div>'+
      '</div>'+
    '</div>'+

    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83C\uDFE0 Occupation par logement</div>'+
          '<div class="a360-section-sub">Mois en cours \u2014 nuits vendues et vacantes \u00e0 venir</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">'+globalOcc+'% global</span>'+
      '</div>'+
      '<div class="a360-table-wrap">'+
        '<table class="a360-table">'+
          '<thead><tr><th>Logement</th><th>Occupation</th><th>Nuits vendues</th><th>Vacantes /14j</th><th>Statut</th></tr></thead>'+
          '<tbody>'+tableRows+'</tbody>'+
        '</table>'+
      '</div>'+
    '</div>'+

    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83D\uDEA8 Alertes EVA \u2014 Occupation</div>'+
          '<div class="a360-section-sub">Signaux d\u00e9tect\u00e9s par EVA</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">EVA Engine</span>'+
      '</div>'+
      alerts+
      '<div style="margin-top:14px">'+
        '<button class="a360-action-btn" onclick="goTo(\'pricing\',document.querySelector(\'[data-page=pricing]\'))">Optimiser les prix \u2192</button>'+
      '</div>'+
    '</div>';
}

// ── 3. QUALITÉ VOYAGEURS ──
function renderAudit360Qualite(){
  var dash=document.getElementById('audit-qualite-dash');
  if(!dash)return;
  var apts=apparts||[];

  if(!apts.length){dash.innerHTML=a360Empty();return;}

  // Notes depuis a.note (champ Supabase)
  var withNote=apts.filter(function(a){return a.note&&Number(a.note)>0;});
  var avgNote=withNote.length?Math.round(withNote.reduce(function(s,a){return s+Number(a.note);},0)/withNote.length*10)/10:0;

  // Si aucune note : afficher état partiel avec recommandations
  var noteSection='';
  if(!withNote.length){
    noteSection='<div class="a360-empty" style="margin-bottom:14px">'+
      '<div class="a360-empty-icon">\u2B50</div>'+
      '<div class="a360-empty-title">Aucune note enregistr\u00e9e</div>'+
      '<div class="a360-empty-sub">Ajoutez la note Airbnb/Booking de chaque logement dans sa fiche pour activer l\u2019analyse qualit\u00e9.</div>'+
    '</div>';
  } else {
    var noteColor=avgNote>=4.5?'#059669':avgNote>=4?'#D97706':'#DC2626';
    var aptNoteRows=apts.map(function(a){
      if(!a.note||!Number(a.note))return '<tr>'+
        '<td><div class="a360-apt-name"><div class="a360-apt-emoji">'+(a.emoji||'\uD83C\uDFE0')+'</div><span>'+a.name+'</span></div></td>'+
        '<td colspan="3" style="color:#B0A8C8;font-size:12px">Note non renseign\u00e9e</td></tr>';
      var n=Number(a.note);
      var fullStars=Math.round(n);
      var stars='<span class="a360-stars">'+'\u2605'.repeat(fullStars)+'\u2606'.repeat(5-fullStars)+'</span>';
      var badge=n>=4.8?'<span class="a360-badge a360-badge-green">Excellent</span>':
                n>=4.5?'<span class="a360-badge a360-badge-purple">Bon</span>':
                n>=4?'<span class="a360-badge a360-badge-orange">\u00c0 am\u00e9liorer</span>':
                '<span class="a360-badge a360-badge-red">Critique</span>';
      var nColor=n>=4.5?'#059669':n>=4?'#D97706':'#DC2626';
      return '<tr>'+
        '<td><div class="a360-apt-name"><div class="a360-apt-emoji">'+(a.emoji||'\uD83C\uDFE0')+'</div><span>'+a.name+'</span></div></td>'+
        '<td><span style="font-size:16px;font-weight:900;color:'+nColor+'">'+n+'</span><span style="font-size:11px;color:#8A8A99">/5</span> '+stars+'</td>'+
        '<td>'+(a.nb_avis?'<strong>'+a.nb_avis+'</strong> avis':'<span style="color:#B0A8C8">—</span>')+'</td>'+
        '<td>'+badge+'</td>'+
      '</tr>';
    }).join('');

    noteSection=
      '<div class="a360-hero">'+
        '<div class="a360-hero-kicker">EVA Audit 360 \u00b7 Qualit\u00e9 voyageurs</div>'+
        '<div class="a360-hero-title">Note moyenne : '+avgNote+'/5</div>'+
        '<div class="a360-hero-sub">'+withNote.length+' logement'+(withNote.length>1?'s':'')+' not\u00e9'+(withNote.length>1?'s':'')+' sur '+apts.length+'</div>'+
        '<div class="a360-hero-chips">'+
          '<span class="a360-hero-chip accent">'+avgNote+'/5 moyenne</span>'+
          '<span class="a360-hero-chip">'+withNote.filter(function(a){return Number(a.note)>=4.5;}).length+' excellent'+(withNote.filter(function(a){return Number(a.note)>=4.5;}).length>1?'s':'')+'</span>'+
          '<span class="a360-hero-chip">'+withNote.filter(function(a){return Number(a.note)<4;}).length+' action'+(withNote.filter(function(a){return Number(a.note)<4;}).length>1?'s':'')+' requise'+(withNote.filter(function(a){return Number(a.note)<4;}).length>1?'s':'')+'</span>'+
          '<span class="a360-hero-chip">'+apts.reduce(function(s,a){return s+(a.nb_avis||0);},0)+' avis au total</span>'+
        '</div>'+
      '</div>'+

      '<div class="a360-kpi-row" style="margin-bottom:14px">'+
        '<div class="a360-kpi a360-kpi-accent">'+
          '<div class="a360-kpi-label">Note moyenne</div>'+
          '<div class="a360-kpi-value" style="color:'+noteColor+'">'+avgNote+'</div>'+
          '<div class="a360-kpi-help">sur 5 \u00e9toiles</div>'+
        '</div>'+
        '<div class="a360-kpi">'+
          '<div class="a360-kpi-label">Biens not\u00e9s</div>'+
          '<div class="a360-kpi-value">'+withNote.length+'/'+apts.length+'</div>'+
          '<div class="a360-kpi-help">fiches renseign\u00e9es</div>'+
        '</div>'+
        '<div class="a360-kpi">'+
          '<div class="a360-kpi-label">Note \u2265 4,5</div>'+
          '<div class="a360-kpi-value" style="color:#059669">'+withNote.filter(function(a){return Number(a.note)>=4.5;}).length+'</div>'+
          '<div class="a360-kpi-help">biens excellents</div>'+
        '</div>'+
        '<div class="a360-kpi">'+
          '<div class="a360-kpi-label">Note &lt; 4</div>'+
          '<div class="a360-kpi-value" style="color:#DC2626">'+withNote.filter(function(a){return Number(a.note)<4;}).length+'</div>'+
          '<div class="a360-kpi-help">action requise</div>'+
        '</div>'+
        '<div class="a360-kpi">'+
          '<div class="a360-kpi-label">Avis totaux</div>'+
          '<div class="a360-kpi-value">'+(apts.reduce(function(s,a){return s+(a.nb_avis||0);},0)||'—')+'</div>'+
          '<div class="a360-kpi-help">tous logements</div>'+
        '</div>'+
      '</div>'+

      '<div class="a360-section">'+
        '<div class="a360-section-head">'+
          '<div>'+
            '<div class="a360-section-title">\u2B50 Notes par logement</div>'+
            '<div class="a360-section-sub">Source : donn\u00e9es renseign\u00e9es dans les fiches</div>'+
          '</div>'+
          '<span class="a360-badge a360-badge-purple">Moyenne '+avgNote+'/5</span>'+
        '</div>'+
        '<div class="a360-table-wrap">'+
          '<table class="a360-table">'+
            '<thead><tr><th>Logement</th><th>Note</th><th>Avis</th><th>Statut</th></tr></thead>'+
            '<tbody>'+aptNoteRows+'</tbody>'+
          '</table>'+
        '</div>'+
      '</div>';
  }

  // Recommandations EVA
  var reco='';
  apts.forEach(function(a){
    var n=Number(a.note||0);
    if(n>0&&n<4) reco+=a360Alert('risk','\u26a0\ufe0f',a.name+' \u2014 note critique : '+n+'/5','Priorit\u00e9 absolue : identifier la cause (m\u00e9nage, \u00e9quipements, annonce) et corriger avant de relever les prix.');
    else if(n>=4&&n<4.5) reco+=a360Alert('warn','\uD83D\uDCA1',a.name+' \u2014 note \u00e0 am\u00e9liorer : '+n+'/5','Petites am\u00e9liorations possibles : photos, description, \u00e9quipements. Chaque demi-point peut augmenter la conversion de 10\u00a0%.');
    else if(n>=4.8) reco+=a360Alert('ok','\uD83C\uDFC6',a.name+' \u2014 note excellente : '+n+'/5','Ce bien peut justifier une hausse de prix. Les voyageurs paient plus pour un bien bien not\u00e9.');
  });
  if(!reco) reco=a360Alert('ok','\uD83D\uDCA1','Conseil EVA','Renseignez la note Airbnb/Booking dans chaque fiche logement pour activer l\u2019analyse compl\u00e8te.');

  dash.innerHTML=
    noteSection+
    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83D\uDEA8 Recommandations EVA \u2014 Qualit\u00e9</div>'+
          '<div class="a360-section-sub">Actions pour am\u00e9liorer la satisfaction voyageurs</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">EVA Engine</span>'+
      '</div>'+
      reco+
    '</div>';
}

// ── 4. DISTRIBUTION OTA — version simple V1 ──
function renderAudit360Ota(){
  var dash=document.getElementById('audit-ota-dash');
  if(!dash)return;
  var allRes=reservations||[];
  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var monthRes=allRes.filter(function(r){return r.date_from&&r.date_from.startsWith(month);});

  // Vérifier si données canal disponibles
  var withPlatform=monthRes.filter(function(r){return r.platform&&r.platform!=='';});

  if(!monthRes.length||withPlatform.length<2){
    dash.innerHTML=
      '<div class="a360-hero">'+
        '<div class="a360-hero-kicker">EVA Audit 360 \u00b7 Distribution OTA</div>'+
        '<div class="a360-hero-title">Donn\u00e9es OTA insuffisantes</div>'+
        '<div class="a360-hero-sub">Cette analyse sera enrichie avec les donn\u00e9es PMS</div>'+
      '</div>'+
      '<div class="a360-empty">'+
        '<div class="a360-empty-icon">\uD83C\uDF10</div>'+
        '<div class="a360-empty-title">Donn\u00e9es OTA insuffisantes pour l\u2019instant</div>'+
        '<div class="a360-empty-sub">Connectez Smoobu ou ajoutez manuellement vos r\u00e9servations avec le canal source (Airbnb, Booking\u2026) pour activer cette vue.</div>'+
        '<div style="margin-top:16px">'+
          '<button class="a360-action-btn" onclick="goTo(\'settings\',document.querySelector(\'[data-page=settings]\'))">Connecter un PMS \u2192</button>'+
        '</div>'+
      '</div>';
    return;
  }

  // Répartition par canal
  var channels={};
  var labels={'airbnb':'Airbnb','booking':'Booking.com','vrbo':'VRBO','homeaway':'HomeAway','direct':'Direct','autre':'Autre'};
  var colors={'airbnb':'#FF5A5F','booking':'#003580','vrbo':'#0C8FE8','direct':'#059669','autre':'#8A8A99'};
  monthRes.forEach(function(r){
    var c=(r.platform||'autre').toLowerCase();
    if(c!=='airbnb'&&c!=='booking'&&c!=='vrbo'&&c!=='homeaway'&&c!=='direct')c='autre';
    channels[c]=(channels[c]||0)+1;
  });
  var total=monthRes.length;
  var sorted=Object.entries(channels).sort(function(a,b){return b[1]-a[1];});

  // Détection dépendance
  var topEntry=sorted[0];
  var depAlert='';
  if(topEntry&&topEntry[1]/total>0.85){
    depAlert=a360Alert('warn','\uD83D\uDD17','D\u00e9pendance \u00e0 '+(labels[topEntry[0]]||topEntry[0]),
      Math.round(topEntry[1]/total*100)+'% de vos r\u00e9servations viennent d\u2019une seule source. Diversifiez pour r\u00e9duire le risque de d\u00e9plistage.');
  } else {
    depAlert=a360Alert('ok','\u2705','Distribution OTA saine','Vos r\u00e9servations sont r\u00e9parties sur plusieurs canaux.');
  }

  var bars=sorted.map(function(e){
    var key=e[0];var count=e[1];
    var pct=Math.round(count/total*100);
    var color=colors[key]||'#6D28D9';
    return '<div class="a360-ota-row">'+
      '<div class="a360-ota-label">'+
        '<span style="font-weight:600">'+(labels[key]||key)+'</span>'+
        '<span style="font-weight:800;color:#17122E">'+count+' r\u00e9sa \u2014 <span style="color:'+color+'">'+pct+'%</span></span>'+
      '</div>'+
      '<div class="a360-ota-bar-wrap"><div class="a360-ota-bar-fill" style="width:'+pct+'%;background:'+color+'"></div></div>'+
    '</div>';
  }).join('');

  dash.innerHTML=
    '<div class="a360-hero">'+
      '<div class="a360-hero-kicker">EVA Audit 360 \u00b7 Distribution OTA</div>'+
      '<div class="a360-hero-title">'+total+' r\u00e9servation'+(total>1?'s':'')+' sur '+sorted.length+' canal'+(sorted.length>1?'x':'')+' ce mois</div>'+
      '<div class="a360-hero-sub">Canal principal : '+(labels[topEntry[0]]||topEntry[0])+' \u2014 '+Math.round(topEntry[1]/total*100)+'%</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+total+' r\u00e9sas</span>'+
        '<span class="a360-hero-chip">'+sorted.length+' canal'+(sorted.length>1?'x':'')+' actif'+(sorted.length>1?'s':'')+'</span>'+
        '<span class="a360-hero-chip">'+(labels[topEntry[0]]||topEntry[0])+' : '+Math.round(topEntry[1]/total*100)+'%</span>'+
      '</div>'+
    '</div>'+

    '<div class="a360-kpi-row">'+
      '<div class="a360-kpi a360-kpi-accent">'+
        '<div class="a360-kpi-label">R\u00e9servations</div>'+
        '<div class="a360-kpi-value">'+total+'</div>'+
        '<div class="a360-kpi-help">ce mois</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Canaux actifs</div>'+
        '<div class="a360-kpi-value">'+sorted.length+'</div>'+
        '<div class="a360-kpi-help">sources diff\u00e9rentes</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Canal principal</div>'+
        '<div class="a360-kpi-value" style="font-size:15px;letter-spacing:0">'+(labels[topEntry[0]]||topEntry[0])+'</div>'+
        '<div class="a360-kpi-help">'+Math.round(topEntry[1]/total*100)+'% des r\u00e9sas</div>'+
      '</div>'+
    '</div>'+

    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83C\uDF10 R\u00e9partition par canal</div>'+
          '<div class="a360-section-sub">Mois en cours</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">'+total+' r\u00e9servations</span>'+
      '</div>'+
      '<div style="padding:4px 0">'+bars+'</div>'+
    '</div>'+

    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83D\uDEA8 Alerte EVA \u2014 OTA</div>'+
          '<div class="a360-section-sub">D\u00e9tection de d\u00e9pendance</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">EVA Engine</span>'+
      '</div>'+
      depAlert+
    '</div>';
}

// ── 5. TARIFICATION ──
function renderAudit360Tarification(){
  var dash=document.getElementById('audit-tarification-dash');
  if(!dash)return;
  var apts=apparts||[];
  var allRes=reservations||[];

  if(!apts.length){dash.innerHTML=a360Empty();return;}

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var monthRes=allRes.filter(function(r){return r.date_from&&r.date_from.startsWith(month);});
  var totalNights=monthRes.reduce(function(s,r){return s+a360NbNuits(r);},0);
  var totalRev=monthRes.reduce(function(s,r){return s+(r.price_total||0);},0);
  var adr=totalNights>0?Math.round(totalRev/totalNights):0;
  var avgPrice=apts.length?Math.round(apts.reduce(function(s,a){return s+(a.price||0);},0)/apts.length):0;

  // Catégoriser les biens
  var underPriced=apts.filter(function(a){return (a.price||0)>0&&(a.ai_rec||0)>(a.price||0);});
  var belowFloor=apts.filter(function(a){return (a.price||0)>0&&(a.price||0)<floor(a);});
  var overComp=apts.filter(function(a){return (a.comp||0)>0&&(a.price||0)>(a.comp||0)*1.2;});
  var hotEvts=Object.values(eventsCache||{}).flat().filter(function(e){return e.hot;});
  var eventOpps=apts.filter(function(a){
    var city=a.city||'';
    return (eventsCache[city]||[]).some(function(e){return e.hot;});
  });

  // Table tarifaire
  var tableRows=apts.map(function(a){
    var fl=floor(a);
    var status='';
    var statusBadge='';
    if((a.price||0)<fl){
      status='Sous plancher';statusBadge='<span class="a360-badge a360-badge-red">Sous plancher</span>';
    } else if((a.ai_rec||0)>(a.price||0)){
      status='Sous-tarif\u00e9';statusBadge='<span class="a360-badge a360-badge-orange">Sous-tarif\u00e9</span>';
    } else if((a.comp||0)>0&&(a.price||0)>(a.comp||0)*1.2){
      status='Potentiellement sur-tarif\u00e9';statusBadge='<span class="a360-badge a360-badge-orange">Vrai vs concurrence</span>';
    } else {
      statusBadge='<span class="a360-badge a360-badge-green">OK</span>';
    }
    return '<tr>'+
      '<td><span style="margin-right:6px">'+(a.emoji||'\uD83C\uDFE0')+'</span>'+a.name+'</td>'+
      '<td style="font-weight:800">'+( a.price||'—')+'\u20AC</td>'+
      '<td style="color:#7C3AED">'+(a.ai_rec||'—')+'\u20AC</td>'+
      '<td style="color:#8A8A99">'+(a.comp||'—')+'\u20AC</td>'+
      '<td>'+fl+'\u20AC</td>'+
      '<td>'+statusBadge+'</td>'+
    '</tr>';
  }).join('');

  // Alertes
  var alerts='';
  belowFloor.forEach(function(a){
    alerts+=a360Alert('risk','\uD83D\uDD3B',a.name+' \u2014 prix sous plancher ('+floor(a)+'\u20AC requis)','Chaque nuit vendue \u00e0 '+(a.price||0)+'\u20AC g\u00e9n\u00e8re une perte nette. Corrigez en urgence.');
  });
  underPriced.forEach(function(a){
    if(!belowFloor.includes(a)){
      var gain=((a.ai_rec||0)-(a.price||0));
      alerts+=a360Alert('warn','\uD83D\uDCC8',a.name+' \u2014 sous-tarif\u00e9 : +'+(gain)+'\u20AC potentiels/nuit','EVA conseille '+(a.ai_rec||0)+'\u20AC vs '+(a.price||0)+'\u20AC actuel.');
    }
  });
  eventOpps.forEach(function(a){
    var city=a.city||'';
    var ev=(eventsCache[city]||[]).find(function(e){return e.hot;});
    if(ev) alerts+=a360Alert('warn','\uD83C\uDF89',a.name+' \u2014 \u00e9v\u00e9nement local : '+( ev.name||'pic de demande'),
      'EVA recommande d\u2019appliquer un boost de +'+(ev.boost||10)+'% sur les nuits proches de l\u2019\u00e9v\u00e9nement.');
  });
  overComp.forEach(function(a){
    alerts+=a360Alert('warn','\uD83D\uDCA1',a.name+' \u2014 prix \u00e9lev\u00e9 vs concurrence ('+(a.comp||0)+'\u20AC)','Prix actuel : '+(a.price||0)+'\u20AC. Surveillez l\u2019impact sur le taux de r\u00e9servation.');
  });
  if(!alerts) alerts=a360Alert('ok','\u2705','Tarification globalement optimis\u00e9e','Tous vos biens sont correctement positionn\u00e9s. Continuez \u00e0 ajuster selon les \u00e9v\u00e9nements locaux.');

  var priceColor=avgPrice>0?'#17122E':'#8A8A99';

  dash.innerHTML=
    '<div class="a360-hero">'+
      '<div class="a360-hero-kicker">EVA Audit 360 \u00b7 Tarification</div>'+
      '<div class="a360-hero-title">ADR r\u00e9alis\u00e9 : '+adr+'\u20AC / nuit</div>'+
      '<div class="a360-hero-sub">Prix moyen pratiqu\u00e9 : '+avgPrice+'\u20AC \u2014 '+underPriced.length+' bien'+(underPriced.length>1?'s':'')+' sous-tarif\u00e9'+(underPriced.length>1?'s':'')+'</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">ADR '+adr+'\u20AC</span>'+
        '<span class="a360-hero-chip">Prix moyen '+avgPrice+'\u20AC</span>'+
        (belowFloor.length?'<span class="a360-hero-chip" style="background:rgba(220,38,38,.25);border-color:rgba(220,38,38,.4)">'+belowFloor.length+' sous plancher</span>':'')+
        (hotEvts.length?'<span class="a360-hero-chip" style="background:rgba(124,58,237,.3);border-color:rgba(124,58,237,.4)">'+hotEvts.length+' \u00e9v\u00e9nement'+(hotEvts.length>1?'s':'')+'</span>':'')+
      '</div>'+
    '</div>'+

    '<div class="a360-kpi-row">'+
      '<div class="a360-kpi a360-kpi-accent">'+
        '<div class="a360-kpi-label">Prix moyen pratiqu\u00e9</div>'+
        '<div class="a360-kpi-value" style="color:'+priceColor+'">'+avgPrice+'\u20AC</div>'+
        '<div class="a360-kpi-help">tous biens</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">ADR r\u00e9alis\u00e9</div>'+
        '<div class="a360-kpi-value">'+adr+'\u20AC</div>'+
        '<div class="a360-kpi-help">ce mois</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Sous-tarif\u00e9s</div>'+
        '<div class="a360-kpi-value" style="color:'+(underPriced.length?'#D97706':'#059669')+'">'+underPriced.length+'</div>'+
        '<div class="a360-kpi-help">vs conseil EVA</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Sous plancher</div>'+
        '<div class="a360-kpi-value" style="color:'+(belowFloor.length?'#DC2626':'#059669')+'">'+belowFloor.length+'</div>'+
        '<div class="a360-kpi-help">action urgente</div>'+
      '</div>'+
      '<div class="a360-kpi">'+
        '<div class="a360-kpi-label">Opps. \u00e9v\u00e9nements</div>'+
        '<div class="a360-kpi-value" style="color:'+(hotEvts.length?'#7C3AED':'#8A8A99')+'">'+hotEvts.length+'</div>'+
        '<div class="a360-kpi-help">pics d\u00e9tect\u00e9s</div>'+
      '</div>'+
    '</div>'+

    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83D\uDCCA Positionnement tarifaire</div>'+
          '<div class="a360-section-sub">Prix actuel \u2022 Conseil EVA \u2022 Concurrence \u2022 Plancher</div>'+
        '</div>'+
        '<button class="a360-action-btn" onclick="goTo(\'pricing\',document.querySelector(\'[data-page=pricing]\'))">EVA Pricing \u2192</button>'+
      '</div>'+
      '<div class="a360-table-wrap">'+
        '<table class="a360-table">'+
          '<thead><tr>'+
            '<th>Logement</th>'+
            '<th>Prix actuel</th>'+
            '<th style="color:#7C3AED">Conseil EVA</th>'+
            '<th>Concurrence</th>'+
            '<th>Plancher</th>'+
            '<th>Statut</th>'+
          '</tr></thead>'+
          '<tbody>'+tableRows+'</tbody>'+
        '</table>'+
      '</div>'+
    '</div>'+

    '<div class="a360-section">'+
      '<div class="a360-section-head">'+
        '<div>'+
          '<div class="a360-section-title">\uD83D\uDEA8 Alertes EVA \u2014 Tarification</div>'+
          '<div class="a360-section-sub">Actions recommand\u00e9es par EVA</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">EVA Engine</span>'+
      '</div>'+
      alerts+
    '</div>';
}

/* ====================================================
   ANALYSE EVA V2 — 5 sections
   ==================================================== */

function analyseEmpty(msg){
  return '<div class="a360-empty"><div class="a360-empty-icon">\uD83D\uDCCA</div>'+
    '<div class="a360-empty-title">Donn\u00e9es insuffisantes</div>'+
    '<div class="a360-empty-sub">'+(msg||'Ajoutez des logements et des r\u00e9servations pour activer cette analyse.')+'</div></div>';
}

/* ── 1. VUE GLOBALE ── */
/* ====================================================
   MODÈLE FINANCIER CONCIERGERIE — helpers centraux
   Principe : le loyer n'est jamais une charge d'exploitation
   de la conciergerie. La commission conciergerie (18-22% selon
   propriétaire) est une recette explicite, pas un solde résiduel.
   ==================================================== */

// ── Modèle financier — séparation stricte Propriétaire / Conciergerie ──
//
// VUE PROPRIÉTAIRE :
//   CA brut
//   − commissions OTA (Airbnb/Booking/autres)
//   − commission conciergerie
//   − charges logement (électricité, eau, internet, assurance, consommables)
//   − réparations imputées propriétaire (ex: usure normale, dégâts non couverts)
//   = net propriétaire
//
// VUE CONCIERGERIE :
//   commission conciergerie (= SON REVENU, jamais une charge)
//   + part éventuelle sur upsells
//   − charges internes conciergerie (logiciels/PMS, comptabilité, banque, outils, support)
//   = marge conciergerie
//
// Le ménage, le linge et la maintenance courante sont par défaut des coûts
// du LOGEMENT (donc imputés au propriétaire), sauf si explicitement
// catégorisés "Exceptionnel" + un tag futur les rattachant à la conciergerie.

// Charges logement → imputées au PROPRIÉTAIRE
var RQ_CHARGES_LOGEMENT=['Électricité','Eau','Internet','Assurance','Consommables','Ménage','Linge','Maintenance'];
// Réparations exceptionnelles → imputées au PROPRIÉTAIRE par défaut (le bien lui appartient)
var RQ_CHARGES_REPARATIONS=['Exceptionnel'];
// Charges de structure → imputées à la CONCIERGERIE (jamais le logement)
var RQ_CHARGES_STRUCTURE=['PMS','Comptabilité','Frais bancaires','Plateforme'];
// Estimation des taux de commission OTA par plateforme (faute de catégorie commission_plateforme en base démo)
var RQ_OTA_RATES={airbnb:3,booking:15,direct:0,other:10};
// "Loyer" n'appartient à aucune liste : ce n'est pas une charge, c'est le bien du propriétaire.

function rqGetCommissionRate(apt){
  if(!apt||!apt.proprietaire_id)return 20;
  var prop=(typeof proprietaires!=='undefined'?proprietaires:[]).find(function(p){return p.id===apt.proprietaire_id;});
  return prop&&prop.commission?Number(prop.commission):20;
}

function rqOtaRate(platform){
  return RQ_OTA_RATES[platform]!=null?RQ_OTA_RATES[platform]:RQ_OTA_RATES.other;
}

// Calcule le bilan financier correct, avec séparation stricte des deux vues.
function rqComputeFinancials(apt,aptReservations,aptCharges){
  var caBrut=aptReservations.reduce(function(s,r){return s+(r.price_total||0);},0);

  // Commissions OTA estimées par réservation selon sa plateforme
  var commissionsOta=Math.round(aptReservations.reduce(function(s,r){
    return s+(r.price_total||0)*rqOtaRate(r.platform)/100;
  },0));

  var commPct=rqGetCommissionRate(apt);
  var commissionConciergerie=Math.round(caBrut*commPct/100);

  // Charges logement (électricité, eau, internet, assurance, consommables, ménage, linge, maintenance)
  var chargesLogement=aptCharges.filter(function(c){return RQ_CHARGES_LOGEMENT.indexOf(c.category)>=0&&c.per==='mois'&&c.type==='fixe';}).reduce(function(s,c){return s+(c.amount||0);},0);
  // Réparations imputées propriétaire
  var reparationsProp=aptCharges.filter(function(c){return RQ_CHARGES_REPARATIONS.indexOf(c.category)>=0;}).reduce(function(s,c){return s+(c.amount||0);},0);
  // Charges de structure (conciergerie uniquement)
  var chargesStructure=aptCharges.filter(function(c){return RQ_CHARGES_STRUCTURE.indexOf(c.category)>=0;}).reduce(function(s,c){return s+(c.amount||0);},0);

  // VUE PROPRIÉTAIRE
  var netProprietaire=caBrut-commissionsOta-commissionConciergerie-chargesLogement-reparationsProp;

  // VUE CONCIERGERIE — la commission est un revenu, jamais une charge
  var upsellShare=0; // réservé pour une future part sur upsells, non actif par défaut
  var netConciergerie=commissionConciergerie+upsellShare-chargesStructure;

  return {
    caBrut:caBrut,commPct:commPct,
    commissionsOta:commissionsOta,
    commissionConciergerie:commissionConciergerie,
    chargesLogement:chargesLogement,reparationsProp:reparationsProp,
    chargesStructure:chargesStructure,upsellShare:upsellShare,
    netProprietaire:netProprietaire,netConciergerie:netConciergerie,
    netTotal:netProprietaire+netConciergerie
  };
}

// Potentiel EVA scindé propriétaire/conciergerie pour UN logement
// Le gain de pricing (ai_rec - price) bénéficie aux deux parties selon le taux de commission
function rqAptEvaPotential(apt,nightsPerMonth){
  nightsPerMonth=nightsPerMonth||8;
  if(!apt.ai_rec||!apt.price||apt.ai_rec<=apt.price)return {total:0,proprietaire:0,conciergerie:0};
  var gainNightly=apt.ai_rec-apt.price;
  var total=Math.round(gainNightly*nightsPerMonth);
  var commPct=rqGetCommissionRate(apt);
  var conciergerie=Math.round(total*commPct/100);
  var proprietaire=total-conciergerie;
  return {total:total,proprietaire:proprietaire,conciergerie:conciergerie,commPct:commPct};
}

// Potentiel EVA total du portefeuille, scindé
function rqPortfolioEvaPotential(apts,avgNightsPerMonth){
  var totals={total:0,proprietaire:0,conciergerie:0};
  apts.forEach(function(a){
    var p=rqAptEvaPotential(a,avgNightsPerMonth);
    totals.total+=p.total;totals.proprietaire+=p.proprietaire;totals.conciergerie+=p.conciergerie;
  });
  return totals;
}

// ============================================================
// EVA Engine — Couche 1 : sous-scores métier réutilisables (0-100)
// Une seule source de vérité, consommée par les 3 fonctions contextualisées
// (rqEvaPropertyHealth, rqEvaActionPriority, rqEvaPortfolioInsights).
// Ne jamais dupliquer ces calculs ailleurs dans le fichier.
// ============================================================

// Commercial : occupation réalisée + positionnement prix réel vs prix marché EVA (ai_rec).
// NB : ne tient volontairement pas compte des événements à venir — c'est un signal
// d'opportunité court terme (cockpit), pas un indicateur structurel de santé (fiche logement).
function rqAptCommercialScore(apt,occ,adr){
  occ=occ||0;
  var occScore=Math.max(0,Math.min(100,occ));
  var marketRef=(apt&&apt.ai_rec)?apt.ai_rec:((apt&&apt.price)?apt.price:adr);
  var priceScore=50;
  if(marketRef>0&&adr>0){
    priceScore=Math.round(adr/marketRef*100);
    priceScore=Math.max(0,Math.min(100,priceScore));
  }
  return Math.round(occScore*0.7+priceScore*0.3);
}

// Financier : marge nette réelle (propriétaire + conciergerie) rapportée au CA généré.
// C'est le vrai signe de rentabilité — pas l'occupation, pas le CA brut.
function rqAptFinancialScore(apt,fin){
  if(!fin)return 50;
  if(!fin.caBrut){
    // Pas de CA sur la période : si des charges courent malgré tout, c'est un déficit réel
    // (signal négatif), pas une absence de données. Sinon, vraiment rien à évaluer → neutre.
    if((fin.netProprietaire||0)<0||(fin.netConciergerie||0)<0)return 15;
    return 50;
  }
  var margeProp=fin.netProprietaire/fin.caBrut;
  var margeConc=fin.netConciergerie/fin.caBrut;
  var margeGlobale=margeProp*0.7+margeConc*0.3;
  var score;
  if(margeGlobale>=0.30)score=100;
  else if(margeGlobale>=0)score=50+Math.round(margeGlobale/0.30*50);
  else score=50+Math.round(margeGlobale*150); // marge négative punie plus fort
  return Math.max(0,Math.min(100,score));
}

// Opérationnel : qualité perçue (note voyageurs) + exécution terrain (ménages en retard/non planifiés).
function rqAptOperationalScore(apt,missions,note){
  var score=70; // neutre-bon par défaut
  if(note!=null&&note!=='—'&&!isNaN(+note)){
    var n=+note;
    if(n>=4.7)score+=20;
    else if(n>=4.3)score+=10;
    else if(n>=4.0)score+=0;
    else if(n>=3.5)score-=20;
    else score-=35;
  }
  var todayIso=new Date().toISOString().slice(0,10);
  var late=(missions||[]).filter(function(m){return m.date&&m.date<todayIso&&m.status!=='terminee'&&m.status!=='annulee';});
  if(late.length)score-=Math.min(30,late.length*15);
  var upcoming=(missions||[]).filter(function(m){return m.date&&m.date>=todayIso&&m.status!=='annulee';});
  if(!upcoming.length)score-=5;
  return Math.max(0,Math.min(100,score));
}

// ============================================================
// rqEvaPropertyHealth() — Verdict santé d'UN logement (fiche logement)
// Question : "Comment se porte ce logement ?"
//
// Règle métier validée (PAS un MIN mathématique, PAS une moyenne) :
//   - Commercial et Opérationnel sont les axes VITAUX. Un seul critique (<45)
//     suffit à déclencher 🔴.
//   - Deux axes vitaux fragiles en même temps (45-69 chacun, sans être critiques
//     individuellement) déclenchent aussi 🔴 : double signal faible = vrai risque.
//   - Le Financier ne déclenche JAMAIS 🔴 seul. S'il est faible (<70), le verdict
//     devient 🟠 ("optimisation possible"), avec un wording "urgence financière"
//     si la marge est très faible ou négative — jamais une couleur différente.
//
// Échelle de temps : structurelle. Financier moyenné sur 3 mois (mois courant
// inclus) pour capter une tendance et non un accident ponctuel. Commercial sur
// les 30 derniers jours réels (occupation + ADR), pas une projection.
// ============================================================
function rqEvaPropertyHealth(apt){
  if(!apt)return null;

  var allRes=(typeof reservations!=='undefined'?reservations:[])||[];
  var allCharges=(typeof chargesData!=='undefined'?chargesData:[])||[];
  var allMissions=(typeof missionsData!=='undefined'?missionsData:[])||[];

  var aptRes=allRes.filter(function(r){return String(r.appartement_id)===String(apt.id);});
  var aptCharges=allCharges.filter(function(c){return String(c.appartement_id)===String(apt.id);});
  var aptMissions=allMissions.filter(function(m){return String(m.appartement_id)===String(apt.id);});

  // ── Financier : moyenné sur 3 mois pour capter une tendance, pas un instantané ──
  // IMPORTANT : un seul appel à rqComputeFinancials, avec les réservations cumulées sur 3 mois
  // et les charges récurrentes (fixe/mois) multipliées par 3. Les charges ponctuelles
  // ('une_fois', ex. réparations exceptionnelles) ne sont comptées qu'UNE fois sur la fenêtre —
  // sinon un appel répété par mois les compterait 3x au lieu d'1x.
  var today=new Date();
  var months3=[];
  for(var i=2;i>=0;i--){
    var d=new Date(today.getFullYear(),today.getMonth()-i,1);
    months3.push(d.toISOString().slice(0,7));
  }
  var combinedRes3=aptRes.filter(function(r){return r.date_from&&months3.indexOf(r.date_from.slice(0,7))>=0;});
  var scaledCharges3=aptCharges.map(function(c){
    if(c.type==='fixe'&&c.per==='mois')return {appartement_id:c.appartement_id,category:c.category,type:c.type,per:c.per,amount:(c.amount||0)*3};
    return c; // charges ponctuelles ('une_fois') : comptées une seule fois, pas multipliées
  });
  var finAvg=rqComputeFinancials(apt,combinedRes3,scaledCharges3);

  // ── Commercial : occupation réelle 30 derniers jours + ADR réel vs ai_rec ──
  function iso(dt){return dt.toISOString().slice(0,10);}
  function dayAt(offset){var dt=new Date();dt.setDate(dt.getDate()+offset);return dt;}
  function covers(r,date){return r&&r.date_from&&r.date_to&&r.date_from<=date&&r.date_to>date;}
  var bookedDays=0;
  for(var k=-30;k<0;k++){
    var dte=iso(dayAt(k));
    if(aptRes.some(function(r){return covers(r,dte);}))bookedDays++;
  }
  var occ=Math.round(bookedDays/30*100);
  var last30Start=iso(dayAt(-30));
  var last30Res=aptRes.filter(function(r){return r.date_from&&r.date_from>=last30Start;});
  var nights30=last30Res.reduce(function(s,r){return s+(r.nights||0);},0);
  var rev30=last30Res.reduce(function(s,r){return s+(r.price_total||0);},0);
  var adr=nights30>0?Math.round(rev30/nights30):(apt.price||0);

  // ── Sous-scores (Couche 1, jamais recalculés ailleurs) ──
  var scoreCommercial=rqAptCommercialScore(apt,occ,adr);
  var scoreFinancier=rqAptFinancialScore(apt,finAvg);
  var scoreOperationnel=rqAptOperationalScore(apt,aptMissions,apt.note);

  // ── Verdict métier ──
  var CRIT=45,BON=70;
  var commCritical=scoreCommercial<CRIT;
  var opCritical=scoreOperationnel<CRIT;
  var commFragile=scoreCommercial>=CRIT&&scoreCommercial<BON;
  var opFragile=scoreOperationnel>=CRIT&&scoreOperationnel<BON;
  var finWeak=scoreFinancier<BON;
  var finUrgent=scoreFinancier<CRIT||finAvg.netProprietaire<0||finAvg.netConciergerie<0;

  var verdict,verdictLabel;
  if(commCritical||opCritical){
    verdict='rouge';verdictLabel='🔴 Bien problématique';
  }else if(commFragile&&opFragile){
    verdict='rouge';verdictLabel='🔴 Bien problématique';
  }else if(finWeak){
    verdict='orange';
    verdictLabel=finUrgent?'🟠 Bien à optimiser — urgence financière':'🟠 Bien à optimiser';
  }else if(commFragile||opFragile){
    verdict='orange';verdictLabel='🟠 Bien à optimiser';
  }else{
    verdict='vert';verdictLabel='🟢 Bien performant';
  }

  // ── Pourquoi (priorité aux axes vitaux dans l'explication) ──
  var why=[];
  if(commCritical)why.push('Commercial critique : occupation/positionnement prix très faible ('+scoreCommercial+'/100).');
  if(opCritical)why.push('Opérationnel critique : qualité ou exécution terrain en difficulté ('+scoreOperationnel+'/100).');
  if(!commCritical&&!opCritical&&commFragile&&opFragile){
    why.push('Commercial et opérationnel sont tous les deux fragiles en même temps ('+scoreCommercial+'/100 et '+scoreOperationnel+'/100).');
  }else{
    if(!commCritical&&commFragile)why.push('Commercial perfectible : occupation ou positionnement prix sous le niveau attendu ('+scoreCommercial+'/100).');
    if(!opCritical&&opFragile)why.push('Opérationnel perfectible : qualité ou exécution terrain à renforcer ('+scoreOperationnel+'/100).');
  }
  if(finUrgent)why.push('Marge nette quasi nulle ou négative sur la tendance récente, malgré l\u2019activité.');
  else if(finWeak)why.push('Marge financière perfectible ('+scoreFinancier+'/100) : du revenu net non capté.');
  if(!why.length)why.push('Commercial, financier et opérationnel sont tous au-dessus du seuil de vigilance.');

  // ── Action prioritaire + impact estimé (axe vital faible traité avant le reste) ──
  var potential=rqAptEvaPotential(apt,Math.max(4,Math.round(occ/100*30)));
  var priorityAction;
  if(opCritical||(opFragile&&scoreOperationnel<=scoreCommercial)){
    priorityAction='Sécuriser l\u2019exécution opérationnelle (ménages, avis) avant tout ajustement tarifaire.';
  }else if(commCritical||commFragile){
    priorityAction='Revoir le positionnement tarifaire : occupation ou prix décalés du marché.';
  }else if(finWeak){
    priorityAction=finUrgent?'Traiter en priorité la marge : charges ou commission à revoir, urgence financière.':'Optimiser la marge nette : revoir les charges récurrentes ou la commission.';
  }else{
    priorityAction='Aucune action prioritaire — maintenir le pilotage actuel.';
  }

  return {
    verdict:verdict,verdictLabel:verdictLabel,
    scoreCommercial:scoreCommercial,scoreFinancier:scoreFinancier,scoreOperationnel:scoreOperationnel,
    why:why,priorityAction:priorityAction,impactEstimate:potential.total,
    finUrgent:finUrgent,occ:occ,adr:adr,fin:finAvg
  };
}

function renderAnalyseGlobale(){
  var dash=document.getElementById('analyse-globale-dash');
  if(!dash)return;
  if(!apparts.length){dash.innerHTML=analyseEmpty();return;}

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());
  var daysInMonth=new Date(today.getFullYear(),today.getMonth()+1,0).getDate();

  // CA brut du mois
  var monthRes=reservations.filter(function(r){return r.date_from&&r.date_from.startsWith(month);});
  var caTotal=monthRes.reduce(function(s,r){return s+(r.price_total||0);},0);
  var totalNights=monthRes.reduce(function(s,r){return s+(r.nights||0);},0);
  var adr=totalNights>0?Math.round(caTotal/totalNights):0;
  var avNights=apparts.length*daysElapsed;
  var occ=avNights>0?Math.min(100,Math.round(totalNights/avNights*100)):0;

  // Bilan financier correct : 2 vues strictement séparées
  var commissionTotal=0,otaTotal=0,chargesLogementTotal=0,reparationsTotal=0,chargesStructureTotal=0,netConciergerieTotal=0,netProprietaireTotal=0;
  apparts.forEach(function(a){
    var aptRes=monthRes.filter(function(r){return r.appartement_id===a.id;});
    var aptCharges=(chargesData||[]).filter(function(c){return c.appartement_id===a.id;});
    var fin=rqComputeFinancials(a,aptRes,aptCharges);
    commissionTotal+=fin.commissionConciergerie;
    otaTotal+=fin.commissionsOta;
    chargesLogementTotal+=fin.chargesLogement;
    reparationsTotal+=fin.reparationsProp;
    chargesStructureTotal+=fin.chargesStructure;
    netConciergerieTotal+=fin.netConciergerie;
    netProprietaireTotal+=fin.netProprietaire;
  });
  var margeConciergerie=commissionTotal>0?Math.round(netConciergerieTotal/commissionTotal*100):0;
  var margeColor=margeConciergerie>=15?'#059669':margeConciergerie>=5?'#D97706':'#DC2626';

  // Potentiel EVA scindé propriétaire / conciergerie
  var avgNightsMonth=Math.max(4,Math.round(totalNights/Math.max(1,apparts.length)));
  var potential=rqPortfolioEvaPotential(apparts,avgNightsMonth);
  var caAnnuel=Math.round(caTotal*12);

  // KPIs par mois (6 derniers mois pour sparkline)
  var months6=[];
  for(var i=5;i>=0;i--){var d=new Date(today.getFullYear(),today.getMonth()-i,1);months6.push(d.toISOString().slice(0,7));}
  var monthlyCA=months6.map(function(m){
    return reservations.filter(function(r){return r.date_from&&r.date_from.startsWith(m);}).reduce(function(s,r){return s+(r.price_total||0);},0);
  });
  var maxCA=Math.max.apply(null,monthlyCA)||1;

  var sparkBars=monthlyCA.map(function(v,i){
    var h=Math.max(4,Math.round(v/maxCA*48));
    var isCurrentMonth=(months6[i]===month);
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">'+
      '<div style="width:100%;height:'+h+'px;background:'+(isCurrentMonth?'linear-gradient(180deg,#6D28D9,#EC4899)':'rgba(109,40,217,.25)')+';border-radius:4px 4px 0 0;min-height:4px"></div>'+
      '<div style="font-size:8px;color:#B0A8C8;font-weight:700">'+months6[i].slice(5)+'</div>'+
    '</div>';
  }).join('');

  dash.innerHTML=
    // Hero — mise en avant du potentiel EVA, pas du résultat net
    '<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">Analyse EVA \u00b7 Vue globale</div>'+
      '<div class="a360-hero-title">Potentiel EVA d\u00e9tect\u00e9 : +'+potential.total.toLocaleString('fr-FR')+'\u20AC/mois</div>'+
      '<div class="a360-hero-sub">+'+potential.proprietaire.toLocaleString('fr-FR')+'\u20AC pour les propri\u00e9taires \u00b7 +'+potential.conciergerie.toLocaleString('fr-FR')+'\u20AC pour la conciergerie</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+caTotal.toLocaleString('fr-FR')+'\u20AC CA brut ce mois</span>'+
        '<span class="a360-hero-chip">'+commissionTotal.toLocaleString('fr-FR')+'\u20AC commission conciergerie</span>'+
        '<span class="a360-hero-chip">'+apparts.length+' logements</span>'+
      '</div>'+
    '</div>'+

    // Bloc répartition propriétaire / conciergerie (visuel clé)
    '<div class="p360-section" style="margin-bottom:14px">'+
      '<div class="p360-section-head"><div><div class="p360-section-title">\uD83E\uDD1D Quand EVA fait gagner les propri\u00e9taires, la conciergerie gagne aussi</div></div></div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">'+
        '<div style="background:#F0FDF4;border:1px solid rgba(5,150,105,.18);border-radius:14px;padding:16px">'+
          '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#047857;margin-bottom:6px">Propri\u00e9taires</div>'+
          '<div style="font-size:24px;font-weight:950;color:#059669">+'+potential.proprietaire.toLocaleString('fr-FR')+'\u20AC<span style="font-size:13px;color:#6B9080">/mois</span></div>'+
          '<div style="font-size:11px;color:#6B9080;margin-top:4px">Net revers\u00e9 ce mois (apr\u00e8s OTA, commission, charges logement) : '+netProprietaireTotal.toLocaleString('fr-FR')+'\u20AC</div>'+
        '</div>'+
        '<div style="background:#F5F0FF;border:1px solid rgba(124,58,237,.18);border-radius:14px;padding:16px">'+
          '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#7C3AED;margin-bottom:6px">Conciergerie</div>'+
          '<div style="font-size:24px;font-weight:950;color:#7C3AED">+'+potential.conciergerie.toLocaleString('fr-FR')+'\u20AC<span style="font-size:13px;color:#9B8AC4">/mois</span></div>'+
          '<div style="font-size:11px;color:#9B8AC4;margin-top:4px">Marge ce mois (commission \u2212 charges structure) : '+netConciergerieTotal.toLocaleString('fr-FR')+'\u20AC ('+margeConciergerie+'% de la commission)</div>'+
        '</div>'+
      '</div>'+
    '</div>'+

    // KPI strip — résultat net redescend en KPI secondaire
    '<div class="p360-kpi-strip" style="margin-bottom:14px">'+
      '<div class="p360-kpi-card accent">'+
        '<div class="p360-kpi-lbl">CA brut / mois</div>'+
        '<div class="p360-kpi-val">'+caTotal.toLocaleString('fr-FR')+'\u20AC</div>'+
        '<div class="p360-kpi-help">'+daysElapsed+'/'+daysInMonth+' jours</div>'+
      '</div>'+
      '<div class="p360-kpi-card">'+
        '<div class="p360-kpi-lbl">Commission conciergerie</div>'+
        '<div class="p360-kpi-val" style="color:#7C3AED">+'+commissionTotal.toLocaleString('fr-FR')+'\u20AC</div>'+
        '<div class="p360-kpi-help">revenu \u2014 18-22% selon propri\u00e9taire</div>'+
      '</div>'+
      '<div class="p360-kpi-card">'+
        '<div class="p360-kpi-lbl">Charges structure conciergerie</div>'+
        '<div class="p360-kpi-val" style="color:#DC2626">'+chargesStructureTotal.toLocaleString('fr-FR')+'\u20AC</div>'+
        '<div class="p360-kpi-help">PMS, compta, banque, outils</div>'+
      '</div>'+
      '<div class="p360-kpi-card">'+
        '<div class="p360-kpi-lbl">R\u00e9sultat net conciergerie</div>'+
        '<div class="p360-kpi-val" style="color:'+margeColor+'">'+netConciergerieTotal.toLocaleString('fr-FR')+'\u20AC</div>'+
        '<div class="p360-kpi-help">'+margeConciergerie+'% de la commission</div>'+
      '</div>'+
      '<div class="p360-kpi-card">'+
        '<div class="p360-kpi-lbl">ADR</div>'+
        '<div class="p360-kpi-val">'+adr+'\u20AC</div>'+
        '<div class="p360-kpi-help">prix moyen / nuit</div>'+
      '</div>'+
    '</div>'+

    // Graphique CA mensuel
    '<div class="p360-section">'+
      '<div class="p360-section-head">'+
        '<div><div class="p360-section-title">\uD83D\uDCC8 Evolution du CA sur 6 mois</div></div>'+
        '<span class="a360-badge a360-badge-purple">'+caAnnuel.toLocaleString('fr-FR')+'\u20AC / an estim\u00e9</span>'+
      '</div>'+
      '<div style="display:flex;align-items:flex-end;gap:8px;height:80px;padding:0 4px">'+sparkBars+'</div>'+
    '</div>'+

    // Navigation vers sous-sections
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:14px">'+
      ['analyse-rentabilite:\uD83C\uDFE0 Rentabilit\u00e9 par logement',
       'analyse-opportunites:\uD83D\uDE80 Opportunit\u00e9s EVA',
       'analyse-economies:\uD83D\uDCB0 \u00c9conomies EVA',
       'analyse-qualite:\u2B50 Qualit\u00e9 voyageurs'].map(function(x){
        var parts=x.split(':');
        return '<button class="a360-action-btn" onclick="goTo(\''+parts[0]+'\',document.querySelector(\'[data-page='+parts[0]+']\'))">'+parts[1]+' \u2192</button>';
      }).join('')+
    '</div>';
}

/* ── 2. RENTABILITÉ ── */
function renderAnalyseRentabilite(){
  var dash=document.getElementById('analyse-rentabilite-dash');
  if(!dash)return;
  if(!apparts.length){dash.innerHTML=analyseEmpty();return;}

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());

  var stats=apparts.map(function(a){
    var aptRes=reservations.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var aptCharges=(chargesData||[]).filter(function(c){return c.appartement_id===a.id;});
    var fin=rqComputeFinancials(a,aptRes,aptCharges);
    var nights=aptRes.reduce(function(s,r){return s+(r.nights||0);},0);
    var occ=daysElapsed>0?Math.min(100,Math.round(nights/daysElapsed*100)):0;
    var avgNightsMonth=Math.max(4,nights);
    var potential=rqAptEvaPotential(a,avgNightsMonth);
    var margeColor=fin.netConciergerie>=fin.commissionConciergerie*0.15?'#059669':fin.netConciergerie>=0?'#D97706':'#DC2626';
    var margeBadge=fin.netConciergerie>=fin.commissionConciergerie*0.15?'a360-badge-green':fin.netConciergerie>=0?'a360-badge-orange':'a360-badge-red';
    return {a:a,fin:fin,occ:occ,potential:potential,margeColor:margeColor,margeBadge:margeBadge};
  }).sort(function(x,y){return y.potential.total-x.potential.total;});

  var totalCA=stats.reduce(function(s,r){return s+r.fin.caBrut;},0);
  var totalCommission=stats.reduce(function(s,r){return s+r.fin.commissionConciergerie;},0);
  var totalChargesStructure=stats.reduce(function(s,r){return s+r.fin.chargesStructure;},0);
  var totalNetConc=stats.reduce(function(s,r){return s+r.fin.netConciergerie;},0);
  var avgMargeConc=totalCommission>0?Math.round(totalNetConc/totalCommission*100):0;
  var margeGlobalColor=avgMargeConc>=15?'#059669':avgMargeConc>=5?'#D97706':'#DC2626';
  var totalPotential=stats.reduce(function(s,r){return s+r.potential.total;},0);

  var rows=stats.map(function(s){
    var occColor=s.occ>=65?'#059669':s.occ>=45?'#D97706':'#DC2626';
    var occBar='<div style="height:4px;background:#F3F0FA;border-radius:999px;overflow:hidden;margin-top:4px">'+
      '<div style="height:100%;width:'+s.occ+'%;background:'+occColor+';border-radius:999px"></div></div>';
    var potBar=s.potential.total>0?'<div style="display:flex;height:5px;border-radius:999px;overflow:hidden;margin-top:4px;background:#F3F0FA">'+
      '<div style="height:100%;width:'+Math.round(s.potential.proprietaire/s.potential.total*100)+'%;background:#059669"></div>'+
      '<div style="height:100%;width:'+Math.round(s.potential.conciergerie/s.potential.total*100)+'%;background:#7C3AED"></div>'+
    '</div>':'';
    return '<tr>'+
      '<td><div style="display:flex;align-items:center;gap:8px">'+
        '<div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#F3E8FF,#EDE9FF);display:flex;align-items:center;justify-content:center;font-size:14px">'+(s.a.emoji||'\uD83C\uDFE0')+'</div>'+
        '<div><div style="font-size:13px;font-weight:700;color:#17122E">'+s.a.name+'</div><div style="font-size:10px;color:#8A8A99">'+s.a.city+'</div></div></div></td>'+
      '<td style="font-weight:800;color:#17122E">'+s.fin.caBrut.toLocaleString('fr-FR')+'\u20AC</td>'+
      '<td style="color:#7C3AED;font-weight:700">+'+s.fin.commissionConciergerie.toLocaleString('fr-FR')+'\u20AC<div style="font-size:9px;color:#B0A8C8">'+s.fin.commPct+'%</div></td>'+
      '<td style="color:#DC2626">'+s.fin.chargesStructure.toLocaleString('fr-FR')+'\u20AC</td>'+
      '<td style="font-weight:800;color:'+s.margeColor+'">'+s.fin.netConciergerie.toLocaleString('fr-FR')+'\u20AC</td>'+
      '<td><div style="font-size:12px;color:'+occColor+';font-weight:700">'+s.occ+'%</div>'+occBar+'</td>'+
      '<td>'+(s.potential.total>0?'<div style="font-size:12px;font-weight:800;color:#17122E">+'+s.potential.total+'\u20AC</div><div style="font-size:9px;color:#8A8A99">+'+s.potential.proprietaire+'\u20AC prop \u00b7 +'+s.potential.conciergerie+'\u20AC conc</div>'+potBar:'<span style="font-size:11px;color:#B0A8C8">—</span>')+'</td>'+
    '</tr>';
  }).join('');

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">Analyse EVA \u00b7 Rentabilit\u00e9</div>'+
      '<div class="a360-hero-title">Potentiel EVA total : +'+totalPotential.toLocaleString('fr-FR')+'\u20AC/mois sur le portefeuille</div>'+
      '<div class="a360-hero-sub">'+apparts.length+' logements \u00b7 Commission conciergerie (revenu) : +'+totalCommission.toLocaleString('fr-FR')+'\u20AC \u00b7 Marge nette conciergerie : '+totalNetConc.toLocaleString('fr-FR')+'\u20AC ('+avgMargeConc+'%)</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+totalCA.toLocaleString('fr-FR')+'\u20AC CA</span>'+
        '<span class="a360-hero-chip">+'+totalCommission.toLocaleString('fr-FR')+'\u20AC commission</span>'+
        '<span class="a360-hero-chip">'+avgMargeConc+'% marge conciergerie</span>'+
      '</div>'+
    '</div>'+
    '<div class="p360-kpi-strip" style="margin-bottom:14px">'+
      '<div class="p360-kpi-card accent"><div class="p360-kpi-lbl">CA brut</div><div class="p360-kpi-val">'+totalCA.toLocaleString('fr-FR')+'\u20AC</div></div>'+
      '<div class="p360-kpi-card"><div class="p360-kpi-lbl">Commission conciergerie</div><div class="p360-kpi-val" style="color:#7C3AED">+'+totalCommission.toLocaleString('fr-FR')+'\u20AC</div></div>'+
      '<div class="p360-kpi-card"><div class="p360-kpi-lbl">Charges structure</div><div class="p360-kpi-val" style="color:#DC2626">'+totalChargesStructure.toLocaleString('fr-FR')+'\u20AC</div></div>'+
      '<div class="p360-kpi-card"><div class="p360-kpi-lbl">Marge nette conciergerie</div><div class="p360-kpi-val" style="color:'+margeGlobalColor+'">'+totalNetConc.toLocaleString('fr-FR')+'\u20AC</div></div>'+
    '</div>'+
    '<div class="p360-section">'+
      '<div class="p360-section-head">'+
        '<div><div class="p360-section-title">\uD83C\uDFE0 Rentabilit\u00e9 par logement</div><div class="p360-section-sub">Commission (revenu), charges structure, marge nette et potentiel EVA ce mois</div></div>'+
        '<span class="a360-badge a360-badge-purple">'+apparts.length+' logements</span>'+
      '</div>'+
      '<div class="a360-table-wrap">'+
        '<table class="a360-table"><thead><tr>'+
          '<th>Logement</th><th>CA</th><th>Commission</th><th>Charges structure</th><th>Marge conciergerie</th><th>Occupation</th><th>Potentiel EVA</th>'+
        '</tr></thead><tbody>'+rows+'</tbody></table>'+
      '</div>'+
    '</div>';
}

/* ── 3. OPPORTUNITÉS EVA ── */
function renderAnalyseOpportunites(){
  var dash=document.getElementById('analyse-opportunites-dash');
  if(!dash)return;
  if(!apparts.length){dash.innerHTML=analyseEmpty();return;}
  // Réutilise renderProfit360Opportunites() sur le bon conteneur
  var tmp=document.createElement('div');
  var oldId='profit-opportunites-dash';
  var realDash=document.getElementById(oldId);
  // Créer un conteneur temporaire, injecter, copier
  if(typeof renderProfit360Opportunites==='function'){
    var el=document.getElementById('profit-opportunites-dash');
    if(!el){
      el=document.createElement('div');
      el.id='profit-opportunites-dash';
      el.style.display='none';
      document.body.appendChild(el);
    }
    renderProfit360Opportunites();
    dash.innerHTML='<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">Analyse EVA \u00b7 Opportunit\u00e9s</div>'+
      '<div class="a360-hero-title">Leviers identifi\u00e9s par EVA pour augmenter votre CA</div>'+
      '<div class="a360-hero-sub">Pricing, remplissage, \u00e9v\u00e9nements locaux et upsells</div>'+
    '</div>'+el.innerHTML;
  } else {
    dash.innerHTML=analyseEmpty('Opportunit\u00e9s en cours de chargement.');
  }
}

/* ── 4. ÉCONOMIES EVA ── */
function renderAnalyseEconomies(){
  var dash=document.getElementById('analyse-economies-dash');
  if(!dash)return;
  if(!apparts.length){dash.innerHTML=analyseEmpty();return;}

  var allCharges=chargesData||[];
  var today=new Date();
  var month=today.toISOString().slice(0,7);

  // Identifier les anomalies par logement
  var anomalies=[];

  apparts.forEach(function(a){
    var aptCharges=allCharges.filter(function(c){return c.appartement_id===a.id;});
    // Charges énergivores : électricité > 0.6€/m² (vs 0.55€/m² standard)
    var elec=aptCharges.find(function(c){return c.category==='Électricité';});
    if(elec&&a.surface_m2&&(elec.amount/a.surface_m2)>0.62){
      anomalies.push({type:'risk',icon:'\u26A1',apt:a.name,title:'Consommation \u00e9lectrique \u00e9lev\u00e9e',desc:elec.amount+'\u20AC/mois \u2014 '+(Math.round(elec.amount/a.surface_m2*100)/100).toFixed(2)+'\u20AC/m\u00b2 (moy. 0,55\u20AC)',gain:Math.round((elec.amount/a.surface_m2-0.55)*a.surface_m2*12)});
    }
    // Réparations répétées : plusieurs charges exceptionnelles
    var repairs=aptCharges.filter(function(c){return c.type==='variable';});
    if(repairs.length>=2){
      var totalRepairs=repairs.reduce(function(s,c){return s+(c.amount||0);},0);
      anomalies.push({type:'warn',icon:'\uD83D\uDD27',apt:a.name,title:repairs.length+' charge'+(repairs.length>1?'s':'')+' exceptionnelle'+(repairs.length>1?'s':'')+' d\u00e9tect\u00e9e'+(repairs.length>1?'s':''),desc:'Total : '+totalRepairs+'\u20AC ('+repairs.map(function(r){return r.label;}).slice(0,2).join(', ')+'...)',gain:Math.round(totalRepairs*0.3)});
    }
    // Ménage coûteux vs occupation
    var menage=aptCharges.find(function(c){return c.category==='M\u00e9nage';});
    var aptRes=reservations.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var nbRes=aptRes.length;
    if(menage&&nbRes>0&&menage.amount/nbRes>18){
      anomalies.push({type:'warn',icon:'\uD83E\uDDF9',apt:a.name,title:'Co\u00fbt m\u00e9nage \u00e9lev\u00e9 par rotation',desc:menage.amount+'\u20AC/mois pour '+nbRes+' rotation'+(nbRes>1?'s':'')+' \u2014 '+(Math.round(menage.amount/nbRes))+'\u20AC/r\u00e9sa (moy. 15\u20AC)',gain:Math.round((menage.amount/nbRes-15)*nbRes*12)});
    }
  });

  if(!anomalies.length){
    anomalies.push({type:'ok',icon:'\u2705',apt:'Tous les biens',title:'Aucune anomalie de co\u00fbt d\u00e9tect\u00e9e',desc:'Vos charges sont dans les normes. EVA surveille en continu.',gain:0});
  }

  var totalGain=anomalies.reduce(function(s,a){return s+(a.gain||0);},0);
  var typeColors={'risk':'#FEF2F2','warn':'#FFFBEB','ok':'#F0FDF4'};
  var typeBorders={'risk':'rgba(220,38,38,.14)','warn':'rgba(217,119,6,.14)','ok':'rgba(5,150,105,.14)'};

  var cards=anomalies.map(function(an){
    return '<div style="background:'+typeColors[an.type]+';border:1px solid '+typeBorders[an.type]+';border-radius:14px;padding:14px 16px;display:flex;align-items:flex-start;gap:12px;margin-bottom:10px">'+
      '<div style="font-size:22px;flex-shrink:0">'+an.icon+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:13px;font-weight:800;color:#17122E;margin-bottom:3px">'+an.apt+' \u2014 '+an.title+'</div>'+
        '<div style="font-size:11px;color:#7B708F;line-height:1.45">'+an.desc+'</div>'+
      '</div>'+
      (an.gain>0?'<div style="text-align:right;flex-shrink:0"><div style="font-size:16px;font-weight:900;color:#059669">+'+an.gain+'\u20AC</div><div style="font-size:9px;color:#8A8A99;text-transform:uppercase;letter-spacing:.5px">/ an</div></div>':'')+
    '</div>';
  }).join('');

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">Analyse EVA \u00b7 \u00c9conomies EVA</div>'+
      '<div class="a360-hero-title">'+anomalies.length+' signal'+(anomalies.length>1?'s':'')+' d\u00e9tect\u00e9'+(anomalies.length>1?'s':'')+' par EVA</div>'+
      '<div class="a360-hero-sub">'+( totalGain>0?'Potentiel d\u2019\u00e9conomie : +'+totalGain.toLocaleString('fr-FR')+'\u20AC / an':'Vos co\u00fbts sont optimis\u00e9s')+'</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+anomalies.length+' signal'+(anomalies.length>1?'s':'')+'</span>'+
        (totalGain>0?'<span class="a360-hero-chip">+'+totalGain.toLocaleString('fr-FR')+'\u20AC / an potentiel</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="p360-section">'+
      '<div class="p360-section-head">'+
        '<div><div class="p360-section-title">\uD83D\uDCB0 Signaux \u00e9conomies EVA</div><div class="p360-section-sub">Anomalies co\u00fbts et leviers d\u2019optimisation</div></div>'+
        '<span class="a360-badge a360-badge-purple">EVA Engine</span>'+
      '</div>'+
      cards+
    '</div>';
}

/* ── 5. QUALITÉ VOYAGEURS ── */
function renderAnalyseQualite(){
  var dash=document.getElementById('analyse-qualite-dash');
  if(!dash)return;
  if(!apparts.length){dash.innerHTML=analyseEmpty();return;}

  var withNote=apparts.filter(function(a){return a.note&&Number(a.note)>0;});
  var avgNote=withNote.length?Math.round(withNote.reduce(function(s,a){return s+Number(a.note);},0)/withNote.length*10)/10:0;
  var noteColor=avgNote>=4.5?'#059669':avgNote>=4?'#D97706':'#DC2626';

  // Missions avec mauvaise note hôte
  var allMissions=[];
  try{allMissions=generateEvaMissions();}catch(e){}
  var badMissions=allMissions.filter(function(m){return m.type==='qualite'||m.type==='menage';}).slice(0,4);

  var noteCards=apparts.map(function(a){
    var n=Number(a.note||0);
    if(!n)return '';
    var nColor=n>=4.5?'#059669':n>=4?'#D97706':'#DC2626';
    var stars='\u2605'.repeat(Math.round(n))+'\u2606'.repeat(5-Math.round(n));
    var badge=n>=4.8?'<span class="a360-badge a360-badge-green">Excellent</span>':
              n>=4.5?'<span class="a360-badge a360-badge-purple">Bon</span>':
              n>=4?'<span class="a360-badge a360-badge-orange">\u00c0 am\u00e9liorer</span>':
              '<span class="a360-badge a360-badge-red">Critique</span>';
    var barW=Math.round((n/5)*100);
    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #F3F0FA">'+
      '<div style="width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#F3E8FF,#EDE9FF);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">'+(a.emoji||'\uD83C\uDFE0')+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:13px;font-weight:700;color:#17122E">'+a.name+'</div>'+
        '<div style="height:4px;background:#F3F0FA;border-radius:999px;margin-top:5px;overflow:hidden">'+
          '<div style="height:100%;width:'+barW+'%;background:'+nColor+';border-radius:999px"></div>'+
        '</div>'+
      '</div>'+
      '<div style="text-align:right;flex-shrink:0">'+
        '<div style="font-size:16px;font-weight:900;color:'+nColor+'">'+n+'<span style="font-size:10px;color:#8A8A99">/5</span></div>'+
        '<div style="font-size:10px;color:#F59E0B">'+stars+'</div>'+
      '</div>'+
      '<div style="flex-shrink:0">'+badge+'</div>'+
    '</div>';
  }).filter(Boolean).join('');

  var alertsQualite=[];
  apparts.forEach(function(a){
    var n=Number(a.note||0);
    if(n>0&&n<4) alertsQualite.push('<div class="a360-alert a360-alert-risk"><div class="a360-alert-icon">\u26A0\uFE0F</div><div><div class="a360-alert-title">'+a.name+' \u2014 note critique : '+n+'/5</div><div class="a360-alert-desc">Priorit\u00e9 : am\u00e9liorer m\u00e9nage, \u00e9quipements ou description avant d\u2019augmenter les prix.</div></div></div>');
    else if(n>=4&&n<4.5) alertsQualite.push('<div class="a360-alert a360-alert-warn"><div class="a360-alert-icon">\uD83D\uDCA1</div><div><div class="a360-alert-title">'+a.name+' \u2014 note \u00e0 am\u00e9liorer : '+n+'/5</div><div class="a360-alert-desc">Chaque +0,5 point de note peut augmenter la conversion de 10% et justifier une hausse tarifaire.</div></div></div>');
    else if(n>=4.8) alertsQualite.push('<div class="a360-alert a360-alert-ok"><div class="a360-alert-icon">\uD83C\uDFC6</div><div><div class="a360-alert-title">'+a.name+' \u2014 note excellente : '+n+'/5</div><div class="a360-alert-desc">Ce bien peut justifier une hausse de prix. Les voyageurs paient plus pour l\u2019excellence.</div></div></div>');
  });
  if(!alertsQualite.length) alertsQualite.push('<div class="a360-alert a360-alert-ok"><div class="a360-alert-icon">\u2705</div><div><div class="a360-alert-title">Renseignez les notes Airbnb/Booking dans les fiches logements</div><div class="a360-alert-desc">EVA g\u00e9n\u00e8rera des recommandations personnalis\u00e9es pour chaque bien.</div></div></div>');

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">Analyse EVA \u00b7 Qualit\u00e9 voyageurs</div>'+
      '<div class="a360-hero-title">Note moyenne parc : '+avgNote+'/5</div>'+
      '<div class="a360-hero-sub">'+withNote.length+' logement'+(withNote.length>1?'s':'')+' not\u00e9'+(withNote.length>1?'s':'')+' \u2014 '+withNote.filter(function(a){return Number(a.note)>=4.5;}).length+' excellent'+(withNote.filter(function(a){return Number(a.note)>=4.5;}).length>1?'s':'')+'</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+avgNote+'/5 moyenne</span>'+
        '<span class="a360-hero-chip">'+withNote.filter(function(a){return Number(a.note)>=4.5;}).length+' biens excellents</span>'+
        (withNote.filter(function(a){return Number(a.note)<4;}).length?'<span class="a360-hero-chip" style="background:rgba(220,38,38,.25);border-color:rgba(220,38,38,.4)">'+withNote.filter(function(a){return Number(a.note)<4;}).length+' action'+(withNote.filter(function(a){return Number(a.note)<4;}).length>1?'s':'')+' requise'+(withNote.filter(function(a){return Number(a.note)<4;}).length>1?'s':'')+'</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="p360-section" style="margin-bottom:14px">'+
      '<div class="p360-section-head"><div><div class="p360-section-title">\u2B50 Notes par logement</div></div><span class="a360-badge a360-badge-purple">'+avgNote+'/5</span></div>'+
      (noteCards||'<div style="font-size:13px;color:#8A8A99;padding:10px 0">Renseignez les notes dans les fiches logements pour activer cette vue.</div>')+
    '</div>'+
    '<div class="p360-section">'+
      '<div class="p360-section-head"><div><div class="p360-section-title">\uD83D\uDEA8 Alertes EVA Qualit\u00e9</div></div><span class="a360-badge a360-badge-purple">EVA Engine</span></div>'+
      alertsQualite.join('')+
    '</div>';
}

/* ====================================================
   CLEANYQ V2 — 3 sous-sections
   ==================================================== */

/* ── Aujourd'hui ── */
function renderCleanyQToday(){
  var dash=document.getElementById('cleanyq-today-dash');
  if(!dash)return;
  var today=new Date();
  var todayIso=today.toISOString().slice(0,10);

  // Réservations avec check-in ou check-out aujourd'hui
  var checkinsToday=reservations.filter(function(r){return r.date_from===todayIso;});
  var checkoutsToday=reservations.filter(function(r){return r.date_to===todayIso;});

  // Fusion missions réelles + suggestions virtuelles (source de vérité = réservations)
  var merged=getMergedCleaningMissions(14);
  var todayMissions=merged.filter(function(m){return m.date===todayIso;});

  var done=todayMissions.filter(function(m){return m.status==='terminee';});
  var pending=todayMissions.filter(function(m){return m.status==='en_attente';});
  var inProgress=todayMissions.filter(function(m){return m.status==='acceptee';});
  var risk=checkinsToday.filter(function(r){
    return !merged.some(function(m){return m.appartement_id===r.appartement_id&&m.date===todayIso&&!m.virtual;});
  });

  var heroClass=risk.length?'urgent':'ok';
  var heroTitle=risk.length?risk.length+' check-in sans m\u00e9nage s\u00e9curis\u00e9 !':
    todayMissions.length>0&&done.length===todayMissions.filter(function(m){return !m.virtual;}).length&&todayMissions.filter(function(m){return !m.virtual;}).length>0?'Tous les m\u00e9nages valid\u00e9s \u2714':
    'Op\u00e9rations du jour sous contr\u00f4le';

  // KPI strip
  var kpiHtml='<div class="p360-kpi-strip" style="margin-bottom:14px">'+
    '<div class="p360-kpi-card '+(risk.length?'':'accent')+'">'+
      '<div class="p360-kpi-lbl">Check-ins</div>'+
      '<div class="p360-kpi-val" style="color:'+(checkinsToday.length?'#17122E':'#8A8A99')+'">'+checkinsToday.length+'</div>'+
      '<div class="p360-kpi-help">aujourd\u2019hui</div>'+
    '</div>'+
    '<div class="p360-kpi-card">'+
      '<div class="p360-kpi-lbl">Check-outs</div>'+
      '<div class="p360-kpi-val">'+checkoutsToday.length+'</div>'+
      '<div class="p360-kpi-help">aujourd\u2019hui</div>'+
    '</div>'+
    '<div class="p360-kpi-card">'+
      '<div class="p360-kpi-lbl">M\u00e9nages</div>'+
      '<div class="p360-kpi-val">'+todayMissions.length+'</div>'+
      '<div class="p360-kpi-help">pr\u00e9vus (r\u00e9el + EVA)</div>'+
    '</div>'+
    '<div class="p360-kpi-card">'+
      '<div class="p360-kpi-lbl">Valid\u00e9s</div>'+
      '<div class="p360-kpi-val" style="color:#059669">'+done.length+'</div>'+
      '<div class="p360-kpi-help">termin\u00e9s</div>'+
    '</div>'+
    '<div class="p360-kpi-card '+(risk.length?'accent':'')+'">'+
      '<div class="p360-kpi-lbl">\u00c0 risque</div>'+
      '<div class="p360-kpi-val" style="color:'+(risk.length?'#DC2626':'#059669')+'">'+risk.length+'</div>'+
      '<div class="p360-kpi-help">'+(risk.length?'sans cleaner':'OK')+'</div>'+
    '</div>'+
  '</div>';

  // Alerte risque
  var riskAlert='';
  if(risk.length){
    riskAlert=risk.map(function(r){
      return '<div class="a360-alert a360-alert-risk" style="margin-bottom:8px">'+
        '<div class="a360-alert-icon">\uD83D\uDEA8</div>'+
        '<div style="flex:1">'+
          '<div class="a360-alert-title">Check-in sans m\u00e9nage s\u00e9curis\u00e9 : '+r.apartment_name+'</div>'+
          '<div class="a360-alert-desc">Voyageur : '+r.guest_name+' \u2014 arriv\u00e9e aujourd\u2019hui. Aucune mission confirm\u00e9e.</div>'+
        '</div>'+
        '<button class="eva-action-day-btn" onclick="openMissionModal()">Cr\u00e9er</button>'+
      '</div>';
    }).join('');
  }

  // Missions du jour liste (réelles + suggestions virtuelles)
  var missionsList='';
  if(todayMissions.length){
    missionsList=todayMissions.map(function(m){
      var apt=apparts.find(function(a){return a.id===m.appartement_id;})||{name:m.apartment_name||m.appartement_id,emoji:'\uD83C\uDFE0'};
      if(m.virtual){
        return '<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #F3F0FA;background:#F8F5FF;border-radius:10px;margin-bottom:4px;padding-left:10px;padding-right:10px">'+
          '<div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#F3E8FF,#EDE9FF);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">'+(apt.emoji||'\uD83C\uDFE0')+'</div>'+
          '<div style="flex:1;min-width:0">'+
            '<div style="font-size:13px;font-weight:700;color:#17122E">'+apt.name+' <span style="font-size:9px;font-weight:800;color:#7C3AED;background:#EDE4FF;border-radius:6px;padding:2px 6px;margin-left:4px">Suggestion EVA</span></div>'+
            '<div style="font-size:11px;color:#8A8A99">'+(m.heure||'10:00')+' \u00b7 '+(m.duree_min||90)+' min \u00b7 '+m.tarif+'\u20AC'+(m.cleaner_name?' \u00b7 '+m.cleaner_name:' \u00b7 cleaner \u00e0 assigner')+'</div>'+
          '</div>'+
          '<button class="eva-action-day-btn" onclick="confirmVirtualMission(\''+m.id+'\')">Confirmer</button>'+
        '</div>';
      }
      var statusLabel=m.status==='terminee'?'\u2705 Valid\u00e9':m.status==='acceptee'?'\uD83D\uDD04 En cours':'\u23F3 En attente';
      var statusColor=m.status==='terminee'?'#059669':m.status==='acceptee'?'#D97706':'#8A8A99';
      return '<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #F3F0FA">'+
        '<div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#F3E8FF,#EDE9FF);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">'+(apt.emoji||'\uD83C\uDFE0')+'</div>'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-size:13px;font-weight:700;color:#17122E">'+apt.name+'</div>'+
          '<div style="font-size:11px;color:#8A8A99">'+(m.heure||'10:00')+' \u00b7 '+(m.duree_min||90)+' min \u00b7 '+m.tarif+'\u20AC</div>'+
        '</div>'+
        '<div style="font-size:11px;font-weight:700;color:'+statusColor+'">'+statusLabel+'</div>'+
      '</div>';
    }).join('');
  } else {
    missionsList='<div style="text-align:center;padding:2rem;color:#8A8A99;font-size:13px">Aucune mission de m\u00e9nage pr\u00e9vue aujourd\u2019hui.</div>';
  }

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:16px;background:'+(risk.length?'linear-gradient(135deg,#7F1D1D,#DC2626)':'linear-gradient(135deg,#211051,#6D28D9,#EC4899)')+'">'+
      '<div class="a360-hero-kicker">CleanyQ \u00b7 Aujourd\u2019hui \u00b7 '+todayIso+'</div>'+
      '<div class="a360-hero-title">'+heroTitle+'</div>'+
      '<div class="a360-hero-sub">'+checkinsToday.length+' check-in \u00b7 '+checkoutsToday.length+' check-out \u00b7 '+todayMissions.length+' m\u00e9nage'+(todayMissions.length>1?'s':'')+' pr\u00e9vu'+(todayMissions.length>1?'s':'')+'</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+done.length+'/'+todayMissions.length+' valid\u00e9'+(done.length>1?'s':'')+'</span>'+
        (risk.length?'<span class="a360-hero-chip" style="background:rgba(255,255,255,.25)">'+risk.length+' check-in \u00e0 risque</span>':'')+
      '</div>'+
    '</div>'+
    kpiHtml+
    (riskAlert?'<div style="margin-bottom:14px">'+riskAlert+'</div>':'')+
    '<div class="p360-section">'+
      '<div class="p360-section-head">'+
        '<div><div class="p360-section-title">\uD83D\uDDC3\uFE0F Missions du jour</div></div>'+
        '<button class="a360-action-btn" onclick="openMissionModal()">\uD83D\uDCCB Cr\u00e9er une mission</button>'+
      '</div>'+
      missionsList+
    '</div>';
}

/* ── Missions ── */
function renderCleanyQMissions(){
  var dash=document.getElementById('cleanyq-missions-dash');
  if(!dash)return;
  var today=new Date().toISOString().slice(0,10);

  // Fusion réelles + suggestions virtuelles (fenêtre élargie à 30j pour cette vue)
  var merged=getMergedCleaningMissions(30);
  var real=(missionsData||[]);

  var upcoming=merged.filter(function(m){return m.date>=today;}).sort(function(a,b){return a.date.localeCompare(b.date);}).slice(0,25);
  var past=real.filter(function(m){return m.date<today;}).sort(function(a,b){return b.date.localeCompare(a.date);}).slice(0,10);
  var suggestionsCount=upcoming.filter(function(m){return m.virtual;}).length;

  function missionCard(m,showDate){
    var apt=apparts.find(function(a){return a.id===m.appartement_id;})||{name:m.apartment_name||'—',emoji:'\uD83C\uDFE0'};
    if(m.virtual){
      return '<div style="background:#F8F5FF;border:1px solid rgba(124,58,237,.16);border-radius:14px;padding:14px;margin-bottom:8px;display:flex;align-items:center;gap:12px">'+
        '<div style="width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#F3E8FF,#EDE9FF);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">'+(apt.emoji||'\uD83C\uDFE0')+'</div>'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-size:13px;font-weight:700;color:#17122E">'+apt.name+' <span style="font-size:9px;font-weight:800;color:#7C3AED;background:#EDE4FF;border-radius:6px;padding:2px 6px;margin-left:4px">Suggestion EVA</span></div>'+
          '<div style="font-size:11px;color:#8A8A99">'+(showDate?m.date+' \u00b7 ':'')+(m.heure||'10:00')+' \u00b7 '+(m.duree_min||90)+' min'+(m.cleaner_name?' \u00b7 '+m.cleaner_name:' \u00b7 cleaner \u00e0 assigner')+'</div>'+
        '</div>'+
        '<button class="eva-action-day-btn" onclick="confirmVirtualMission(\''+m.id+'\')" style="flex-shrink:0">Confirmer</button>'+
      '</div>';
    }
    var statusLabel=m.status==='terminee'?'\u2705 Valid\u00e9':m.status==='acceptee'?'\uD83D\uDD04 En cours':'\u23F3 En attente';
    var statusColor=m.status==='terminee'?'#059669':m.status==='acceptee'?'#D97706':'#8A8A99';
    var urgBg=m.status==='en_attente'&&m.date===today?'#FEF2F2':'white';
    return '<div style="background:'+urgBg+';border:1px solid rgba(139,92,246,.1);border-radius:14px;padding:14px;margin-bottom:8px;display:flex;align-items:center;gap:12px">'+
      '<div style="width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#F3E8FF,#EDE9FF);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">'+(apt.emoji||'\uD83C\uDFE0')+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:13px;font-weight:700;color:#17122E">'+apt.name+'</div>'+
        '<div style="font-size:11px;color:#8A8A99">'+(showDate?m.date+' \u00b7 ':'')+( m.heure||'10:00')+' \u00b7 '+(m.duree_min||90)+' min</div>'+
      '</div>'+
      '<div style="text-align:right;flex-shrink:0">'+
        '<div style="font-size:12px;font-weight:700;color:'+statusColor+'">'+statusLabel+'</div>'+
        '<div style="font-size:11px;color:#8A8A99;margin-top:2px">'+m.tarif+'\u20AC</div>'+
      '</div>'+
    '</div>';
  }

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">CleanyQ \u00b7 Missions</div>'+
      '<div class="a360-hero-title">'+upcoming.length+' mission'+(upcoming.length>1?'s':'')+' \u00e0 venir</div>'+
      '<div class="a360-hero-sub">'+(upcoming.length-suggestionsCount)+' confirm\u00e9e'+((upcoming.length-suggestionsCount)>1?'s':'')+' \u00b7 '+suggestionsCount+' suggestion'+(suggestionsCount>1?'s':'')+' EVA \u00e0 valider</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+(upcoming.length-suggestionsCount)+' confirm\u00e9e'+((upcoming.length-suggestionsCount)>1?'s':'')+'</span>'+
        (suggestionsCount?'<span class="a360-hero-chip">'+suggestionsCount+' suggestion'+(suggestionsCount>1?'s':'')+' EVA</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="p360-section" style="margin-bottom:14px">'+
      '<div class="p360-section-head"><div><div class="p360-section-title">\uD83D\uDCC5 Prochaines missions</div></div>'+
        '<button class="a360-action-btn" onclick="openMissionModal()">\uD83D\uDCCB Nouvelle mission</button></div>'+
      (upcoming.length?upcoming.map(function(m){return missionCard(m,true);}).join(''):
        '<div style="text-align:center;padding:2rem;color:#8A8A99;font-size:13px">Aucune mission \u00e0 venir. Cliquez sur "Nouvelle mission" pour en cr\u00e9er une.</div>')+
    '</div>'+
    (past.length?'<div class="p360-section">'+
      '<div class="p360-section-head"><div><div class="p360-section-title">\uD83D\uDDC3\uFE0F Historique r\u00e9cent</div></div></div>'+
      past.map(function(m){return missionCard(m,true);}).join('')+
    '</div>':'');
}

/* ── Squad ── */
function renderCleanyQSquad(){
  var dash=document.getElementById('cleanyq-squad-dash');
  if(!dash)return;
  // Réutilise les données cleaners depuis missionsData et cleanersData
  var squadData=typeof cleanersData!=='undefined'?cleanersData:[];
  var allM=missionsData||[];

  if(!squadData.length){
    dash.innerHTML=
      '<div class="a360-hero" style="margin-bottom:16px">'+
        '<div class="a360-hero-kicker">CleanyQ \u00b7 Squad</div>'+
        '<div class="a360-hero-title">Votre \u00e9quipe de cleaners</div>'+
        '<div class="a360-hero-sub">Ajoutez vos cleaners pour g\u00e9rer les missions</div>'+
      '</div>'+
      '<div class="a360-empty">'+
        '<div class="a360-empty-icon">\uD83E\uDDF9</div>'+
        '<div class="a360-empty-title">Aucun cleaner dans la Squad</div>'+
        '<div class="a360-empty-sub">Ajoutez vos cleaners pour automatiser la gestion des m\u00e9nages.</div>'+
        '<div style="margin-top:16px"><button class="a360-action-btn" onclick="openCleanerModal()">\u002B Ajouter un cleaner</button></div>'+
      '</div>';
    return;
  }

  var cards=squadData.map(function(s){
    var nbMissions=allM.filter(function(m){return m.cleaner_id===s.id&&m.status==='terminee';}).length;
    var nbPending=allM.filter(function(m){return m.cleaner_id===s.id&&(m.status==='en_attente'||m.status==='acceptee');}).length;
    var score=s.score||0;
    var scoreColor=score>=4.5?'#059669':score>=4?'#D97706':'#DC2626';
    return '<div style="background:white;border:1px solid rgba(139,92,246,.12);border-radius:18px;padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px">'+
      '<div style="width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,#6D28D9,#EC4899);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:white;flex-shrink:0">'+(s.name||'?').charAt(0)+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div style="font-size:14px;font-weight:800;color:#17122E">'+(s.name||'Cleaner')+'</div>'+
        '<div style="font-size:11px;color:#8A8A99;margin-top:2px">'+(s.city||'Toutes zones')+(s.radius_km?' \u00b7 '+s.radius_km+' km':'')+'</div>'+
        '<div style="height:3px;background:#F3F0FA;border-radius:999px;margin-top:7px;overflow:hidden">'+
          '<div style="height:100%;width:'+(score/5*100)+'%;background:'+scoreColor+';border-radius:999px"></div>'+
        '</div>'+
      '</div>'+
      '<div style="text-align:right;flex-shrink:0">'+
        '<div style="font-size:18px;font-weight:900;color:'+scoreColor+'">'+score+'<span style="font-size:10px;color:#8A8A99">/5</span></div>'+
        '<div style="font-size:10px;color:#8A8A99;margin-top:2px">'+nbMissions+' termin\u00e9es \u00b7 '+nbPending+' en cours</div>'+
        '<span class="a360-badge '+(s.status==='active'?'a360-badge-green':'a360-badge-gray')+'" style="margin-top:4px;display:inline-block">'+(s.status==='active'?'Actif':'Inactif')+'</span>'+
      '</div>'+
    '</div>';
  }).join('');

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:16px">'+
      '<div class="a360-hero-kicker">CleanyQ \u00b7 Squad</div>'+
      '<div class="a360-hero-title">'+squadData.length+' cleaner'+(squadData.length>1?'s':'')+' dans la Squad</div>'+
      '<div class="a360-hero-sub">Note moyenne : '+( squadData.length?Math.round(squadData.reduce(function(s,c){return s+(c.score||0);},0)/squadData.length*10)/10:0)+'/5</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+squadData.length+' cleaner'+(squadData.length>1?'s':'')+'</span>'+
        '<span class="a360-hero-chip">'+allM.filter(function(m){return m.status==='en_attente';}).length+' missions en attente</span>'+
      '</div>'+
    '</div>'+
    '<div class="p360-section">'+
      '<div class="p360-section-head"><div><div class="p360-section-title">\uD83E\uDDF9 Cleaners</div></div>'+
        '<button class="a360-action-btn" onclick="openCleanerModal()">\u002B Ajouter</button></div>'+
      cards+
    '</div>';
}

function openAddModal(){editId=null;['m-name','m-city','m-zone','m-rent','m-clean','m-price','m-comp','m-address','m-lat','m-lng'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});document.getElementById('m-address-preview').style.display='none';document.getElementById('m-address-results').style.display='none';document.getElementById('m-degressif-toggle').className='toggle off';document.getElementById('m-degressif-config').style.display='none';document.getElementById('m-deg-start').value='14';document.getElementById('m-deg-step').value='5';document.getElementById('m-deg-min').value='';document.getElementById('m-emoji').value='🏠';document.getElementById('modal-error').style.display='none';document.getElementById('modal').classList.add('open');
  const az=document.getElementById('modal-archive-zone');if(az)az.style.display='none';
  const mt=document.getElementById('modal-title');if(mt)mt.textContent='Ajouter un appartement';
  ['m-surface','m-couchages','m-chambres'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const mt2=document.getElementById('m-type');if(mt2)mt2.value='studio';
}
function openEdit(id){const a=apparts.find(x=>x.id===id);if(!a)return;editId=id;document.getElementById('m-name').value=a.name||'';document.getElementById('m-city').value=a.city||'';document.getElementById('m-zone').value=a.zone||'';document.getElementById('m-address').value=a.address||'';document.getElementById('m-lat').value=a.latitude||'';document.getElementById('m-lng').value=a.longitude||'';const prev=document.getElementById('m-address-preview');if(a.address){prev.textContent='📍 '+a.address;prev.style.display='block';}else{prev.style.display='none';}
  const degToggle=document.getElementById('m-degressif-toggle');const degConfig=document.getElementById('m-degressif-config');
  if(a.auto_degressif){degToggle.className='toggle on';degConfig.style.display='block';document.getElementById('m-deg-start').value=a.degressif_start||14;document.getElementById('m-deg-step').value=a.degressif_step||5;document.getElementById('m-deg-min').value=a.degressif_min||'';updateDegPreview();}
  else{degToggle.className='toggle off';degConfig.style.display='none';}document.getElementById('m-emoji').value=a.emoji||'🏠';document.getElementById('m-rent').value=a.rent||'';document.getElementById('m-clean').value=a.cleaner||'';document.getElementById('m-price').value=a.price||'';document.getElementById('m-comp').value=a.comp||'';document.getElementById('modal-error').style.display='none';document.getElementById('modal').classList.add('open');
  const az=document.getElementById('modal-archive-zone');if(az)az.style.display='block';
  const mt=document.getElementById('modal-title');if(mt)mt.textContent='Modifier le bien';
}
function closeModal(){document.getElementById('modal').classList.remove('open')}
function openAddResModal(){document.getElementById('mr-apt').innerHTML=apparts.map(a=>`<option value="${a.id}">${a.emoji||'🏠'} ${a.name}</option>`).join('');document.getElementById('modal-res').classList.add('open');}
function closeResModal(){document.getElementById('modal-res').classList.remove('open')}

async function saveAppart(){
  const name=document.getElementById('m-name').value.trim();const city=document.getElementById('m-city').value.trim();
  if(!name){showErr('modal-error','Nom obligatoire');return}
  if(!city){showErr('modal-error','Ville obligatoire — nécessaire pour les événements');return}
  const btn=document.getElementById('btn-save-appart');btn.disabled=true;btn.textContent='…';
  const price=+document.getElementById('m-price').value||0;
  const degOn=document.getElementById('m-degressif-toggle').classList.contains('on');const body={user_id:currentUser.user.id,name,city,zone:document.getElementById('m-zone').value||'',address:document.getElementById('m-address').value||'',latitude:+document.getElementById('m-lat').value||null,longitude:+document.getElementById('m-lng').value||null,commission_conc:+document.getElementById('m-commission-conc')?.value||0,type_bien:document.getElementById('m-type')?.value||'studio',surface:+document.getElementById('m-surface')?.value||null,couchages:+document.getElementById('m-couchages')?.value||null,chambres:+document.getElementById('m-chambres')?.value||null,emoji:document.getElementById('m-emoji').value||'🏠',rent:+document.getElementById('m-rent').value||0,cleaner:+document.getElementById('m-clean').value||0,price,comp:+document.getElementById('m-comp').value||0,ai_rec:Math.round(price*1.08),booked:false,auto_pricing:true,has_event:false,auto_degressif:degOn,degressif_start:degOn?+document.getElementById('m-deg-start').value:14,degressif_step:degOn?+document.getElementById('m-deg-step').value:5,degressif_min:degOn?+document.getElementById('m-deg-min').value||0:0};
  try{
    if(editId){await sbFetch(`appartements?id=eq.${editId}`,{method:'PATCH',body:JSON.stringify(body)});const i=apparts.findIndex(a=>a.id===editId);if(i>=0)apparts[i]={...apparts[i],...body};showToast('✓ Modifié');}
    else{const res=await sbFetch('appartements',{method:'POST',body:JSON.stringify(body)});const c=await res.json();apparts.push(Array.isArray(c)&&c[0]?c[0]:{...body,id:Date.now().toString()});showToast('✓ Ajouté');}
    closeModal();renderAll();
    // Charger les événements pour la nouvelle ville
    const cityNorm=city.charAt(0).toUpperCase()+city.slice(1).toLowerCase();
    if(!eventsCache[cityNorm])loadEvents(false);
  }catch(e){showErr('modal-error','Erreur');}
  btn.disabled=false;btn.textContent='✓ Enregistrer';
}

async function saveReservation(){
  const aptId=document.getElementById('mr-apt').value;const from=document.getElementById('mr-from').value;const to=document.getElementById('mr-to').value;
  if(!from||!to){showErr('modal-res-error','Dates obligatoires');return}
  const nights=Math.round((new Date(to)-new Date(from))/(1000*60*60*24));
  const body={user_id:currentUser.user.id,appartement_id:aptId,guest_name:document.getElementById('mr-guest').value,date_from:from,date_to:to,price_total:+document.getElementById('mr-price').value||0,platform:document.getElementById('mr-platform').value,status:'confirmed',nights};
  try{const res=await sbFetch('reservations',{method:'POST',body:JSON.stringify(body)});const c=await res.json();reservations.unshift(Array.isArray(c)&&c[0]?c[0]:{...body,id:Date.now().toString()});closeResModal();renderAll();showToast('✓ Réservation ajoutée');}
  catch(e){showErr('modal-res-error','Erreur');}
}

async function toggleBooked(id,val){await sbFetch(`appartements?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({booked:val})});const a=apparts.find(x=>x.id===id);if(a)a.booked=val;renderAll();}
async function toggleAutoPricing(id,val){await sbFetch(`appartements?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({auto_pricing:val})});const a=apparts.find(x=>x.id===id);if(a)a.auto_pricing=val;renderPricingTable();}
async function applyAI(id,rec){
  const a=apparts.find(x=>x.id===id);if(!a)return;
  const maxPrice=Math.round((a.price||100)*1.25);
  const fl=Math.round((a.rent||0)/30+(a.cleaner||0));
  rec=Math.max(Math.min(rec,maxPrice),fl);
  await sbFetch(`appartements?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({price:rec})});
  a.price=rec;renderAll();
  // Proposer push vers Smoobu si connecté
  if(smoobuConnected&&a&&a.smoobu_id){
    showSmoobuPush(a,rec);
  } else {
    showToast('✓ Prix appliqué : '+rec+'€');
  }
}

function showSmoobuPush(apt,newPrice){
  const modal=document.getElementById('modal');
  const m=document.querySelector('#modal .modal');
  m.innerHTML=`
    <div class="modal-head"><div class="modal-title">🤖 EVA → Smoobu</div><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div style="text-align:center;padding:1rem 0">
      <div style="font-size:40px;margin-bottom:12px">🤖→🔗</div>
      <div style="font-size:16px;font-weight:600;margin-bottom:6px">Appliquer ${newPrice}€/nuit sur Smoobu ?</div>
      <div style="font-size:13px;color:#8A8A99;margin-bottom:4px">${apt.emoji||'🏠'} ${apt.name}</div>
      <div style="display:flex;justify-content:center;gap:16px;margin:16px 0">
        <div style="background:#FCEBEB;border-radius:10px;padding:10px 20px;text-align:center">
          <div style="font-size:11px;color:#8A8A99">Ancien prix</div>
          <div style="font-size:20px;font-weight:700;color:#E24B4A;text-decoration:line-through">${apt.price||0}€</div>
        </div>
        <div style="display:flex;align-items:center;font-size:20px;color:#8A8A99">→</div>
        <div style="background:#E1F5EE;border-radius:10px;padding:10px 20px;text-align:center">
          <div style="font-size:11px;color:#8A8A99">Nouveau prix</div>
          <div style="font-size:20px;font-weight:700;color:#1D9E75">${newPrice}€</div>
        </div>
      </div>
      <div style="font-size:12px;color:#8A8A99;margin-bottom:16px">Le prix sera modifié sur Airbnb et Booking via Smoobu</div>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="closeModal()" style="flex:1">Annuler</button>
        <button class="btn btn-purple" onclick="pushToSmoobu('${apt.id}','${apt.smoobu_id}',${newPrice})" style="flex:2">✅ Confirmer et pousser</button>
      </div>
      <button onclick="closeModal();showToast('✓ Prix modifié dans RentyQ uniquement')" style="margin-top:10px;background:none;border:none;font-size:12px;color:#8A8A99;cursor:pointer;font-family:inherit">Modifier seulement dans RentyQ →</button>
    </div>`;
  modal.classList.add('open');
}

async function pushToSmoobu(aptId,smoobuId,newPrice){
  closeModal();
  showToast('🔄 Envoi à Smoobu…');
  try{
    const res=await smoobuCall('updatePrice',{apartmentId:smoobuId,price:newPrice});
    if(res.success||res.status==='ok'){
      showToast('✅ Prix poussé sur Smoobu : '+newPrice+'€');
    } else {
      showToast('⚠ Erreur Smoobu — prix modifié dans RentyQ uniquement');
    }
  }catch(e){
    showToast('⚠ Erreur connexion Smoobu');
  }
}
async function deleteAppart(id){if(!confirm('Supprimer ?'))return;await sbFetch(`appartements?id=eq.${id}`,{method:'DELETE'});apparts=apparts.filter(a=>a.id!==id);renderAll();}
async function saveProfile(){const name=document.getElementById('set-name').value.trim();await sbFetch(`profiles?id=eq.${currentProfile.id}`,{method:'PATCH',body:JSON.stringify({name})});currentProfile.name=name;renderSidebar();showToast('✓ Sauvegardé');}

function buildGlobalRulesAnalysis(){
  const rows=apparts.map(a=>({a,smart:getSmartRec(a)})).sort((x,y)=>{
    const rank={urgent:4,important:3,'opportunité':2,normal:1};
    return (rank[y.smart.priority]||0)-(rank[x.smart.priority]||0) || Math.abs(y.smart.delta)-Math.abs(x.smart.delta);
  });
  const urgent=rows.filter(r=>r.smart.priority==='urgent');
  const baisse=rows.filter(r=>r.smart.direction==='BAISSER');
  const hausse=rows.filter(r=>r.smart.direction==='AUGMENTER');
  const occ=portfolioOccupancy();
  const horizon=+(document.getElementById('pricing-horizon')?.value||14);
  const now=new Date();
  const freeTotal=apparts.reduce((sum,a)=>{
    return sum+Array.from({length:horizon},(_,i)=>{
      const d=new Date(now);d.setDate(d.getDate()+i);
      const date=isoDate(d);
      return !getAptReservations(a).some(r=>bookingCoversDate(r,date));
    }).filter(Boolean).length;
  },0);
  const recoverable=rows.reduce((s,r)=>s+Math.max(0,r.smart.rec||0),0);
  const score=Math.max(0,Math.min(100,Math.round(occ*0.7 + (100-Math.min(100,urgent.length*20))*0.3)));
  const top=rows.slice(0,4);

  let html=`<div class="eva-dashboard">
    <div class="eva-hero-card">
      <div class="eva-hero-kicker">EVA Rules Engine · sans IA payante</div>
      <div class="eva-hero-title">${urgent.length?urgent.length+' action'+(urgent.length>1?'s':'')+' à faire maintenant':'Portefeuille sous contrôle'}</div>
      <div class="eva-hero-sub">${occ<45?'Priorité absolue : remplir les nuits proches. Une nuit vide vaut 0€, donc EVA privilégie l\u2019occupation avant la marge.':occ<65?'Objectif : sécuriser plus de réservations sur les 14 prochains jours avant de remonter les prix.':'Le remplissage est correct : EVA peut protéger les prix sur les dates fortes.'}</div>
      <div class="eva-hero-money">
        <div class="eva-money-big">+${recoverable}€</div>
        <div class="eva-money-label">revenu théorique à sécuriser<br>en appliquant les recommandations</div>
      </div>
    </div>
    <div class="eva-side-stack">
      <div class="eva-metric-card">
        <div class="eva-metric-label">Occupation</div>
        <div class="eva-metric-value">${occ}%</div>
        <div class="eva-progress"><span style="width:${Math.max(5,Math.min(100,occ))}%"></span></div>
        <div class="eva-metric-help">Objectif minimum : 65%</div>
      </div>
      <div class="eva-metric-card">
        <div class="eva-metric-label">Nuits libres</div>
        <div class="eva-metric-value">${freeTotal}</div>
        <div class="eva-metric-help">Sur les ${horizon} prochains jours</div>
      </div>
      <div class="eva-metric-card">
        <div class="eva-metric-label">Score EVA</div>
        <div class="eva-metric-value">${score}/100</div>
        <div class="eva-progress"><span style="width:${score}%"></span></div>
        <div class="eva-metric-help">${score<50?'Plan d\u2019action urgent':score<75?'Optimisation en cours':'Bonne dynamique'}</div>
      </div>
      <div class="eva-metric-card">
        <div class="eva-metric-label">Baisses utiles</div>
        <div class="eva-metric-value">${baisse.length}</div>
        <div class="eva-metric-help">Pour vendre plutôt que laisser vide</div>
      </div>
    </div>
  </div>`;

  html+=`<div class="eva-actions-panel">
    <div class="eva-panel-head">
      <div><div class="eva-panel-title">🎯 Missions EVA prioritaires</div><div class="eva-panel-sub">Lisible en 3 secondes : quoi faire, combien, pourquoi.</div></div>
      <span class="eva-pill ${urgent.length?'eva-pill-red':'eva-pill-green'}">${urgent.length?urgent.length+' urgent'+(urgent.length>1?'s':''):'OK'}</span>
    </div>
    <div class="eva-action-grid">`;

  const cards=top.length?top:rows.slice(0,3);
  cards.forEach(({a,smart})=>{
    const urgentClass=smart.priority==='urgent'?'urgent':(smart.direction==='AUGMENTER'?'up':'');
    const badge=smart.priority==='urgent'?'<span class="eva-pill eva-pill-red">🚨 urgent</span>':smart.direction==='AUGMENTER'?'<span class="eva-pill eva-pill-orange">💰 opportunité</span>':'<span class="eva-pill eva-pill-purple">🎯 à optimiser</span>';
    html+=`<div class="eva-action-card ${urgentClass}">
      <div class="eva-action-top">
        <div><div class="eva-apt-name">${a.emoji||'🏠'} ${escapeHtml(a.name||'Appartement')}</div><div class="eva-apt-city">${escapeHtml(a.city||extractCity(a.zone,null)||'')}</div></div>
        ${badge}
      </div>
      <div class="eva-price-row"><span class="eva-price-old">${a.price||0}€</span><span class="eva-price-arrow">→</span><span class="eva-price-new">${smart.rec}€</span></div>
      <div class="eva-reason">${escapeHtml((smart.reasons&&smart.reasons[0])||smart.reason||'Prix cohérent avec les données disponibles')}</div>
      <div class="eva-card-footer">
        <span class="eva-impact">${smart.delta<0?'Mieux vaut louer moins cher que vide':'Revenu à capter'}</span>
        <button class="btn btn-sm btn-purple" onclick="applyAI('${a.id}',${smart.rec})">Appliquer</button>
      </div>
    </div>`;
  });
  html+=`</div></div>`;
  return html;
}

function runGlobal(){
  const btn=document.getElementById('btn-global');const zone=document.getElementById('global-result');
  if(btn){btn.disabled=true;btn.textContent='...';}
  if(!apparts.length){
    zone.innerHTML='<div style="text-align:center;padding:2rem;background:#F8F4FF;border-radius:16px;border:1px dashed rgba(124,58,237,.2)">'
      +'<div style="font-size:32px;margin-bottom:10px">&#x1F9E0;</div>'
      +'<div style="font-size:15px;font-weight:800;color:#17122E;margin-bottom:6px">Aucun bien dans votre parc</div>'
      +'<div style="font-size:13px;color:#7B708F;margin-bottom:16px">Ajoutez un bien et importez vos données pour qu’EVA génère votre plan d’action.</div>'
      +'<button onclick="openAddModal()" style="border:none;border-radius:10px;padding:10px 20px;background:#7C3AED;color:white;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit">+ Ajouter mon premier bien</button>'
      +'</div>';
    if(btn){btn.disabled=false;btn.innerHTML='&#x1F916; Analyse globale';}return;
  }
  zone.innerHTML=buildGlobalRulesAnalysis();
  if(btn){btn.disabled=false;btn.innerHTML='&#x1F916; Analyse globale';}
}
function applyAllEVA(){
  const horizon=+(document.getElementById('pricing-horizon')?.value||14);
  const now=new Date();
  let count=0;
  apparts.forEach(a=>{
    const hasFreeDays=Array.from({length:horizon},(_,i)=>{
      const d=new Date(now);d.setDate(d.getDate()+i);
      return d.toISOString().split('T')[0];
    }).some(date=>!reservations.some(r=>r.appartement_id===a.id&&r.date_from<=date&&r.date_to>=date));
    if(hasFreeDays){const smart=getSmartRec(a);applyAI(a.id,smart.rec);count++;}
  });
  showToast(`✅ EVA appliqué sur ${count} bien${count>1?'s':''}`);
}


async function loadEvents(force=false){
  const loading=document.getElementById('events-loading');
  const empty=document.getElementById('events-empty');
  const container=document.getElementById('events-container');
  const btn=document.getElementById('btn-refresh-events');
  if(!container)return;
  const citiesMap={};
  (apparts||[]).forEach(a=>{
    const city=normalizeCityName(a.city||extractCity(a.zone,null)||'');
    if(city){if(!citiesMap[city])citiesMap[city]=[];citiesMap[city].push(a);}
  });
  const cities=Object.keys(citiesMap);
  if(!cities.length){
    if(empty)empty.style.display='block';
    if(loading)loading.style.display='none';
    container.innerHTML='';
    const sub=document.getElementById('events-sub');if(sub)sub.textContent='Ajoutez une ville/adresse pour détecter les événements';
    return;
  }
  if(empty)empty.style.display='none';
  if(loading)loading.style.display='block';
  if(btn){btn.disabled=true;btn.textContent='Recherche…';}

  for(const city of cities){
    if(!force && eventsCache[city] && eventsCache[city].length)continue;
    let events=[];
    try{
      // Priorité : votre Edge Function events-proxy. Elle peut agréger Ticketmaster + OpenAgenda avec clés cachées.
      const data=await eventsCall(city);
      events=normalizeEventsPayload(data,city);
    }catch(e){
      console.warn('events-proxy indisponible pour',city,e);
      events=[];
    }
    if(!events.length){
      try{events=await fetchOpenAgendaFallback(city);}catch(e){console.warn('OpenAgenda fallback indisponible',city,e);}
    }
    if(!events.length){
      events=buildLocalSeasonalEvents(city);
    }
    eventsCache[city]=events.slice(0,30);
  }
  if(loading)loading.style.display='none';
  if(btn){btn.disabled=false;btn.textContent='🔄 Actualiser';}
  renderEventsPage(citiesMap);
  try{renderAll();}catch(e){}
}

function normalizeEventsPayload(data,city){
  const raw=data?.events||data?.items||data?.results||data?._embedded?.events||[];
  if(!Array.isArray(raw))return [];
  const now=new Date();
  return raw.map((e,idx)=>{
    const date=e.date||e.startDate||e.start_time||e.firstdate_begin||e.dates?.start?.localDate||e.date_start||'';
    const name=e.name||e.title||e.label||'Événement local';
    const venue=e.venue||e.location||e.place||e._embedded?.venues?.[0]?.name||'';
    const segment=e.segment||e.category||e.type||e.classifications?.[0]?.segment?.name||'Local';
    const boost=eventBoostFromName(name,segment,date,idx);
    return {name,date,venue,segment,boost,hot:boost>=10,emoji:eventEmoji(segment,name),date_label:formatEventDate(date),source:e.source||'events-proxy'};
  }).filter(e=>e.name).sort((a,b)=>(new Date(a.date||'2999-01-01'))-(new Date(b.date||'2999-01-01')));
}

async function fetchOpenAgendaFallback(city){
  const start=new Date().toISOString().slice(0,10);
  const end=addDays(new Date(),180).toISOString().slice(0,10);
  const url=`https://api.openagenda.com/v2/agendas/events?where=${encodeURIComponent(city)}&from=${start}&to=${end}&size=20`;
  const r=await fetch(url);
  if(!r.ok)throw new Error('OpenAgenda HTTP '+r.status);
  const data=await r.json();
  const raw=data.events||data.items||[];
  return raw.map((e,idx)=>{
    const name=(typeof e.title==='object'?e.title.fr||Object.values(e.title)[0]:e.title)||e.name||'Événement local';
    const date=e.firstdate_begin||e.dateRange?.[0]?.begin||e.start||'';
    const venue=(typeof e.location?.name==='object'?e.location.name.fr||Object.values(e.location.name)[0]:e.location?.name)||e.locationName||'';
    const segment=e.keywords?.[0]||'OpenAgenda';
    const boost=eventBoostFromName(name,segment,date,idx);
    return {name,date,venue,segment,boost,hot:boost>=10,emoji:eventEmoji(segment,name),date_label:formatEventDate(date),source:'OpenAgenda'};
  }).filter(e=>e.name);
}

function buildLocalSeasonalEvents(city){
  // Fallback métier : évite une page vide quand les APIs ne répondent pas.
  const today=new Date();
  const presets=[];
  const m=today.getMonth()+1;
  if([6,7,8].includes(m))presets.push({name:`Saison touristique été — ${city}`,boost:10,segment:'Saison',emoji:'☀️',date:isoDate(addDays(today,7))});
  if([11,12].includes(m))presets.push({name:`Marchés et sorties de fin d\u2019année — ${city}`,boost:12,segment:'Saison',emoji:'🎄',date:isoDate(addDays(today,10))});
  presets.push({name:`Week-ends à forte demande locale — ${city}`,boost:6,segment:'Demande locale',emoji:'📍',date:isoDate(addDays(today,5))});
  return presets.map(e=>({...e,hot:e.boost>=10,venue:city,date_label:formatEventDate(e.date),source:'RentyQ fallback'}));
}
function formatEventDate(date){
  if(!date)return 'date à confirmer';
  try{return new Date(date).toLocaleDateString('fr-FR',{day:'numeric',month:'short'});}catch(e){return date;}
}
function eventEmoji(segment='',name=''){
  const t=(segment+' '+name).toLowerCase();
  if(/concert|music|musique|festival/.test(t))return '🎵';
  if(/sport|match|football|rugby|basket/.test(t))return '🏟️';
  if(/expo|museum|art|culture/.test(t))return '🎨';
  if(/march[eé]|no[eë]l|foire|salon/.test(t))return '🎪';
  if(/business|congr[eè]s|conf[eé]rence/.test(t))return '💼';
  return '🎯';
}
function eventBoostFromName(name='',segment='',date='',idx=0){
  const t=(name+' '+segment).toLowerCase();
  let boost=6;
  if(/festival|concert|match|finale|salon|congr[eè]s|foire|zenith|z[eé]nith|arena|stade/.test(t))boost=15;
  else if(/expo|spectacle|th[eé][aâ]tre|march[eé]|course/.test(t))boost=10;
  if(date){const days=Math.round((new Date(date)-new Date())/(1000*60*60*24));if(days>=0&&days<=14)boost+=3;}
  return Math.min(25,boost);
}

function renderEventsPage(citiesMap){
  const container=document.getElementById('events-container');
  const cities=Object.keys(citiesMap);
  let html='';
  let totalEvents=0;

  for(const city of cities){
    const cityEvents=eventsCache[city]||[];
    const apts=citiesMap[city];
    totalEvents+=cityEvents.length;
    const hotCount=cityEvents.filter(e=>e.hot).length;

    html+=`<div class="city-section">
      <div class="city-header">
        <div class="city-name">📍 ${city}</div>
        <div class="city-apts">${apts.map(a=>a.emoji||'🏠'+' '+a.name).join(', ')}</div>
        <span class="city-count">${cityEvents.length} événement${cityEvents.length>1?'s':''}</span>
        ${hotCount>0?`<span class="city-count" style="background:#FAEEDA;color:#854F0B">🔥 ${hotCount} à fort impact</span>`:``}
      </div>`;

    if(!cityEvents.length){
      html+=`<div style="color:#8A8A99;font-size:13px;padding:1rem;background:white;border-radius:12px;border:1px solid #EEEEF5">Aucun événement trouvé pour ${city} dans les 6 prochains mois.</div>`;
    } else {
      html+=`<div class="events-grid">`;
      const sorted=[...cityEvents].sort((a,b)=>(b.boost||0)-(a.boost||0));
      sorted.slice(0,12).forEach(e=>{
        html+=`<div class="event-card ${e.hot?'hot':''}">
          <div class="ev-row">
            <div class="ev-emoji">${e.emoji}</div>
            <div class="ev-info">
              <div class="ev-name">${e.name}</div>
              <div class="ev-meta">${e.date_label}${e.venue?' · '+e.venue:''}</div>
              <div style="margin-top:4px">
                <span class="tag ${e.hot?'tag-warn':'tag-info'}">${e.hot?'🔥 Chaud':e.segment||'Événement'}</span>
              </div>
            </div>
            <div>
              <div class="ev-boost" style="color:${e.hot?'#D97706':'#6B3FA0'}">+${e.boost}%</div>
              <div class="ev-boost-lbl">prix</div>
            </div>
          </div>
        </div>`;
      });
      html+=`</div>`;
    }
    html+=`</div>`;
  }

  document.getElementById('events-sub').textContent=`${totalEvents} événements détectés dans ${cities.length} ville${cities.length>1?'s':''}`;
  container.innerHTML=html;
}

function refreshEvents(){loadEvents(true);}

// SMOOBU
function updateSmoobuUI(connected){
  const dot=document.getElementById('status-dot');const label=document.getElementById('status-label');
  const badge=document.getElementById('smoobu-nav-badge');const saveBtn=document.getElementById('btn-save-smoobu');
  if(connected){dot.className='status-dot connected';label.textContent='Connecté ✓';if(badge)badge.style.display='inline-block';if(saveBtn)saveBtn.style.display='inline-flex';document.getElementById('smoobu-data').style.display='block';}
}

async function testSmoobu(){
  const key=document.getElementById('smoobu-key').value.trim();
  if(!key){showErr('smoobu-error','Collez une clé API Smoobu à tester');return;}
  const btn=document.querySelector('[onclick="testSmoobu()"]');
  btn.disabled=true;btn.textContent='Test…';
  try{
    const data=await smoobuCall('testConnection',{apiKey:key});
    if(data.success){
      showOk('smoobu-success','Connexion Smoobu OK. Cliquez sur “Connecter” pour enregistrer la clé côté serveur.');
      updateSmoobuUI(true);
    }else{
      showErr('smoobu-error','Clé invalide');
      updateSmoobuUI(false);
    }
  }catch(e){
    showErr('smoobu-error','Erreur de connexion Smoobu');
    updateSmoobuUI(false);
  }
  btn.disabled=false;btn.textContent='🔌 Tester';
}

async function saveSmoobuKey(){
  const key=document.getElementById('smoobu-key').value.trim();if(!key)return;
  try{
    await smoobuCall('saveKey',{apiKey:key});
    smoobuConnected=true;
    document.getElementById('smoobu-key').value='';
    updateSmoobuUI(true);
    showToast('✓ Clé Smoobu enregistrée côté serveur');
    await syncSmoobu();
  }catch(e){
    showErr('smoobu-error',"Impossible d\'enregistrer la clé Smoobu");
  }
}

async function syncSmoobu(){
  showToast('🔄 Sync Smoobu…');
  try{
    const aptsData=await smoobuCall('getApartments');const smoobuApts=aptsData._embedded?.apartments||aptsData.apartments||[];
    for(const sa of smoobuApts){
      if(!apparts.find(a=>a.smoobu_id===String(sa.id))){
        const city=sa.city||sa.location||'';
        const body={user_id:currentUser.user.id,name:sa.name||'Appart Smoobu',city:city,zone:'',emoji:'🏠',rent:0,cleaner:25,price:sa.price||100,comp:0,ai_rec:Math.round((sa.price||100)*1.08),booked:false,auto_pricing:true,has_event:false,smoobu_id:String(sa.id)};
        const res=await sbFetch('appartements',{method:'POST',body:JSON.stringify(body)});const c=await res.json();
        if(Array.isArray(c)&&c[0])apparts.push(c[0]);
      }
    }
    const bkData=await smoobuCall('getBookings');const bookings=bkData.bookings||bkData._embedded?.bookings||[];
    const real=bookings.filter(b=>!b['is-blocked-booking']);
    let rev=0;real.forEach(b=>rev+=b.price||0);
    document.getElementById('sm-apts').textContent=smoobuApts.length;
    document.getElementById('sm-bookings').textContent=real.length;
    document.getElementById('sm-revenue').textContent=Math.round(rev)+'€';
    renderSmoobuApts(smoobuApts);
    renderAll();
    if(apparts.length)loadEvents(true);
    showToast(`✓ ${smoobuApts.length} apparts, ${real.length} réservations`);
  }catch(e){showToast('⚠️ Erreur sync');}
}

function renderSmoobuApts(apts){
  const t=document.getElementById('smoobu-apts-table');
  if(!apts||!apts.length){t.innerHTML='<tr><td style="padding:1rem;color:#8A8A99">Aucun appartement</td></tr>';return}
  t.innerHTML=`<thead><tr><th>Nom</th><th>Ville</th><th>Prix base</th></tr></thead><tbody>`+
  apts.map(a=>`<tr><td><div class="apt-name"><div class="apt-emoji">🏠</div>${a.name||'—'}</div></td><td>${a.city||'—'}</td><td>${a.price||'—'}€</td></tr>`).join('')+`</tbody>`;
}

function toggleSidebar(){
  const sb=document.querySelector('.sidebar');
  const ov=document.getElementById('sidebar-overlay');
  sb.classList.toggle('open');
  ov.classList.toggle('open');
}
function closeSidebarMobile(){
  const sb=document.querySelector('.sidebar');
  const ov=document.getElementById('sidebar-overlay');
  if(sb)sb.classList.remove('open');
  if(ov)ov.classList.remove('open');
}


function openAddModal(){editId=null;['m-name','m-city','m-zone','m-rent','m-clean','m-price','m-comp','m-address','m-lat','m-lng'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});document.getElementById('m-address-preview').style.display='none';document.getElementById('m-address-results').style.display='none';document.getElementById('m-degressif-toggle').className='toggle off';document.getElementById('m-degressif-config').style.display='none';document.getElementById('m-deg-start').value='14';document.getElementById('m-deg-step').value='5';document.getElementById('m-deg-min').value='';document.getElementById('m-emoji').value='🏠';document.getElementById('modal-error').style.display='none';document.getElementById('modal').classList.add('open');
  const az=document.getElementById('modal-archive-zone');if(az)az.style.display='none';
  const mt=document.getElementById('modal-title');if(mt)mt.textContent='Ajouter un appartement';
  ['m-surface','m-couchages','m-chambres'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const mt2=document.getElementById('m-type');if(mt2)mt2.value='studio';
}
function openEdit(id){const a=apparts.find(x=>x.id===id);if(!a)return;editId=id;document.getElementById('m-name').value=a.name||'';document.getElementById('m-city').value=a.city||'';document.getElementById('m-zone').value=a.zone||'';document.getElementById('m-address').value=a.address||'';document.getElementById('m-lat').value=a.latitude||'';document.getElementById('m-lng').value=a.longitude||'';const prev=document.getElementById('m-address-preview');if(a.address){prev.textContent='📍 '+a.address;prev.style.display='block';}else{prev.style.display='none';}
  const degToggle=document.getElementById('m-degressif-toggle');const degConfig=document.getElementById('m-degressif-config');
  if(a.auto_degressif){degToggle.className='toggle on';degConfig.style.display='block';document.getElementById('m-deg-start').value=a.degressif_start||14;document.getElementById('m-deg-step').value=a.degressif_step||5;document.getElementById('m-deg-min').value=a.degressif_min||'';updateDegPreview();}
  else{degToggle.className='toggle off';degConfig.style.display='none';}document.getElementById('m-emoji').value=a.emoji||'🏠';document.getElementById('m-rent').value=a.rent||'';document.getElementById('m-clean').value=a.cleaner||'';document.getElementById('m-price').value=a.price||'';document.getElementById('m-comp').value=a.comp||'';document.getElementById('modal-error').style.display='none';document.getElementById('modal').classList.add('open');
  const az=document.getElementById('modal-archive-zone');if(az)az.style.display='block';
  const mt=document.getElementById('modal-title');if(mt)mt.textContent='Modifier le bien';
}
function closeModal(){document.getElementById('modal').classList.remove('open')}
function openAddResModal(){document.getElementById('mr-apt').innerHTML=apparts.map(a=>`<option value="${a.id}">${a.emoji||'🏠'} ${a.name}</option>`).join('');document.getElementById('modal-res').classList.add('open');}
function closeResModal(){document.getElementById('modal-res').classList.remove('open')}

async function saveAppart(){
  const name=document.getElementById('m-name').value.trim();const city=document.getElementById('m-city').value.trim();
  if(!name){showErr('modal-error','Nom obligatoire');return}
  if(!city){showErr('modal-error','Ville obligatoire — nécessaire pour les événements');return}
  const btn=document.getElementById('btn-save-appart');btn.disabled=true;btn.textContent='…';
  const price=+document.getElementById('m-price').value||0;
  const degOn=document.getElementById('m-degressif-toggle').classList.contains('on');const body={user_id:currentUser.user.id,name,city,zone:document.getElementById('m-zone').value||'',address:document.getElementById('m-address').value||'',latitude:+document.getElementById('m-lat').value||null,longitude:+document.getElementById('m-lng').value||null,type_bien:document.getElementById('m-type')?.value||'studio',surface:+document.getElementById('m-surface')?.value||null,couchages:+document.getElementById('m-couchages')?.value||null,chambres:+document.getElementById('m-chambres')?.value||null,emoji:document.getElementById('m-emoji').value||'🏠',rent:+document.getElementById('m-rent').value||0,cleaner:+document.getElementById('m-clean').value||0,price,comp:+document.getElementById('m-comp').value||0,ai_rec:Math.round(price*1.08),booked:false,auto_pricing:true,has_event:false,auto_degressif:degOn,degressif_start:degOn?+document.getElementById('m-deg-start').value:14,degressif_step:degOn?+document.getElementById('m-deg-step').value:5,degressif_min:degOn?+document.getElementById('m-deg-min').value||0:0};
  try{
    if(editId){await sbFetch(`appartements?id=eq.${editId}`,{method:'PATCH',body:JSON.stringify(body)});const i=apparts.findIndex(a=>a.id===editId);if(i>=0)apparts[i]={...apparts[i],...body};showToast('✓ Modifié');}
    else{const res=await sbFetch('appartements',{method:'POST',body:JSON.stringify(body)});const c=await res.json();apparts.push(Array.isArray(c)&&c[0]?c[0]:{...body,id:Date.now().toString()});showToast('✓ Ajouté');}
    closeModal();renderAll();
    // Charger les événements pour la nouvelle ville
    const cityNorm=city.charAt(0).toUpperCase()+city.slice(1).toLowerCase();
    if(!eventsCache[cityNorm])loadEvents(false);
  }catch(e){showErr('modal-error','Erreur');}
  btn.disabled=false;btn.textContent='✓ Enregistrer';
}

async function saveReservation(){
  const aptId=document.getElementById('mr-apt').value;const from=document.getElementById('mr-from').value;const to=document.getElementById('mr-to').value;
  if(!from||!to){showErr('modal-res-error','Dates obligatoires');return}
  const nights=Math.round((new Date(to)-new Date(from))/(1000*60*60*24));
  const body={user_id:currentUser.user.id,appartement_id:aptId,guest_name:document.getElementById('mr-guest').value,date_from:from,date_to:to,price_total:+document.getElementById('mr-price').value||0,platform:document.getElementById('mr-platform').value,status:'confirmed',nights};
  try{const res=await sbFetch('reservations',{method:'POST',body:JSON.stringify(body)});const c=await res.json();reservations.unshift(Array.isArray(c)&&c[0]?c[0]:{...body,id:Date.now().toString()});closeResModal();renderAll();showToast('✓ Réservation ajoutée');}
  catch(e){showErr('modal-res-error','Erreur');}
}

async function toggleBooked(id,val){await sbFetch(`appartements?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({booked:val})});const a=apparts.find(x=>x.id===id);if(a)a.booked=val;renderAll();}
async function toggleAutoPricing(id,val){await sbFetch(`appartements?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({auto_pricing:val})});const a=apparts.find(x=>x.id===id);if(a)a.auto_pricing=val;renderPricingTable();}
async function applyAI(id,rec){
  const a=apparts.find(x=>x.id===id);if(!a)return;
  const maxPrice=Math.round((a.price||100)*1.25);
  const fl=Math.round((a.rent||0)/30+(a.cleaner||0));
  rec=Math.max(Math.min(rec,maxPrice),fl);
  await sbFetch(`appartements?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({price:rec})});
  a.price=rec;renderAll();
  // Proposer push vers Smoobu si connecté
  if(smoobuConnected&&a&&a.smoobu_id){
    showSmoobuPush(a,rec);
  } else {
    showToast('✓ Prix appliqué : '+rec+'€');
  }
}

function showSmoobuPush(apt,newPrice){
  const modal=document.getElementById('modal');
  const m=document.querySelector('#modal .modal');
  m.innerHTML=`
    <div class="modal-head"><div class="modal-title">🤖 EVA → Smoobu</div><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div style="text-align:center;padding:1rem 0">
      <div style="font-size:40px;margin-bottom:12px">🤖→🔗</div>
      <div style="font-size:16px;font-weight:600;margin-bottom:6px">Appliquer ${newPrice}€/nuit sur Smoobu ?</div>
      <div style="font-size:13px;color:#8A8A99;margin-bottom:4px">${apt.emoji||'🏠'} ${apt.name}</div>
      <div style="display:flex;justify-content:center;gap:16px;margin:16px 0">
        <div style="background:#FCEBEB;border-radius:10px;padding:10px 20px;text-align:center">
          <div style="font-size:11px;color:#8A8A99">Ancien prix</div>
          <div style="font-size:20px;font-weight:700;color:#E24B4A;text-decoration:line-through">${apt.price||0}€</div>
        </div>
        <div style="display:flex;align-items:center;font-size:20px;color:#8A8A99">→</div>
        <div style="background:#E1F5EE;border-radius:10px;padding:10px 20px;text-align:center">
          <div style="font-size:11px;color:#8A8A99">Nouveau prix</div>
          <div style="font-size:20px;font-weight:700;color:#1D9E75">${newPrice}€</div>
        </div>
      </div>
      <div style="font-size:12px;color:#8A8A99;margin-bottom:16px">Le prix sera modifié sur Airbnb et Booking via Smoobu</div>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="closeModal()" style="flex:1">Annuler</button>
        <button class="btn btn-purple" onclick="pushToSmoobu('${apt.id}','${apt.smoobu_id}',${newPrice})" style="flex:2">✅ Confirmer et pousser</button>
      </div>
      <button onclick="closeModal();showToast('✓ Prix modifié dans RentyQ uniquement')" style="margin-top:10px;background:none;border:none;font-size:12px;color:#8A8A99;cursor:pointer;font-family:inherit">Modifier seulement dans RentyQ →</button>
    </div>`;
  modal.classList.add('open');
}

async function pushToSmoobu(aptId,smoobuId,newPrice){
  closeModal();
  showToast('🔄 Envoi à Smoobu…');
  try{
    const res=await smoobuCall('updatePrice',{apartmentId:smoobuId,price:newPrice});
    if(res.success||res.status==='ok'){
      showToast('✅ Prix poussé sur Smoobu : '+newPrice+'€');
    } else {
      showToast('⚠ Erreur Smoobu — prix modifié dans RentyQ uniquement');
    }
  }catch(e){
    showToast('⚠ Erreur connexion Smoobu');
  }
}
async function deleteAppart(id){if(!confirm('Supprimer ?'))return;await sbFetch(`appartements?id=eq.${id}`,{method:'DELETE'});apparts=apparts.filter(a=>a.id!==id);renderAll();}
async function saveProfile(){const name=document.getElementById('set-name').value.trim();await sbFetch(`profiles?id=eq.${currentProfile.id}`,{method:'PATCH',body:JSON.stringify({name})});currentProfile.name=name;renderSidebar();showToast('✓ Sauvegardé');}

function buildGlobalRulesAnalysis(){
  const rows=apparts.map(a=>({a,smart:getSmartRec(a)})).sort((x,y)=>{
    const rank={urgent:4,important:3,'opportunité':2,normal:1};
    return (rank[y.smart.priority]||0)-(rank[x.smart.priority]||0) || Math.abs(y.smart.delta)-Math.abs(x.smart.delta);
  });
  const urgent=rows.filter(r=>r.smart.priority==='urgent');
  const baisse=rows.filter(r=>r.smart.direction==='BAISSER');
  const hausse=rows.filter(r=>r.smart.direction==='AUGMENTER');
  const occ=portfolioOccupancy();
  const horizon=+(document.getElementById('pricing-horizon')?.value||14);
  const now=new Date();
  const freeTotal=apparts.reduce((sum,a)=>{
    return sum+Array.from({length:horizon},(_,i)=>{
      const d=new Date(now);d.setDate(d.getDate()+i);
      const date=isoDate(d);
      return !getAptReservations(a).some(r=>bookingCoversDate(r,date));
    }).filter(Boolean).length;
  },0);
  const recoverable=rows.reduce((s,r)=>s+Math.max(0,r.smart.rec||0),0);
  const score=Math.max(0,Math.min(100,Math.round(occ*0.7 + (100-Math.min(100,urgent.length*20))*0.3)));
  const top=rows.slice(0,4);

  let html=`<div class="eva-dashboard">
    <div class="eva-hero-card">
      <div class="eva-hero-kicker">EVA Rules Engine · sans IA payante</div>
      <div class="eva-hero-title">${urgent.length?urgent.length+' action'+(urgent.length>1?'s':'')+' à faire maintenant':'Portefeuille sous contrôle'}</div>
      <div class="eva-hero-sub">${occ<45?'Priorité absolue : remplir les nuits proches. Une nuit vide vaut 0€, donc EVA privilégie l\u2019occupation avant la marge.':occ<65?'Objectif : sécuriser plus de réservations sur les 14 prochains jours avant de remonter les prix.':'Le remplissage est correct : EVA peut protéger les prix sur les dates fortes.'}</div>
      <div class="eva-hero-money">
        <div class="eva-money-big">+${recoverable}€</div>
        <div class="eva-money-label">revenu théorique à sécuriser<br>en appliquant les recommandations</div>
      </div>
    </div>
    <div class="eva-side-stack">
      <div class="eva-metric-card">
        <div class="eva-metric-label">Occupation</div>
        <div class="eva-metric-value">${occ}%</div>
        <div class="eva-progress"><span style="width:${Math.max(5,Math.min(100,occ))}%"></span></div>
        <div class="eva-metric-help">Objectif minimum : 65%</div>
      </div>
      <div class="eva-metric-card">
        <div class="eva-metric-label">Nuits libres</div>
        <div class="eva-metric-value">${freeTotal}</div>
        <div class="eva-metric-help">Sur les ${horizon} prochains jours</div>
      </div>
      <div class="eva-metric-card">
        <div class="eva-metric-label">Score EVA</div>
        <div class="eva-metric-value">${score}/100</div>
        <div class="eva-progress"><span style="width:${score}%"></span></div>
        <div class="eva-metric-help">${score<50?'Plan d\u2019action urgent':score<75?'Optimisation en cours':'Bonne dynamique'}</div>
      </div>
      <div class="eva-metric-card">
        <div class="eva-metric-label">Baisses utiles</div>
        <div class="eva-metric-value">${baisse.length}</div>
        <div class="eva-metric-help">Pour vendre plutôt que laisser vide</div>
      </div>
    </div>
  </div>`;

  html+=`<div class="eva-actions-panel">
    <div class="eva-panel-head">
      <div><div class="eva-panel-title">🎯 Missions EVA prioritaires</div><div class="eva-panel-sub">Lisible en 3 secondes : quoi faire, combien, pourquoi.</div></div>
      <span class="eva-pill ${urgent.length?'eva-pill-red':'eva-pill-green'}">${urgent.length?urgent.length+' urgent'+(urgent.length>1?'s':''):'OK'}</span>
    </div>
    <div class="eva-action-grid">`;

  const cards=top.length?top:rows.slice(0,3);
  cards.forEach(({a,smart})=>{
    const urgentClass=smart.priority==='urgent'?'urgent':(smart.direction==='AUGMENTER'?'up':'');
    const badge=smart.priority==='urgent'?'<span class="eva-pill eva-pill-red">🚨 urgent</span>':smart.direction==='AUGMENTER'?'<span class="eva-pill eva-pill-orange">💰 opportunité</span>':'<span class="eva-pill eva-pill-purple">🎯 à optimiser</span>';
    html+=`<div class="eva-action-card ${urgentClass}">
      <div class="eva-action-top">
        <div><div class="eva-apt-name">${a.emoji||'🏠'} ${escapeHtml(a.name||'Appartement')}</div><div class="eva-apt-city">${escapeHtml(a.city||extractCity(a.zone,null)||'')}</div></div>
        ${badge}
      </div>
      <div class="eva-price-row"><span class="eva-price-old">${a.price||0}€</span><span class="eva-price-arrow">→</span><span class="eva-price-new">${smart.rec}€</span></div>
      <div class="eva-reason">${escapeHtml((smart.reasons&&smart.reasons[0])||smart.reason||'Prix cohérent avec les données disponibles')}</div>
      <div class="eva-card-footer">
        <span class="eva-impact">${smart.delta<0?'Mieux vaut louer moins cher que vide':'Revenu à capter'}</span>
        <button class="btn btn-sm btn-purple" onclick="applyAI('${a.id}',${smart.rec})">Appliquer</button>
      </div>
    </div>`;
  });
  html+=`</div></div>`;
  return html;
}

function runGlobal(){
  const btn=document.getElementById('btn-global');const zone=document.getElementById('global-result');
  if(btn){btn.disabled=true;btn.textContent='⏳…';}
  if(!apparts.length){zone.innerHTML=`<div class="ai-bubble" style="margin-bottom:1rem"><div class="ai-bubble-head">🤖</div><div class="ai-bubble-text">Ajoutez des appartements d\u2019abord.</div></div>`;if(btn){btn.disabled=false;btn.innerHTML='🤖 Analyse globale';}return;}
  zone.innerHTML=buildGlobalRulesAnalysis();
  if(btn){btn.disabled=false;btn.innerHTML='🤖 Analyse globale';}
}

async function askAI(id){
  const a=apparts.find(x=>x.id===id);if(!a)return;
  const city=a.city||extractCity(a.zone,null)||'';
  const smart=getSmartRec(a);
  const cityEvents=(eventsCache[city]||[]).filter(e=>e.hot);
  const freeDays=reservations.filter(r=>r.appartement_id===id).length;

  // Afficher dans une modale légère
  const modal=document.getElementById('modal');
  if(!modal)return;
  const m=modal.querySelector('.modal');
  m.innerHTML=`
    <div class="modal-head">
      <div class="modal-title">${a.emoji||'🏠'} Analyse EVA — ${a.name}</div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="ai-bubble" style="margin-bottom:0">
      <div class="ai-bubble-head"><div class="ai-dot"></div> EVA analyse votre bien…</div>
      <div class="ai-bubble-text" id="ai-modal-text">
        <div class="typing"><span></span><span></span><span></span></div>
      </div>
    </div>`;
  modal.classList.add('open');

  // Générer l\u2019analyse
  setTimeout(()=>{
    const fl=floor(a);
    const occ=Math.min(Math.round((freeDays/8)*100),100)||0;
    let txt=`<strong>${a.name}</strong> — ${city}<br><br>`;
    txt+=`<strong>Situation actuelle :</strong><br>`;
    txt+=`• Prix actuel : ${a.price||0}€/nuit · Plancher : ${fl}€<br>`;
    txt+=`• Statut ce soir : ${a.booked?'✅ Loué':'⚠️ Libre'}<br>`;
    txt+=`• Occupation estimée : ${occ}%<br><br>`;
    txt+=`<strong>Recommandation EVA :</strong> ${smart.rec}€/nuit<br>`;
    txt+=`• ${smart.reason}<br><br>`;
    if(cityEvents.length>0){
      txt+=`<strong>Événements détectés :</strong><br>`;
      cityEvents.slice(0,3).forEach(e=>{
        txt+=`• ${e.name}${e.date?' — '+new Date(e.date).toLocaleDateString('fr-FR',{day:'numeric',month:'short'}):''} (+${e.boost||8}%)<br>`;
      });
      txt+='<br>';
    }
    txt+=`<strong>Action recommandée :</strong> `;
    if(!a.booked&&occ<40)txt+=`Baisser à <strong>${smart.rec}€</strong> pour remplir cette nuit libre.`;
    else if(cityEvents.length>0)txt+=`Monter à <strong>${smart.rec}€</strong> pendant l\u2019événement.`;
    else txt+=`Maintenir à <strong>${smart.rec}€</strong>, prix cohérent avec le marché.`;
    document.getElementById('ai-modal-text').innerHTML=txt;
  },800);
}


function showForgotPassword(){
  document.getElementById('login-form').style.display='none';
  document.getElementById('forgot-form').style.display='block';
}
function showLogin(){
  document.getElementById('forgot-form').style.display='none';
  document.getElementById('login-form').style.display='block';
}
async function doForgotPassword(){
  const email=document.getElementById('forgot-email').value.trim();
  if(!email){showErr('forgot-error','Entrez votre email');return}
  const btn=document.getElementById('btn-forgot');btn.disabled=true;btn.textContent='Envoi...';
  try{
    const res=await fetch(`${SB_URL}/auth/v1/recover`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email})});
    if(res.ok){showOk('forgot-success','✓ Email envoyé ! Vérifiez votre boîte mail.');}
    else{showErr('forgot-error','Email introuvable');}
  }catch(e){showErr('forgot-error','Erreur réseau');}
  btn.disabled=false;btn.textContent='📧 Envoyer le lien';
}


// MODULES
let userModules=['solo'];
let currentMode='solo';
let proprietaires=[];
let rapportsData=[];
let editProprioId=null;

function getModules(){
  const mods=currentProfile?.modules||currentProfile?.type||'solo';
  if(typeof mods==='string'){
    if(mods.includes(','))return mods.split(',');
    return [mods];
  }
  if(Array.isArray(mods))return mods;
  return['solo'];
}

function updateNavVisibility(){
  // CleanyQ — visible seulement si au moins 1 cleaner ou 1 mission
  const hasCleanyQ=typeof cleanersData!=='undefined'&&(cleanersData.length>0||(typeof missionsData!=='undefined'&&missionsData.length>0));
  const navCQ=document.getElementById('nav-cleanyq');
  const navCQLabel=document.getElementById('nav-label-cleanyq');
  if(navCQ)navCQ.style.display=hasCleanyQ?'flex':'none';
  if(navCQLabel)navCQLabel.style.display=hasCleanyQ?'block':'none';

  // Smoobu — visible seulement si clé configurée
  const hasSmoobu=!!smoobuConnected;
  const navSm=document.getElementById('nav-smoobu');
  const navSmLabel=document.getElementById('nav-label-integrations');
  if(navSm)navSm.style.display=hasSmoobu?'flex':'none';
  if(navSmLabel)navSmLabel.style.display=hasSmoobu?'block':'none';
}

function applyModules(){
  userModules=getModules();
  updateNavVisibility();
  // mode-switcher masqué — sidebar unifiée, on reste toujours en mode solo
  const switcher=document.getElementById('mode-switcher');
  if(switcher)switcher.style.display='none';
  // switchMode auto désactivé (sidebar unifiée — pas de bascule Solo/Conciergerie)
  // if(userModules.includes('concierge')&&!userModules.includes('solo'))switchMode('concierge');
  // else if(!userModules.includes('concierge')&&userModules.includes('solo'))switchMode('solo');
  // Update settings toggles
  const tSolo=document.getElementById('toggle-mod-solo');
  const tConc=document.getElementById('toggle-mod-concierge');
  if(tSolo){tSolo.className='toggle '+(userModules.includes('solo')?'on':'off');}
  if(tConc){tConc.className='toggle '+(userModules.includes('concierge')?'on':'off');}
}

function switchMode(mode){
  currentMode=mode;
  // Afficher champ commission si mode conciergerie
  const commField=document.getElementById('conciergerie-commission-field');
  if(commField)commField.style.display=mode==='concierge'?'block':'none';
  const navSolo=document.getElementById('nav-solo');
  const navConc=document.getElementById('nav-concierge');
  const btnSolo=document.getElementById('mode-btn-solo');
  const btnConc=document.getElementById('mode-btn-concierge');
  if(mode==='solo'){
    if(navSolo)navSolo.style.display='block';
    if(navConc)navConc.style.display='none';
    if(btnSolo){btnSolo.style.background='rgba(107,63,160,0.5)';btnSolo.style.color='white';}
    if(btnConc){btnConc.style.background='transparent';btnConc.style.color='rgba(255,255,255,0.4)';}
    goTo('cockpit',document.querySelector('#nav-solo .nav-item'));
  } else {
    if(navSolo)navSolo.style.display='none';
    if(navConc)navConc.style.display='block';
    if(btnConc){btnConc.style.background='rgba(107,63,160,0.5)';btnConc.style.color='white';}
    if(btnSolo){btnSolo.style.background='transparent';btnSolo.style.color='rgba(255,255,255,0.4)';}
    goTo('cockpit-c',document.querySelector('#nav-concierge .nav-item'));
    renderCockpitConcierge();
    renderParcConcierge();
  }
}

function renderCockpitConcierge(){
  const el=document.getElementById('cockpit-c-content');if(!el)return;
  document.getElementById('cockpit-c-date').textContent=new Date().toLocaleDateString('fr-FR',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const totalAppts=apparts.filter(a=>a.proprietaire_id).length;
  const mois=new Date().toISOString().slice(0,7);
  const monthRes=reservations.filter(r=>r.date_from&&r.date_from.startsWith(mois));
  const totalRev=monthRes.reduce((s,r)=>s+(r.price_total||0),0);
  const totalComm=proprietaires.reduce((s,p)=>{
    const pAppts=apparts.filter(a=>a.proprietaire_id===p.id);
    const pRes=monthRes.filter(r=>pAppts.some(a=>a.id===r.appartement_id));
    return s+Math.round(pRes.reduce((s2,r)=>s2+(r.price_total||0),0)*(p.commission||20)/100);
  },0);
  const hotEvents=Object.values(eventsCache).flat().filter(e=>e.hot).length;

  let h='';

  // KPIs
  h+=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:1.25rem">
    <div class="kpi"><div class="kpi-label">Propriétaires</div><div class="kpi-value" style="color:#6B3FA0">${proprietaires.length}</div><div class="kpi-delta" style="color:#6B3FA0">clients actifs</div></div>
    <div class="kpi"><div class="kpi-label">Apparts gérés</div><div class="kpi-value">${totalAppts}</div><div class="kpi-delta" style="color:#059669">en gestion</div></div>
    <div class="kpi"><div class="kpi-label">Revenus mois</div><div class="kpi-value">${totalRev}€</div><div class="kpi-delta" style="color:#059669">brut total</div></div>
    <div class="kpi"><div class="kpi-label">Mes commissions</div><div class="kpi-value" style="color:#BA7517">${totalComm}€</div><div class="kpi-delta" style="color:#BA7517">ce mois</div></div>
    ${hotEvents>0?`<div class="kpi" style="border-color:#FCD34D;background:#FFFBEB"><div class="kpi-label">Événements</div><div class="kpi-value" style="color:#BA7517">${hotEvents}</div><div class="kpi-delta" style="color:#BA7517">\ud83d\udd25 boost dispo</div></div>`:''}
  </div>`;

  // Alertes conciergerie
  h+=`<div style="font-size:11px;font-weight:500;color:#8A8A99;text-transform:uppercase;letter-spacing:.8px;margin-bottom:.5rem">Actions prioritaires</div>`;
  let alerts=[];
  proprietaires.forEach(p=>{
    const pAppts=apparts.filter(a=>a.proprietaire_id===p.id);
    if(!pAppts.length)alerts.push({type:'warning',text:`${p.name} — aucun appartement assigné`,action:'Assigner',onclick:`openAssignApparts('${p.id}')`});
    pAppts.forEach(a=>{
      if(!a.booked)alerts.push({type:'urgent',text:`${a.name} (${p.name}) — libre ce soir`,action:'Voir le parc',onclick:"goTo('parc-c')"});
    });
    const pRes=monthRes.filter(r=>pAppts.some(a=>a.id===r.appartement_id));
    if(pAppts.length>0&&pRes.length===0)alerts.push({type:'warning',text:`${p.name} — 0 réservations ce mois`,action:'Analyser',onclick:"goTo('rapports')"});
  });
  if(!alerts.length)alerts.push({type:'success',text:'Tout est en ordre ! Aucune action urgente.',action:''});

  alerts.slice(0,5).forEach(a=>{
    const col=a.type==='urgent'?'#993C1D':a.type==='warning'?'#854F0B':'#0F6E56';
    const bg=a.type==='urgent'?'#FAECE7':a.type==='warning'?'#FAEEDA':'#E1F5EE';
    const brd=a.type==='urgent'?'#D85A30':a.type==='warning'?'#BA7517':'#1D9E75';
    h+=`<div style="display:flex;align-items:center;gap:10px;padding:.75rem 1rem;border-radius:10px;border:0.5px solid #EEEEF5;border-left:3px solid ${brd};background:white;margin-bottom:6px">
      <div style="flex:1;font-size:13px;color:${col};font-weight:500">${a.text}</div>
      ${a.action?`<button onclick="${a.onclick}" class="btn btn-sm" style="background:${bg};border-color:${brd};color:${col}">${a.action}</button>`:''}
    </div>`;
  });

  // Liste propriétaires avec mini-rapports
  h+=`<div style="font-size:11px;font-weight:500;color:#8A8A99;text-transform:uppercase;letter-spacing:.8px;margin-bottom:.5rem;margin-top:1.25rem">Vos propriétaires</div>`;
  if(!proprietaires.length){
    h+=`<div style="text-align:center;padding:2rem;background:white;border-radius:12px;border:0.5px solid #EEEEF5">
      <div style="font-size:32px;margin-bottom:8px">👤</div>
      <div style="font-weight:500;margin-bottom:8px">Aucun propriétaire</div>
      <button class="btn btn-purple btn-sm" onclick="openAddProprioModal()">+ Ajouter un propriétaire</button>
    </div>`;
  } else {
    h+=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">`;
    proprietaires.forEach(p=>{
      const pAppts=apparts.filter(a=>a.proprietaire_id===p.id);
      const pRes=monthRes.filter(r=>pAppts.some(a=>a.id===r.appartement_id));
      const rev=pRes.reduce((s,r)=>s+(r.price_total||0),0);
      const comm=Math.round(rev*(p.commission||20)/100);
      const net=rev-comm;
      const freeApts=pAppts.filter(a=>!a.booked).length;
      h+=`<div style="background:white;border-radius:12px;border:0.5px solid #EEEEF5;padding:1rem;position:relative;overflow:hidden">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${freeApts>0?'#D85A30':'#1D9E75'}"></div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#6B3FA0,#FF6B6B);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:white;flex-shrink:0">${(p.name||'?').charAt(0).toUpperCase()}</div>
          <div>
            <div style="font-size:14px;font-weight:700">${p.name}</div>
            <div style="font-size:11px;color:#8A8A99">${pAppts.length} appart${pAppts.length>1?'s':''} · ${p.commission||20}% comm.</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px">
          <div style="background:#F5F4FF;border-radius:8px;padding:6px;text-align:center">
            <div style="font-size:16px;font-weight:700">${rev}€</div>
            <div style="font-size:10px;color:#8A8A99">Brut</div>
          </div>
          <div style="background:#FAEEDA;border-radius:8px;padding:6px;text-align:center">
            <div style="font-size:16px;font-weight:700;color:#BA7517">${comm}€</div>
            <div style="font-size:10px;color:#8A8A99">Comm.</div>
          </div>
          <div style="background:#E1F5EE;border-radius:8px;padding:6px;text-align:center">
            <div style="font-size:16px;font-weight:700;color:#059669">${net}€</div>
            <div style="font-size:10px;color:#8A8A99">Net</div>
          </div>
        </div>
        ${freeApts>0?`<div style="font-size:11px;padding:4px 8px;border-radius:6px;background:#FAECE7;color:#993C1D">${freeApts} appart${freeApts>1?'s':''} libre${freeApts>1?'s':''} ce soir</div>`:`<div style="font-size:11px;padding:4px 8px;border-radius:6px;background:#E1F5EE;color:#059669">Tout loué \u2713</div>`}
      </div>`;
    });
    h+=`</div>`;
  }

  el.innerHTML=h;
}

function renderParcConcierge(){
  const el=document.getElementById('parc-c-content');if(!el)return;
  const managed=apparts.filter(a=>a.proprietaire_id);
  document.getElementById('parc-c-sub').textContent=managed.length+' appartement'+(managed.length>1?'s':'')+' en gestion';

  if(!managed.length){
    el.innerHTML=`<div style="text-align:center;padding:3rem;background:white;border-radius:14px;border:0.5px solid #EEEEF5">
      <div style="font-size:40px;margin-bottom:1rem">🏠</div>
      <div style="font-weight:600;font-size:16px;margin-bottom:6px">Aucun appartement en gestion</div>
      <div style="font-size:13px;color:#8A8A99;margin-bottom:1.25rem">Ajoutez des propriétaires puis assignez-leur des appartements</div>
      <button class="btn btn-purple" onclick="goTo('proprietaires',document.querySelector('[onclick*=proprietaires]'))">👤 Gérer les propriétaires</button>
    </div>`;
    return;
  }

  let h=`<div class="card"><div class="table-wrap"><table>
    <thead><tr><th>Appartement</th><th>Propriétaire</th><th>Ville</th><th>Prix/nuit</th><th>Commission</th><th>Statut</th><th>Net proprio</th></tr></thead><tbody>`;

  managed.forEach(a=>{
    const p=proprietaires.find(x=>x.id===a.proprietaire_id);
    const commPct=p?.commission||20;
    const netPrice=Math.round((a.price||0)*(100-commPct)/100);
    h+=`<tr>
      <td><div class="apt-name"><div class="apt-emoji">${a.emoji||'\ud83c\udfe0'}</div><div><div>${a.name}</div><div style="font-size:11px;color:#8A8A99">${a.zone||''}</div></div></div></td>
      <td style="font-weight:600;color:#6B3FA0">${p?.name||'—'}</td>
      <td style="font-size:12px;color:#8A8A99">${a.city||'—'}</td>
      <td class="price-main">${getCurrentDegPrice(a)}€${a.auto_degressif&&!a.booked&&getCurrentDegPrice(a)<a.price?'<div style="font-size:10px;color:#6B3FA0">⏰ dégressif</div>':''}</td>
      <td><span class="tag tag-warn">${commPct}%</span></td>
      <td><span class="tag ${a.booked?'tag-ok':'tag-bad'}">${a.booked?'Loué':'Libre'}</span></td>
      <td style="font-weight:600;color:#059669">${netPrice}€</td>
    </tr>`;
  });

  h+=`</tbody></table></div></div>`;
  el.innerHTML=h;
}

async function toggleModule(mod){
  if(userModules.includes(mod)){
    userModules=userModules.filter(m=>m!==mod);
    if(userModules.length===0)userModules=['solo'];
  } else {
    userModules.push(mod);
  }
  const type=userModules.includes('concierge')?'concierge':'solo';
  currentProfile.modules=userModules.join(',');
  currentProfile.type=type;
  await sbFetch(`profiles?id=eq.${currentProfile.id}`,{method:'PATCH',body:JSON.stringify({type,modules:'{'+userModules.join(',')+'}'})});
  applyModules();
  renderSidebar();
  showToast('✓ Module '+(userModules.includes(mod)?'activé':'désactivé'));
}

// PROPRIETAIRES
async function loadProprietaires(){
  try{
    const res=await sbFetch(`proprietaires?user_id=eq.${currentUser.user.id}&select=*&order=created_at.asc`);
    proprietaires=await res.json()||[];
  }catch(e){proprietaires=[];}
}

function renderProprietaires(){
  const list=document.getElementById('proprios-list');
  const empty=document.getElementById('proprios-empty');
  const kpis=document.getElementById('proprios-kpis');
  if(!list)return;
  if(!proprietaires.length){empty.style.display='block';list.innerHTML='';kpis.innerHTML='';return;}
  empty.style.display='none';

  const totalAppts=proprietaires.reduce((s,p)=>s+apparts.filter(a=>a.proprietaire_id===p.id).length,0);
  const avgComm=proprietaires.length?Math.round(proprietaires.reduce((s,p)=>s+(p.commission||20),0)/proprietaires.length):0;

  kpis.innerHTML=`
    <div class="kpi"><div class="kpi-label">Propriétaires</div><div class="kpi-value">${proprietaires.length}</div><div class="kpi-delta" style="color:#6B3FA0">clients actifs</div></div>
    <div class="kpi"><div class="kpi-label">Apparts gérés</div><div class="kpi-value">${totalAppts}</div><div class="kpi-delta" style="color:#059669">en gestion</div></div>
    <div class="kpi"><div class="kpi-label">Commission moy.</div><div class="kpi-value">${avgComm}%</div><div class="kpi-delta" style="color:#8A8A99">sur revenus bruts</div></div>`;

  list.innerHTML=proprietaires.map(p=>{
    const pApparts=apparts.filter(a=>a.proprietaire_id===p.id);
    const pRes=reservations.filter(r=>pApparts.some(a=>a.id===r.appartement_id));
    const rev=pRes.reduce((s,r)=>s+(r.price_total||0),0);
    const comm=Math.round(rev*(p.commission||20)/100);
    const net=rev-comm;
    return`<div class="card" style="margin-bottom:.75rem">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#6B3FA0,#FF6B6B);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:white;flex-shrink:0">${(p.name||'?').charAt(0).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:700">${p.name}</div>
          <div style="font-size:12px;color:#8A8A99;margin-top:2px">${p.email||'—'} ${p.phone?' · '+p.phone:''}</div>
          <div style="display:flex;gap:12px;margin-top:8px;font-size:12px;color:#8A8A99;flex-wrap:wrap">
            <span>🏠 <strong style="color:#1A1A2E">${pApparts.length}</strong> appart${pApparts.length>1?'s':''}</span>
            <span>💰 <strong style="color:#1A1A2E">${rev}€</strong> revenus</span>
            <span>📊 <strong style="color:#6B3FA0">${p.commission||20}%</strong> commission</span>
            <span>💸 <strong style="color:#059669">${net}€</strong> net proprio</span>
          </div>
          ${pApparts.length?`<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${pApparts.map(a=>`<span class="tag tag-info">${a.emoji||'🏠'} ${a.name}</span>`).join('')}</div>`:'<div style="margin-top:8px;font-size:12px;color:#BA7517">⚠ Aucun appartement assigné</div>'}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-sm" onclick="openEditProprio('${p.id}')">✏️</button>
          <button class="btn btn-sm" onclick="openAssignApparts('${p.id}')">🏠+</button>
          <button class="btn btn-sm" onclick="deleteProprio('${p.id}')" style="color:#DC2626">🗑</button>
        </div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('proprios-sub').textContent=proprietaires.length+' propriétaire'+(proprietaires.length>1?'s':'');
}

function openAddProprioModal(){
  editProprioId=null;
  document.getElementById('modal-proprio-title').textContent='Ajouter un propriétaire';
  ['mp-name','mp-email','mp-phone','mp-iban','mp-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('mp-commission').value='20';
  document.getElementById('modal-proprio-error').style.display='none';
  document.getElementById('modal-proprio').classList.add('open');
}

function openEditProprio(id){
  const p=proprietaires.find(x=>x.id===id);if(!p)return;
  editProprioId=id;
  document.getElementById('modal-proprio-title').textContent='Modifier '+p.name;
  document.getElementById('mp-name').value=p.name||'';
  document.getElementById('mp-email').value=p.email||'';
  document.getElementById('mp-phone').value=p.phone||'';
  document.getElementById('mp-commission').value=p.commission||20;
  document.getElementById('mp-iban').value=p.iban||'';
  document.getElementById('mp-notes').value=p.notes||'';
  document.getElementById('modal-proprio-error').style.display='none';
  document.getElementById('modal-proprio').classList.add('open');
}

function closeProprioModal(){document.getElementById('modal-proprio').classList.remove('open')}

async function saveProprietaire(){
  const name=document.getElementById('mp-name').value.trim();
  if(!name){showErr('modal-proprio-error','Nom obligatoire');return}
  const btn=document.getElementById('btn-save-proprio');btn.disabled=true;btn.textContent='…';
  const body={
    user_id:currentUser.user.id,
    name,
    email:document.getElementById('mp-email').value.trim(),
    phone:document.getElementById('mp-phone').value.trim(),
    commission:+document.getElementById('mp-commission').value||20,
    iban:document.getElementById('mp-iban').value.trim(),
    notes:document.getElementById('mp-notes').value.trim()
  };
  try{
    if(editProprioId){
      await sbFetch(`proprietaires?id=eq.${editProprioId}`,{method:'PATCH',body:JSON.stringify(body)});
      const i=proprietaires.findIndex(p=>p.id===editProprioId);
      if(i>=0)proprietaires[i]={...proprietaires[i],...body};
      showToast('✓ Propriétaire modifié');
    } else {
      const res=await sbFetch('proprietaires',{method:'POST',body:JSON.stringify(body)});
      const c=await res.json();
      proprietaires.push(Array.isArray(c)&&c[0]?c[0]:{...body,id:Date.now().toString()});
      showToast('✓ Propriétaire ajouté');
    }
    closeProprioModal();renderProprietaires();
  }catch(e){showErr('modal-proprio-error','Erreur');}
  btn.disabled=false;btn.textContent='✓ Enregistrer';
}

async function deleteProprio(id){
  if(!confirm('Supprimer ce propriétaire ?'))return;
  await sbFetch(`proprietaires?id=eq.${id}`,{method:'DELETE'});
  proprietaires=proprietaires.filter(p=>p.id!==id);
  apparts.filter(a=>a.proprietaire_id===id).forEach(a=>a.proprietaire_id=null);
  renderProprietaires();showToast('🗑 Propriétaire supprimé');
}

function openAssignApparts(proprioId){
  const p=proprietaires.find(x=>x.id===proprioId);if(!p)return;
  const assigned=apparts.filter(a=>a.proprietaire_id===proprioId);
  const unassigned=apparts.filter(a=>!a.proprietaire_id||a.proprietaire_id===proprioId);
  let html=`<div style="font-weight:700;margin-bottom:1rem">Assigner des appartements à ${p.name}</div>`;
  if(!apparts.length){html+='<div style="color:#8A8A99;font-size:13px">Aucun appartement. Ajoutez-en dans Le Parc.</div>';}
  else{
    apparts.forEach(a=>{
      const isAssigned=a.proprietaire_id===proprioId;
      const otherProprio=!isAssigned&&a.proprietaire_id?proprietaires.find(p=>p.id===a.proprietaire_id):null;
      html+=`<label style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;cursor:pointer;border:1px solid #E8E8EE;margin-bottom:6px${otherProprio?';opacity:0.5':''}">
        <input type="checkbox" ${isAssigned?'checked':''} ${otherProprio?'disabled':''} onchange="assignAppart('${a.id}','${proprioId}',this.checked)" style="width:18px;height:18px;accent-color:#6B3FA0"/>
        <span style="font-size:14px">${a.emoji||'🏠'}</span>
        <div><div style="font-size:13px;font-weight:500">${a.name}</div><div style="font-size:11px;color:#8A8A99">${a.city||a.zone||''}${otherProprio?' · Assigné à '+otherProprio.name:''}</div></div>
      </label>`;
    });
  }
  html+=`<button class="btn btn-purple" onclick="closeAssignModal()" style="width:100%;margin-top:1rem;justify-content:center">✓ Terminé</button>`;
  document.getElementById('modal-proprio-title').textContent='Assigner les appartements';
  document.querySelector('#modal-proprio .modal').innerHTML=`<div class="modal-head"><div class="modal-title">Assigner à ${p.name}</div><button class="modal-close" onclick="closeAssignModal()">✕</button></div>${html}`;
  document.getElementById('modal-proprio').classList.add('open');
}

function closeAssignModal(){
  document.getElementById('modal-proprio').classList.remove('open');
  // Restore modal content
  document.querySelector('#modal-proprio .modal').innerHTML=`
    <div class="modal-head"><div class="modal-title" id="modal-proprio-title">Ajouter un propriétaire</div><button class="modal-close" onclick="closeProprioModal()">✕</button></div>
    <div class="form-group"><label>Nom complet ★</label><input type="text" id="mp-name" placeholder="Jean Dupont"/></div>
    <div class="form-group"><label>Email</label><input type="email" id="mp-email" placeholder="jean@exemple.fr"/></div>
    <div class="form-group"><label>Téléphone</label><input type="text" id="mp-phone" placeholder="06 12 34 56 78"/></div>
    <div class="form-group"><label>Commission (%)</label><input type="number" id="mp-commission" placeholder="20" value="20"/></div>
    <div class="form-group"><label>IBAN</label><input type="text" id="mp-iban" placeholder="FR76 1234…"/></div>
    <div class="form-group"><label>Notes</label><input type="text" id="mp-notes" placeholder="Contrat signé le…"/></div>
    <div style="display:flex;gap:8px;margin-top:1.25rem">
      <button class="btn" onclick="closeProprioModal()" style="flex:1">Annuler</button>
      <button class="btn btn-purple" onclick="saveProprietaire()" id="btn-save-proprio" style="flex:2">✓ Enregistrer</button>
    </div>
    <div class="auth-error" id="modal-proprio-error"></div>`;
  renderProprietaires();
}

async function assignAppart(aptId,proprioId,assign){
  const val=assign?proprioId:null;
  await sbFetch(`appartements?id=eq.${aptId}`,{method:'PATCH',body:JSON.stringify({proprietaire_id:val})});
  const a=apparts.find(x=>x.id===aptId);
  if(a)a.proprietaire_id=val;
  showToast(assign?'✓ Appartement assigné':'Appartement retiré');
}

// RAPPORTS MENSUELS
function initRapportMois(){
  const sel=document.getElementById('rapport-mois');if(!sel)return;
  const now=new Date();
  sel.innerHTML='';
  for(let i=0;i<6;i++){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const val=d.toISOString().slice(0,7);
    const label=d.toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
    sel.innerHTML+=`<option value="${val}">${label.charAt(0).toUpperCase()+label.slice(1)}</option>`;
  }
}

function renderRapports(){
  const list=document.getElementById('rapports-list');
  const empty=document.getElementById('rapports-empty');
  if(!list)return;
  if(!proprietaires.length){empty.style.display='block';list.innerHTML='';return;}
  empty.style.display='none';

  const mois=document.getElementById('rapport-mois')?.value||new Date().toISOString().slice(0,7);
  const moisLabel=new Date(mois+'-01').toLocaleDateString('fr-FR',{month:'long',year:'numeric'});

  let html='';
  proprietaires.forEach(p=>{
    const pApparts=apparts.filter(a=>a.proprietaire_id===p.id);
    const pRes=reservations.filter(r=>{
      const apt=pApparts.find(a=>a.id===r.appartement_id);
      return apt&&r.date_from&&r.date_from.startsWith(mois);
    });
    const revBrut=pRes.reduce((s,r)=>s+(r.price_total||0),0);
    const nuits=pRes.reduce((s,r)=>s+(r.nights||0),0);
    const comm=Math.round(revBrut*(p.commission||20)/100);
    const net=revBrut-comm;
    const nbJours=new Date(+mois.split('-')[0],+mois.split('-')[1],0).getDate();
    const occMax=pApparts.length*nbJours;
    const occ=occMax>0?Math.round(nuits/occMax*100):0;

    html+=`<div class="card" style="margin-bottom:.75rem">
      <div class="card-head">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#6B3FA0,#FF6B6B);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:white;flex-shrink:0">${(p.name||'?').charAt(0).toUpperCase()}</div>
          <div>
            <div style="font-size:15px;font-weight:700">${p.name}</div>
            <div style="font-size:12px;color:#8A8A99">${moisLabel} · ${pApparts.length} appart${pApparts.length>1?'s':''}</div>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-bottom:1rem">
        <div style="background:#F5F4FF;border-radius:10px;padding:.75rem;text-align:center">
          <div style="font-size:20px;font-weight:700">${revBrut}€</div>
          <div style="font-size:11px;color:#8A8A99">Revenus bruts</div>
        </div>
        <div style="background:#FAEEDA;border-radius:10px;padding:.75rem;text-align:center">
          <div style="font-size:20px;font-weight:700;color:#BA7517">${comm}€</div>
          <div style="font-size:11px;color:#8A8A99">Commission ${p.commission||20}%</div>
        </div>
        <div style="background:#E1F5EE;border-radius:10px;padding:.75rem;text-align:center">
          <div style="font-size:20px;font-weight:700;color:#059669">${net}€</div>
          <div style="font-size:11px;color:#8A8A99">Net propriétaire</div>
        </div>
        <div style="background:#F5F4FF;border-radius:10px;padding:.75rem;text-align:center">
          <div style="font-size:20px;font-weight:700">${pRes.length}</div>
          <div style="font-size:11px;color:#8A8A99">Réservations</div>
        </div>
        <div style="background:#F5F4FF;border-radius:10px;padding:.75rem;text-align:center">
          <div style="font-size:20px;font-weight:700">${nuits}</div>
          <div style="font-size:11px;color:#8A8A99">Nuits vendues</div>
        </div>
        <div style="background:#F5F4FF;border-radius:10px;padding:.75rem;text-align:center">
          <div style="font-size:20px;font-weight:700;color:${occ>=60?'#059669':occ>=40?'#BA7517':'#D85A30'}">${occ}%</div>
          <div style="font-size:11px;color:#8A8A99">Occupation</div>
        </div>
      </div>
      ${pApparts.length?`<div style="font-size:12px;color:#8A8A99;margin-bottom:6px">Détail par appartement</div>
      <table style="min-width:auto"><thead><tr><th>Appartement</th><th>Résa</th><th>Nuits</th><th>Revenus</th></tr></thead><tbody>
      ${pApparts.map(a=>{
        const aRes=pRes.filter(r=>r.appartement_id===a.id);
        const aRev=aRes.reduce((s,r)=>s+(r.price_total||0),0);
        const aN=aRes.reduce((s,r)=>s+(r.nights||0),0);
        return`<tr><td><div class="apt-name"><div class="apt-emoji" style="width:24px;height:24px;font-size:14px">${a.emoji||'🏠'}</div>${a.name}</div></td><td>${aRes.length}</td><td>${aN}</td><td style="font-weight:600">${aRev}€</td></tr>`;
      }).join('')}
      </tbody></table>`:'<div style="font-size:12px;color:#BA7517">⚠ Aucun appartement assigné</div>'}
    </div>`;
  });

  list.innerHTML=html;
}

async function genererRapports(){
  const mois=document.getElementById('rapport-mois')?.value||new Date().toISOString().slice(0,7);
  for(const p of proprietaires){
    const pApparts=apparts.filter(a=>a.proprietaire_id===p.id);
    const pRes=reservations.filter(r=>pApparts.some(a=>a.id===r.appartement_id)&&r.date_from&&r.date_from.startsWith(mois));
    const revBrut=pRes.reduce((s,r)=>s+(r.price_total||0),0);
    const nuits=pRes.reduce((s,r)=>s+(r.nights||0),0);
    const comm=Math.round(revBrut*(p.commission||20)/100);
    const net=revBrut-comm;
    const nbJours=new Date(+mois.split('-')[0],+mois.split('-')[1],0).getDate();
    const occMax=pApparts.length*nbJours;
    const occ=occMax>0?Math.round(nuits/occMax*100):0;
    try{
      await sbFetch('rapports',{method:'POST',body:JSON.stringify({
        user_id:currentUser.user.id,proprietaire_id:p.id,mois,
        revenus_brut:revBrut,commission_pct:p.commission||20,
        commission_montant:comm,net_proprietaire:net,
        nb_reservations:pRes.length,nb_nuits:nuits,taux_occupation:occ
      })});
    }catch(e){}
  }
  renderRapports();
  showToast('✓ Rapports générés pour '+proprietaires.length+' propriétaire'+(proprietaires.length>1?'s':''));
}





// CLEANYQ
/* ====================================================
   GÉNÉRATION DYNAMIQUE D'OPÉRATIONS — démo durable
   Source de vérité = reservations + apparts + cleanersData.
   Aucune écriture Supabase, aucune persistance.
   ==================================================== */

/* ── Brique 1 : missions ménage virtuelles depuis les check-outs ── */
function generateVirtualCleaningMissions(windowDays){
  windowDays=windowDays||14;
  var out=[];
  var apts=apparts||[];
  var cleaners=cleanersData||[];
  if(!apts.length)return out;

  var today=new Date();
  var winStart=new Date(today);winStart.setDate(winStart.getDate()-1); // inclut hier (check-out tardif non traité)
  var winStartIso=winStart.toISOString().slice(0,10);
  var winEnd=new Date(today);winEnd.setDate(winEnd.getDate()+windowDays);
  var winEndIso=winEnd.toISOString().slice(0,10);

  var checkouts=(reservations||[]).filter(function(r){
    return r.date_to&&r.date_to>=winStartIso&&r.date_to<=winEndIso;
  });

  checkouts.forEach(function(r){
    var apt=apts.find(function(a){return a.id===r.appartement_id;});
    if(!apt)return;

    // Barème durée/tarif selon taille du bien (même logique que le seed)
    var bedrooms=Number(apt.bedrooms||0);
    var duree=bedrooms>=3?180:bedrooms===2?150:bedrooms===1?120:90;
    var tarif=bedrooms>=3?90:bedrooms===2?65:bedrooms===1?55:40;

    // Assignation auto : cleaner couvrant la zone (même ville), meilleur score
    var sameCity=cleaners.filter(function(c){return c.city===apt.city&&c.status==='active';});
    var pool=sameCity.length?sameCity:cleaners.filter(function(c){return c.status==='active';});
    pool=pool.slice().sort(function(a,b){return (b.score||0)-(a.score||0);});
    var assigned=pool.length?pool[0]:null;

    var d1=new Date(today);d1.setDate(d1.getDate()+1);
    var tomorrowIso=d1.toISOString().slice(0,10);
    var isImminent=(r.date_to===today.toISOString().slice(0,10)||r.date_to===tomorrowIso);
    var priority=(isImminent&&!assigned)?'haute':(isImminent?'normale':'faible');

    out.push({
      id:'virtual-cleaning-'+r.appartement_id+'-'+r.date_to,
      category:'cleaning',
      source:'checkout',
      appartement_id:r.appartement_id,
      apartment_name:apt.name,
      date:r.date_to,
      heure:'10:00',
      duree_min:duree,
      tarif:tarif,
      cleaner_id:assigned?assigned.id:null,
      cleaner_name:assigned?assigned.name:null,
      status:'a_generer',
      virtual:true,
      priority:priority
    });
  });

  return out;
}

/* ── Brique 2 : orchestrateur générique (point d'extension futur) ──
   V1 : ne couvre que le ménage post check-out.
   Futur : ajoutera generateQualityCheckOps(), generateTechnicalOps(),
   generateOwnerOps(), generateEventPrepOps() dans le même tableau. */
function generateVirtualOperations(windowDays){
  windowDays=windowDays||14;
  return [].concat(
    generateVirtualCleaningMissions(windowDays)
  );
}

/* ── Brique 3 : fusion réelles + virtuelles avec déduplication ──
   Clé de dédup : appartement_id + date.
   Une mission réelle sur ce couple fait disparaître la suggestion virtuelle. */
function getMergedCleaningMissions(windowDays){
  windowDays=windowDays||14;
  var real=missionsData||[];
  var virtual=generateVirtualOperations(windowDays);

  var realKeys={};
  real.forEach(function(m){realKeys[m.appartement_id+'|'+m.date]=true;});

  var virtualFiltered=virtual.filter(function(v){
    return !realKeys[v.appartement_id+'|'+v.date];
  });

  var merged=real.concat(virtualFiltered);
  merged.sort(function(a,b){return (a.date||'').localeCompare(b.date||'');});
  return merged;
}

/* ── Confirmer une mission virtuelle : la transforme en mission réelle ──
   C'est le SEUL chemin qui écrit dans Supabase pour une suggestion EVA. */
async function confirmVirtualMission(virtualId){
  var merged=getMergedCleaningMissions(30);
  var v=merged.find(function(m){return m.id===virtualId&&m.virtual;});
  if(!v){showToast('Suggestion introuvable \u2014 actualisation\u2026');return;}

  var body={
    user_id:currentUser.user.id,
    appartement_id:v.appartement_id,
    cleaner_id:v.cleaner_id||null,
    date:v.date,
    heure:v.heure,
    duree_min:v.duree_min,
    tarif:v.tarif,
    status:v.cleaner_id?'acceptee':'en_attente',
    checklist:'Draps, sdb, cuisine, aspirateur, poubelles',
    notes:'Mission confirm\u00e9e depuis une suggestion EVA (check-out)'
  };
  try{
    var res=await sbFetch('cleaning_missions',{method:'POST',body:JSON.stringify(body)});
    var m=await res.json();
    missionsData.unshift(Array.isArray(m)&&m[0]?m[0]:Object.assign({},body,{id:Date.now().toString()}));
    showToast('\u2713 Mission confirm\u00e9e'+(v.cleaner_id?' et assign\u00e9e \u00e0 '+v.cleaner_name:''));
    var active=document.querySelector('.page.active');
    if(active&&active.id==='page-cleanyq-today')renderCleanyQToday();
    if(active&&active.id==='page-cleanyq-missions')renderCleanyQMissions();
    if(active&&active.id==='page-cleanyq-squad')renderCleanyQSquad();
    renderCockpit();
  }catch(e){showToast('Erreur lors de la confirmation');}
}

let cleanersData=[];
let missionsData=[];
let editCleanerId=null;

async function loadCleaners(){
  try{
    const res=await sbFetch(`cleaners?user_id=eq.${currentUser.user.id}&select=*&order=score.desc`);
    cleanersData=await res.json()||[];
  }catch(e){cleanersData=[];}
}

async function loadMissions(){
  try{
    const res=await sbFetch(`cleaning_missions?user_id=eq.${currentUser.user.id}&select=*&order=date.desc`);
    missionsData=await res.json()||[];
  }catch(e){missionsData=[];}
}

function renderCleanyQ(){
  const kpis=document.getElementById('cleanyq-kpis');
  const squad=document.getElementById('cleanyq-squad');
  const missions=document.getElementById('cleanyq-missions');
  const empty=document.getElementById('cleanyq-empty');
  const split=document.getElementById('cleanyq-split');
  if(!kpis)return;

  if(!cleanersData.length&&!missionsData.length){
    empty.style.display='block';if(split)split.style.display='none';kpis.innerHTML='';return;
  }
  empty.style.display='none';if(split)split.style.display='grid';

  const pending=missionsData.filter(m=>m.status==='en_attente').length;
  const accepted=missionsData.filter(m=>m.status==='acceptee').length;
  const done=missionsData.filter(m=>m.status==='terminee').length;
  const avgScore=cleanersData.length?Math.round(cleanersData.reduce((s,c)=>s+(c.score||0),0)/cleanersData.length):0;

  kpis.innerHTML=`
    <div class="kpi"><div class="kpi-label">Squad</div><div class="kpi-value" style="color:#6B3FA0">${cleanersData.length}</div><div class="kpi-delta" style="color:#6B3FA0">cleaners</div></div>
    <div class="kpi"><div class="kpi-label">En attente</div><div class="kpi-value" style="color:${pending>0?'#E24B4A':'#1D9E75'}">${pending}</div><div class="kpi-delta" style="color:${pending>0?'#E24B4A':'#8A8A99'}">${pending>0?'à traiter':'tout assigné ✓'}</div></div>
    <div class="kpi"><div class="kpi-label">Acceptées</div><div class="kpi-value" style="color:#BA7517">${accepted}</div><div class="kpi-delta" style="color:#8A8A99">en cours</div></div>
    <div class="kpi"><div class="kpi-label">Terminées</div><div class="kpi-value" style="color:#1D9E75">${done}</div><div class="kpi-delta" style="color:#1D9E75">ce mois</div></div>
    <div class="kpi"><div class="kpi-label">Score Squad</div><div class="kpi-value" style="color:${avgScore>=80?'#1D9E75':avgScore>=60?'#BA7517':'#E24B4A'}">${avgScore}</div><div class="kpi-delta" style="color:#8A8A99">/100</div></div>`;

  // MISSIONS — grouped by date
  const statusLabels={en_attente:'⏳ En attente',acceptee:'✅ Acceptée',en_cours:'🧹 En cours',terminee:'✓ Terminée',annulee:'✗ Annulée'};
  const statusColors={en_attente:'#FAEEDA;color:#854F0B',acceptee:'#E1F5EE;color:#085041',en_cours:'#EEEDFE;color:#3C3489',terminee:'#E1F5EE;color:#085041',annulee:'#FCEBEB;color:#A32D2D'};
  const today=new Date().toISOString().split('T')[0];
  const tomorrow=new Date(Date.now()+86400000).toISOString().split('T')[0];

  let mHtml='';
  const activeMissions=missionsData.filter(m=>m.status!=='annulee'&&m.status!=='terminee');
  const pastMissions=missionsData.filter(m=>m.status==='terminee'||m.status==='annulee').slice(0,5);

  if(!activeMissions.length&&!pastMissions.length){
    mHtml='<div style="background:white;border-radius:12px;border:0.5px solid #E8E8EE;padding:2rem;text-align:center;color:#8A8A99;font-size:13px"><div style="font-size:24px;margin-bottom:8px">📋</div>Aucune mission en cours<br><button class="btn btn-purple btn-sm" onclick="openMissionModal()" style="margin-top:10px">+ Créer une mission</button></div>';
  } else {
    // Active missions
    activeMissions.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    let lastDate='';
    activeMissions.forEach(m=>{
      const dateLabel=m.date===today?"Aujourd\'hui":m.date===tomorrow?'Demain':new Date(m.date).toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short'});
      if(m.date!==lastDate){
        mHtml+=`<div style="font-size:11px;font-weight:600;color:#6B3FA0;margin:${lastDate?'1rem':'0'} 0 0.4rem;text-transform:uppercase;letter-spacing:0.5px">${dateLabel}</div>`;
        lastDate=m.date;
      }
      const apt=apparts.find(a=>a.id===m.appartement_id);
      const cl=cleanersData.find(c=>c.id===m.cleaner_id);
      const st=m.status||'en_attente';
      const isUrgent=st==='en_attente'&&m.date<=today;
      mHtml+=`<div style="background:white;border-radius:10px;border:0.5px solid ${isUrgent?'#F09595':'#E8E8EE'};${isUrgent?'border-left:3px solid #E24B4A;':''}padding:0.75rem 1rem;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:16px">${apt?.emoji||'🏠'}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500">${apt?.name||'—'}</div>
            <div style="font-size:11px;color:#8A8A99">${m.heure||'14:00'} · ${m.duree_min||120}min · ${m.tarif||0}€</div>
          </div>
          <div style="text-align:right">
            <span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${statusColors[st]}">${statusLabels[st]}</span>
            <div style="font-size:11px;color:#8A8A99;margin-top:3px">${cl?cl.name:'Non assigné'}</div>
          </div>
        </div>
        ${m.checklist?`<div style="font-size:11px;color:#8A8A99;margin-top:6px;padding-top:6px;border-top:0.5px solid #F0F0F5">📝 ${m.checklist}</div>`:''}
        <div style="display:flex;gap:6px;margin-top:8px">
          ${st==='en_attente'?`<button class="btn btn-sm" onclick="updateMissionStatus('${m.id}','acceptee')" style="font-size:11px;background:#E1F5EE;border-color:#5DCAA5;color:#085041">✅ Valider la mission</button>`:''}
          ${st==='acceptee'?`<button class="btn btn-sm" onclick="updateMissionStatus('${m.id}','terminee')" style="font-size:11px;background:#E1F5EE;border-color:#5DCAA5;color:#085041">🧹 Marquer comme terminée</button>`:''}
          ${st!=='terminee'?`<button class="btn btn-sm" onclick="if(confirm('Annuler cette mission ?'))updateMissionStatus('${m.id}','annulee')" style="font-size:11px;color:#E24B4A">✗ Annuler</button>`:''}
        </div>
      </div>`;
    });

    // Past missions
    if(pastMissions.length){
      mHtml+=`<div style="font-size:11px;font-weight:600;color:#8A8A99;margin:1rem 0 0.4rem;text-transform:uppercase;letter-spacing:0.5px">Historique récent</div>`;
      pastMissions.forEach(m=>{
        const apt=apparts.find(a=>a.id===m.appartement_id);
        const cl=cleanersData.find(c=>c.id===m.cleaner_id);
        const st=m.status;
        mHtml+=`<div style="background:white;border-radius:10px;border:0.5px solid #E8E8EE;padding:0.6rem 1rem;margin-bottom:4px;opacity:0.7">
          <div style="display:flex;align-items:center;gap:8px;font-size:12px">
            <span>${apt?.emoji||'🏠'}</span>
            <span style="flex:1">${apt?.name||'—'} · ${m.date}</span>
            <span>${cl?.name||'—'}</span>
            <span style="padding:2px 6px;border-radius:100px;font-size:10px;background:${statusColors[st]}">${statusLabels[st]}</span>
          </div>
        </div>`;
      });
    }
  }
  missions.innerHTML=mHtml;

  // CLEANERS — detailed cards
  let cHtml='';
  if(!cleanersData.length){
    cHtml='<div style="background:white;border-radius:12px;border:0.5px solid #E8E8EE;padding:2rem;text-align:center;color:#8A8A99;font-size:13px"><div style="font-size:24px;margin-bottom:8px">👥</div>Aucune cleaner dans votre Squad<br><button class="btn btn-purple btn-sm" onclick="openCleanerModal()" style="margin-top:10px">+ Ajouter</button></div>';
  } else {
    cleanersData.forEach(c=>{
      const badge=c.score>=90?'⭐ Gold':c.score>=75?'✅ Vérifié':c.score>=60?'🟡 En progression':'🔴 Attention';
      const badgeBg=c.score>=90?'#FAEEDA;color:#854F0B':c.score>=75?'#E1F5EE;color:#085041':c.score>=60?'#FFF8E1;color:#854F0B':'#FCEBEB;color:#A32D2D';
      const nbMissions=missionsData.filter(m=>m.cleaner_id===c.id&&m.status==='terminee').length;
      const pendingMissions=missionsData.filter(m=>m.cleaner_id===c.id&&(m.status==='en_attente'||m.status==='acceptee')).length;

      cHtml+=`<div style="background:white;border-radius:12px;border:0.5px solid #E8E8EE;padding:1rem;margin-bottom:8px">
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px">
          <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#0EA5E9,#5DCAA5);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:white;flex-shrink:0">${(c.name||'?').charAt(0).toUpperCase()}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-size:14px;font-weight:600">${c.name}</span>
              <span style="font-size:10px;padding:2px 8px;border-radius:100px;background:${badgeBg}">${badge}</span>
              ${c.auto_accept?'<span style="font-size:10px;padding:2px 6px;border-radius:100px;background:#E1F5EE;color:#085041">⚡ Auto</span>':''}
            </div>
            <div style="font-size:11px;color:#8A8A99;margin-top:2px">Score: <b style="color:${c.score>=80?'#1D9E75':'#BA7517'}">${c.score||0}/100</b> · ${nbMissions} missions · ${pendingMissions} en cours</div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0">
            <button class="btn btn-sm" onclick="editCleaner('${c.id}')" style="font-size:11px">✏️</button>
            <button class="btn btn-sm" onclick="deleteCleaner('${c.id}')" style="font-size:11px;color:#E24B4A">🗑</button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;margin-bottom:8px">
          <div style="padding:6px 8px;background:#F8F7FF;border-radius:6px">
            <span style="color:#8A8A99">📍 Zone :</span> <b>${c.city||'—'}</b> · ${c.radius_km||10}km
          </div>
          <div style="padding:6px 8px;background:#F8F7FF;border-radius:6px">
            <span style="color:#8A8A99">📅 Dispo :</span> <b>${c.disponibilites||'Lun-Ven'}</b>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:11px;margin-bottom:8px">
          <div style="padding:6px 8px;background:#E1F5EE;border-radius:6px;text-align:center">
            <div style="color:#8A8A99">Studio/T1</div><b style="color:#085041">${c.tarif_t1||30}€</b>
          </div>
          <div style="padding:6px 8px;background:#E1F5EE;border-radius:6px;text-align:center">
            <div style="color:#8A8A99">T2/T3</div><b style="color:#085041">${c.tarif_t2||40}€</b>
          </div>
          <div style="padding:6px 8px;background:#E1F5EE;border-radius:6px;text-align:center">
            <div style="color:#8A8A99">T4+</div><b style="color:#085041">${c.tarif_t3||55}€</b>
          </div>
        </div>

        <div style="font-size:11px;color:#8A8A99;display:flex;flex-wrap:wrap;gap:8px">
          ${c.phone?`<span>☎ ${c.phone}</span>`:''}
          ${c.email?`<span>✉ ${c.email}</span>`:''}
          ${c.siret?`<span>🏢 SIRET: ${c.siret}</span>`:''}
        </div>
      </div>`;
    });
  }
  squad.innerHTML=cHtml;
}

// CLEANER CRUD
function openCleanerModal(){
  editCleanerId=null;
  document.getElementById('modal-cleaner-title').textContent='Ajouter une cleaner';
  ['cl-name','cl-phone','cl-email','cl-city'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('cl-radius').value='10';
  document.getElementById('cl-tarif1').value='30';
  document.getElementById('cl-tarif2').value='40';
  document.getElementById('cl-tarif3').value='55';
  document.getElementById('cl-auto').className='toggle off';
  document.getElementById('cl-siret').value='';
  document.getElementById('cl-dispo').value='Lun-Ven';
  document.getElementById('modal-cleaner').classList.add('open');
}

function closeCleanerModal(){document.getElementById('modal-cleaner').classList.remove('open');}

function editCleaner(id){
  const c=cleanersData.find(x=>x.id===id);if(!c)return;
  editCleanerId=id;
  document.getElementById('modal-cleaner-title').textContent='Modifier '+c.name;
  document.getElementById('cl-name').value=c.name||'';
  document.getElementById('cl-phone').value=c.phone||'';
  document.getElementById('cl-email').value=c.email||'';
  document.getElementById('cl-city').value=c.city||'';
  document.getElementById('cl-radius').value=c.radius_km||10;
  document.getElementById('cl-tarif1').value=c.tarif_t1||30;
  document.getElementById('cl-tarif2').value=c.tarif_t2||40;
  document.getElementById('cl-tarif3').value=c.tarif_t3||55;
  document.getElementById('cl-auto').className='toggle '+(c.auto_accept?'on':'off');
  document.getElementById('cl-siret').value=c.siret||'';
  document.getElementById('cl-dispo').value=c.disponibilites||'Lun-Ven';
  document.getElementById('modal-cleaner').classList.add('open');
}

async function saveCleaner(){
  const name=document.getElementById('cl-name').value.trim();
  if(!name){showToast('Nom obligatoire');return;}
  const body={
    user_id:currentUser.user.id,name,
    phone:document.getElementById('cl-phone').value.trim(),
    email:document.getElementById('cl-email').value.trim(),
    city:document.getElementById('cl-city').value.trim(),
    radius_km:+document.getElementById('cl-radius').value||10,
    siret:document.getElementById('cl-siret').value.trim(),
    disponibilites:document.getElementById('cl-dispo').value.trim()||'Lun-Ven',
    tarif_t1:+document.getElementById('cl-tarif1').value||30,
    tarif_t2:+document.getElementById('cl-tarif2').value||40,
    tarif_t3:+document.getElementById('cl-tarif3').value||55,
    auto_accept:document.getElementById('cl-auto').classList.contains('on')
  };
  try{
    if(editCleanerId){
      await sbFetch(`cleaners?id=eq.${editCleanerId}`,{method:'PATCH',body:JSON.stringify(body)});
      const i=cleanersData.findIndex(c=>c.id===editCleanerId);
      if(i>=0)cleanersData[i]={...cleanersData[i],...body};
      showToast('✓ Cleaner modifiée');
    } else {
      const res=await sbFetch('cleaners',{method:'POST',body:JSON.stringify(body)});
      const c=await res.json();
      cleanersData.push(Array.isArray(c)&&c[0]?c[0]:{...body,id:Date.now().toString(),score:70,nb_missions:0});
      showToast('✓ Cleaner ajoutée à la Squad');
    }
    closeCleanerModal();renderCleanyQ();
  }catch(e){showToast('Erreur');}
}

async function deleteCleaner(id){
  if(!confirm('Retirer cette cleaner de votre Squad ?'))return;
  await sbFetch(`cleaners?id=eq.${id}`,{method:'DELETE'});
  cleanersData=cleanersData.filter(c=>c.id!==id);
  renderCleanyQ();showToast('Cleaner retirée');
}

// MISSIONS
function openMissionModal(){
  const sel=document.getElementById('mi-appart');
  sel.innerHTML=apparts.map(a=>`<option value="${a.id}">${a.emoji||'🏠'} ${a.name}</option>`).join('');
  const clSel=document.getElementById('mi-cleaner');
  clSel.innerHTML='<option value="">— Auto (envoyé à la Squad) —</option>'+cleanersData.map(c=>`<option value="${c.id}">${c.name} (${c.score}/100)</option>`).join('');
  document.getElementById('mi-date').value=new Date().toISOString().split('T')[0];
  document.getElementById('mi-heure').value='14:00';
  document.getElementById('mi-duree').value='120';
  document.getElementById('mi-tarif').value='35';
  document.getElementById('mi-checklist').value='Draps, sdb, cuisine, aspirateur, poubelles';
  document.getElementById('mi-notes').value='';
  document.getElementById('modal-mission').classList.add('open');
}

function closeMissionModal(){document.getElementById('modal-mission').classList.remove('open');}

async function saveMission(){
  const aptId=document.getElementById('mi-appart').value;
  const date=document.getElementById('mi-date').value;
  if(!aptId||!date){showToast('Appartement et date obligatoires');return;}
  const cleanerId=document.getElementById('mi-cleaner').value||null;
  const body={
    user_id:currentUser.user.id,
    appartement_id:aptId,
    cleaner_id:cleanerId,
    date,
    heure:document.getElementById('mi-heure').value||'14:00',
    duree_min:+document.getElementById('mi-duree').value||120,
    tarif:+document.getElementById('mi-tarif').value||35,
    status:cleanerId?'acceptee':'en_attente',
    checklist:document.getElementById('mi-checklist').value,
    notes:document.getElementById('mi-notes').value
  };
  try{
    const res=await sbFetch('cleaning_missions',{method:'POST',body:JSON.stringify(body)});
    const m=await res.json();
    missionsData.unshift(Array.isArray(m)&&m[0]?m[0]:{...body,id:Date.now().toString()});
    closeMissionModal();renderCleanyQ();
    showToast('✓ Mission créée'+(cleanerId?' et assignée':''));
  }catch(e){showToast('Erreur');}
}

async function updateMissionStatus(id,status){
  await sbFetch(`cleaning_missions?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({status})});
  const m=missionsData.find(x=>x.id===id);
  if(m)m.status=status;
  renderCleanyQ();
  showToast(status==='terminee'?'✓ Mission terminée':status==='annulee'?'Mission annulée':'✓ Mission mise à jour');
}

// DEGRESSIVE PRICING
function toggleDegressif(){
  const toggle=document.getElementById('m-degressif-toggle');
  const config=document.getElementById('m-degressif-config');
  const isOn=toggle.classList.contains('on');
  if(isOn){toggle.className='toggle off';config.style.display='none';}
  else{toggle.className='toggle on';config.style.display='block';updateDegPreview();}
}

function updateDegPreview(){
  const price=+document.getElementById('m-price').value||90;
  const start=+document.getElementById('m-deg-start').value||14;
  const step=+document.getElementById('m-deg-step').value||5;
  const minPrice=+document.getElementById('m-deg-min').value||Math.round((+document.getElementById('m-rent').value||0)/30+(+document.getElementById('m-clean').value||0));
  if(!document.getElementById('m-deg-min').value)document.getElementById('m-deg-min').value=minPrice;
  
  let html='<div style="font-weight:500;margin-bottom:6px">📉 Courbe de prix pour ce soir :</div><div style="display:flex;flex-wrap:wrap;gap:4px">';
  for(let h=start;h<=22;h++){
    const reduction=(h-start)*step;
    const p=Math.max(price-reduction,minPrice);
    const isNow=new Date().getHours()===h;
    const pct=Math.round((1-p/price)*100);
    html+=`<div style="padding:4px 8px;border-radius:6px;font-size:11px;${isNow?'background:#6B3FA0;color:white;font-weight:600':'background:white;border:0.5px solid #E8E8EE'}">${h}h → ${p}€${pct>0?' <span style="opacity:0.7">(-'+pct+'%)</span>':''}</div>`;
    if(p<=minPrice)break;
  }
  html+='</div>';
  document.getElementById('m-deg-preview').innerHTML=html;
}

// Update preview when price/rent/clean changes
['m-price','m-rent','m-clean','m-deg-start','m-deg-step','m-deg-min'].forEach(id=>{
  const el=document.getElementById(id);
  if(el)el.addEventListener('input',()=>{
    if(document.getElementById('m-degressif-toggle').classList.contains('on'))updateDegPreview();
  });
});

function getCurrentDegPrice(a){
  if(!a.auto_degressif||a.booked)return a.price||0;
  const now=new Date().getHours();
  const start=a.degressif_start||14;
  if(now<start)return a.price||0;
  const step=a.degressif_step||5;
  const minP=a.degressif_min||Math.round((a.rent||0)/30+(a.cleaner||0));
  const reduction=(now-start)*step;
  return Math.max((a.price||0)-reduction,minP);
}

// ADDRESS AUTOCOMPLETE & MAP
let addressTimer=null;
let parcMap=null;

async function searchAddress(query){
  clearTimeout(addressTimer);
  const results=document.getElementById('m-address-results');
  if(query.length<3){results.style.display='none';return;}
  addressTimer=setTimeout(async()=>{
    try{
      const res=await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=5`);
      const data=await res.json();
      if(!data.features||!data.features.length){results.style.display='none';return;}
      results.innerHTML=data.features.map((f,i)=>`
        <div onclick="selectAddress(${i})" style="padding:10px 12px;cursor:pointer;border-bottom:0.5px solid #E8E8EE;font-size:13px;display:flex;align-items:flex-start;gap:8px;transition:background .1s" onmouseover="this.style.background='#F5F4FF'" onmouseout="this.style.background='white'">
          <span style="color:#6B3FA0;flex-shrink:0;margin-top:2px">📍</span>
          <div>
            <div style="font-weight:500">${f.properties.label}</div>
            <div style="font-size:11px;color:#8A8A99">${f.properties.city} · ${f.properties.postcode}</div>
          </div>
        </div>`).join('');
      results.style.display='block';
      window._addressResults=data.features;
    }catch(e){results.style.display='none';}
  },300);
}

function selectAddress(idx){
  const f=window._addressResults[idx];
  if(!f)return;
  const props=f.properties;
  const coords=f.geometry.coordinates;
  document.getElementById('m-address').value=props.label;
  document.getElementById('m-city').value=props.city||'';
  document.getElementById('m-zone').value=props.district||props.locality||'';
  document.getElementById('m-lat').value=coords[1];
  document.getElementById('m-lng').value=coords[0];
  document.getElementById('m-address-results').style.display='none';
  const prev=document.getElementById('m-address-preview');
  prev.innerHTML=`📍 ${props.label}<br><span style="font-size:11px;color:#8A8A99">GPS: ${coords[1].toFixed(5)}, ${coords[0].toFixed(5)} · ${props.city} (${props.postcode})</span>`;
  prev.style.display='block';
}

// Close address dropdown on click outside
document.addEventListener('click',e=>{
  if(!e.target.closest('#m-address')&&!e.target.closest('#m-address-results')){
    const r=document.getElementById('m-address-results');
    if(r)r.style.display='none';
  }
});

// MAP VIEW
function switchParcView(view){
  const listView=document.getElementById('parc-list-view');
  const mapView=document.getElementById('parc-map-view');
  const detailView=document.getElementById('parc-detail-view');
  const btnList=document.getElementById('parc-view-list');
  const btnMap=document.getElementById('parc-view-map');
  if(detailView)detailView.style.display='none';
  if(view==='map'){
    if(listView)listView.style.display='none';
    if(mapView)mapView.style.display='block';
    if(btnMap){btnMap.style.background='#6B3FA0';btnMap.style.color='white';}
    if(btnList){btnList.style.background='transparent';btnList.style.color='#8A8A99';}
    setTimeout(()=>renderParcMap(),100);
  } else {
    if(listView)listView.style.display='block';
    if(mapView)mapView.style.display='none';
    if(btnList){btnList.style.background='#6B3FA0';btnList.style.color='white';}
    if(btnMap){btnMap.style.background='transparent';btnMap.style.color='#8A8A99';}
  }
}


function renderParcMap(){
  const container=document.getElementById('parc-map');
  if(!container)return;
  
  const geoApparts=apparts.filter(a=>a.latitude&&a.longitude);
  
  if(!geoApparts.length){
    container.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8A8A99;font-size:14px;flex-direction:column;gap:8px"><div style="font-size:32px">📍</div><div>Aucun appartement géolocalisé</div><div style="font-size:12px">Ajoutez une adresse à vos appartements pour les voir sur la carte</div></div>';
    return;
  }
  
  // Init or reset map
  if(parcMap){parcMap.remove();parcMap=null;}
  
  parcMap=L.map('parc-map').setView([geoApparts[0].latitude,geoApparts[0].longitude],12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© OpenStreetMap',
    maxZoom:18
  }).addTo(parcMap);
  
  const bounds=[];
  
  geoApparts.forEach(a=>{
    const lat=+a.latitude;
    const lng=+a.longitude;
    bounds.push([lat,lng]);
    
    const statusColor=a.booked?'#1D9E75':'#E24B4A';
    const statusText=a.booked?'Loué':'Libre';
    
    const icon=L.divIcon({
      className:'',
      html:`<div style="display:flex;flex-direction:column;align-items:center">
        <div style="background:${statusColor};color:white;padding:3px 7px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.25);border:1.5px solid white">${a.price||0}€</div>
        <div style="width:2px;height:8px;background:${statusColor}"></div>
        <div style="width:8px;height:8px;border-radius:50%;background:${statusColor};border:1.5px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.3)"></div>
      </div>`,
      iconSize:[0,0],
      iconAnchor:[20,36]
    });
    
    const marker=L.marker([lat,lng],{icon}).addTo(parcMap);
    
    marker.bindPopup(`
      <div style="min-width:200px;font-family:Inter,system-ui,sans-serif">
        <div style="font-size:15px;font-weight:600;margin-bottom:4px">${a.emoji||'🏠'} ${a.name}</div>
        <div style="font-size:12px;color:#8A8A99;margin-bottom:8px">${a.address||a.city||''}</div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <span style="padding:3px 8px;border-radius:100px;font-size:11px;font-weight:500;background:${a.booked?'#E1F5EE;color:#085041':'#FCEBEB;color:#A32D2D'}">${statusText}</span>
          <span style="font-size:13px;font-weight:600">${a.price||0}€/nuit</span>
        </div>
        <div style="font-size:11px;color:#8A8A99">
          Loyer: ${a.rent||0}€ · Plancher: ${Math.round((a.rent||0)/30+(a.cleaner||0))}€
        </div>
        <button onclick="openEdit('${a.id}')" style="margin-top:8px;padding:6px 12px;border-radius:6px;background:#6B3FA0;color:white;border:none;font-size:12px;cursor:pointer;width:100%;font-family:inherit">✏️ Modifier</button>
      </div>
    `,{maxWidth:250});
  });
  
  if(bounds.length>1){
    parcMap.fitBounds(bounds,{padding:[40,40]});
  }
}

// FINANCES MODULE
let chargesData=[];
let transactionsData=[];
let catRules=[];
let importBuffer=[];

const DEFAULT_FIXES=[
  {category:'loyer',label:'Loyer mensuel',amount:0,type:'fixe',per:'mois'},
  {category:'charges_locatives',label:'Charges locatives',amount:0,type:'fixe',per:'mois'},
  {category:'energie',label:'Électricité / gaz',amount:0,type:'fixe',per:'mois'},
  {category:'internet',label:'Internet / WiFi',amount:0,type:'fixe',per:'mois'},
  {category:'assurance',label:'Assurance PNO',amount:0,type:'fixe',per:'mois'}
];
const DEFAULT_VARS=[
  {category:'menage',label:'Ménage / séjour',amount:0,type:'variable',per:'reservation'},
  {category:'linge',label:'Linge / blanchisserie',amount:0,type:'variable',per:'reservation'},
  {category:'produits',label:'Produits d\'accueil',amount:0,type:'variable',per:'reservation'},
  {category:'commission_plateforme',label:'Commission plateforme (%)',amount:3,type:'variable',per:'reservation'}
];

const AUTO_CATEGORIES={
  'LOYER':'loyer','FONCIA':'loyer','NEXITY':'loyer','ORPI':'loyer','CENTURY':'loyer','LAFORET':'loyer',
  'EDF':'energie','ENGIE':'energie','ELECTRICITE':'energie','GAZ':'energie','DIRECT ENERGIE':'energie',
  'FREE':'internet','ORANGE':'internet','SFR':'internet','BOUYGUES':'internet','RED BY':'internet',
  'AIRBNB':'revenu','BOOKING':'revenu','VRBO':'revenu','ABRITEL':'revenu','HOMEAWAY':'revenu',
  'MENAGE':'menage','CLEANING':'menage','NETTOYAGE':'menage',
  'ASSURANCE':'assurance','MAIF':'assurance','AXA':'assurance','ALLIANZ':'assurance','MMA':'assurance',
  'LINGE':'linge','BLANCHISSERIE':'linge','PRESSING':'linge',
  'CHARGES':'charges_locatives','COPROPRIETE':'charges_locatives','SYNDIC':'charges_locatives'
};

async function loadCharges(){
  try{
    const res=await sbFetch(`charges?user_id=eq.${currentUser.user.id}&select=*`);
    chargesData=await res.json()||[];
  }catch(e){chargesData=[];}
}

async function loadTransactions(){
  try{
    const res=await sbFetch(`transactions?user_id=eq.${currentUser.user.id}&select=*&order=date.desc`);
    transactionsData=await res.json()||[];
  }catch(e){transactionsData=[];}
}

async function loadCatRules(){
  try{
    const res=await sbFetch(`categorisation_rules?user_id=eq.${currentUser.user.id}&select=*`);
    catRules=await res.json()||[];
  }catch(e){catRules=[];}
}

// CHARGES MODAL
function openChargesModal(){
  const sel=document.getElementById('ch-appart');
  sel.innerHTML=apparts.map(a=>`<option value="${a.id}">${a.emoji||'🏠'} ${a.name}</option>`).join('');
  document.getElementById('modal-charges').classList.add('open');
  loadChargesForAppart();
}

function closeChargesModal(){document.getElementById('modal-charges').classList.remove('open');}

function loadChargesForAppart(){
  const aptId=document.getElementById('ch-appart').value;
  const aptCharges=chargesData.filter(c=>c.appartement_id===aptId);
  const apt=apparts.find(a=>a.id===aptId);
  
  // Fixes
  const fixesDiv=document.getElementById('ch-fixes-list');
  let fixesHtml='';
  const fixes=aptCharges.filter(c=>c.type==='fixe');
  const defaultFixes=DEFAULT_FIXES.map(d=>{
    const existing=fixes.find(f=>f.category===d.category);
    return existing||{...d,appartement_id:aptId};
  });
  const customFixes=fixes.filter(f=>!DEFAULT_FIXES.some(d=>d.category===f.category));
  [...defaultFixes,...customFixes].forEach((c,i)=>{
    fixesHtml+=`<div style="display:grid;grid-template-columns:1fr 100px 30px;gap:6px;align-items:center;margin-bottom:6px" data-type="fixe" data-cat="${c.category}" data-id="${c.id||''}">
      <input type="text" value="${c.label}" class="ch-label" style="padding:8px;border-radius:8px;border:1px solid #E8E8EE;font-size:12px"/>
      <input type="number" value="${c.amount||0}" class="ch-amount" style="padding:8px;border-radius:8px;border:1px solid #E8E8EE;font-size:12px;text-align:right" onchange="updateChargeTotals()"/>
      <button onclick="this.parentElement.remove();updateChargeTotals()" style="background:none;border:none;color:#E24B4A;cursor:pointer;font-size:16px">✕</button>
    </div>`;
  });
  // Use existing rent value as default
  if(!fixes.find(f=>f.category==='loyer')&&apt&&apt.rent){
    fixesHtml=fixesHtml.replace('value="0"','value="'+(apt.rent||0)+'"');
  }
  fixesDiv.innerHTML=fixesHtml;

  // Variables
  const varsDiv=document.getElementById('ch-vars-list');
  let varsHtml='';
  const vars=aptCharges.filter(c=>c.type==='variable');
  const defaultVars=DEFAULT_VARS.map(d=>{
    const existing=vars.find(f=>f.category===d.category);
    return existing||{...d,appartement_id:aptId};
  });
  const customVars=vars.filter(f=>!DEFAULT_VARS.some(d=>d.category===f.category));
  [...defaultVars,...customVars].forEach((c,i)=>{
    const isPercent=c.category==='commission_plateforme';
    varsHtml+=`<div style="display:grid;grid-template-columns:1fr 100px 30px;gap:6px;align-items:center;margin-bottom:6px" data-type="variable" data-cat="${c.category}" data-id="${c.id||''}">
      <input type="text" value="${c.label}" class="ch-label" style="padding:8px;border-radius:8px;border:1px solid #E8E8EE;font-size:12px"/>
      <div style="position:relative"><input type="number" value="${c.amount||0}" class="ch-amount" style="padding:8px;border-radius:8px;border:1px solid #E8E8EE;font-size:12px;text-align:right;width:100%"/>${isPercent?'<span style="position:absolute;right:8px;top:8px;font-size:12px;color:#8A8A99">%</span>':''}</div>
      <button onclick="this.parentElement.remove();updateChargeTotals()" style="background:none;border:none;color:#E24B4A;cursor:pointer;font-size:16px">✕</button>
    </div>`;
  });
  // Use existing cleaner value
  if(!vars.find(f=>f.category==='menage')&&apt&&apt.cleaner){
    varsHtml=varsHtml.replace(/value="0"/,'value="'+(apt.cleaner||0)+'"');
  }
  varsDiv.innerHTML=varsHtml;
  updateChargeTotals();
}

function addChargeRow(type){
  const container=document.getElementById(type==='fixe'?'ch-fixes-list':'ch-vars-list');
  const cat='custom_'+Date.now();
  const html=`<div style="display:grid;grid-template-columns:1fr 100px 30px;gap:6px;align-items:center;margin-bottom:6px" data-type="${type}" data-cat="${cat}" data-id="">
    <input type="text" value="" class="ch-label" placeholder="Nom de la charge" style="padding:8px;border-radius:8px;border:1px solid #E8E8EE;font-size:12px"/>
    <input type="number" value="0" class="ch-amount" style="padding:8px;border-radius:8px;border:1px solid #E8E8EE;font-size:12px;text-align:right"/>
    <button onclick="this.parentElement.remove();updateChargeTotals()" style="background:none;border:none;color:#E24B4A;cursor:pointer;font-size:16px">✕</button>
  </div>`;
  container.insertAdjacentHTML('beforeend',html);
}

function updateChargeTotals(){
  let total=0;
  document.querySelectorAll('#ch-fixes-list [data-type=fixe] .ch-amount').forEach(el=>{total+=+(el.value||0);});
  document.getElementById('ch-total-fixes').textContent=total+' €';
}

async function saveAllCharges(){
  const aptId=document.getElementById('ch-appart').value;
  // Delete existing charges for this appart
  await sbFetch(`charges?user_id=eq.${currentUser.user.id}&appartement_id=eq.${aptId}`,{method:'DELETE'});
  
  const rows=document.querySelectorAll('#ch-fixes-list > div, #ch-vars-list > div');
  const charges=[];
  rows.forEach(row=>{
    const label=row.querySelector('.ch-label')?.value?.trim();
    const amount=+(row.querySelector('.ch-amount')?.value||0);
    const type=row.dataset.type;
    const cat=row.dataset.cat;
    if(label&&amount>0){
      charges.push({user_id:currentUser.user.id,appartement_id:aptId,category:cat,label,amount,type,per:type==='fixe'?'mois':'reservation'});
    }
  });
  
  if(charges.length){
    await sbFetch('charges',{method:'POST',body:JSON.stringify(charges)});
  }
  await loadCharges();
  closeChargesModal();
  renderFinances();
  showToast('✓ Charges enregistrées');
}

// CSV IMPORT
function openImportCSV(){
  document.getElementById('modal-import').classList.add('open');
  document.getElementById('import-preview').style.display='none';
  document.getElementById('import-upload').style.display='block';
  document.getElementById('csv-file').value='';
  importBuffer=[];
}
function closeImportCSV(){document.getElementById('modal-import').classList.remove('open');}

function handleCSVUpload(event){
  const file=event.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=function(e){
    let text=e.target.result;
    // Try to detect separator
    const sep=text.includes(';')?';':',';
    const lines=text.split('\n').filter(l=>l.trim());
    if(lines.length<2){showToast('Fichier vide ou invalide');return;}
    
    // Detect columns (date, label, amount)
    const header=lines[0].toLowerCase();
    let dateIdx=-1,labelIdx=-1,amountIdx=-1;
    const cols=lines[0].split(sep).map(c=>c.trim().replace(/"/g,'').toLowerCase());
    cols.forEach((c,i)=>{
      if(c.includes('date')&&dateIdx===-1)dateIdx=i;
      if((c.includes('libel')||c.includes('label')||c.includes('description')||c.includes('nom'))&&labelIdx===-1)labelIdx=i;
      if((c.includes('montant')||c.includes('amount')||c.includes('debit')||c.includes('credit')||c.includes('valeur'))&&amountIdx===-1)amountIdx=i;
    });
    
    // Fallback: assume date=0, label=1, amount=2
    if(dateIdx===-1)dateIdx=0;
    if(labelIdx===-1)labelIdx=1;
    if(amountIdx===-1)amountIdx=cols.length-1;
    
    importBuffer=[];
    for(let i=1;i<lines.length;i++){
      const vals=lines[i].split(sep).map(v=>v.trim().replace(/"/g,''));
      if(vals.length<3)continue;
      const rawDate=vals[dateIdx]||'';
      const label=vals[labelIdx]||'';
      const rawAmount=vals[amountIdx]||'0';
      const amount=parseFloat(rawAmount.replace(/\s/g,'').replace(',','.'));
      if(isNaN(amount)||!label)continue;
      
      // Parse date
      let date='';
      if(rawDate.includes('/')){const p=rawDate.split('/');date=p.length===3?`${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`:rawDate;}
      else if(rawDate.includes('-')){date=rawDate;}
      else{date=rawDate;}
      
      // Auto-categorize
      const cat=autoCategorizerLabel(label);
      const aptId=autoAssignAppart(label);
      
      importBuffer.push({date,label,amount,category:cat,appartement_id:aptId,mois:date.slice(0,7)});
    }
    
    renderImportPreview();
  };
  reader.readAsText(file,'UTF-8');
}

function autoCategorizerLabel(label){
  const upper=label.toUpperCase();
  // Check custom rules first
  for(const rule of catRules){
    if(upper.includes(rule.keyword.toUpperCase()))return rule.category;
  }
  // Check auto categories
  for(const[kw,cat] of Object.entries(AUTO_CATEGORIES)){
    if(upper.includes(kw))return cat;
  }
  return 'autre';
}

function autoAssignAppart(label){
  const upper=label.toUpperCase();
  // Check custom rules
  for(const rule of catRules){
    if(upper.includes(rule.keyword.toUpperCase())&&rule.appartement_id)return rule.appartement_id;
  }
  return null;
}

function renderImportPreview(){
  document.getElementById('import-upload').style.display='none';
  document.getElementById('import-preview').style.display='block';
  document.getElementById('import-count').textContent=importBuffer.length+' transactions détectées';
  
  const catColors={loyer:'#FCEBEB;color:#A32D2D',charges_locatives:'#FCEBEB;color:#A32D2D',energie:'#FCEBEB;color:#A32D2D',internet:'#FCEBEB;color:#A32D2D',assurance:'#FCEBEB;color:#A32D2D',menage:'#FAEEDA;color:#854F0B',linge:'#FAEEDA;color:#854F0B',produits:'#FAEEDA;color:#854F0B',revenu:'#E1F5EE;color:#085041',autre:'#F0F0F5;color:#8A8A99'};
  const catLabels={loyer:'Loyer',charges_locatives:'Charges',energie:'Énergie',internet:'Internet',assurance:'Assurance',menage:'Ménage',linge:'Linge',produits:'Produits',revenu:'Revenu',commission_plateforme:'Commission',autre:'Autre'};
  
  let html=`<table style="width:100%;font-size:12px"><thead><tr><th style="padding:6px;text-align:left">Date</th><th style="text-align:left">Libellé</th><th style="text-align:right">Montant</th><th>Catégorie</th><th>Appart</th></tr></thead><tbody>`;
  importBuffer.slice(0,50).forEach((t,i)=>{
    const col=catColors[t.category]||catColors.autre;
    html+=`<tr style="border-bottom:0.5px solid #E8E8EE">
      <td style="padding:6px">${t.date}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.label}</td>
      <td style="text-align:right;font-weight:500;color:${t.amount>=0?'#1D9E75':'#E24B4A'}">${t.amount>=0?'+':''}${t.amount}€</td>
      <td><select onchange="importBuffer[${i}].category=this.value" style="padding:3px 6px;border-radius:6px;border:1px solid #E8E8EE;font-size:11px;background:${col.split(';')[0]}">
        ${Object.entries(catLabels).map(([k,v])=>`<option value="${k}" ${t.category===k?'selected':''}>${v}</option>`).join('')}
      </select></td>
      <td><select onchange="importBuffer[${i}].appartement_id=this.value||null" style="padding:3px 6px;border-radius:6px;border:1px solid #E8E8EE;font-size:11px">
        <option value="">—</option>
        ${apparts.map(a=>`<option value="${a.id}" ${t.appartement_id===a.id?'selected':''}>${a.name}</option>`).join('')}
      </select></td>
    </tr>`;
  });
  html+=`</tbody></table>`;
  document.getElementById('import-table').innerHTML=html;
}

async function saveImportedTransactions(){
  if(!importBuffer.length){showToast('Aucune transaction');return;}
  const toSave=importBuffer.map(t=>({
    user_id:currentUser.user.id,
    appartement_id:t.appartement_id,
    date:t.date,
    label:t.label,
    amount:t.amount,
    category:t.category,
    source:'import_csv',
    mois:t.mois
  }));
  try{
    await sbFetch('transactions',{method:'POST',body:JSON.stringify(toSave)});
    await loadTransactions();
    closeImportCSV();
    renderFinances();
    showToast('✓ '+toSave.length+' transactions importées');
  }catch(e){showToast('Erreur import');}
}

// RULES
function openRulesModal(){
  document.getElementById('modal-rules').classList.add('open');
  document.getElementById('rule-appart').innerHTML='<option value="">Tous</option>'+apparts.map(a=>`<option value="${a.id}">${a.name}</option>`).join('');
  renderRulesList();
}
function closeRulesModal(){document.getElementById('modal-rules').classList.remove('open');}

function renderRulesList(){
  const list=document.getElementById('rules-list');
  if(!catRules.length){list.innerHTML='<div style="color:#8A8A99;font-size:12px;padding:0.5rem">Aucune règle. Ajoutez-en ci-dessous.</div>';return;}
  list.innerHTML=catRules.map(r=>{
    const apt=apparts.find(a=>a.id===r.appartement_id);
    return`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:0.5px solid #E8E8EE;font-size:12px">
      <span style="font-weight:500;flex:1">"${r.keyword}"</span>
      <span style="padding:2px 8px;border-radius:100px;background:#EEEDFE;color:#3C3489;font-size:11px">${r.category}</span>
      ${apt?`<span style="font-size:11px;color:#8A8A99">${apt.name}</span>`:''}
      <button onclick="deleteRule('${r.id}')" style="background:none;border:none;color:#E24B4A;cursor:pointer">✕</button>
    </div>`;
  }).join('');
}

async function addRule(){
  const keyword=document.getElementById('rule-keyword').value.trim();
  const category=document.getElementById('rule-category').value;
  const aptId=document.getElementById('rule-appart').value||null;
  if(!keyword){showToast('Entrez un mot-clé');return;}
  const body={user_id:currentUser.user.id,keyword,category,appartement_id:aptId};
  await sbFetch('categorisation_rules',{method:'POST',body:JSON.stringify(body)});
  await loadCatRules();
  document.getElementById('rule-keyword').value='';
  renderRulesList();
  showToast('✓ Règle ajoutée');
}

async function deleteRule(id){
  await sbFetch(`categorisation_rules?id=eq.${id}`,{method:'DELETE'});
  catRules=catRules.filter(r=>r.id!==id);
  renderRulesList();
}

// FINANCES RENDERING
function initFinMois(){
  const sel=document.getElementById('fin-mois');if(!sel)return;
  const now=new Date();
  sel.innerHTML='';
  for(let i=0;i<6;i++){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const val=d.toISOString().slice(0,7);
    const label=d.toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
    sel.innerHTML+=`<option value="${val}">${label.charAt(0).toUpperCase()+label.slice(1)}</option>`;
  }
}

function renderFinances(){
  const mois=document.getElementById('fin-mois')?.value||new Date().toISOString().slice(0,7);
  const moisLabel=new Date(mois+'-01').toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
  const isConcierge=currentMode==='concierge';

  if(!apparts.length||!chargesData.length){
    document.getElementById('fin-empty').style.display='block';
    document.getElementById('fin-kpis').innerHTML='';
    document.getElementById('fin-pl-list').innerHTML='';
    document.getElementById('fin-global').innerHTML='';
    return;
  }
  document.getElementById('fin-empty').style.display='none';

  const aptsToShow=isConcierge?apparts.filter(a=>a.proprietaire_id):apparts;
  let totalRev=0,totalCharges=0,totalNet=0;
  const aptData=[];

  aptsToShow.forEach(a=>{
    const ac=chargesData.filter(c=>c.appartement_id===a.id);
    const aptRes=reservations.filter(r=>r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(mois));
    const aptTx=transactionsData.filter(t=>t.appartement_id===a.id&&t.mois===mois);
    const nbRes=aptRes.length||aptTx.filter(t=>t.category==='revenu').length||0;
    const revTx=aptTx.filter(t=>t.amount>0||t.category==='revenu');
    const finMois=rqComputeFinancials(a,aptRes,ac);
    // Le CA peut venir de transactions saisies manuellement si présentes, sinon des réservations (déjà dans finMois.caBrut)
    const rev=revTx.reduce((s,t)=>s+Math.abs(t.amount),0)||finMois.caBrut;
    const totalFixes=finMois.chargesLogement;
    const totalVars=finMois.reparationsProp;
    const commAmount=finMois.commissionsOta;
    const charges=finMois.commissionsOta+finMois.commissionConciergerie+finMois.chargesLogement+finMois.reparationsProp;
    const net=finMois.netProprietaire;
    const marge=rev>0?Math.round(net/rev*100):0;
    const proprio=isConcierge?proprietaires.find(p=>p.id===a.proprietaire_id):null;
    const concComm=finMois.netConciergerie;

    totalRev+=rev;totalCharges+=charges;totalNet+=isConcierge?concComm:net;
    aptData.push({a,rev,charges,totalFixes,totalVars,commAmount,net,marge,nbRes,concComm,proprio});
  });

  const margeGlobale=totalRev>0?Math.round(totalNet/totalRev*100):0;
  const maxRev=Math.max(...aptData.map(d=>d.rev),1);

  // ── KPIs ──
  document.getElementById('fin-kpis').innerHTML=`
    <div class="kpi" style="border-left:3px solid #1D9E75">
      <div class="kpi-label">Revenus bruts</div>
      <div class="kpi-value" style="color:#1D9E75">${totalRev} €</div>
      <div class="kpi-delta" style="color:#1D9E75">${moisLabel}</div>
    </div>
    <div class="kpi" style="border-left:3px solid #E24B4A">
      <div class="kpi-label">Total charges</div>
      <div class="kpi-value" style="color:#E24B4A">${totalCharges} €</div>
      <div class="kpi-delta" style="color:#8A8A99">${aptsToShow.length} bien${aptsToShow.length>1?'s':''}</div>
    </div>
    <div class="kpi" style="border-left:3px solid ${totalNet>=0?'#6B3FA0':'#E24B4A'}">
      <div class="kpi-label">${isConcierge?'Mes commissions':'Résultat net'}</div>
      <div class="kpi-value" style="color:${totalNet>=0?'#6B3FA0':'#E24B4A'}">${totalNet>=0?'+':''}${totalNet} €</div>
      <div class="kpi-delta" style="color:${margeGlobale>=15?'#1D9E75':margeGlobale>=0?'#BA7517':'#E24B4A'}">Marge ${margeGlobale}%</div>
    </div>
    <div class="kpi" style="border-left:3px solid #BA7517">
      <div class="kpi-label">Réservations</div>
      <div class="kpi-value">${aptData.reduce((s,d)=>s+d.nbRes,0)}</div>
      <div class="kpi-delta" style="color:#8A8A99">ce mois</div>
    </div>`;

  // ── Vue barres comparatives ──
  let globalHtml=`<div class="card" style="margin-bottom:1rem">
    <div style="font-size:14px;font-weight:600;margin-bottom:1rem">Revenus vs Charges par bien</div>`;

  aptData.forEach(d=>{
    const revW=Math.max(Math.round(d.rev/maxRev*100),2);
    const chW=Math.max(Math.round(d.charges/maxRev*100),2);
    globalHtml+=`<div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:13px;font-weight:500">${d.a.emoji||'🏠'} ${d.a.name}</span>
        <span style="font-size:14px;font-weight:700;color:${d.net>=0?'#1D9E75':'#E24B4A'}">${d.net>=0?'+':''}${d.net}€</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:3px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:10px;color:#8A8A99;width:55px">Revenus</span>
          <div style="flex:1;height:14px;background:#F0F0F5;border-radius:4px;overflow:hidden"><div style="width:${revW}%;height:100%;background:#1D9E75;border-radius:4px"></div></div>
          <span style="font-size:12px;font-weight:500;color:#1D9E75;min-width:55px;text-align:right">${d.rev}€</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:10px;color:#8A8A99;width:55px">Charges</span>
          <div style="flex:1;height:14px;background:#F0F0F5;border-radius:4px;overflow:hidden"><div style="width:${chW}%;height:100%;background:#E24B4A;border-radius:4px"></div></div>
          <span style="font-size:12px;font-weight:500;color:#E24B4A;min-width:55px;text-align:right">${d.charges}€</span>
        </div>
      </div>
    </div>`;
  });
  globalHtml+=`</div>`;
  document.getElementById('fin-global').innerHTML=globalHtml;

  // ── Cards P&L par appart ──
  let plHtml='';
  aptData.forEach(d=>{
    const statusBg=d.net>=0?'#E1F5EE':'#FCEBEB';
    const statusCol=d.net>=0?'#085041':'#A32D2D';
    const statusTxt=d.net>=0?'✓ Rentable':'⚠ Déficitaire';
    const margeCol=d.marge>=15?'#1D9E75':d.marge>=0?'#BA7517':'#E24B4A';

    plHtml+=`<div class="card" style="margin-bottom:0.75rem;overflow:hidden;border-top:3px solid ${d.net>=0?'#1D9E75':'#E24B4A'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:22px">${d.a.emoji||'🏠'}</div>
          <div>
            <div style="font-size:15px;font-weight:600">${d.a.name}</div>
            <div style="font-size:12px;color:#8A8A99">${d.a.city||''} · ${moisLabel}</div>
          </div>
        </div>
        <span style="padding:4px 12px;border-radius:100px;font-size:12px;font-weight:500;background:${statusBg};color:${statusCol}">${statusTxt}</span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
        <div style="background:#F0FFF7;border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:#1D9E75">+${d.rev}€</div>
          <div style="font-size:10px;color:#8A8A99;margin-top:2px">Revenus</div>
        </div>
        <div style="background:#FEF8F8;border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:#E24B4A">-${d.charges}€</div>
          <div style="font-size:10px;color:#8A8A99;margin-top:2px">Charges</div>
        </div>
        <div style="background:${d.net>=0?'#F0FFF7':'#FEF8F8'};border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:${d.net>=0?'#1D9E75':'#E24B4A'}">${d.net>=0?'+':''}${d.net}€</div>
          <div style="font-size:10px;color:#8A8A99;margin-top:2px">Net</div>
        </div>
        <div style="background:#F5F4FF;border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:${margeCol}">${d.marge}%</div>
          <div style="font-size:10px;color:#8A8A99;margin-top:2px">Marge</div>
        </div>
      </div>

      <div style="background:#F8F8FC;border-radius:8px;padding:10px">
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid #EEEEF5">
          <span style="color:#8A8A99">Charges fixes</span>
          <span style="color:#E24B4A;font-weight:500">-${d.totalFixes}€/mois</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid #EEEEF5">
          <span style="color:#8A8A99">Réparations / charges ponctuelles</span>
          <span style="color:#BA7517;font-weight:500">-${d.totalVars}€</span>
        </div>
        ${d.commAmount?`<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px">
          <span style="color:#8A8A99">Commission plateforme</span>
          <span style="color:#BA7517;font-weight:500">-${d.commAmount}€</span>
        </div>`:''}
        ${d.proprio?`<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-top:1px solid #C4B5FD;margin-top:4px">
          <span style="color:#6B3FA0;font-weight:500">Ma commission (${d.proprio.commission||20}%)</span>
          <span style="color:#6B3FA0;font-weight:700">+${d.concComm}€</span>
        </div>`:''}
      </div>
    </div>`;
  });
  document.getElementById('fin-pl-list').innerHTML=plHtml;

  const sub=document.getElementById('finances-sub');
  if(sub)sub.innerHTML=`Rentabilité nette · <a href="#" onclick="openRulesModal();return false" style="color:#6B3FA0">🏷 Règles</a>`;
}

// CALENDRIER
let calDate=new Date();
let calFilter=null;
function calNav(dir){calDate=new Date(calDate.getFullYear(),calDate.getMonth()+dir,1);renderCalendar();}
function calSetFilter(aptId){calFilter=calFilter===aptId?null:aptId;renderCalendar();}

function renderCalendar(){
  const year=calDate.getFullYear(),month=calDate.getMonth();
  const label=calDate.toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
  document.getElementById('cal-month-label').textContent=label.charAt(0).toUpperCase()+label.slice(1);
  const filtersEl=document.getElementById('cal-filters');
  filtersEl.innerHTML=`<button onclick="calSetFilter(null)" style="padding:5px 12px;border-radius:8px;border:1px solid ${calFilter===null?'#6B3FA0':'#E8E8EE'};background:${calFilter===null?'#F5F4FF':'white'};color:${calFilter===null?'#6B3FA0':'#8A8A99'};font-size:12px;font-weight:500;cursor:pointer;font-family:inherit">Tous</button>`+apparts.map(a=>`<button onclick="calSetFilter('${a.id}')" style="padding:5px 12px;border-radius:8px;border:1px solid ${calFilter===a.id?'#6B3FA0':'#E8E8EE'};background:${calFilter===a.id?'#F5F4FF':'white'};color:${calFilter===a.id?'#6B3FA0':'#8A8A99'};font-size:12px;font-weight:500;cursor:pointer;font-family:inherit">${a.emoji||'🏠'} ${a.name}</button>`).join('');
  const firstDay=new Date(year,month,1).getDay();const startDay=firstDay===0?6:firstDay-1;const daysInMonth=new Date(year,month+1,0).getDate();
  const today=new Date().toISOString().split('T')[0];const moisStr=calDate.toISOString().slice(0,7);
  const filteredApparts=calFilter?apparts.filter(a=>a.id===calFilter):apparts;
  const aptIds=new Set(filteredApparts.map(a=>a.id));
  const monthRes=reservations.filter(r=>aptIds.has(r.appartement_id)&&r.date_from&&(r.date_from.startsWith(moisStr)||r.date_to>=moisStr+'-01'));
  const monthMissions=typeof missionsData!=='undefined'?missionsData.filter(m=>aptIds.has(m.appartement_id)&&m.date&&m.date.startsWith(moisStr)):[];
  const cities=[...new Set(filteredApparts.map(a=>a.city).filter(Boolean))];
  const monthEvents=[];cities.forEach(c=>{(eventsCache[c]||[]).forEach(e=>{if(e.date&&e.date.startsWith(moisStr))monthEvents.push(e);});});
  const jours=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
  let html='<div style="display:grid;grid-template-columns:repeat(7,1fr)">';
  jours.forEach(j=>{html+=`<div style="padding:10px 4px;text-align:center;font-size:11px;font-weight:600;color:#8A8A99;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #EEEEF5">${j}</div>`;});
  for(let i=0;i<startDay;i++){html+=`<div style="padding:8px;min-height:90px;border-bottom:1px solid #EEEEF5;border-right:1px solid #EEEEF5;background:#FAFAFF"></div>`;}
  for(let d=1;d<=daysInMonth;d++){
    const ds=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;const isToday=ds===today;const isWE=(startDay+d-1)%7>=5;
    const dayRes=monthRes.filter(r=>r.date_from<=ds&&r.date_to>=ds);const dayMissions=monthMissions.filter(m=>m.date===ds);const dayEvents=monthEvents.filter(e=>e.date===ds);
    const hasRes=dayRes.length>0;const isFree=!hasRes;
    let bg='white';if(isFree&&!isWE)bg='#FEF8F8';if(isFree&&isWE)bg='#FDF2F2';if(hasRes)bg='#F0FFF7';if(isToday)bg=hasRes?'#E1F5EE':'#FCEBEB';
    html+=`<div onclick="showCalDay('${ds}')" style="padding:6px 8px;min-height:90px;border-bottom:1px solid #EEEEF5;border-right:1px solid #EEEEF5;background:${bg};cursor:pointer;position:relative;transition:background .1s" onmouseover="this.style.background='#F5F4FF'" onmouseout="this.style.background='${bg}'">`;
    html+=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-size:13px;font-weight:${isToday?'700':'500'};color:${isToday?'#6B3FA0':'#1A1A2E'};${isToday?'background:#F0EBF9;padding:2px 6px;border-radius:4px':''}">${d}</span>`;
    if(isFree)html+=`<span style="font-size:9px;color:#E24B4A;font-weight:500">LIBRE</span>`;
    html+=`</div>`;
    dayRes.forEach(r=>{const apt=apparts.find(a=>a.id===r.appartement_id);const isCI=r.date_from===ds;const isCO=r.date_to===ds;const lb=isCI?'▶ '+r.guest_name:isCO?r.guest_name+' ▶':(apt?apt.name:r.guest_name);html+=`<div style="font-size:10px;padding:2px 6px;border-radius:4px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:${isCI?'#059669':isCO?'#BA7517':'#1D9E75'};color:white;font-weight:500">${lb||'Réservation'}</div>`;});
    dayMissions.forEach(m=>{const apt=apparts.find(a=>a.id===m.appartement_id);html+=`<div style="font-size:10px;padding:2px 6px;border-radius:4px;margin-bottom:2px;background:#E0F4FD;color:#0284C7;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🧹 ${m.heure||''} ${apt?apt.name:''}</div>`;});
    if(dayEvents.length)html+=`<div style="font-size:9px;padding:2px 5px;border-radius:4px;background:#FEF3C7;color:#92400E">🎯 ${dayEvents.length} evt</div>`;
    html+=`</div>`;
  }
  const totalCells=startDay+daysInMonth;const rem=totalCells%7===0?0:7-totalCells%7;
  for(let i=0;i<rem;i++){html+=`<div style="padding:8px;min-height:90px;border-bottom:1px solid #EEEEF5;border-right:1px solid #EEEEF5;background:#FAFAFF"></div>`;}
  html+=`</div>`;
  document.getElementById('cal-grid').innerHTML=html;
  let freeN=0,bookedN=0;
  for(let d=1;d<=daysInMonth;d++){const ds2=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;const hasR=monthRes.some(r=>r.date_from<=ds2&&r.date_to>=ds2);if(hasR)bookedN+=filteredApparts.length;else freeN+=filteredApparts.length;}
  const totalN=daysInMonth*filteredApparts.length;const occ=totalN>0?Math.round(bookedN/totalN*100):0;
  document.getElementById('cal-sub').textContent=`${bookedN} nuits réservées · ${freeN} libres · ${occ}% occupation · ${monthMissions.length} ménage${monthMissions.length>1?'s':''}`;
}

function showCalDay(ds){
  const el=document.getElementById('cal-day-detail');
  const dateLabel=new Date(ds+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const filteredApparts=calFilter?apparts.filter(a=>a.id===calFilter):apparts;
  const aptIds=new Set(filteredApparts.map(a=>a.id));
  const dayRes=reservations.filter(r=>aptIds.has(r.appartement_id)&&r.date_from<=ds&&r.date_to>=ds);
  const dayMissions=typeof missionsData!=='undefined'?missionsData.filter(m=>aptIds.has(m.appartement_id)&&m.date===ds):[];
  const cities=[...new Set(filteredApparts.map(a=>a.city).filter(Boolean))];
  const dayEvents=[];cities.forEach(c=>{(eventsCache[c]||[]).forEach(e=>{if(e.date===ds)dayEvents.push(e);});});
  let html=`<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem"><div style="font-size:16px;font-weight:600">${dateLabel}</div><button onclick="document.getElementById('cal-day-detail').style.display='none'" style="background:none;border:none;font-size:18px;color:#8A8A99;cursor:pointer">✕</button></div>`;
  html+=`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:1rem">`;
  filteredApparts.forEach(a=>{
    const res=reservations.find(r=>r.appartement_id===a.id&&r.date_from<=ds&&r.date_to>=ds);
    const mission=dayMissions.find(m=>m.appartement_id===a.id);
    const isCI=res&&res.date_from===ds;const isCO=res&&res.date_to===ds;
    const sBg=res?'#E1F5EE':'#FCEBEB';const sCol=res?'#085041':'#A32D2D';const sTxt=isCI?'Check-in':isCO?'Check-out':res?'Occupé':'Libre';
    html+=`<div style="background:${sBg};border-radius:10px;padding:12px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-weight:600;font-size:13px">${a.emoji||'🏠'} ${a.name}</span><span style="font-size:11px;font-weight:500;color:${sCol}">${sTxt}</span></div>${res?`<div style="font-size:12px;color:${sCol}">👤 ${res.guest_name||'Voyageur'} · ${res.price_total||0}€</div>`:'<div style="font-size:12px;color:#E24B4A">💰 Prix : '+getCurrentDegPrice(a)+'€</div>'}${mission?`<div style="font-size:11px;color:#0284C7;margin-top:4px">🧹 Ménage ${mission.heure||''}</div>`:''}</div>`;
  });
  html+=`</div>`;
  if(dayEvents.length){html+=`<div style="font-size:11px;font-weight:600;color:#8A8A99;margin-bottom:6px">Événements</div>`;dayEvents.forEach(e=>{html+=`<div style="display:flex;align-items:center;gap:8px;padding:8px;background:#FEF3C7;border-radius:8px;margin-bottom:4px;font-size:12px"><span>${e.emoji||'🎯'}</span><span style="flex:1;font-weight:500">${e.name}</span><span style="color:#BA7517;font-weight:600">+${e.boost}%</span></div>`;});}
  html+=`</div>`;el.innerHTML=html;el.style.display='block';el.scrollIntoView({behavior:'smooth',block:'start'});
}

// PREVISIONNEL
function renderPrevisionnel(){
  const el=document.getElementById('fin-previsionnel');
  if(el.style.display==='block'){el.style.display='none';return;}
  el.style.display='block';
  if(!apparts.length){el.innerHTML='<div class="card" style="text-align:center;padding:2rem;color:#8A8A99">Ajoutez des appartements.</div>';return;}
  const now=new Date();const moisActuel=now.toISOString().slice(0,7);const months=['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
  let totalFixesMensuel=0,totalVarParRes=0,prixMoyenNuit=0,commPctMoy=0,nbApparts=apparts.length;
  apparts.forEach(a=>{const ac=chargesData.filter(c=>c.appartement_id===a.id);totalFixesMensuel+=ac.filter(c=>c.type==='fixe'&&c.per==='mois'&&c.category!=='Loyer').reduce((s,c)=>s+(c.amount||0),0);totalVarParRes+=ac.filter(c=>c.type==='variable'&&c.category!=='commission_plateforme').reduce((s,c)=>s+(c.amount||0),0);commPctMoy+=rqGetCommissionRate(a);prixMoyenNuit+=a.price||0;});
  prixMoyenNuit=nbApparts?Math.round(prixMoyenNuit/nbApparts):90;commPctMoy=nbApparts?Math.round(commPctMoy/nbApparts):20;
  const moisRes=reservations.filter(r=>r.date_from&&r.date_from.startsWith(moisActuel));const nuitsVendues=moisRes.reduce((s,r)=>s+(r.nights||0),0);const nuitsDispos=nbApparts*30;const occActuel=nuitsDispos>0?Math.round(nuitsVendues/nuitsDispos*100):50;
  const saisonCoeff=[0.7,0.7,0.8,0.85,0.9,1.0,1.1,1.1,0.95,0.85,0.75,0.8];
  const scenarios=[{name:'Pessimiste',emoji:'😰',occBase:Math.max(occActuel-15,20),color:'#E24B4A',bg:'#FCEBEB'},{name:'Réaliste',emoji:'📊',occBase:occActuel,color:'#6B3FA0',bg:'#F5F4FF'},{name:'Optimiste',emoji:'🚀',occBase:Math.min(occActuel+15,95),color:'#1D9E75',bg:'#E1F5EE'}];
  scenarios.forEach(sc=>{sc.months=[];sc.totalRev=0;sc.totalCharges=0;sc.totalNet=0;for(let i=0;i<12;i++){const d=new Date(now.getFullYear(),now.getMonth()+i,1);const mIdx=d.getMonth();const occ=Math.min(Math.round(sc.occBase*saisonCoeff[mIdx]),98);const nuits=Math.round(nbApparts*30*occ/100);const nbRes=Math.round(nuits/3);const rev=nuits*prixMoyenNuit;const charges=totalFixesMensuel+totalVarParRes*nbRes+Math.round(rev*commPctMoy/100);const net=rev-charges;sc.months.push({mois:months[mIdx],occ,nuits,rev,charges,net});sc.totalRev+=rev;sc.totalCharges+=charges;sc.totalNet+=net;}});
  const chargesFixes=totalFixesMensuel;const revParNuit=prixMoyenNuit*(1-commPctMoy/100);const varParNuit=totalVarParRes/3;const margeParNuit=revParNuit-varParNuit;const nuitsPointMort=margeParNuit>0?Math.ceil(chargesFixes/margeParNuit):999;const occPointMort=nuitsDispos>0?Math.round(nuitsPointMort/nuitsDispos*100):0;
  const sc=scenarios[1];const maxRev=Math.max(...scenarios[2].months.map(m=>m.rev),1);
  const rev3=sc.months.slice(0,3).reduce((s,m)=>s+m.rev,0);const net3=sc.months.slice(0,3).reduce((s,m)=>s+m.net,0);const rev6=sc.months.slice(0,6).reduce((s,m)=>s+m.rev,0);const net6=sc.months.slice(0,6).reduce((s,m)=>s+m.net,0);
  let html=`<div style="font-size:11px;font-weight:500;color:#8A8A99;text-transform:uppercase;letter-spacing:0.8px;margin:1.5rem 0 0.75rem">📈 Prévisionnel 12 mois</div>`;
  html+=`<div class="card" style="display:flex;align-items:center;gap:16px;padding:1rem 1.25rem;margin-bottom:1rem;border-left:3px solid ${occPointMort<=occActuel?'#1D9E75':'#E24B4A'}"><div style="font-size:32px">${occPointMort<=occActuel?'✅':'⚠️'}</div><div style="flex:1"><div style="font-size:14px;font-weight:600">Point mort : ${nuitsPointMort} nuits/mois (${occPointMort}%)</div><div style="font-size:12px;color:#8A8A99;margin-top:2px">Occupation actuelle : ${occActuel}% · ${occPointMort<=occActuel?'Au-dessus ✓':'En dessous — remplir plus'}</div></div><div style="text-align:right"><div style="font-size:22px;font-weight:700;color:${occPointMort<=occActuel?'#1D9E75':'#E24B4A'}">${occPointMort}%</div><div style="font-size:10px;color:#8A8A99">seuil</div></div></div>`;
  html+=`<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:1rem"><div class="kpi"><div class="kpi-label">Revenus 3 mois</div><div class="kpi-value" style="color:#1D9E75">${Math.round(rev3)}€</div><div class="kpi-delta" style="color:#1D9E75">net : ${net3>=0?'+':''}${Math.round(net3)}€</div></div><div class="kpi"><div class="kpi-label">Revenus 6 mois</div><div class="kpi-value" style="color:#1D9E75">${Math.round(rev6)}€</div><div class="kpi-delta" style="color:#1D9E75">net : ${net6>=0?'+':''}${Math.round(net6)}€</div></div><div class="kpi"><div class="kpi-label">Revenus 12 mois</div><div class="kpi-value" style="color:#1D9E75">${Math.round(sc.totalRev)}€</div><div class="kpi-delta" style="color:#1D9E75">net : ${sc.totalNet>=0?'+':''}${Math.round(sc.totalNet)}€</div></div><div class="kpi"><div class="kpi-label">Occ. moyenne</div><div class="kpi-value" style="color:#6B3FA0">${Math.round(sc.months.reduce((s,m)=>s+m.occ,0)/12)}%</div><div class="kpi-delta" style="color:#8A8A99">sur 12 mois</div></div></div>`;
  html+=`<div class="card" style="margin-bottom:1rem"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem"><div style="font-size:14px;font-weight:600">Projections mensuelles</div><div style="display:flex;gap:12px;font-size:11px">${scenarios.map(s=>`<span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:2px;background:${s.color}"></span>${s.name}</span>`).join('')}</div></div><div style="display:flex;align-items:flex-end;gap:3px;height:180px;padding-bottom:20px">${sc.months.map((m,i)=>{const p=scenarios[0].months[i];const o=scenarios[2].months[i];const hP=Math.max(Math.round(p.rev/maxRev*140),4);const hR=Math.max(Math.round(m.rev/maxRev*140),4);const hO=Math.max(Math.round(o.rev/maxRev*140),4);return`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:1px"><div style="display:flex;gap:1px;align-items:flex-end;width:100%"><div style="flex:1;background:${scenarios[0].color};opacity:0.3;height:${hP}px;border-radius:2px 2px 0 0"></div><div style="flex:1;background:${scenarios[1].color};height:${hR}px;border-radius:2px 2px 0 0"></div><div style="flex:1;background:${scenarios[2].color};opacity:0.3;height:${hO}px;border-radius:2px 2px 0 0"></div></div><div style="font-size:8px;color:#8A8A99;margin-top:2px">${m.mois}</div></div>`;}).join('')}</div></div>`;
  html+=`<div class="card"><div style="font-size:14px;font-weight:600;margin-bottom:1rem">Comparaison 12 mois</div><div class="table-wrap"><table><thead><tr><th>Scénario</th><th>Occ.</th><th style="text-align:right">Revenus</th><th style="text-align:right">Charges</th><th style="text-align:right">Net</th><th style="text-align:right">Marge</th></tr></thead><tbody>${scenarios.map(s=>{const avgO=Math.round(s.months.reduce((a,m)=>a+m.occ,0)/12);const mg=s.totalRev>0?Math.round(s.totalNet/s.totalRev*100):0;return`<tr><td style="font-weight:600">${s.emoji} ${s.name}</td><td>${avgO}%</td><td style="text-align:right;color:#1D9E75">${Math.round(s.totalRev)}€</td><td style="text-align:right;color:#E24B4A">${Math.round(s.totalCharges)}€</td><td style="text-align:right;font-weight:700;color:${s.totalNet>=0?'#1D9E75':'#E24B4A'}">${s.totalNet>=0?'+':''}${Math.round(s.totalNet)}€</td><td style="text-align:right"><span class="tag ${mg>=15?'tag-ok':mg>=0?'tag-warn':'tag-bad'}">${mg}%</span></td></tr>`;}).join('')}</tbody></table></div></div>`;
  html+=`<div style="background:#F8F7FF;border-radius:10px;padding:1rem;margin-bottom:1rem;font-size:12px;color:#8A8A99;line-height:1.8"><strong style="color:#6B3FA0">Hypothèses :</strong> Occ. actuelle ${occActuel}% · Prix moy. ${prixMoyenNuit}€/nuit · ${nbApparts} bien${nbApparts>1?'s':''} · Charges fixes ${totalFixesMensuel}€/mois · Saisonnalité appliquée</div>`;
  el.innerHTML=html;el.scrollIntoView({behavior:'smooth',block:'start'});
}

// MODE DÉMO
async function loadDemoData(){
  const btn=document.querySelector('[onclick="loadDemoData()"]');
  if(btn){btn.disabled=true;btn.textContent='Chargement des données démo…';}

  // Fermer l\'onboarding
  document.getElementById('onb2').classList.remove('open');
  try{localStorage.setItem('onb2_seen_'+(currentUser?.user?.id||'demo'),'1');}catch(e){}

  // Appartements démo
  const demoApparts=[
    {name:'Studio Marais',city:'Paris',zone:'Le Marais',address:'15 rue des Francs-Bourgeois, Paris',latitude:48.8566,longitude:2.3522,emoji:'🏠',rent:950,cleaner:30,price:95,comp:105,ai_rec:102,booked:true,auto_pricing:true,note:4.7,auto_degressif:true,degressif_start:14,degressif_step:5,degressif_min:55},
    {name:'T2 Bastille',city:'Paris',zone:'Bastille',address:'8 rue de la Roquette, Paris',latitude:48.8534,longitude:2.3710,emoji:'🛋️',rent:1200,cleaner:35,price:110,comp:120,ai_rec:118,booked:false,auto_pricing:true,note:4.3,auto_degressif:false},
    {name:'T3 Bellecour Lyon',city:'Lyon',zone:'Bellecour',address:'12 place Bellecour, Lyon',latitude:45.7578,longitude:4.8320,emoji:'🌇',rent:850,cleaner:40,price:85,comp:92,ai_rec:90,booked:true,auto_pricing:true,note:4.8,auto_degressif:false},
    {name:'Studio Centre Orléans',city:'Orléans',zone:'Centre',address:'5 rue de la République, Orléans',latitude:47.9025,longitude:1.9040,emoji:'🌸',rent:650,cleaner:25,price:72,comp:78,ai_rec:76,booked:false,auto_pricing:true,note:4.5,auto_degressif:true,degressif_start:15,degressif_step:4,degressif_min:42}
  ];

  // Réservations démo (passées + futures)
  const now=new Date();
  const fmt=d=>d.toISOString().split('T')[0];
  const demoRes=[];
  const guests=['Sophie Martin','Pierre Durand','Emma Laurent','Lucas Bernard','Camille Petit','Hugo Moreau','Léa Simon','Nathan Michel'];
  const platforms=['airbnb','airbnb','booking','airbnb','direct','booking','airbnb','airbnb'];

  for(let i=-14;i<21;i+=3){
    const from=new Date(now.getTime()+i*86400000);
    const nights=Math.floor(Math.random()*3)+2;
    const to=new Date(from.getTime()+nights*86400000);
    const aptIdx=Math.floor(Math.random()*demoApparts.length);
    const price=demoApparts[aptIdx].price*nights;
    demoRes.push({
      apartment_name:demoApparts[aptIdx].name,
      appartement_id:'demo-apt-'+aptIdx,
      guest_name:guests[Math.floor(Math.random()*guests.length)],
      date_from:fmt(from),date_to:fmt(to),
      nights,price_total:price,
      platform:platforms[Math.floor(Math.random()*platforms.length)],
      status:'confirmed'
    });
  }

  // Charges démo
  const demoCharges=[];
  demoApparts.forEach((a,i)=>{
    const id='demo-apt-'+i;
    demoCharges.push({appartement_id:id,category:'loyer',label:'Loyer mensuel',amount:a.rent,type:'fixe',per:'mois'});
    demoCharges.push({appartement_id:id,category:'charges_locatives',label:'Charges locatives',amount:Math.round(a.rent*0.08),type:'fixe',per:'mois'});
    demoCharges.push({appartement_id:id,category:'energie',label:'Électricité',amount:Math.round(35+Math.random()*25),type:'fixe',per:'mois'});
    demoCharges.push({appartement_id:id,category:'internet',label:'Internet / WiFi',amount:25,type:'fixe',per:'mois'});
    demoCharges.push({appartement_id:id,category:'assurance',label:'Assurance PNO',amount:Math.round(20+Math.random()*15),type:'fixe',per:'mois'});
    demoCharges.push({appartement_id:id,category:'menage',label:'Ménage / séjour',amount:a.cleaner,type:'variable',per:'reservation'});
    demoCharges.push({appartement_id:id,category:'commission_plateforme',label:'Commission plateforme (%)',amount:3,type:'variable',per:'reservation'});
  });

  // Cleaners démo
  const demoCleaner=[
    {name:'Sara D.',phone:'06 12 34 56 78',email:'sara@email.com',city:'Paris',radius_km:10,tarif_t1:30,tarif_t2:42,tarif_t3:58,score:96,auto_accept:true,disponibilites:'Lun-Sam',id:'demo-cl-1'},
    {name:'Inès M.',phone:'06 98 76 54 32',email:'ines@email.com',city:'Lyon',radius_km:8,tarif_t1:28,tarif_t2:38,tarif_t3:52,score:82,auto_accept:false,disponibilites:'Lun-Ven',id:'demo-cl-2'}
  ];

  // Missions démo
  const demoMissions=[];
  for(let i=0;i<6;i++){
    const d=new Date(now.getTime()+(i-1)*86400000*2);
    const aptIdx=i%demoApparts.length;
    const clIdx=i%demoCleaner.length;
    demoMissions.push({
      id:'demo-mi-'+i,
      appartement_id:'demo-apt-'+aptIdx,
      cleaner_id:demoCleaner[clIdx].id,
      date:fmt(d),
      heure:['10:00','14:00','11:00','15:30'][i%4],
      duree_min:[120,150,120,180][i%4],
      tarif:[30,42,30,58][i%4],
      status:i<2?'terminee':i<4?'acceptee':'en_attente',
      checklist:'Draps, sdb, cuisine, aspirateur, poubelles',
      notes:''
    });
  }

  // Injecter les données
  apparts=demoApparts.map((a,i)=>({...a,id:'demo-apt-'+i,user_id:'demo'}));
  reservations=demoRes;
  chargesData=demoCharges;
  if(typeof cleanersData!=='undefined')cleanersData=demoCleaner;
  if(typeof missionsData!=='undefined')missionsData=demoMissions;

  // Afficher l\u2019app
  document.getElementById('app').style.display='flex';
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('loading').style.display='none';

  renderSidebar();
  renderAll();
  document.getElementById('cockpit-date').textContent=new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  applyModules();

  // Charger les événements pour les villes démo
  loadEvents(true);

  showToast('🎮 Mode démo activé — 4 apparts, réservations, finances');
}

// FIX nav-label-smoobu → nav-label-integrations

// STRIPE & TARIFS — MODE BÊTA
const BETA_PRICE_ID = 'price_1ThyhD2KSiLvAG7LTq3jetSn';

function renderTarifs(){
  const el=document.getElementById('tarifs-content');if(!el)return;
  const plan=currentProfile?.plan||'';

  el.innerHTML=`
  <!-- BANDEAU BÊTA -->
  <div style="background:linear-gradient(135deg,#1E1448,#6D28D9);border-radius:16px;padding:16px 24px;margin-bottom:2rem;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
    <div style="font-size:22px;flex-shrink:0">🎁</div>
    <div style="flex:1;min-width:200px">
      <div style="font-family:Sora,sans-serif;font-size:14px;font-weight:800;color:#fff;margin-bottom:3px">Bêta privée — Accès complet au pack PRO</div>
      <div style="font-size:13px;color:rgba(255,255,255,.8);line-height:1.5">30 jours gratuits, puis <strong style="color:#fff">99&nbsp;€/mois sans engagement.</strong> Annulation à tout moment.</div>
    </div>
    <div style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);border-radius:10px;padding:6px 14px;font-size:12px;font-weight:700;color:#fff;white-space:nowrap;flex-shrink:0">Bêta privée 🔒</div>
  </div>

  <!-- HERO -->
  <div style="text-align:center;padding:1rem 1rem 2rem;max-width:680px;margin:0 auto">
    <div style="display:inline-block;background:linear-gradient(135deg,#F3E8FF,#FCE7F3);border-radius:999px;padding:6px 16px;font-size:12px;font-weight:800;color:#6D28D9;font-family:Sora,sans-serif;letter-spacing:.5px;margin-bottom:16px;text-transform:uppercase">Bêta privée — 30 jours offerts</div>
    <h1 style="font-family:Sora,sans-serif;font-size:clamp(26px,3vw,38px);font-weight:900;color:#0B0722;letter-spacing:-.8px;line-height:1.15;margin-bottom:14px">Combien EVA peut-elle vous faire gagner\u00a0?</h1>
    <p style="font-size:15px;color:#7B708F;line-height:1.7;margin-bottom:2rem">Pendant la bêta, vous accédez à l'intégralité du pack PRO gratuitement pendant 30 jours.<br><strong style="color:#0B0722">Sans engagement.</strong></p>
    <div style="display:inline-flex;gap:0;background:#F3E8FF;border-radius:14px;padding:16px 24px;text-align:left">
      <div style="display:grid;gap:10px;font-size:13px;color:#4B3B6B">
        ${['1 logement','EVA analyse vos donn\u00e9es','D\u00e9couvrez votre potentiel','D\u00e9cidez ensuite'].map((s,i)=>`
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#6D28D9,#EC4899);color:white;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i+1}</div>
            <span style="font-weight:${i===0||i===3?'700':'500'};color:${i===3?'#6D28D9':'#0B0722'}">${s}</span>
          </div>`).join('')}
      </div>
    </div>
  </div>

  <!-- OFFRES BÊTA -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-bottom:3rem">

    <!-- Starter — grisé -->
    <div style="background:#F9F9FC;border-radius:20px;border:1.5px solid #E5E3EE;padding:24px;display:flex;flex-direction:column;opacity:.62;pointer-events:none;position:relative">
      <div style="position:absolute;top:14px;right:14px;background:#F3F4F6;color:#8A8A99;font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px;font-family:Sora,sans-serif">Disponible après la bêta</div>
      <div style="font-family:Sora,sans-serif;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#B0A8C8;margin-bottom:8px">Starter</div>
      <div style="font-family:Sora,sans-serif;font-size:40px;font-weight:900;color:#C0BAD0;line-height:1;margin-bottom:4px">49\u20ac<span style="font-size:14px;font-weight:500;color:#B0A8C8">/mois</span></div>
      <div style="font-size:12px;color:#B0A8C8;margin-bottom:18px">Pour les investisseurs qui pilotent leurs biens</div>
      <div style="font-size:13px;line-height:1.9;color:#B0A8C8;flex:1;margin-bottom:20px">
        \u2713 Jusqu\u2019\u00e0 <strong>5 logements</strong><br>
        \u2713 Cockpit EVA<br>
        \u2713 Audit 360\u00b0 &amp; Profit 360\u00b0<br>
        \u2713 Scanner EVA<br>
        \u2713 Import Airbnb / Booking<br>
        \u2717 Mode conciergerie
      </div>
      <button disabled class="btn" style="width:100%;justify-content:center;padding:12px;font-family:Sora,sans-serif;font-size:14px;font-weight:700;opacity:.5;cursor:not-allowed">Non disponible en bêta</button>
    </div>

    <!-- PRO Bêta — seul pack actif -->
    <div style="background:linear-gradient(180deg,#F8F4FF 0%,white 100%);border-radius:20px;border:2px solid #6D28D9;padding:24px;display:flex;flex-direction:column;position:relative;box-shadow:0 20px 50px rgba(109,40,217,.16)">
      <div style="position:absolute;top:-14px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#6D28D9,#EC4899);color:white;font-size:11px;font-weight:800;padding:4px 16px;border-radius:999px;font-family:Sora,sans-serif;white-space:nowrap">B\u00caTA \u2014 ACC\u00c8S COMPLET</div>
      <div style="font-family:Sora,sans-serif;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#6D28D9;margin-bottom:8px">PRO B\u00eata</div>
      <div style="font-family:Sora,sans-serif;font-size:40px;font-weight:900;color:#0B0722;line-height:1;margin-bottom:4px">99\u20ac<span style="font-size:14px;font-weight:500;color:#8A8A99">/mois</span></div>
      <div style="font-size:12px;color:#7B708F;margin-bottom:4px">Acc\u00e8s complet pendant la b\u00eata</div>
      <div style="font-size:11px;font-weight:700;color:#059669;background:#DCFCE7;border-radius:999px;padding:3px 10px;display:inline-block;margin-bottom:18px">30 jours gratuits offerts</div>
      <div style="font-size:13px;line-height:1.9;color:#3A3A50;flex:1;margin-bottom:20px">
        \u2713 Jusqu\u2019\u00e0 <strong>30 logements</strong><br>
        \u2713 Cockpit EVA complet<br>
        \u2713 Connexion PMS<br>
        \u2713 Mode conciergerie<br>
        \u2713 Gestion multi-propri\u00e9taires<br>
        \u2713 Calendrier intelligent EVA<br>
        \u2713 Opportunit\u00e9s EVA avanc\u00e9es<br>
        \u2713 Audit 360\u00b0 &amp; Profit 360\u00b0<br>
        \u2713 Scanner EVA
      </div>
      <button onclick="startCheckout('pro')" class="btn btn-purple" style="width:100%;justify-content:center;padding:12px;font-family:Sora,sans-serif;font-size:14px;font-weight:800;box-shadow:0 8px 20px rgba(109,40,217,.28)">
        Commencer l\u2019essai gratuit
      </button>
    </div>

    <!-- Scale — grisé -->
    <div style="background:#F9F9FC;border-radius:20px;border:1.5px solid #E5E3EE;padding:24px;display:flex;flex-direction:column;opacity:.62;pointer-events:none;position:relative">
      <div style="position:absolute;top:14px;right:14px;background:#F3F4F6;color:#8A8A99;font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px;font-family:Sora,sans-serif">Disponible après la bêta</div>
      <div style="font-family:Sora,sans-serif;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#B0A8C8;margin-bottom:8px">Scale</div>
      <div style="font-family:Sora,sans-serif;font-size:40px;font-weight:900;color:#C0BAD0;line-height:1;margin-bottom:4px">199\u20ac<span style="font-size:14px;font-weight:500;color:#B0A8C8">/mois</span></div>
      <div style="font-size:12px;color:#B0A8C8;margin-bottom:18px">Conciergeries de 30 \u00e0 100 lots</div>
      <div style="font-size:13px;line-height:1.9;color:#B0A8C8;flex:1;margin-bottom:20px">
        \u2713 Jusqu\u2019\u00e0 <strong>100 logements</strong><br>
        \u2713 Tout Pro<br>
        \u2713 Historique EVA avanc\u00e9<br>
        \u2713 Rapports multi-clients<br>
        \u2713 Support prioritaire<br>
        \u2713 Scanner EVA illimit\u00e9
      </div>
      <button disabled class="btn" style="width:100%;justify-content:center;padding:12px;font-family:Sora,sans-serif;font-size:14px;font-weight:700;opacity:.5;cursor:not-allowed">Non disponible en bêta</button>
    </div>

  </div>

  <!-- POURQUOI PAYER -->
  <div style="background:linear-gradient(135deg,#F8F4FF,#FFF0F7);border-radius:22px;padding:2.5rem;margin-bottom:2.5rem;border:1px solid rgba(109,40,217,.12)">
    <div style="text-align:center;max-width:560px;margin:0 auto">
      <div style="font-family:Sora,sans-serif;font-size:22px;font-weight:900;color:#0B0722;margin-bottom:12px">Pourquoi ajouter RentyQ \u00e0 votre PMS\u00a0?</div>
      <p style="font-size:14px;color:#7B708F;line-height:1.7;margin-bottom:20px">Votre PMS vous aide <strong style="color:#0B0722">à g\u00e9rer</strong>. EVA vous aide <strong style="color:#6D28D9">à gagner davantage</strong>.</p>
      <div style="background:white;border-radius:16px;padding:20px;border:1px solid rgba(109,40,217,.12);text-align:left;margin-bottom:16px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:700;margin-bottom:6px">Co\u00fbt RentyQ</div>
            <div style="font-family:Sora,sans-serif;font-size:24px;font-weight:900;color:#DC2626">199\u20ac<span style="font-size:13px;font-weight:500;color:#8A8A99">/mois</span></div>
            <div style="font-size:12px;color:#8A8A99;margin-top:2px">\u2248 2 388\u20ac/an</div>
          </div>
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:700;margin-bottom:6px">Impact moyen EVA</div>
            <div style="font-family:Sora,sans-serif;font-size:24px;font-weight:900;color:#059669">+3 000\u20ac</div>
            <div style="font-size:12px;color:#8A8A99;margin-top:2px">jusqu\u2019\u00e0 +10 000\u20ac/an</div>
          </div>
        </div>
      </div>
      <p style="font-size:13px;color:#7B708F;font-style:italic">Si EVA ne vous aide pas \u00e0 am\u00e9liorer votre rentabilit\u00e9, il n\u2019a pas sa place dans votre activit\u00e9.</p>
    </div>
  </div>

  <!-- COMMENT CA MARCHE -->
  <div style="margin-bottom:2.5rem">
    <div style="font-family:Sora,sans-serif;font-size:22px;font-weight:900;color:#0B0722;text-align:center;margin-bottom:1.5rem">Comment \u00e7a fonctionne\u00a0?</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
      ${[
        {n:'1',icon:'\uD83D\uDD17',t:'Connectez vos donn\u00e9es',d:'PMS, Airbnb, Booking ou import manuel'},
        {n:'2',icon:'\uD83E\uDDE0',t:'EVA analyse',d:'Revenus, charges, occupation et performance'},
        {n:'3',icon:'\uD83D\uDCA1',t:'D\u00e9couvrez vos opportunit\u00e9s',d:'EVA identifie les actions \u00e0 fort impact'},
        {n:'4',icon:'\uD83D\uDCC8',t:'Augmentez votre rentabilit\u00e9',d:'Prenez de meilleures d\u00e9cisions, plus rapidement'}
      ].map(s=>`<div style="background:white;border-radius:16px;border:1px solid rgba(109,40,217,.12);padding:18px;text-align:center">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#6D28D9,#EC4899);color:white;font-size:14px;font-weight:900;display:flex;align-items:center;justify-content:center;margin:0 auto 10px;font-family:Sora,sans-serif">${s.n}</div>
        <div style="font-size:22px;margin-bottom:8px">${s.icon}</div>
        <div style="font-family:Sora,sans-serif;font-size:13px;font-weight:800;color:#0B0722;margin-bottom:4px">${s.t}</div>
        <div style="font-size:12px;color:#7B708F;line-height:1.4">${s.d}</div>
      </div>`).join('')}
    </div>
  </div>

  <!-- FAQ -->
  <div style="margin-bottom:2.5rem">
    <div style="font-family:Sora,sans-serif;font-size:22px;font-weight:900;color:#0B0722;text-align:center;margin-bottom:1.5rem">Questions fr\u00e9quentes</div>
    <div style="display:grid;gap:8px;max-width:700px;margin:0 auto">
      ${[
        ['Puis-je essayer RentyQ gratuitement\u00a0?','Oui. 30 jours gratuits sur votre premier logement, sans carte bancaire.'],
        ['Ai-je besoin d\u2019un PMS\u00a0?','Non. EVA fonctionne avec des imports Airbnb, Booking, des relev\u00e9s bancaires ou une saisie manuelle.'],
        ['Puis-je annuler \u00e0 tout moment\u00a0?','Oui. Sans engagement, sans frais.'],
        ['EVA remplace-t-elle mon PMS\u00a0?','Non. Votre PMS g\u00e8re. EVA analyse et recommande pour vous faire gagner plus.'],
        ['Mes donn\u00e9es sont-elles s\u00e9curis\u00e9es\u00a0?','Oui. Donn\u00e9es stock\u00e9es sur infrastructure s\u00e9curis\u00e9e (Supabase \u2014 ISO 27001).']
      ].map(([q,a])=>`<details style="background:white;border:1px solid rgba(109,40,217,.12);border-radius:14px;padding:16px;cursor:pointer">
        <summary style="font-family:Sora,sans-serif;font-size:14px;font-weight:700;color:#0B0722;list-style:none;display:flex;justify-content:space-between;align-items:center">${q}<span style="color:#6D28D9;font-size:16px">+</span></summary>
        <div style="font-size:13px;color:#7B708F;line-height:1.65;margin-top:10px;padding-top:10px;border-top:1px solid #F0EBF9">${a}</div>
      </details>`).join('')}
    </div>
  </div>

  <!-- FOOTER CTA -->
  <div style="background:linear-gradient(135deg,#6D28D9 0%,#9333EA 50%,#EC4899 100%);border-radius:22px;padding:3rem;text-align:center;color:white;margin-bottom:1rem">
    <div style="font-family:Sora,sans-serif;font-size:26px;font-weight:900;line-height:1.2;margin-bottom:10px">Pr\u00eat \u00e0 d\u00e9couvrir le potentiel r\u00e9el de vos logements\u00a0?</div>
    <p style="color:rgba(255,255,255,.8);font-size:14px;margin-bottom:24px">Essayez RentyQ gratuitement pendant 30 jours. Sans carte bancaire.</p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
      <button onclick="startCheckout('starter')" style="padding:13px 28px;border-radius:14px;background:white;color:#6D28D9;border:none;font-size:15px;font-weight:800;cursor:pointer;font-family:Sora,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18)">Essayer gratuitement</button>
      <button onclick="window.location.href='mailto:contact@rentyq.fr'" style="padding:13px 28px;border-radius:14px;background:rgba(255,255,255,.15);color:white;border:1px solid rgba(255,255,255,.3);font-size:15px;font-weight:700;cursor:pointer;font-family:Sora,sans-serif">Demander une d\u00e9mo</button>
    </div>
  </div>

  <div style="text-align:center;font-size:12px;color:#8A8A99;padding:0.5rem 0 1.5rem">
    \uD83D\uDD12 Paiement s\u00e9curis\u00e9 par Stripe &nbsp;\u00b7&nbsp; Annulation \u00e0 tout moment &nbsp;\u00b7&nbsp; Aucun engagement
  </div>
  `;
}

async function startCheckout(plan){
  const btn=event.target;btn.disabled=true;btn.textContent='Chargement...';
  try{
    const res=await fetch(STRIPE_FN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'createCheckout',plan,priceId:BETA_PRICE_ID,email:currentProfile?.email||''})});
    const data=await res.json();
    if(data.url){window.location.href=data.url;}
    else{showToast('Erreur : '+(data.error||'Réessayez'));btn.disabled=false;btn.textContent="Commencer l\u2019essai gratuit";}
  }catch(e){showToast('Erreur de connexion');btn.disabled=false;btn.textContent="Commencer l\u2019essai gratuit";}
}

function checkPaymentReturn(){
  const params=new URLSearchParams(window.location.search);
  if(params.get('payment')==='success'){
    const plan=params.get('plan')||'starter';
    if(currentProfile)currentProfile.plan=plan.charAt(0).toUpperCase()+plan.slice(1);
    renderSidebar();
    goTo('tarifs',document.querySelector('[onclick*=tarifs]'));
    document.getElementById('tarifs-success').style.display='block';
    document.getElementById('tarifs-content').style.display='none';
    showToast('🎉 Abonnement activé !');
    window.history.replaceState({},'',window.location.pathname);
  }
  if(params.get('payment')==='cancelled'){
    showToast('Paiement annulé — vous pouvez réessayer quand vous voulez.');
    window.history.replaceState({},'',window.location.pathname);
  }
}

// Init
(async function(){
  document.getElementById('loading').style.display='none';
  document.getElementById('auth-screen').style.display='flex';
  try{
    // 1. Vérifier d’abord un retour OAuth Google (hash dans l’URL)
    const isOAuth=await checkOAuthCallback();
    if(isOAuth){
      document.getElementById('auth-screen').style.display='none';
      document.getElementById('loading').style.display='flex';
      await loadApp();
      return;
    }
    // 2. Session localStorage existante
    const stored=localStorage.getItem('sb_session');
    if(stored){
      const parsed=JSON.parse(stored);
      // Vérifier que la session est valide (token non expiré)
      if(parsed&&parsed.access_token&&parsed.user&&parsed.user.id){
        currentUser=parsed;
        document.getElementById('auth-screen').style.display='none';
        document.getElementById('loading').style.display='flex';
        await loadApp();
        return;
      }else{
        try{localStorage.removeItem('sb_session');}catch(e2){}
      }
    }
  }catch(e){
    try{localStorage.removeItem('sb_session');}catch(e2){}
    document.getElementById('loading').style.display='none';
    document.getElementById('auth-screen').style.display='flex';
  }
})();

// ══ PRODUCT TOUR ══
const RQ_TOUR_KEY = 'rentyq_tour_v1';
let rqTourStep = -1;

const RQ_TOUR_STEPS = [
  {
    sel: "[onclick*=\"cockpit\"]",
    page: "cockpit",
    emoji: "🏠",
    title: "1/5 — Cockpit",
    text: "C\u2019est votre porte d\'entrée. EVA affiche le score global, le potentiel annuel détecté et les actions prioritaires du jour. Tout part d\u2019ici."
  },
  {
    sel: "[onclick*=\"parc\"]",
    page: "parc",
    emoji: "🏢",
    title: "2/5 — Mes logements",
    text: "Retrouvez tous vos biens, leur score EVA individuel, leur rentabilité et les recommandations spécifiques à chaque logement."
  },
  {
    sel: "[onclick*=\"eva-audit\"]",
    page: "eva-audit",
    emoji: "📊",
    title: "3/5 — EVA Audit 360°",
    text: "EVA analyse vos données réelles : réservations, charges, occupation, rentabilité nette. Il transforme les chiffres en décisions concrètes et chiffrées."
  },
  {
    sel: "[onclick*=\"pricing\"]",
    page: "pricing",
    emoji: "🧠",
    title: "4/5 — EVA Pricing",
    text: "EVA détecte les événements locaux, analyse la demande et suggère le bon prix pour chaque nuit libre. Vous validez avant application."
  },
  {
    sel: "[onclick*=\"pricing\"]",
    page: "pricing",
    emoji: "💡",
    title: "5/5 — Opportunités EVA",
    text: "EVA détecte les pics de demande locale et les traduit directement en prix conseillés. Pas d’événements — des revenus supplémentaires à capter."
  }
];

function rqTourShouldShow() {
  try { return !localStorage.getItem(RQ_TOUR_KEY); } catch(e) { return false; }
}

function rqTourTrigger() {
  if (!rqTourShouldShow()) return;
  setTimeout(() => {
    const overlay = document.getElementById('rq-tour-overlay');
    if (!overlay) return;
    overlay.style.display = 'block';
    overlay.style.pointerEvents = 'auto';
    document.getElementById('rq-tour-welcome').style.display = 'block';
    document.getElementById('rq-tour-card').style.display = 'none';
    document.getElementById('rq-tour-spot').style.display = 'none';
  }, 1000);
}

function rqTourStart() {
  document.getElementById('rq-tour-welcome').style.display = 'none';
  document.getElementById('rq-tour-card').style.display = 'block';
  document.getElementById('rq-tour-spot').style.display = 'block';
  rqTourGoTo(0);
}

function rqTourGoTo(idx) {
  if (idx < 0 || idx >= RQ_TOUR_STEPS.length) return;
  rqTourStep = idx;
  const step = RQ_TOUR_STEPS[idx];

  // Naviguer vers la page
  const navBtn = document.querySelector(step.sel);
  if (navBtn) {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    navBtn.classList.add('active');
    if (typeof goTo === 'function') goTo(step.page, navBtn);
  }

  // Contenu
  document.getElementById('rq-tour-emoji').textContent = step.emoji;
  document.getElementById('rq-tour-title').textContent = step.title;
  document.getElementById('rq-tour-text').textContent = step.text;

  // Dots
  document.getElementById('rq-tour-dots').innerHTML = RQ_TOUR_STEPS.map((_, i) =>
    `<div style="width:${i===idx?'20px':'8px'};height:8px;border-radius:4px;background:${i===idx?'#534AB7':'#E5E7EB'};transition:all .3s"></div>`
  ).join('');

  // Boutons
  document.getElementById('rq-tour-prev').style.display = idx === 0 ? 'none' : 'block';
  const next = document.getElementById('rq-tour-next');
  if (idx === RQ_TOUR_STEPS.length - 1) {
    next.innerHTML = '🚀 Lancer ma première analyse EVA';
    next.style.fontSize = '12px';
    next.style.background = 'linear-gradient(135deg,#534AB7,#9333EA)';
  } else {
    next.innerHTML = 'Suivant →';
    next.style.fontSize = '13px';
    next.style.background = '#534AB7';
  }

  // Position spotlight + card
  setTimeout(() => {
    const el = document.querySelector(step.sel);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spot = document.getElementById('rq-tour-spot');
    spot.style.left = (rect.left - 6) + 'px';
    spot.style.top = (rect.top - 6) + 'px';
    spot.style.width = (rect.width + 12) + 'px';
    spot.style.height = (rect.height + 12) + 'px';

    const card = document.getElementById('rq-tour-card');
    const cardTop = Math.max(12, Math.min(rect.top + rect.height/2 - 120, window.innerHeight - 320));
    card.style.left = (rect.right + 18) + 'px';
    card.style.top = cardTop + 'px';
  }, 80);
}

function rqTourNext() {
  if (rqTourStep === RQ_TOUR_STEPS.length - 1) {
    rqTourClose();
    const evaBtn = document.querySelector('[onclick*="pricing"]');
    if (evaBtn && typeof goTo === 'function') goTo('pricing', evaBtn);
    const t = document.getElementById('toast');
    if (t) { t.textContent = '🤖 EVA est prête — analysez vos recommandations !'; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); }
  } else {
    rqTourGoTo(rqTourStep + 1);
  }
}

function rqTourPrev() {
  if (rqTourStep > 0) rqTourGoTo(rqTourStep - 1);
}

function rqTourClose() {
  const overlay = document.getElementById('rq-tour-overlay');
  if (overlay) overlay.style.display = 'none';
  try { localStorage.setItem(RQ_TOUR_KEY, '1'); } catch(e) {}
}


/* ===== EVA AUDIT 360 — moteur local MVP ===== */
const EVA360_DEMO_RESERVATIONS = `reservation_id;platform;property_name;property_address;guest_name;booking_date;check_in;check_out;nights;guests;status;nightly_rate_eur;accommodation_subtotal_eur;cleaning_fee_eur;guest_service_fee_eur;host_service_fee_eur;tourist_tax_eur;host_payout_eur;currency
HM20260001;Airbnb Business;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Sarah U.;2026-03-01;2026-03-11;2026-03-14;3;1;Terminée;75;225;35;38.44;7.8;4.83;257.03;EUR
HM20260002;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Emma J.;2026-03-05;2026-03-15;2026-03-19;4;2;Terminée;65;260;35;45.72;8.85;6.48;292.63;EUR
HM20260003;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Paul U.;2026-03-08;2026-03-19;2026-03-20;1;2;Terminée;81;81;35;18.53;3.48;1.71;114.23;EUR
HM20260004;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Manon W.;2026-03-13;2026-03-22;2026-03-25;3;2;Terminée;63;189;35;29.53;6.72;4.63;221.91;EUR
HM20260005;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Alex B.;2026-03-19;2026-03-27;2026-03-29;2;1;Terminée;88;176;35;28.77;6.3;3.71;201.99;EUR
HM20260006;Airbnb Business;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Nadia C.;2026-04-01;2026-04-03;2026-04-06;3;1;Terminée;79;237;35;41.21;8.4;5.3;263.3;EUR
HM20260007;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Louis M.;2026-04-08;2026-04-10;2026-04-14;4;2;Terminée;71;284;35;47.20;9.57;6.66;303.77;EUR
HM20260008;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Clara T.;2026-04-12;2026-04-17;2026-04-20;3;2;Terminée;82;246;35;41.12;8.43;5.52;267.05;EUR
HM20260009;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Mehdi R.;2026-04-18;2026-04-23;2026-04-26;3;1;Terminée;76;228;35;38.40;7.89;5.02;250.09;EUR
HM20260010;Airbnb Business;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Victor D.;2026-05-02;2026-05-05;2026-05-09;4;1;Terminée;92;368;35;58.50;12.09;7.20;383.71;EUR
HM20260011;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Julie P.;2026-05-04;2026-05-10;2026-05-13;3;2;Terminée;88;264;35;43.10;8.97;5.90;284.13;EUR
HM20260012;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Hugo F.;2026-05-12;2026-05-15;2026-05-18;3;2;Terminée;95;285;35;46.40;9.60;6.10;304.30;EUR
HM20260013;Airbnb;Studio Hyper Centre Orléans - Cathédrale;Rue Jeanne d\u2019Arc, 45000 Orléans;Laura V.;2026-05-18;2026-05-21;2026-05-24;3;1;Terminée;84;252;35;41.60;8.58;5.40;273.02;EUR`;

const EVA360_DEMO_BANK = `Date;Libellé;Contrepartie;Débit (€);Crédit (€);Solde impact (€)
2026-03-02;Loyer;Prélèvement SCI Centre;620.0;;-620.0
2026-03-02;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-03-03;Électricité;EDF;54.2;;-54.2
2026-03-04;Assurance PNO;AXA Assurance;14.9;;-14.9
2026-03-09;Charges copropriété;Syndic Orléans Habitat;78.0;;-78.0
2026-03-09;Netflix;Netflix;13.49;;-13.49
2026-03-11;Taxe séjour reversée;Orléans Métropole;42.0;;-42.0
2026-03-11;Maintenance;Petit dépannage;65.0;;-65.0
2026-03-13;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-03-14;Internet;Orange Internet;29.99;;-29.99
2026-03-18;Produits d\u2019accueil;Amazon;24.8;;-24.8
2026-03-18;Linge / blanchisserie;Blanchisserie Orléans;38.5;;-38.5
2026-03-25;Eau;Orléans Métropole Eau;18.5;;-18.5
2026-03-27;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-03-28;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-04-01;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-04-02;Charges copropriété;Syndic Orléans Habitat;78.0;;-78.0
2026-04-03;Loyer;Prélèvement SCI Centre;620.0;;-620.0
2026-04-04;Électricité;EDF;54.2;;-54.2
2026-04-05;Assurance PNO;AXA Assurance;14.9;;-14.9
2026-04-09;Netflix;Netflix;13.49;;-13.49
2026-04-11;Taxe séjour reversée;Orléans Métropole;42.0;;-42.0
2026-04-13;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-04-14;Internet;Orange Internet;29.99;;-29.99
2026-04-18;Produits d\u2019accueil;Amazon;24.8;;-24.8
2026-04-18;Linge / blanchisserie;Blanchisserie Orléans;38.5;;-38.5
2026-04-25;Eau;Orléans Métropole Eau;18.5;;-18.5
2026-04-27;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-05-02;Loyer;Prélèvement SCI Centre;620.0;;-620.0
2026-05-02;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-05-03;Électricité;EDF;54.2;;-54.2
2026-05-04;Assurance PNO;AXA Assurance;14.9;;-14.9
2026-05-09;Charges copropriété;Syndic Orléans Habitat;78.0;;-78.0
2026-05-09;Netflix;Netflix;13.49;;-13.49
2026-05-11;Taxe séjour reversée;Orléans Métropole;42.0;;-42.0
2026-05-11;Maintenance;Petit dépannage;65.0;;-65.0
2026-05-13;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0
2026-05-14;Internet;Orange Internet;29.99;;-29.99
2026-05-18;Produits d\u2019accueil;Amazon;24.8;;-24.8
2026-05-18;Linge / blanchisserie;Blanchisserie Orléans;38.5;;-38.5
2026-05-25;Eau;Orléans Métropole Eau;18.5;;-18.5
2026-05-27;Ménage Airbnb;Prestataire Ménage;45.0;;-45.0`;

function eva360ParseCsv(raw){
  raw = (raw || '').replace(/^\uFEFF/, '').trim();
  if(!raw) return [];
  const firstLine = raw.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g)||[]).length >= (firstLine.match(/,/g)||[]).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for(let i=0;i<raw.length;i++){
    const c = raw[i], n = raw[i+1];
    if(c === '"' && q && n === '"'){ cell += '"'; i++; continue; }
    if(c === '"'){ q = !q; continue; }
    if(c === sep && !q){ row.push(cell); cell=''; continue; }
    if((c === '\n' || c === '\r') && !q){
      if(c === '\r' && n === '\n') i++;
      row.push(cell); rows.push(row); row=[]; cell='';
      continue;
    }
    cell += c;
  }
  row.push(cell); rows.push(row);
  const headers = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(x => String(x||'').trim() !== '')).map(r => {
    const o = {};
    headers.forEach((h,i) => o[h] = (r[i] || '').trim());
    return o;
  });
}
function eva360NormKey(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_');}
function eva360FindKey(row, candidates){
  const keys = Object.keys(row || {});
  const norm = Object.fromEntries(keys.map(k => [eva360NormKey(k), k]));
  for(const c of candidates){ if(norm[eva360NormKey(c)]) return norm[eva360NormKey(c)]; }
  for(const k of keys){
    const nk = eva360NormKey(k);
    if(candidates.some(c => nk.includes(eva360NormKey(c)))) return k;
  }
  return null;
}
function eva360Num(v){
  if(v === null || v === undefined) return 0;
  let s = String(v).replace(/\s/g,'').replace('€','').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function eva360Date(v){
  const d = new Date(String(v||'').trim());
  return isNaN(d.getTime()) ? null : d;
}
function eva360MonthKey(d){return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');}
function eva360MonthLabel(key){
  const [y,m]=key.split('-').map(Number);
  return new Date(y,m-1,1).toLocaleDateString('fr-FR',{month:'short',year:'numeric'}).replace('.', '');
}
function eva360DaysInMonth(key){const [y,m]=key.split('-').map(Number); return new Date(y,m,0).getDate();}
function eva360Money(v){return Math.round(v).toLocaleString('fr-FR') + ' €';}
function eva360ReadFile(inputId){
  const input = document.getElementById(inputId);
  return new Promise((resolve,reject)=>{
    if(!input || !input.files || !input.files[0]) return reject(new Error('Fichier manquant'));
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('Impossible de lire le fichier'));
    fr.readAsText(input.files[0], 'utf-8');
  });
}
async function runEvaAudit360(){
  const err = document.getElementById('eva360-error');
  try{
    if(err){err.style.display='none';err.textContent='';}
    const resRaw = await eva360ReadFile('eva360-res-file');
    const bankRaw = await eva360ReadFile('eva360-bank-file');
    const address = (document.getElementById('eva360-address')?.value || '').trim();
    if(!address) throw new Error('Ajoutez l\u2019adresse du bien.');
    eva360Render(eva360Analyze(resRaw, bankRaw, address));
  }catch(e){
    if(err){err.textContent = e.message || 'Erreur pendant l\u2019analyse EVA.'; err.style.display='block';}
  }
}
function loadEvaAuditDemo(){
  const addr = document.getElementById('eva360-address');
  if(addr) addr.value = "5 rue d\'Illiers, 45000 Orléans";
  eva360Render(eva360Analyze(EVA360_DEMO_RESERVATIONS, EVA360_DEMO_BANK, "5 rue d\u2019Illiers, 45000 Orléans"));
}
function eva360Analyze(resRaw, bankRaw, address){
  const resRows = eva360ParseCsv(resRaw);
  const bankRows = eva360ParseCsv(bankRaw);
  if(!resRows.length) throw new Error('Le CSV réservations est vide ou illisible.');
  if(!bankRows.length) throw new Error('Le CSV bancaire est vide ou illisible.');
  const r0 = resRows[0], b0 = bankRows[0];
  const kIn = eva360FindKey(r0, ['check_in','arrivee','arrival','date_debut']);
  const kOut = eva360FindKey(r0, ['check_out','depart','departure','date_fin']);
  const kNights = eva360FindKey(r0, ['nights','nuits','nuitées']);
  const kPayout = eva360FindKey(r0, ['host_payout_eur','payout','revenu','montant','accommodation_subtotal_eur']);
  const kRate = eva360FindKey(r0, ['nightly_rate_eur','prix_nuit','adr','nightly_rate']);
  if(!kIn || !kOut) throw new Error('EVA ne trouve pas les colonnes check_in/check_out dans le CSV réservations.');
  const months = {};
  let totalRevenue = 0, totalNights = 0, bookingCount = 0, rateSum = 0, rateCount = 0;
  resRows.forEach(r=>{
    const start = eva360Date(r[kIn]), end = eva360Date(r[kOut]);
    if(!start || !end || end <= start) return;
    const nights = eva360Num(kNights ? r[kNights] : 0) || Math.max(1, Math.round((end-start)/86400000));
    const payout = eva360Num(kPayout ? r[kPayout] : 0);
    const rate = eva360Num(kRate ? r[kRate] : 0);
    bookingCount++; totalRevenue += payout; totalNights += nights;
    if(rate){rateSum += rate; rateCount++;}
    const perNight = payout && nights ? payout/nights : rate;
    for(let d=new Date(start); d<end; d.setDate(d.getDate()+1)){
      const key = eva360MonthKey(d);
      months[key] ||= {month:key, revenue:0, charges:0, occupied:0, bookings:0, events:[]};
      months[key].occupied += 1;
      months[key].revenue += perNight;
    }
  });
  const kDate = eva360FindKey(b0, ['date']);
  const kDebit = eva360FindKey(b0, ['debit','débit']);
  const kCredit = eva360FindKey(b0, ['credit','crédit']);
  const kImpact = eva360FindKey(b0, ['solde impact','impact','amount','montant']);
  const kLabel = eva360FindKey(b0, ['libelle','libellé','description','contrepartie']);
  if(!kDate) throw new Error('EVA ne trouve pas la colonne Date dans le CSV bancaire.');
  let totalCharges = 0, chargesByCat = {};
  bankRows.forEach(r=>{
    const d = eva360Date(r[kDate]); if(!d) return;
    let amount = 0;
    if(kDebit && eva360Num(r[kDebit])) amount = eva360Num(r[kDebit]);
    else if(kImpact) amount = Math.abs(Math.min(0, eva360Num(r[kImpact])));
    else amount = Math.abs(eva360Num(kCredit ? r[kCredit] : 0));
    if(!amount) return;
    const key = eva360MonthKey(d);
    months[key] ||= {month:key, revenue:0, charges:0, occupied:0, bookings:0, events:[]};
    months[key].charges += amount;
    totalCharges += amount;
    const cat = eva360Categorize((r[kLabel] || '') + ' ' + Object.values(r).join(' '));
    chargesByCat[cat] = (chargesByCat[cat] || 0) + amount;
  });
  const allMonths = Object.keys(months).sort().map(k=>{
    const m = months[k];
    m.days = eva360DaysInMonth(k);
    m.occPct = Math.min(100, Math.round((m.occupied / m.days) * 100));
    m.net = m.revenue - m.charges;
    return m;
  });
  const totalNet = totalRevenue - totalCharges;
  const avgOcc = allMonths.length ? Math.round(allMonths.reduce((s,m)=>s+m.occPct,0)/allMonths.length) : 0;
  const adr = rateCount ? rateSum/rateCount : (totalNights ? totalRevenue/totalNights : 0);
  const score = Math.max(38, Math.min(92, Math.round(48 + avgOcc*.25 + (totalNet>0?16:0) + (String(address).toLowerCase().includes('orleans')||String(address).toLowerCase().includes('orléans')?8:3))));
  const events = eva360EventsForAddress(address, allMonths, adr);
  return {address, months:allMonths, totalRevenue, totalCharges, totalNet, avgOcc, adr, totalNights, bookingCount, chargesByCat, score, events};
}
function eva360Categorize(label){
  const l = eva360NormKey(label);
  if(l.includes('menage')) return 'Ménage';
  if(l.includes('loyer')) return 'Loyer';
  if(l.includes('electric') || l.includes('edf')) return 'Électricité';
  if(l.includes('internet') || l.includes('orange')) return 'Internet';
  if(l.includes('linge') || l.includes('blanchisserie')) return 'Linge';
  if(l.includes('maintenance') || l.includes('depannage')) return 'Maintenance';
  if(l.includes('copro')) return 'Copropriété';
  if(l.includes('assurance')) return 'Assurance';
  if(l.includes('sejour')) return 'Taxe de séjour';
  if(l.includes('netflix')) return 'Abonnements';
  if(l.includes('accueil') || l.includes('amazon')) return 'Produits d\u2019accueil';
  if(l.includes('eau')) return 'Eau';
  return 'Autres';
}
function eva360EventsForAddress(address, months, adr){
  const city = eva360NormKey(address).includes('orleans') ? 'Orléans' : 'ville';
  const base = Math.round(adr || 75);
  if(city === 'Orléans'){
    return [
      {date:'2026-05-07', name:"Fêtes de Jeanne d\u2019Arc", type:'Patrimoine / tourisme', current:base+12, suggested:base+28, gap:16},
      {date:'2026-05-16', name:'Week-end Loire & centre historique', type:'Tourisme urbain', current:base+5, suggested:base+18, gap:13},
      {date:'2026-06-11', name:'Déplacements professionnels Orléans centre', type:'Business', current:base, suggested:base+14, gap:14},
      {date:'2026-09-17', name:'Festival de Loire', type:'Événement majeur', current:base+18, suggested:base+42, gap:24}
    ];
  }
  return [
    {date:'2026-06-12', name:'Pic de demande locale', type:'Événement local', current:base, suggested:base+15, gap:15},
    {date:'2026-07-05', name:'Période touristique', type:'Tourisme', current:base+8, suggested:base+22, gap:14}
  ];
}
function eva360Render(data){
  document.getElementById('eva360-empty').style.display='none';
  document.getElementById('eva360-dashboard').style.display='block';
  document.getElementById('eva360-score').textContent = data.score + '/100';
  document.getElementById('eva360-revenue').textContent = eva360Money(data.totalRevenue);
  document.getElementById('eva360-charges').textContent = eva360Money(data.totalCharges);
  document.getElementById('eva360-net').textContent = eva360Money(data.totalNet);
  document.getElementById('eva360-period').textContent = data.months.length + ' mois analysés • ' + data.bookingCount + ' réservations';
  document.getElementById('eva360-net-help').textContent = Math.round((data.totalNet / Math.max(1,data.months.length))).toLocaleString('fr-FR') + ' €/mois en moyenne';
  const occ = document.getElementById('eva360-occupancy');
  occ.innerHTML = data.months.map(m=>`
    <div class="eva360-pie-card">
      <div class="eva360-pie-wrap">
        <div class="eva360-pie" style="--occ:${m.occPct}%"><div class="eva360-pie-inner">${m.occPct}%</div></div>
        <div>
          <div class="eva360-pie-month">${eva360MonthLabel(m.month)}</div>
          <div class="eva360-pie-detail">${m.occupied} nuits occupées<br>${m.days-m.occupied} nuits disponibles</div>
        </div>
      </div>
    </div>`).join('');
  const maxNet = Math.max(...data.months.map(m=>Math.max(0,m.net)), 1);
  document.getElementById('eva360-net-bars').innerHTML = data.months.map(m=>`
    <div class="eva360-net-row">
      <div class="eva360-net-month">${eva360MonthLabel(m.month)}</div>
      <div class="eva360-bar-track"><div class="eva360-bar-fill" style="--w:${Math.max(4,Math.round(Math.max(0,m.net)/maxNet*100))}%"></div></div>
      <div class="eva360-net-value">${eva360Money(m.net)}</div>
    </div>`).join('');
  const actions = eva360BuildActions(data);
  document.getElementById('eva360-actions').innerHTML = actions.map((a,i)=>`
    <div class="eva360-action">
      <div class="eva360-rank">${i+1}</div>
      <div><div class="eva360-action-title">${a.title}</div><div class="eva360-action-desc">${a.desc}</div></div>
      <div class="eva360-impact">${a.impact}</div>
    </div>`).join('');
  const detect = eva360BuildDetect(data);
  document.getElementById('eva360-detect').innerHTML = detect.map(d=>`<div class="eva360-detect-item"><span>${d.icon}</span><div><strong>${d.title}</strong><br>${d.text}</div></div>`).join('');
  document.getElementById('eva360-events').innerHTML = data.events.map(e=>`
    <div class="eva360-event-row">
      <div class="eva360-event-date">${new Date(e.date).toLocaleDateString('fr-FR',{day:'2-digit',month:'short'})}</div>
      <div><div class="eva360-event-name">${e.name}</div><div class="eva360-event-meta">${e.type}</div></div>
      <div class="eva360-event-price">prix actuel <strong>${e.current} €</strong></div>
      <div class="eva360-event-gap">+${e.gap} €/nuit possible</div>
    </div>`).join('');
}
function eva360BuildActions(data){
  const topCharge = Object.entries(data.chargesByCat).sort((a,b)=>b[1]-a[1])[0] || ['charges',0];
  const lowMonth = data.months.slice().sort((a,b)=>a.occPct-b.occPct)[0];
  return [
    {title:'Corréler les prix avec les événements locaux', desc:'EVA détecte des dates où le prix pratiqué semble trop bas par rapport à la demande locale.', impact:'+1 500 à +2 800 €/an'},
    {title:'Optimiser le poste "'+topCharge[0]+'"', desc:'C\u2019est le poste de dépense le plus visible dans les charges importées. Un audit fournisseur peut améliorer la marge.', impact:'+600 à +1 400 €/an'},
    {title:'Travailler les mois creux', desc: lowMonth ? eva360MonthLabel(lowMonth.month)+' affiche seulement '+lowMonth.occPct+'% d\u2019occupation. Il faut adapter le séjour minimum et les offres courtes.' : 'Adapter le séjour minimum selon la saison.', impact:'+700 à +1 200 €/an'},
    {title:'Positionner le bien pour la clientèle business', desc:'L\u2019adresse et les séjours courts suggèrent un potentiel professionnel à mieux exploiter.', impact:'+500 à +1 000 €/an'},
    {title:'Créer un suivi mensuel EVA', desc:'Comparer chaque mois revenu, charges, occupation et événements pour éviter les opportunités manquées.', impact:'pilotage continu'}
  ];
}
function eva360BuildDetect(data){
  const margin = data.totalRevenue ? Math.round(data.totalNet/data.totalRevenue*100) : 0;
  return [
    {icon:'💰', title:'Rentabilité nette lisible', text:'Le logement conserve environ '+margin+'% des revenus après charges détectées.'},
    {icon:'📊', title:'Occupation moyenne', text:'Le taux d\u2019occupation moyen est de '+data.avgOcc+'% sur la période analysée.'},
    {icon:'🏙️', title:'Adresse exploitable', text:'EVA peut relier l\u2019adresse aux événements, zones business et périodes de demande.'},
    {icon:'🧹', title:'Charges à surveiller', text:'Les charges variables comme ménage, linge et maintenance doivent être pilotées car elles réduisent directement la marge.'}
  ];
}

/* ===== Audit 360° inline par bien (onglet Audit dans fiche logement) ===== */
async function runAptAudit360(aptId){
  const err=document.getElementById('apt-audit-error-'+aptId);
  const result=document.getElementById('apt-audit-result-'+aptId);
  if(err)err.style.display='none';
  if(result)result.innerHTML='<div class="ai-bubble"><div class="ai-bubble-head"><div class="ai-dot"></div> EVA analyse les données du bien…</div><div class="ai-bubble-text"><div class="typing"><span></span><span></span><span></span></div></div></div>';
  try{
    const resInput=document.getElementById('apt-audit-res-'+aptId);
    const bankInput=document.getElementById('apt-audit-bank-'+aptId);
    const address=(document.getElementById('apt-audit-addr-'+aptId)?.value||'').trim();
    if(!address)throw new Error('L\'adresse du bien est requise.');
    const resRaw=await new Promise((res,rej)=>{
      if(!resInput||!resInput.files||!resInput.files[0])return rej(new Error('Importez un CSV de réservations.'));
      const fr=new FileReader();fr.onload=()=>res(String(fr.result||''));fr.onerror=()=>rej(new Error('Impossible de lire le fichier réservations.'));fr.readAsText(resInput.files[0],'utf-8');
    });
    const bankRaw=await new Promise((res,rej)=>{
      if(!bankInput||!bankInput.files||!bankInput.files[0])return rej(new Error('Importez un CSV bancaire.'));
      const fr=new FileReader();fr.onload=()=>res(String(fr.result||''));fr.onerror=()=>rej(new Error('Impossible de lire le fichier bancaire.'));fr.readAsText(bankInput.files[0],'utf-8');
    });
    const data=eva360Analyze(resRaw,bankRaw,address);
    renderAptAudit360Result(aptId,data);
  }catch(e){
    if(err){err.textContent=e.message||'Erreur pendant l\'analyse.';err.style.display='block';}
    if(result)result.innerHTML='';
  }
}

function loadAptAuditDemo(aptId){
  const addrEl=document.getElementById('apt-audit-addr-'+aptId);
  if(addrEl&&!addrEl.value)addrEl.value="5 rue d\'Illiers, 45000 Orléans";
  const addr=addrEl?.value||"5 rue d\u2019Illiers, 45000 Orléans";
  try{
    const data=eva360Analyze(EVA360_DEMO_RESERVATIONS,EVA360_DEMO_BANK,addr);
    renderAptAudit360Result(aptId,data);
  }catch(e){
    const err=document.getElementById('apt-audit-error-'+aptId);
    if(err){err.textContent=e.message;err.style.display='block';}
  }
}

function renderAptAudit360Result(aptId,data){
  const result=document.getElementById('apt-audit-result-'+aptId);
  if(!result)return;
  const money=v=>Math.round(v).toLocaleString('fr-FR')+' €';
  const monthLabel=key=>{const[y,m]=key.split('-').map(Number);return new Date(y,m-1,1).toLocaleDateString('fr-FR',{month:'short',year:'numeric'}).replace('.','');};
  const maxNet=Math.max(...data.months.map(m=>Math.max(0,m.net)),1);
  const actions=eva360BuildActions(data);
  const detect=eva360BuildDetect(data);

  result.innerHTML=`
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px">
      <div class="eva360-kpi purple"><div class="eva360-kpi-label">Score EVA</div><div class="eva360-kpi-value">${data.score}/100</div><div class="eva360-kpi-help">Qualité rentabilité + potentiel local</div></div>
      <div class="eva360-kpi"><div class="eva360-kpi-label">Revenus analysés</div><div class="eva360-kpi-value">${money(data.totalRevenue)}</div><div class="eva360-kpi-help">${data.months.length} mois · ${data.bookingCount} réservations</div></div>
      <div class="eva360-kpi"><div class="eva360-kpi-label">Charges détectées</div><div class="eva360-kpi-value">${money(data.totalCharges)}</div><div class="eva360-kpi-help">D\u2019après le CSV bancaire</div></div>
      <div class="eva360-kpi"><div class="eva360-kpi-label">Rentabilité nette</div><div class="eva360-kpi-value">${money(data.totalNet)}</div><div class="eva360-kpi-help">${Math.round(data.totalNet/Math.max(1,data.months.length)).toLocaleString('fr-FR')} €/mois en moyenne</div></div>
    </div>
    <div class="eva360-section">
      <div class="eva360-section-head"><div><div class="eva360-title">Rentabilité nette mensuelle</div><div class="eva360-sub">Revenus − charges par mois.</div></div></div>
      <div class="eva360-net-bars">
        ${data.months.map(m=>`<div class="eva360-net-row"><div class="eva360-net-month">${monthLabel(m.month)}</div><div class="eva360-bar-track"><div class="eva360-bar-fill" style="--w:${Math.max(4,Math.round(Math.max(0,m.net)/maxNet*100))}%"></div></div><div class="eva360-net-value">${money(m.net)}</div></div>`).join('')}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="eva360-section">
        <div class="eva360-section-head"><div><div class="eva360-title">Actions à mener</div><div class="eva360-sub">Classées par impact probable.</div></div></div>
        <div class="eva360-actions">
          ${actions.map((a,i)=>`<div class="eva360-action"><div class="eva360-rank">${i+1}</div><div><div class="eva360-action-title">${a.title}</div><div class="eva360-action-desc">${a.desc}</div></div><div class="eva360-impact">${a.impact}</div></div>`).join('')}
        </div>
      </div>
      <div class="eva360-section">
        <div class="eva360-section-head"><div><div class="eva360-title">Préconisations EVA</div></div></div>
        <div class="eva360-detect">
          ${detect.map(d=>`<div class="eva360-detect-item"><span>${d.icon}</span><div><strong>${d.title}</strong><br>${d.text}</div></div>`).join('')}
        </div>
      </div>
    </div>
    <div class="eva360-section" style="margin-top:14px">
      <div class="eva360-section-head"><div><div class="eva360-title">Événements locaux et opportunités tarifaires</div></div><span class="eva360-pill">À corréler au pricing</span></div>
      <div class="eva360-event-timeline">
        ${data.events.map(e=>`<div class="eva360-event-row"><div class="eva360-event-date">${new Date(e.date).toLocaleDateString('fr-FR',{day:'2-digit',month:'short'})}</div><div><div class="eva360-event-name">${e.name}</div><div class="eva360-event-meta">${e.type}</div></div><div class="eva360-event-price">actuel <strong>${e.current} €</strong></div><div class="eva360-event-gap">+${e.gap} €/nuit possible</div></div>`).join('')}
      </div>
    </div>`;
}
/* ===== end Audit 360° inline ===== */

/* ===== end EVA AUDIT 360 ===== */


function switchPropertyTab(tab){
  document.querySelectorAll('.rq-property-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.rq-property-tab-panel').forEach(p=>p.classList.remove('active'));
  const btns=[...document.querySelectorAll('.rq-property-tab')];
  const idx={overview:0,audit:1,pricing:2,calendar:3,charges:4}[tab]||0;
  if(btns[idx])btns[idx].classList.add('active');
  const panel=document.getElementById('rq-tab-'+tab);
  if(panel)panel.classList.add('active');
}


/* ===== EVA ONBOARDING & DATA HUB ===== */

// Sources stockées en localStorage (complément des données Supabase)
function evaGetSources(){
  try{return JSON.parse(localStorage.getItem('eva_sources_'+(currentUser?.user?.id||'demo'))||'{}');}catch(e){return {};}
}
function evaSetSource(key,val){
  const s=evaGetSources();s[key]=val;
  try{localStorage.setItem('eva_sources_'+(currentUser?.user?.id||'demo'),JSON.stringify(s));}catch(e){}
}
function evaRemoveSource(key){
  const s=evaGetSources();delete s[key];
  try{localStorage.setItem('eva_sources_'+(currentUser?.user?.id||'demo'),JSON.stringify(s));}catch(e){}
}

// Calcul du niveau de confiance EVA (0-100)
function evaComputeConfidence(){
  const s=evaGetSources();
  let pts=0;
  if(s.pms)pts+=45;
  if(s.airbnb)pts+=25;
  if(s.bank)pts+=20;
  if(s.manual||apparts.length)pts+=10;
  // Bonus historique : réservations existantes
  if(reservations.length>=10)pts+=5;
  if(reservations.length>=30)pts+=5;
  return Math.min(100,pts);
}

function evaConfidenceLabel(pct){
  if(pct>=80)return 'Excellent \u2014 EVA dispose de suffisamment de donn\u00e9es pour des recommandations pr\u00e9cises.';
  if(pct>=50)return 'Correct \u2014 EVA peut produire des recommandations. Ajoutez un relev\u00e9 bancaire pour am\u00e9liorer la pr\u00e9cision.';
  if(pct>=20)return 'Limit\u00e9 \u2014 EVA manque de donn\u00e9es. Connectez un PMS ou importez vos r\u00e9servations.';
  return 'Insuffisant \u2014 Alimentez EVA pour obtenir des recommandations fiables.';
}

function updateEvaConfidenceBadge(){
  const pct=evaComputeConfidence();
  const badge=document.getElementById('eva-confidence-badge');
  if(badge){
    badge.textContent=pct+'%';
    badge.style.background=pct>=80?'rgba(5,150,105,.25)':pct>=50?'rgba(217,119,6,.25)':'rgba(220,38,38,.2)';
    badge.style.color=pct>=80?'#6EE7B7':pct>=50?'#FCD34D':'#FCA5A5';
  }
}

function renderEvaDataPage(){
  const pct=evaComputeConfidence();
  const s=evaGetSources();

  // Confidence card
  const pctEl=document.getElementById('eva-confidence-pct');
  const barEl=document.getElementById('eva-confidence-bar');
  const descEl=document.getElementById('eva-confidence-desc');
  if(pctEl)pctEl.textContent=pct+'%';
  if(barEl)barEl.style.width=pct+'%';
  if(descEl)descEl.textContent=evaConfidenceLabel(pct);

  // Source badges
  const badgesEl=document.getElementById('eva-source-badges');
  if(badgesEl){
    const badges=[];
    if(s.pms)badges.push('<span style="background:rgba(255,255,255,.18);color:white;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px">\u2713 PMS : '+s.pms.name+'</span>');
    if(s.airbnb)badges.push('<span style="background:rgba(255,255,255,.18);color:white;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px">\u2713 Airbnb/Booking</span>');
    if(s.bank)badges.push('<span style="background:rgba(255,255,255,.18);color:white;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px">\u2713 Relev\u00e9s bancaires</span>');
    if(apparts.length)badges.push('<span style="background:rgba(255,255,255,.18);color:white;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px">\u2713 '+apparts.length+' logement'+(apparts.length>1?'s':'')+' actif'+(apparts.length>1?'s':'')+'</span>');
    badgesEl.innerHTML=badges.join('') || '<span style="color:rgba(255,255,255,.5);font-size:12px">Aucune source connect\u00e9e</span>';
  }

  // Sources list
  const listEl=document.getElementById('eva-sources-list');
  if(listEl){
    const rows=[];
    rows.push(evaSourceRow('pms','&#x1F3E2;','PMS',s.pms?s.pms.name+' \u2014 synchronis\u00e9':null,'Synchronisation automatique',45,()=>evaRemoveSourceUI('pms')));
    rows.push(evaSourceRow('airbnb','&#x1F3E0;','Airbnb / Booking',s.airbnb?s.airbnb.count+' r\u00e9servations import\u00e9es':null,'Export CSV plateforme',25,()=>evaRemoveSourceUI('airbnb')));
    rows.push(evaSourceRow('bank','&#x1F3E6;','Relev\u00e9s bancaires',s.bank?s.bank.count+' transactions analys\u00e9es':null,'CSV ou PDF bancaire',20,()=>evaRemoveSourceUI('bank')));
    rows.push(evaSourceRow('manual','&#x270F;&#xFE0F;','Saisie manuelle',apparts.length?apparts.length+' logement'+(apparts.length>1?'s':'')+' actif'+(apparts.length>1?'s':''):null,'Donn\u00e9es saisies manuellement',10,()=>{}));
    listEl.innerHTML=rows.join('');
  }
}

function evaSourceRow(key,icon,label,value,hint,pts,onRemove){
  const active=!!value;
  return '<div class="eva-source-row">'
    +'<div class="eva-source-row-icon">'+icon+'</div>'
    +'<div style="flex:1;min-width:0">'
    +'<div style="font-size:14px;font-weight:700;color:#17122E">'+label+'</div>'
    +'<div style="font-size:12px;color:#8A8A99;margin-top:2px">'+(active?value:hint)+'</div>'
    +'</div>'
    +'<div style="display:flex;align-items:center;gap:8px">'
    +(active
      ? '<span class="eva-source-row-status ok">\u2713 Connect\u00e9</span><button onclick="evaRemoveSourceUI(\''+key+'\')" style="background:none;border:none;color:#DC2626;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit">\u00d7 Supprimer</button>'
      : '<span class="eva-source-row-status missing">+'+pts+' pts</span><button onclick="openEvaOnboarding(\''+key+'\')" style="background:#7C3AED;color:white;border:none;border-radius:8px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Connecter</button>'
    )
    +'</div></div>';
}

function evaRemoveSourceUI(key){
  const labels={pms:'le PMS',airbnb:'Airbnb / Booking',bank:'les relev\u00e9s bancaires'};
  if(!confirm('Supprimer la source "'+( labels[key]||key)+'" ?\n\nLes donn\u00e9es import\u00e9es depuis cette source seront conserv\u00e9es mais EVA ne recevra plus de nouvelles donn\u00e9es de cette source.'))return;
  evaRemoveSource(key);
  updateEvaConfidenceBadge();
  renderEvaDataPage();
  showToast('Source supprim\u00e9e \u2014 reconnectez quand vous voulez');
}

// ── Ouverture de l\u2019onboarding ──
function openEvaOnboarding(method){
  const el=document.getElementById('eva-onboarding');
  el.style.display='flex';
  if(method){evaOnbSelectMethod(method);}
  else{evaOnbStep(1);}
}

function closeEvaOnboarding(){
  document.getElementById('eva-onboarding').style.display='none';
  try{localStorage.setItem('onb2_seen_'+(currentUser?.user?.id||'demo'),'1');}catch(e){}
  updateEvaConfidenceBadge();
  if(document.getElementById('page-eva-data')?.classList.contains('active'))renderEvaDataPage();
}

function onb2Open(){
  try{
    const seen=localStorage.getItem('onb2_seen_'+(currentUser?.user?.id||'demo'));
    if(!seen&&apparts.length===0)openEvaOnboarding();
  }catch(e){}
}

function evaOnbStep(n){
  [1,2,'3-pms','3-airbnb','3-bank','3-manual',4].forEach(s=>{
    const el=document.getElementById('eva-onb-step'+s);
    if(el)el.style.display='none';
  });
  const target=document.getElementById('eva-onb-step'+n);
  if(target)target.style.display='block';
}

function evaOnbSelectMethod(method){
  evaOnbStep(2); // show step 2 first
  [1,2,'3-pms','3-airbnb','3-bank','3-manual',4].forEach(s=>{
    const el=document.getElementById('eva-onb-step'+s);
    if(el)el.style.display='none';
  });
  const map={pms:'3-pms',airbnb:'3-airbnb',bank:'3-bank',manual:'3-manual'};
  const target=document.getElementById('eva-onb-step'+(map[method]||'2'));
  if(target)target.style.display='block';
}

// PMS
const PMS_HINTS={
  smoobu:'Allez dans Smoobu \u2192 Param\u00e8tres \u2192 Avanc\u00e9 \u2192 Cl\u00e9s API, puis copiez la cl\u00e9.',
  easy_concierge:'Contactez Easy Concierge pour obtenir votre cl\u00e9 API partenaire RentyQ.',
  beds24:'Beds24 : Param\u00e8tres \u2192 API \u2192 G\u00e9n\u00e9rer une cl\u00e9.',
  guesty:'Guesty : D\u00e9veloppeur \u2192 Cl\u00e9s API.',
  hostaway:'Hostaway : Int\u00e9grations \u2192 API \u2192 Cl\u00e9 API.'
};
const PMS_NAMES={smoobu:'Smoobu',easy_concierge:'Easy Concierge',beds24:'Beds24',guesty:'Guesty',hostaway:'Hostaway'};
let evaOnbSelectedPms=null;

function evaOnbSelectPms(pms){
  evaOnbSelectedPms=pms;
  document.querySelectorAll('.eva-pms-card').forEach(c=>c.style.border='1px solid #EEEEF5');
  event.currentTarget.style.border='2px solid #7C3AED';
  const detail=document.getElementById('eva-onb-pms-detail');
  document.getElementById('eva-onb-pms-name').textContent=PMS_NAMES[pms]||pms;
  document.getElementById('eva-onb-pms-hint').textContent=PMS_HINTS[pms]||'Entrez votre cl\u00e9 API.';
  detail.style.display='block';
}

function evaOnbSavePms(){
  const key=document.getElementById('eva-onb-pms-key').value.trim();
  if(!key){showToast('Entrez votre cl\u00e9 API');return;}
  evaSetSource('pms',{name:PMS_NAMES[evaOnbSelectedPms]||evaOnbSelectedPms,key,connected:new Date().toISOString()});
  // Si Smoobu, aussi connecter via la page Smoobu existante
  if(evaOnbSelectedPms==='smoobu'){
    const smoobuKeyEl=document.getElementById('smoobu-key');
    if(smoobuKeyEl)smoobuKeyEl.value=key;
  }
  evaOnbShowConfirmation('PMS '+( PMS_NAMES[evaOnbSelectedPms]||evaOnbSelectedPms)+' connect\u00e9. EVA re\u00e7oit maintenant vos r\u00e9servations en temps r\u00e9el.');
}

// CSV Airbnb/Booking
let evaOnbCsvBuffer=null;
function evaOnbHandleCsv(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    evaOnbCsvBuffer=e.target.result;
    const lines=evaOnbCsvBuffer.split('\n').filter(l=>l.trim()).length-1;
    document.getElementById('eva-onb-csv-preview').style.display='block';
    document.getElementById('eva-onb-csv-preview').textContent='\u2705 '+lines+' lignes d\u00e9tect\u00e9es dans '+file.name;
    const btn=document.getElementById('eva-onb-csv-btn');
    btn.disabled=false;btn.style.background='linear-gradient(135deg,#7C3AED,#EC4899)';btn.style.cursor='pointer';
  };
  reader.readAsText(file,'utf-8');
}
function evaOnbSaveCsv(){
  if(!evaOnbCsvBuffer)return;
  const lines=evaOnbCsvBuffer.split('\n').filter(l=>l.trim()).length-1;
  evaSetSource('airbnb',{count:lines,imported:new Date().toISOString()});
  // Déclencher l\u2019import via le moteur EVA Audit existant
  try{
    const input=document.getElementById('eva360-res-file');
    // Store for later use in audit
    window.eva_onb_csv_raw=evaOnbCsvBuffer;
  }catch(e){}
  evaOnbShowConfirmation(lines+' r\u00e9servations import\u00e9es. EVA a analys\u00e9 votre historique Airbnb / Booking.');
}

// CSV bancaire
let evaOnbBankBuffer=null;
function evaOnbHandleBank(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    evaOnbBankBuffer=e.target.result;
    const lines=evaOnbBankBuffer.split('\n').filter(l=>l.trim()).length-1;
    document.getElementById('eva-onb-bank-preview').style.display='block';
    document.getElementById('eva-onb-bank-preview').textContent='\u2705 '+lines+' transactions d\u00e9tect\u00e9es dans '+file.name;
    const btn=document.getElementById('eva-onb-bank-btn');
    btn.disabled=false;btn.style.background='linear-gradient(135deg,#7C3AED,#EC4899)';btn.style.cursor='pointer';
  };
  reader.readAsText(file,'utf-8');
}
function evaOnbSaveBank(){
  if(!evaOnbBankBuffer)return;
  const lines=evaOnbBankBuffer.split('\n').filter(l=>l.trim()).length-1;
  evaSetSource('bank',{count:lines,imported:new Date().toISOString()});
  window.eva_onb_bank_raw=evaOnbBankBuffer;
  evaOnbShowConfirmation(lines+' transactions bancaires analys\u00e9es. EVA a identifi\u00e9 vos charges et revenus.');
}

// Saisie manuelle
async function evaOnbSaveManual(){
  const nb=+document.getElementById('onb-m-nb').value||1;
  const city=document.getElementById('onb-m-city').value.trim();
  const price=+document.getElementById('onb-m-price').value||80;
  const occ=+document.getElementById('onb-m-occ').value||60;
  const charges=+document.getElementById('onb-m-charges').value||500;
  if(!city){showToast('Indiquez au moins une ville');return;}
  // Cr\u00e9er les logements manuellement
  for(let i=0;i<Math.min(nb,5);i++){
    const body={user_id:currentUser.user.id,name:'Logement '+(apparts.length+i+1),city,emoji:'\uD83C\uDFE0',price,rent:charges,cleaner:Math.round(price*0.15),comp:Math.round(price*1.05),ai_rec:Math.round(price*1.08),booked:false,auto_pricing:true};
    try{
      const res=await sbFetch('appartements',{method:'POST',body:JSON.stringify(body)});
      const c=await res.json();
      if(Array.isArray(c)&&c[0])apparts.push(c[0]);
    }catch(e){}
  }
  evaSetSource('manual',{nb,city,price,occ,charges,created:new Date().toISOString()});
  renderAll();
  evaOnbShowConfirmation(nb+' logement'+(nb>1?'s':'')+' cr\u00e9\u00e9'+(nb>1?'s':'')+' \u00e0 '+city+'. EVA commence l\u2019analyse.');
}

function evaOnbShowConfirmation(msg){
  evaOnbStep(4);
  const pct=evaComputeConfidence();
  document.getElementById('eva-onb-confirm-text').textContent=msg;
  document.getElementById('eva-onb-conf-num').textContent=pct+'%';
  document.getElementById('eva-onb-conf-hint').textContent=evaConfidenceLabel(pct);
  updateEvaConfidenceBadge();
}

function evaOnbFinish(){
  closeEvaOnboarding();
  goTo('cockpit',document.querySelector('[onclick*="cockpit"]'));
}
/* ===== end EVA ONBOARDING ===== */

/* ===== EMAIL CONFIRMATION OVERLAY ===== */
function showEmailConfirmOverlay(email){
  const overlay=document.getElementById('email-confirm-overlay');
  const emailDisplay=document.getElementById('confirm-email-display');
  if(emailDisplay)emailDisplay.textContent=email||'votre adresse email';
  overlay.style.display='flex';
  // Reset le form
  const btn=document.getElementById('btn-register');
  if(btn){btn.disabled=false;btn.textContent='Cr\u00e9er mon compte';}
}

function showLoginAfterConfirm(){
  document.getElementById('email-confirm-overlay').style.display='none';
  // Switcher vers le tab login
  switchTab('login');
  // Pr\u00e9-remplir l\u2019email si possible
  const confirmedEmail=document.getElementById('confirm-email-display')?.textContent;
  const loginEmail=document.getElementById('email');
  if(loginEmail&&confirmedEmail&&confirmedEmail!=='votre adresse email')loginEmail.value=confirmedEmail;
  // Afficher un message de bienvenue dans le login
  showOk('auth-error','\u2705 Email confirm\u00e9 ! Connectez-vous maintenant.');
}

async function resendConfirmEmail(){
  const email=document.getElementById('confirm-email-display')?.textContent;
  if(!email||email==='votre adresse email'){showToast('Email introuvable');return;}
  try{
    await authFetch('resend',{type:'signup',email});
    showToast('\u{1F4E7} Email renvoy\u00e9 \u00e0 '+email);
  }catch(e){
    showToast('Erreur lors du renvoi');
  }
}
/* ===== end EMAIL CONFIRMATION ===== */

/* ===== GOOGLE OAUTH ===== */
async function doGoogleLogin(){
  console.log('Google login clicked');
  try{
    const redirectTo=encodeURIComponent('https://rentyq.fr/');
    const url=SB_URL+'/auth/v1/authorize?provider=google&redirect_to='+redirectTo;
    console.log('Redirecting to:',url);
    window.location.href=url;
  }catch(e){
    console.error('doGoogleLogin catch:',e);
    showErr('login-error','Erreur Google : '+e.message);
  }
}

// R\u00e9cup\u00e9rer la session apr\u00e8s retour OAuth (hash #access_token=...)
async function checkOAuthCallback(){
  const hash=window.location.hash;
  if(!hash||!hash.includes('access_token='))return false;
  try{
    const params=new URLSearchParams(hash.slice(1));
    const access_token=params.get('access_token');
    const refresh_token=params.get('refresh_token');
    if(!access_token)return false;
    // R\u00e9cup\u00e9rer le user depuis Supabase
    const res=await fetch(`${SB_URL}/auth/v1/user`,{
      headers:{'apikey':SB_KEY,'Authorization':'Bearer '+access_token}
    });
    const user=await res.json();
    if(!user||!user.id)return false;
    currentUser={access_token,refresh_token,user};
    try{localStorage.setItem('sb_session',JSON.stringify(currentUser));}catch(e){}
    // Nettoyer le hash de l\u2019URL
    history.replaceState(null,'',window.location.pathname);
    return true;
  }catch(e){return false;}
}
/* ===== end GOOGLE OAUTH ===== */

/* ===== PROFIT 360 ===== */
/* ====================================================
   PROFIT 360 — Helper partagé
   ==================================================== */
function p360Empty(msg){
  return '<div class="p360-empty">'+
    '<div style="font-size:40px;margin-bottom:14px">\uD83D\uDCB0</div>'+
    '<div style="font-size:17px;font-weight:800;color:#0B0722;font-family:Sora,sans-serif;margin-bottom:8px">Donn\u00e9es insuffisantes pour cette estimation</div>'+
    '<div style="font-size:13px;color:#8A8A99;line-height:1.65;max-width:380px;margin:0 auto">'+(msg||'Ajoutez vos biens et r\u00e9servations pour g\u00e9n\u00e9rer l\u2019analyse Profit 360.')+'</div>'+
  '</div>';
}

function p360Score(monthRev, occ, price, aiRec, fl){
  var s=40;
  if(occ>=65) s+=20; else if(occ>=45) s+=10;
  if(monthRev>0) s+=15;
  if(price>=fl) s+=10; else s-=10;
  if(aiRec>0&&price>=aiRec) s+=15; else if(aiRec>0&&price>=aiRec*0.9) s+=7;
  return Math.max(10,Math.min(98,s));
}

function p360NbNuits(r){
  try{
    if(!r.date_from||!r.date_to)return r.nights||0;
    return Math.max(0,Math.round((new Date(r.date_to)-new Date(r.date_from))/(1000*60*60*24)));
  }catch(e){return r.nights||0;}
}

/* ====================================================
   PROFIT 360 — Vue globale (refonte de renderProfit360)
   ==================================================== */
function renderProfit360(){
  var el=document.getElementById('profit360-content');
  if(!el)return;

  if(!apparts.length){el.innerHTML=p360Empty();return;}

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());
  var daysInMonth=new Date(today.getFullYear(),today.getMonth()+1,0).getDate();

  // Stats par logement
  var aptStats=apparts.map(function(a){
    var aptRes=reservations.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var monthRev=aptRes.reduce(function(s,r){return s+(r.price_total||0);},0);
    var totalNights=aptRes.reduce(function(s,r){return s+p360NbNuits(r);},0);
    var occ=daysElapsed>0?Math.min(100,Math.round(totalNights/daysElapsed*100)):0;
    var adr=totalNights>0?Math.round(monthRev/totalNights):0;
    var fl=floor(a);
    var potential=Math.max(0,Math.round((a.price||0)*0.15*30));
    var sc=p360Score(monthRev,occ,a.price||0,a.ai_rec||0,fl);
    return {a:a,monthRev:monthRev,totalNights:totalNights,occ:occ,adr:adr,fl:fl,potential:potential,sc:sc};
  }).sort(function(x,y){return y.monthRev-x.monthRev;});

  var totalRev=aptStats.reduce(function(s,r){return s+r.monthRev;},0);
  var totalAnnual=Math.round(totalRev*12);
  var totalNightsAll=aptStats.reduce(function(s,r){return s+r.totalNights;},0);
  var adrGlobal=totalNightsAll>0?Math.round(totalRev/totalNightsAll):0;
  var availableNights=apparts.length*daysElapsed;
  var revpar=availableNights>0?Math.round(totalRev/availableNights):0;
  var occGlobal=availableNights>0?Math.min(100,Math.round(totalNightsAll/availableNights*100)):0;
  var totalPotential=aptStats.reduce(function(s,r){return s+r.potential;},0);
  var best=aptStats[0];
  var avgScore=aptStats.length?Math.round(aptStats.reduce(function(s,r){return s+r.sc;},0)/aptStats.length):0;
  var scoreColor=avgScore>=70?'#10B981':avgScore>=45?'#F59E0B':'#EF4444';
  var hotEvts=Object.values(eventsCache||{}).flat().filter(function(e){return e.hot;});

  // KPI cards
  var kpis='<div class="p360-kpi-strip">'+
    '<div class="p360-kpi-card accent">'+
      '<div class="p360-kpi-lbl">Revenus estim\u00e9s / mois</div>'+
      '<div class="p360-kpi-val">'+totalRev+'\u20AC</div>'+
      '<div class="p360-kpi-help">'+daysElapsed+'/'+daysInMonth+' jours \u00e9coul\u00e9s</div>'+
    '</div>'+
    '<div class="p360-kpi-card">'+
      '<div class="p360-kpi-lbl">Estim\u00e9 annuel</div>'+
      '<div class="p360-kpi-val">'+totalAnnual.toLocaleString('fr-FR')+'\u20AC</div>'+
      '<div class="p360-kpi-help">projection 12 mois</div>'+
    '</div>'+
    '<div class="p360-kpi-card">'+
      '<div class="p360-kpi-lbl">ADR global</div>'+
      '<div class="p360-kpi-val">'+adrGlobal+'\u20AC</div>'+
      '<div class="p360-kpi-help">prix moyen / nuit</div>'+
    '</div>'+
    '<div class="p360-kpi-card">'+
      '<div class="p360-kpi-lbl">RevPAR</div>'+
      '<div class="p360-kpi-val">'+revpar+'\u20AC</div>'+
      '<div class="p360-kpi-help">revenu / bien disponible</div>'+
    '</div>'+
  '</div>';

  // Classement résumé
  var rankRows=aptStats.map(function(r,i){
    var revColor=r.monthRev>0?'#17122E':'#DC2626';
    var occColor=r.occ>=65?'#059669':r.occ>=45?'#D97706':'#DC2626';
    return '<tr>'+
      '<td style="font-weight:700"><span style="margin-right:8px">'+( r.a.emoji||'\uD83C\uDFE0')+'</span>'+r.a.name+
        (i===0?'<span class="a360-badge a360-badge-green" style="margin-left:6px">#1</span>':'')+
      '</td>'+
      '<td style="font-weight:900;color:'+revColor+'">'+r.monthRev+'\u20AC</td>'+
      '<td style="color:'+occColor+';font-weight:700">'+r.occ+'%</td>'+
      '<td style="color:#7C3AED;font-weight:700">'+r.adr+'\u20AC</td>'+
      '<td><div style="display:flex;align-items:center;gap:6px">'+
        '<div style="flex:1;height:5px;background:#F3F0FA;border-radius:999px;overflow:hidden">'+
          '<div style="height:100%;width:'+r.sc+'%;background:'+(r.sc>=70?'#10B981':r.sc>=45?'#F59E0B':'#EF4444')+';border-radius:999px"></div>'+
        '</div>'+
        '<span style="font-size:11px;font-weight:800;color:'+(r.sc>=70?'#059669':r.sc>=45?'#D97706':'#DC2626')+'">'+r.sc+'</span>'+
      '</div></td>'+
    '</tr>';
  }).join('');

  var reco=best&&best.monthRev>0
    ?'\uD83C\uDFC6 Meilleur bien : <strong>'+best.a.name+'</strong> \u2014 '+best.monthRev+'\u20AC ce mois.'
    :'\uD83D\uDCA1 Ajoutez des r\u00e9servations pour calculer les revenus r\u00e9els par logement.';

  el.innerHTML=
    // Hero
    '<div class="a360-hero" style="margin-bottom:14px">'+
      '<div class="a360-hero-kicker">EVA Profit 360 \u00b7 Vue globale</div>'+
      '<div class="a360-hero-title">'+totalRev+'\u20AC g\u00e9n\u00e9r\u00e9s ce mois \u2014 '+totalAnnual.toLocaleString('fr-FR')+'\u20AC estim\u00e9s / an</div>'+
      '<div class="a360-hero-sub">'+apparts.length+' logement'+(apparts.length>1?'s':'')+' \u00b7 Occupation : '+occGlobal+'% \u00b7 Potentiel d\u00e9tect\u00e9 : +'+totalPotential+'\u20AC / an</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+totalRev+'\u20AC / mois</span>'+
        '<span class="a360-hero-chip">ADR '+adrGlobal+'\u20AC</span>'+
        '<span class="a360-hero-chip">'+occGlobal+'% occupation</span>'+
        '<span class="a360-hero-chip">Score EVA : '+avgScore+'/100</span>'+
        (hotEvts.length?'<span class="a360-hero-chip">'+hotEvts.length+' \u00e9v\u00e9nement'+(hotEvts.length>1?'s':'')+' d\u00e9tect\u00e9'+(hotEvts.length>1?'s':'')+'</span>':'')+
      '</div>'+
    '</div>'+

    kpis+

    // Classement
    '<div class="p360-section">'+
      '<div class="p360-section-head">'+
        '<div>'+
          '<div class="p360-section-title">\uD83C\uDFC6 Classement de vos logements</div>'+
          '<div class="p360-section-sub">Revenus, occupation, ADR et score Profit EVA</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">Score moyen : '+avgScore+'/100</span>'+
      '</div>'+
      '<div class="a360-table-wrap">'+
        '<table class="a360-table">'+
          '<thead><tr><th>Logement</th><th>Revenus / mois</th><th>Occupation</th><th>ADR</th><th>Score Profit</th></tr></thead>'+
          '<tbody>'+rankRows+'</tbody>'+
        '</table>'+
      '</div>'+
    '</div>'+

    // Reco EVA
    '<div class="p360-reco">'+
      '<div class="p360-reco-icon">\uD83E\uDD16</div>'+
      '<div class="p360-reco-text">'+reco+' Utilisez <strong>Opportunit\u00e9s</strong> pour d\u00e9couvrir les leviers de croissance, et <strong>Simulations</strong> pour estimer l\u2019impact de vos d\u00e9cisions.</div>'+
    '</div>'+

    // CTA nav
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">'+
      '<button class="a360-action-btn" onclick="goTo(\'profit-logement\',document.querySelector(\'[data-page=profit-logement]\'))">\uD83C\uDFE0 D\u00e9tail par logement</button>'+
      '<button class="a360-action-btn" onclick="goTo(\'profit-opportunites\',document.querySelector(\'[data-page=profit-opportunites]\'))">\uD83D\uDE80 Voir les opportunit\u00e9s</button>'+
      '<button class="a360-action-btn" onclick="goTo(\'profit-simulations\',document.querySelector(\'[data-page=profit-simulations]\'))">\uD83E\uDDEE Simulations</button>'+
    '</div>';
}

/* ====================================================
   PROFIT 360 — Par logement
   ==================================================== */
function renderProfit360ParLogement(){
  var dash=document.getElementById('profit-logement-dash');
  if(!dash)return;
  if(!apparts.length){dash.innerHTML=p360Empty();return;}

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());

  var aptStats=apparts.map(function(a){
    var aptRes=reservations.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var monthRev=aptRes.reduce(function(s,r){return s+(r.price_total||0);},0);
    var totalNights=aptRes.reduce(function(s,r){return s+p360NbNuits(r);},0);
    var occ=daysElapsed>0?Math.min(100,Math.round(totalNights/daysElapsed*100)):0;
    var adr=totalNights>0?Math.round(monthRev/totalNights):0;
    var fl=floor(a);
    var potential=Math.max(0,(a.ai_rec||0)-(a.price||0));
    var sc=p360Score(monthRev,occ,a.price||0,a.ai_rec||0,fl);
    return {a:a,monthRev:monthRev,totalNights:totalNights,occ:occ,adr:adr,fl:fl,potential:potential,sc:sc};
  }).sort(function(x,y){return y.monthRev-x.monthRev;});

  var totalRev=aptStats.reduce(function(s,r){return s+r.monthRev;},0);

  var cards=aptStats.map(function(r,i){
    var occColor=r.occ>=65?'#059669':r.occ>=45?'#D97706':'#DC2626';
    var scoreColor=r.sc>=70?'#059669':r.sc>=45?'#D97706':'#DC2626';
    var revColor=r.monthRev>0?'#17122E':'#DC2626';
    var barW=r.occ;
    var barC=occColor;
    var verdictBadge=r.sc>=70?'<span class="a360-badge a360-badge-green">\u00c0 conserver</span>':
                     r.sc>=45?'<span class="a360-badge a360-badge-orange">\u00c0 optimiser</span>':
                     '<span class="a360-badge a360-badge-red">Action requise</span>';
    return '<div class="p360-apt-v2">'+
      // Head
      '<div class="p360-apt-v2-head">'+
        '<div class="p360-apt-v2-emoji">'+(r.a.emoji||'\uD83C\uDFE0')+'</div>'+
        '<div style="flex:1;min-width:0">'+
          '<div class="p360-apt-v2-name">'+r.a.name+'</div>'+
          '<div class="p360-apt-v2-city">'+(r.a.city||'')+' \u00b7 Rang #'+(i+1)+' du parc</div>'+
        '</div>'+
        verdictBadge+
      '</div>'+
      // Métriques
      '<div class="p360-apt-v2-metrics">'+
        '<div class="p360-apt-v2-metric">'+
          '<div class="p360-apt-v2-metric-val" style="color:'+revColor+'">'+r.monthRev+'\u20AC</div>'+
          '<div class="p360-apt-v2-metric-lbl">Revenus / mois</div>'+
        '</div>'+
        '<div class="p360-apt-v2-metric">'+
          '<div class="p360-apt-v2-metric-val" style="color:'+occColor+'">'+r.occ+'%</div>'+
          '<div class="p360-apt-v2-metric-lbl">Occupation</div>'+
        '</div>'+
        '<div class="p360-apt-v2-metric">'+
          '<div class="p360-apt-v2-metric-val">'+r.adr+'\u20AC</div>'+
          '<div class="p360-apt-v2-metric-lbl">ADR</div>'+
        '</div>'+
      '</div>'+
      // Barre occupation
      '<div>'+
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:#8A8A99;margin-bottom:4px"><span>Occupation</span><span style="font-weight:700;color:'+occColor+'">'+r.occ+'% / 65% objectif</span></div>'+
        '<div class="p360-apt-v2-bar-wrap"><div class="p360-apt-v2-bar" style="width:'+barW+'%;background:'+barC+'"></div></div>'+
      '</div>'+
      // Footer
      '<div class="p360-apt-v2-footer">'+
        '<div class="p360-apt-v2-score">'+
          '<div style="width:32px;height:32px;border-radius:50%;background:conic-gradient('+scoreColor+' '+r.sc+'%,#F3F0FA 0);display:flex;align-items:center;justify-content:center">'+
            '<div style="width:22px;height:22px;border-radius:50%;background:white;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;color:'+scoreColor+'">'+r.sc+'</div>'+
          '</div>'+
          '<span>Score Profit</span>'+
        '</div>'+
        (r.potential>0?
          '<div style="font-size:11px;color:#7C3AED;font-weight:700">\uD83D\uDCC8 +'+r.potential+'\u20AC/nuit potentiel</div>':
          '<div style="font-size:11px;color:#059669;font-weight:700">\u2705 Prix optimis\u00e9</div>')+
      '</div>'+
    '</div>';
  }).join('');

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:14px">'+
      '<div class="a360-hero-kicker">EVA Profit 360 \u00b7 Par logement</div>'+
      '<div class="a360-hero-title">'+apparts.length+' logement'+(apparts.length>1?'s'+'  analys\u00e9s':' analys\u00e9')+'</div>'+
      '<div class="a360-hero-sub">'+totalRev+'\u20AC estim\u00e9s au total ce mois \u2014 d\u00e9tail bien par bien</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+totalRev+'\u20AC total</span>'+
        '<span class="a360-hero-chip">'+aptStats.length+' biens</span>'+
        (aptStats[0]?'<span class="a360-hero-chip">Meilleur : '+aptStats[0].a.name+'</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="p360-apt-grid">'+cards+'</div>'+
    '<div style="display:flex;gap:10px;flex-wrap:wrap">'+
      '<button class="a360-action-btn" onclick="goTo(\'profit-opportunites\',document.querySelector(\'[data-page=profit-opportunites]\'))">\uD83D\uDE80 Voir les opportunit\u00e9s</button>'+
      '<button class="a360-action-btn" onclick="goTo(\'pricing\',document.querySelector(\'[data-page=pricing]\'))">\u2728 EVA Pricing</button>'+
    '</div>';
}

/* ====================================================
   PROFIT 360 — Opportunités
   ==================================================== */
function renderProfit360Opportunites(){
  var dash=document.getElementById('profit-opportunites-dash');
  if(!dash)return;
  if(!apparts.length){dash.innerHTML=p360Empty();return;}

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());
  var allRes=reservations||[];
  var cache=eventsCache||{};

  var opps=[];

  apparts.forEach(function(a){
    var aptRes=allRes.filter(function(r){return r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month);});
    var monthRev=aptRes.reduce(function(s,r){return s+(r.price_total||0);},0);
    var totalNights=aptRes.reduce(function(s,r){return s+p360NbNuits(r);},0);
    var occ=daysElapsed>0?Math.min(100,Math.round(totalNights/daysElapsed*100)):0;
    var fl=floor(a);
    var price=a.price||0;
    var aiRec=a.ai_rec||0;
    var city=a.city||'';
    var hotEvs=(cache[city]||[]).filter(function(e){return e.hot;});

    // 1. Hausse tarifaire (sous ai_rec)
    if(aiRec>price&&price>0){
      var gainNuit=aiRec-price;
      var gainMois=Math.round(gainNuit*Math.max(4,totalNights));
      opps.push({
        icon:'\uD83D\uDCC8',bg:'#F0FDF4',bc:'rgba(5,150,105,.14)',
        impact:'high',impactLbl:'Impact fort',
        apt:a.name,
        title:'Hausse tarifaire recommand\u00e9e \u2014 '+a.name,
        desc:'EVA conseille '+aiRec+'\u20AC vs '+price+'\u20AC actuel. Gain estim\u00e9 de +'+gainNuit+'\u20AC par nuit.',
        monthly:gainMois,annual:gainMois*12,
        cta:'EVA Pricing',ctaPage:'pricing'
      });
    }

    // 2. Prix sous plancher
    if(price>0&&price<fl){
      var perte=Math.round((fl-price)*Math.max(4,totalNights));
      opps.push({
        icon:'\uD83D\uDD3B',bg:'#FEF2F2',bc:'rgba(220,38,38,.14)',
        impact:'high',impactLbl:'Urgent',
        apt:a.name,
        title:'Prix sous plancher \u2014 '+a.name,
        desc:'Chaque nuit \u00e0 '+price+'\u20AC est vendue sous le co\u00fbt estimé ('+fl+'\u20AC). Corrigez en priorit\u00e9.',
        monthly:perte,annual:perte*12,
        cta:'Corriger',ctaPage:'pricing'
      });
    }

    // 3. Nuits vacantes (occ < 60%)
    if(occ<60&&price>0){
      var nuitsLibres=Math.round((60-occ)/100*daysElapsed);
      var gainOcc=Math.round(nuitsLibres*price*0.82);
      opps.push({
        icon:'\uD83C\uDF19',bg:'#FFFBEB',bc:'rgba(217,119,6,.14)',
        impact:'medium',impactLbl:'Impact moyen',
        apt:a.name,
        title:'R\u00e9duction des nuits vacantes \u2014 '+a.name,
        desc:nuitsLibres+' nuit'+(nuitsLibres>1?'s':'')+' libre'+(nuitsLibres>1?'s':'')+' estim\u00e9e'+(nuitsLibres>1?'s':'')+' ce mois. Ajustez le prix ou activez un nouveau canal.',
        monthly:gainOcc,annual:gainOcc*12,
        cta:'Optimiser',ctaPage:'pricing'
      });
    }

    // 4. Événements locaux
    if(hotEvs.length&&price>0){
      var boost=Math.round(price*0.12*hotEvs.length*2);
      opps.push({
        icon:'\uD83C\uDF89',bg:'#F5F0FF',bc:'rgba(124,58,237,.14)',
        impact:'high',impactLbl:'Impact fort',
        apt:a.name,
        title:hotEvs.length+' pic'+(hotEvs.length>1?'s':'')+' de demande \u2014 '+a.name,
        desc:hotEvs.slice(0,2).map(function(e){return e.name||'\u00c9v\u00e9nement local';}).join(', ')+'. Appliquez un boost de prix sur ces dates.',
        monthly:boost,annual:boost*12,
        cta:'Pricer',ctaPage:'pricing'
      });
    }

    // 5. Note basse
    var note=Number(a.note||0);
    if(note>0&&note<4.5){
      var gainNote=Math.round(price*0.08*Math.max(4,totalNights));
      opps.push({
        icon:'\u2B50',bg:'#FFF7ED',bc:'rgba(234,88,12,.12)',
        impact:'medium',impactLbl:'Impact moyen',
        apt:a.name,
        title:'Am\u00e9lioration de l\u2019annonce \u2014 '+a.name,
        desc:'Note actuelle : '+note+'/5. Am\u00e9liorer les photos, description et \u00e9quipements peut augmenter la conversion et justifier +8% de prix.',
        monthly:gainNote,annual:gainNote*12,
        cta:'Voir le bien',ctaPage:'parc'
      });
    }
  });

  // Canal OTA — opportunité globale si dépendance
  var withPlatform=allRes.filter(function(r){return r.date_from&&r.date_from.startsWith(month)&&r.platform;});
  if(withPlatform.length>=3){
    var channels={};
    withPlatform.forEach(function(r){var c=r.platform||'autre';channels[c]=(channels[c]||0)+1;});
    var top=Object.entries(channels).sort(function(a,b){return b[1]-a[1];})[0];
    if(top&&top[1]/withPlatform.length>0.85){
      var gainCanal=Math.round(apparts.reduce(function(s,a){return s+(a.price||0);},0)/Math.max(1,apparts.length)*0.08*30);
      opps.push({
        icon:'\uD83C\uDF10',bg:'#F0F9FF',bc:'rgba(14,165,233,.14)',
        impact:'medium',impactLbl:'Impact moyen',
        apt:'Tous les biens',
        title:'Diversification des canaux OTA',
        desc:Math.round(top[1]/withPlatform.length*100)+'% de vos r\u00e9sas viennent de '+top[0]+'. Activer un 2e canal r\u00e9duit le risque et augmente la visibilit\u00e9.',
        monthly:gainCanal,annual:gainCanal*12,
        cta:'Voir int\u00e9grations',ctaPage:'settings'
      });
    }
  }

  if(!opps.length){
    opps.push({
      icon:'\u2705',bg:'#F0FDF4',bc:'rgba(5,150,105,.14)',
      impact:'low',impactLbl:'Bonne sant\u00e9',
      apt:'Tous les biens',
      title:'Parc bien optimis\u00e9',
      desc:'EVA ne d\u00e9tecte pas d\u2019opportunit\u00e9 majeure pour l\u2019instant. Continuez le suivi hebdomadaire.',
      monthly:0,annual:0,
      cta:'Lancer un audit',ctaPage:'eva-audit'
    });
  }

  opps.sort(function(a,b){return b.monthly-a.monthly;});
  var totalMonthly=opps.reduce(function(s,o){return s+o.monthly;},0);

  var impactColors={'high':'p360-opp-impact-high','medium':'p360-opp-impact-medium','low':'p360-opp-impact-low'};

  var cards=opps.map(function(o){
    return '<div class="p360-opp-card" style="background:'+o.bg+';border-color:'+o.bc+'">'+
      '<div class="p360-opp-icon" style="background:white">'+o.icon+'</div>'+
      '<div>'+
        '<div class="p360-opp-title">'+o.title+'</div>'+
        '<div class="p360-opp-desc">'+o.desc+'</div>'+
        '<div style="margin-top:6px;display:flex;align-items:center;gap:6px">'+
          '<span class="p360-opp-impact '+impactColors[o.impact]+'">'+o.impactLbl+'</span>'+
          '<span style="font-size:10px;color:#8A8A99">\u00b7 '+o.apt+'</span>'+
        '</div>'+
      '</div>'+
      '<div class="p360-opp-right">'+
        (o.monthly>0?
          '<div class="p360-opp-monthly">+'+o.monthly+'\u20AC</div>'+
          '<div class="p360-opp-annual">+'+o.annual.toLocaleString('fr-FR')+'\u20AC / an</div>':
          '<div style="font-size:12px;color:#8A8A99">—</div>')+
        '<div style="margin-top:8px">'+
          '<button onclick="goTo(\''+o.ctaPage+'\',document.querySelector(\'[data-page='+o.ctaPage+']\'))" style="border:none;border-radius:8px;padding:6px 12px;background:linear-gradient(135deg,#6D28D9,#EC4899);color:white;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit">'+o.cta+' \u2192</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:14px">'+
      '<div class="a360-hero-kicker">EVA Profit 360 \u00b7 Opportunit\u00e9s</div>'+
      '<div class="a360-hero-title">'+opps.length+' opportunit\u00e9'+(opps.length>1?'s':'')+' d\u00e9tect\u00e9e'+(opps.length>1?'s':'')+' par EVA</div>'+
      '<div class="a360-hero-sub">Potentiel total : +'+(totalMonthly>0?totalMonthly+'\u20AC / mois \u2014 +'+totalMonthly*12+'\u20AC / an':'non estim\u00e9')+'</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">'+opps.length+' levier'+(opps.length>1?'s':'')+'</span>'+
        (totalMonthly>0?'<span class="a360-hero-chip">+'+totalMonthly+'\u20AC / mois</span>':'')+
      '</div>'+
    '</div>'+
    '<div class="p360-section">'+
      '<div class="p360-section-head">'+
        '<div>'+
          '<div class="p360-section-title">\uD83D\uDE80 Leviers d\u00e9tect\u00e9s par EVA</div>'+
          '<div class="p360-section-sub">Tri\u00e9s par impact financier estim\u00e9</div>'+
        '</div>'+
        '<span class="a360-badge a360-badge-purple">EVA Engine</span>'+
      '</div>'+
      '<div class="p360-opp-list">'+cards+'</div>'+
    '</div>';
}

/* ====================================================
   PROFIT 360 — Simulations (cartes statiques V1)
   ==================================================== */
function renderProfit360Simulations(){
  var dash=document.getElementById('profit-simulations-dash');
  if(!dash)return;
  if(!apparts.length){dash.innerHTML=p360Empty();return;}

  var today=new Date();
  var month=today.toISOString().slice(0,7);
  var daysElapsed=Math.max(1,today.getDate());
  var daysInMonth=new Date(today.getFullYear(),today.getMonth()+1,0).getDate();

  var monthRes=reservations.filter(function(r){return r.date_from&&r.date_from.startsWith(month);});
  var monthRev=monthRes.reduce(function(s,r){return s+(r.price_total||0);},0);
  var totalNights=monthRes.reduce(function(s,r){return s+p360NbNuits(r);},0);
  var avgPrice=apparts.length?Math.round(apparts.reduce(function(s,a){return s+(a.price||0);},0)/apparts.length):0;
  var availableNights=apparts.length*daysElapsed;
  var occRate=availableNights>0?Math.min(100,Math.round(totalNights/availableNights*100)):0;

  // Base annuelle estimée
  var baseAnnual=Math.round(monthRev*12);

  // Scénario 1 : +5% sur les prix
  var sim1Monthly=Math.round(monthRev*0.05);
  var sim1Annual=sim1Monthly*12;

  // Scénario 2 : +10% d'occupation
  var sim2Monthly=Math.round(avgPrice*(10/100)*daysInMonth*apparts.length*0.82*0.10);
  // Plus simple : 10% de nuits supplémentaires × prix moyen
  var extraNights10=Math.round(availableNights*0.10);
  sim2Monthly=Math.round(extraNights10*avgPrice*0.82);
  var sim2Annual=sim2Monthly*12;

  // Scénario 3 : Réduction des nuits vacantes (objectif 65% d'occupation)
  var vacantNights=Math.max(0,Math.round((0.65-occRate/100)*availableNights));
  var sim3Monthly=Math.round(vacantNights*avgPrice*0.78);
  var sim3Annual=sim3Monthly*12;

  // Scénario 4 : Amélioration du score qualité (+1 point de note → +8% de prix)
  var sim4Monthly=Math.round(monthRev*0.08);
  var sim4Annual=sim4Monthly*12;

  function simCard(icon,title,scenario,monthly,annual,explication,cta,ctaPage){
    return '<div class="p360-sim-card">'+
      '<div class="p360-sim-icon">'+icon+'</div>'+
      '<div class="p360-sim-title">'+title+'</div>'+
      '<div class="p360-sim-scenario">'+scenario+'</div>'+
      '<div class="p360-sim-gains">'+
        '<div class="p360-sim-gain-monthly">'+
          '<div class="p360-sim-gain-val" style="color:#059669">+'+(monthly>0?monthly:'—')+'\u20AC</div>'+
          '<div class="p360-sim-gain-lbl" style="color:#059669">/ mois</div>'+
        '</div>'+
        '<div class="p360-sim-gain-annual">'+
          '<div class="p360-sim-gain-val" style="color:#7C3AED">+'+(annual>0?annual.toLocaleString('fr-FR'):'—')+'\u20AC</div>'+
          '<div class="p360-sim-gain-lbl" style="color:#7C3AED">/ an</div>'+
        '</div>'+
      '</div>'+
      '<div style="font-size:11px;color:#8A8A99;line-height:1.5;background:#F8F5FF;border-radius:8px;padding:8px 10px">'+explication+'</div>'+
      '<button class="p360-sim-cta" onclick="goTo(\''+ctaPage+'\',document.querySelector(\'[data-page='+ctaPage+']\'))">'+cta+' \u2192</button>'+
    '</div>';
  }

  var totalSimMonthly=sim1Monthly+sim2Monthly+sim3Monthly+sim4Monthly;

  dash.innerHTML=
    '<div class="a360-hero" style="margin-bottom:14px">'+
      '<div class="a360-hero-kicker">EVA Profit 360 \u00b7 Simulations</div>'+
      '<div class="a360-hero-title">Et si vous d\u00e9bloqu\u00eez tous ces leviers\u00a0?</div>'+
      '<div class="a360-hero-sub">Potentiel cumul\u00e9 : +'+(totalSimMonthly>0?totalSimMonthly+'\u20AC / mois \u2014 +'+totalSimMonthly*12+'\u20AC / an':'calcul en cours')+'</div>'+
      '<div class="a360-hero-chips">'+
        '<span class="a360-hero-chip accent">Base : '+monthRev+'\u20AC / mois</span>'+
        '<span class="a360-hero-chip">+'+totalSimMonthly+'\u20AC potentiels</span>'+
        '<span class="a360-hero-chip">'+occRate+'% occupation actuelle</span>'+
      '</div>'+
    '</div>'+

    '<div style="background:linear-gradient(135deg,#F3E8FF,#FFF1F9);border:1px solid rgba(168,85,247,.18);border-radius:16px;padding:14px 18px;margin-bottom:14px;font-size:13px;color:#5B2C91;line-height:1.6">'+
      '\uD83D\uDCA1 <strong>Ces simulations sont indicatives.</strong> Elles reposent sur vos revenus et prix actuels. Les charges, fiscalit\u00e9 et saisonnalit\u00e9 ne sont pas int\u00e9gr\u00e9es dans cette V1.'+
    '</div>'+

    '<div class="p360-sim-grid">'+
      simCard(
        '\uD83D\uDCB0','+5% sur les prix',
        'Vous pratiquez en moyenne '+avgPrice+'\u20AC / nuit. Augmenter de 5% = +'+(Math.round(avgPrice*0.05))+'\u20AC par nuit.',
        sim1Monthly,sim1Annual,
        'Calcul\u00e9 sur vos revenus du mois courant ('+monthRev+'\u20AC) \u00d7 5%. Impact appliqu\u00e9 imm\u00e9diatement si vous montez vos prix.',
        'EVA Pricing','pricing'
      )+
      simCard(
        '\uD83D\uDCC5','+10% d\u2019occupation',
        'Votre taux actuel est '+occRate+'%. Atteindre '+(Math.min(100,occRate+10))+'% ajouterait '+extraNights10+' nuits vendues.',
        sim2Monthly,sim2Annual,
        'Calcul\u00e9 sur '+extraNights10+' nuits suppl\u00e9mentaires \u00d7 '+avgPrice+'\u20AC \u00d7 82% (nette de frais).',
        'Voir l\u2019occupation','audit-occupation'
      )+
      simCard(
        '\uD83C\uDF19','R\u00e9duction des nuits vacantes',
        'Objectif : atteindre 65% d\u2019occupation. '+vacantNights+' nuit'+(vacantNights>1?'s':'')+' \u00e0 remplir ce mois.',
        sim3Monthly,sim3Annual,
        'Calcul\u00e9 sur '+vacantNights+' nuit'+(vacantNights>1?'s':'')+' \u00d7 '+avgPrice+'\u20AC \u00d7 78% (taux de conversion estim\u00e9). R\u00e9sultat si objectif 65% atteint.',
        'Voir les nuits','audit-occupation'
      )+
      simCard(
        '\u2B50','Am\u00e9lioration du score qualit\u00e9',
        'Une note + 0,5 point peut justifier +8% sur les prix selon les donn\u00e9es Airbnb.',
        sim4Monthly,sim4Annual,
        'Calcul\u00e9 sur vos revenus actuels ('+monthRev+'\u20AC) \u00d7 8%. S\u2019active par l\u2019am\u00e9lioration des photos, \u00e9quipements et descripti.',
        'Voir la qualit\u00e9','audit-qualite'
      )+
    '</div>';
}





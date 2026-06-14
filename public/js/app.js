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
    const allApparts=await aRes.json()||[];apparts=allApparts.filter(a=>!a.archived);archivedApparts=allApparts.filter(a=>a.archived);
    try{const rRes=await sbFetch(`reservations?user_id=eq.${currentUser.user.id}&select=*&order=date_from.desc`);reservations=await rRes.json()||[];}catch(e){reservations=[];}
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
  document.getElementById('s-name').textContent=(currentProfile.name||'User').split(' ')[0];
  try{document.getElementById('m-avatar').textContent=(currentProfile.name||'U').charAt(0).toUpperCase();}catch(e){}
  document.getElementById('s-avatar').textContent=(currentProfile.name||'U').charAt(0).toUpperCase();
  document.getElementById('s-plan').textContent='Plan '+(currentProfile.plan||'Starter');
  document.getElementById('parc-badge').textContent=apparts.length;
}

function floor(a){return Math.round((a.rent||0)/30+(a.cleaner||0))}

function renderAll(){
  try{renderKPIs();}catch(e){console.warn('renderKPIs',e);}
  try{renderCockpitTable();}catch(e){console.warn('renderCockpitTable',e);}
  try{renderParcTable();}catch(e){console.warn('renderParcTable',e);}
  try{renderResTable();}catch(e){console.warn('renderResTable',e);}
  try{renderPricingTable();}catch(e){console.warn('renderPricingTable',e);}
  document.getElementById('parc-badge').textContent=apparts.length;
  document.getElementById('parc-sub').textContent=apparts.length+' appartement'+(apparts.length>1?'s':'');
  document.getElementById('res-sub').textContent=reservations.length+' réservation'+(reservations.length>1?'s':'');
  if(smoobuConnected){document.getElementById('btn-sync').style.display='inline-flex';}
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
  const dash=document.getElementById('cockpit-dash');if(!dash)return;
  const apts=apparts||[];
  const month=new Date().toISOString().slice(0,7);
  const monthRes=reservations.filter(r=>r.date_from&&r.date_from.startsWith(month));
  const monthRev=monthRes.reduce((s,r)=>s+(r.price_total||0),0);
  const hotEvents=Object.values(eventsCache||{}).flat().filter(e=>e.hot);
  const free=apts.filter(a=>!a.booked);

  // ── Calcul du potentiel annuel EVA ──
  const annualPotential=apts.reduce((sum,a)=>{
    const city=a.city||'';
    const cityEvs=eventsCache[city]||[];
    const hotEvs=cityEvs.filter(e=>e.hot);
    const basePrice=Number(a.price||0);
    const fl=floor(a);
    // Nuits libres estimées × écart de prix
    const freePotential=Math.max(0,Math.round(basePrice*0.15*30));
    const eventPotential=hotEvs.length?Math.round(hotEvs.length*(basePrice*0.12)*3):0;
    return sum+freePotential+eventPotential;
  },0);
  const annualFmt=annualPotential>=1000?(Math.round(annualPotential/100)*100).toLocaleString('fr-FR'):annualPotential;

  // ── Génération des 3 priorités ──
  const priorities=[];
  // Priorité 1 : biens avec événement chaud → monter les prix
  const aptsWithHotEvent=apts.filter(a=>{
    const city=a.city||'';
    return (eventsCache[city]||[]).some(e=>e.hot);
  });
  if(aptsWithHotEvent.length){
    const gain=aptsWithHotEvent.reduce((s,a)=>{
      const city=a.city||'';
      const ev=(eventsCache[city]||[]).find(e=>e.hot);
      return s+Math.round((Number(a.price||0))*(ev?.boost||10)/100)*3;
    },0);
    priorities.push({
      icon:'🔥',
      color:'#FF6B35',
      bg:'#FFF3EE',
      border:'rgba(255,107,53,.18)',
      title:`Augmenter les prix sur ${aptsWithHotEvent.length} bien${aptsWithHotEvent.length>1?'s':''}`,
      desc:`${aptsWithHotEvent.map(a=>a.name).join(', ')} — événement local détecté`,
      gain:`+${gain}€ estimés`,
      action:"goTo('pricing',document.querySelector('[onclick*=pricing]'))",
      btn:'Pricer'
    });
  }
  // Priorité 2 : biens libres ce soir → sous-performance
  if(free.length){
    const lostRev=free.reduce((s,a)=>s+Math.round(Number(a.price||0)*0.82),0);
    priorities.push({
      icon:'⚠️',
      color:'#DC2626',
      bg:'#FEF2F2',
      border:'rgba(220,38,38,.18)',
      title:`${free.length} bien${free.length>1?'s':''} libre${free.length>1?'s':''} ce soir`,
      desc:`${free.map(a=>a.name).join(', ')} — aucune réservation ce soir`,
      gain:`${lostRev}€ en jeu`,
      action:"goTo('pricing',document.querySelector('[onclick*=pricing]'))",
      btn:'Agir'
    });
  }
  // Priorité 3 : événements à venir non encore pricés
  if(hotEvents.length){
    priorities.push({
      icon:'🎉',
      color:'#7C3AED',
      bg:'#F5F0FF',
      border:'rgba(124,58,237,.18)',
      title:`${hotEvents.length} opportunité${hotEvents.length>1?'s':''} de revenus détectée${hotEvents.length>1?'s':''}`,
      desc:'EVA a détecté des pics de demande locale — appliquer les prix conseillés pour capter ces revenus',
      gain:`Opportunité de hausse`,
      action:"goTo('pricing',document.querySelector('[onclick*=pricing]'))",
      btn:'Voir'
    });
  }
  // Si rien d\u2019urgent
  if(!priorities.length){
    priorities.push({
      icon:'✅',
      color:'#059669',
      bg:'#ECFDF5',
      border:'rgba(5,150,105,.18)',
      title:'Situation saine',
      desc:'Tous vos biens sont correctement pilotés. Relancez un audit mensuel.',
      gain:'',
      action:"goTo('eva-audit',document.querySelector('[onclick*=eva-audit]'))",
      btn:'Audit'
    });
  }

  // Compléter à 3 priorités si besoin
  if(apts.length&&priorities.length<3){
    priorities.push({
      icon:'📊',
      color:'#6B3FA0',
      bg:'#F5F0FF',
      border:'rgba(107,63,160,.18)',
      title:'Lancer l\u2019audit mensuel',
      desc:'Comprenez ce que chaque bien rapporte vraiment après charges.',
      gain:'',
      action:"goTo('eva-audit',document.querySelector('[onclick*=eva-audit]'))",
      btn:'Lancer'
    });
  }

  const prioritiesHtml=priorities.slice(0,3).map((p,i)=>`
    <div style="display:grid;grid-template-columns:44px 1fr auto;gap:14px;align-items:center;background:${p.bg};border:1px solid ${p.border};border-radius:18px;padding:16px">
      <div style="width:44px;height:44px;border-radius:14px;background:white;display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 4px 12px rgba(0,0,0,.06)">${p.icon}</div>
      <div>
        <div style="font-size:14px;font-weight:800;color:#17122E;margin-bottom:3px">${i+1}. ${p.title}</div>
        <div style="font-size:12px;color:#7B708F;line-height:1.4">${p.desc}</div>
        ${p.gain?`<div style="font-size:12px;font-weight:900;color:${p.color};margin-top:4px">${p.gain}</div>`:''}
      </div>
      <button onclick="${p.action}" style="border:none;border-radius:10px;padding:8px 14px;background:${p.color};color:white;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap">${p.btn}</button>
    </div>`).join('');

  dash.innerHTML=`
    <!-- Hero EVA -->
    <div style="background:linear-gradient(135deg,#211051 0%,#7C3AED 46%,#EC4899 100%);border-radius:24px;padding:28px;margin-bottom:16px;color:#fff;position:relative;overflow:hidden">
      <div style="position:absolute;right:-80px;top:-90px;width:320px;height:320px;background:radial-gradient(circle,rgba(255,255,255,.18),transparent 62%);pointer-events:none"></div>
      <div style="position:relative;z-index:1">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:900;color:rgba(255,255,255,.65);margin-bottom:10px">EVA Engine · ${new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})}</div>
        <div style="font-size:clamp(22px,3vw,32px);font-weight:950;letter-spacing:-.8px;line-height:1.1;margin-bottom:8px">EVA a trouvé <span style="color:#FCD34D">${annualFmt} €</span><br>de potentiel cette année.</div>
        <div style="font-size:14px;color:rgba(255,255,255,.75);margin-bottom:20px">Sur ${apts.length} logement${apts.length>1?'s':''} · ${hotEvents.length} événement${hotEvents.length>1?'s':''} détecté${hotEvents.length>1?'s':''} · ${free.length} nuit${free.length>1?'s':''} libre${free.length>1?'s':''} ce soir</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button onclick="goTo('pricing',document.querySelector('[onclick*=pricing]'))" style="border:none;border-radius:12px;padding:10px 18px;background:white;color:#7C3AED;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit">🧠 EVA Pricing</button>
          <button onclick="goTo('eva-audit',document.querySelector('[onclick*=eva-audit]'))" style="border:none;border-radius:12px;padding:10px 18px;background:rgba(255,255,255,.15);color:white;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit;border:1px solid rgba(255,255,255,.25)">📊 Lancer l\u2019audit</button>
        </div>
      </div>
    </div>

    <!-- Les 3 priorités -->
    <div style="background:white;border:1px solid rgba(139,92,246,.14);border-radius:22px;padding:20px;margin-bottom:16px;box-shadow:0 14px 40px rgba(69,39,120,.06)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div>
          <div style="font-size:18px;font-weight:950;color:#17122E;letter-spacing:-.3px">Les 3 priorités du jour</div>
          <div style="font-size:12px;color:#8A8A99;margin-top:3px">Ce que EVA recommande de faire maintenant</div>
        </div>
        <span style="font-size:11px;font-weight:900;background:#F3E8FF;color:#7C3AED;border-radius:999px;padding:4px 10px">EVA Engine</span>
      </div>
      <div style="display:grid;gap:10px">${prioritiesHtml}</div>
    </div>

    <!-- 3 KPIs essentiels seulement -->
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
      <div style="background:white;border:1px solid rgba(139,92,246,.14);border-radius:18px;padding:16px;box-shadow:0 8px 24px rgba(69,39,120,.05)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:900;margin-bottom:8px">Revenus ce mois</div>
        <div style="font-size:28px;font-weight:950;color:#17122E;letter-spacing:-.8px">${monthRev}€</div>
        <div style="font-size:12px;color:#7B708F;margin-top:6px">${monthRes.length} réservation${monthRes.length>1?'s':''}</div>
      </div>
      <div style="background:white;border:1px solid rgba(139,92,246,.14);border-radius:18px;padding:16px;box-shadow:0 8px 24px rgba(69,39,120,.05)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:900;margin-bottom:8px">État ce soir</div>
        <div style="font-size:28px;font-weight:950;color:${free.length?'#DC2626':'#059669'};letter-spacing:-.8px">${apts.length-free.length}/${apts.length}</div>
        <div style="font-size:12px;color:#7B708F;margin-top:6px">${free.length?free.length+' libre'+(free.length>1?'s':''):'Tout loué ✓'}</div>
      </div>
      <div style="background:white;border:1px solid rgba(139,92,246,.14);border-radius:18px;padding:16px;box-shadow:0 8px 24px rgba(69,39,120,.05)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#8A8A99;font-weight:900;margin-bottom:8px">Opportunités EVA</div>
        <div style="font-size:28px;font-weight:950;color:${hotEvents.length?'#D97706':'#17122E'};letter-spacing:-.8px">${hotEvents.length}</div>
        <div style="font-size:12px;color:#7B708F;margin-top:6px">${hotEvents.length?hotEvents.length+' signal'+( hotEvents.length>1?'s':'')+' EVA':'Aucune cette semaine'}</div>
      </div>
    </div>`;
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
    const rev=aptRes.reduce((s,r)=>s+(r.price_total||0),0);
    const totalFixes=aptCharges.filter(c=>c.type==='fixe').reduce((s,c)=>s+(c.amount||0),0);
    const totalVars=aptCharges.filter(c=>c.type==='variable'&&c.category!=='commission_plateforme').reduce((s,c)=>s+(c.amount||0),0)*(aptRes.length||1);
    const commPct=aptCharges.find(c=>c.category==='commission_plateforme')?.amount||0;
    const net=rev-totalFixes-totalVars-Math.round(rev*commPct/100);
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
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:12px">
        <div style="min-width:0;flex:1">
          <div style="font-size:14px;font-weight:700;color:#17122E;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.emoji||'🏠'} ${a.name}</div>
          <div style="font-size:12px;color:#8A8A99;margin-top:2px">${a.city||''}</div>
        </div>
        <div style="flex-shrink:0;background:${evaScoreBg};border-radius:8px;padding:4px 8px;text-align:center">
          <div style="font-size:9px;font-weight:800;color:${evaScoreColor};text-transform:uppercase;letter-spacing:.5px">EVA</div>
          <div style="font-size:17px;font-weight:900;color:${evaScoreColor};line-height:1.1;letter-spacing:-.5px">${evaScore}</div>
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
        <button onclick="event.stopPropagation();showApartDetail('${a.id}')" style="background:#534AB7;color:white;border:none;border-radius:8px;padding:7px 13px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0">Voir</button>
      </div>

    </div>`;
  }).join('');

  document.getElementById('parc-sub').textContent=apparts.length+' appartement'+(apparts.length>1?'s':'');
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
  const rev=monthRes.reduce((s,r)=>s+(+r.price_total||0),0);
  const aptCharges=chargesData.filter(c=>String(c.appartement_id)===String(a.id));
  const totalFixes=aptCharges.filter(c=>c.type==='fixe').reduce((s,c)=>s+(+c.amount||0),0);
  const totalVars=aptCharges.filter(c=>c.type==='variable'&&c.category!=='commission_plateforme').reduce((s,c)=>s+(+c.amount||0),0)*(monthRes.length||1);
  const commPct=aptCharges.find(c=>c.category==='commission_plateforme')?.amount||0;
  const commissions=Math.round(rev*(+commPct||0)/100);
  const charges=totalFixes+totalVars+commissions;
  const net=rev-charges;
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

  let score=55;
  score+=Math.min(25,Math.round(occ14*.25));
  if(net>0)score+=12;else if(net<0)score-=12;
  if(note!=='—'&&+note>=4.5)score+=8;else if(note!=='—'&&+note<4)score-=10;
  if(!freeTonight)score+=8;else score-=14;
  if(pendingM.length)score+=5;else score-=5;
  if(hotEvs.length)score+=4;
  score=Math.max(8,Math.min(98,score));
  const healthClass=score<50?'danger':score<75?'warn':'';
  const healthLabel=score<50?'Action urgente':score<75?'À surveiller':'Bonne santé';
  const healthText=score<50?'Ce bien peut récupérer du revenu rapidement.':score<75?'Quelques actions peuvent améliorer la performance.':'Le bien est correctement piloté.';

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

  const actions=[];
  if(freeTonight)actions.push({type:'urgent',icon:'🚨',title:`Sauver la nuit de ce soir`,desc:`Prix conseillé ${recoPrice}€ au lieu de ${basePrice}€ pour éviter une nuit vide.`,btn:'Appliquer',rec:recoPrice});
  if(lostNights72>0&&!freeTonight)actions.push({type:'urgent',icon:'⏱️',title:`${lostNights72} nuit${lostNights72>1?'s':''} à sauver sous 72h`,desc:`Baisser légèrement maintenant pour favoriser le remplissage.`,btn:'Appliquer',rec:recoPrice});
  if(occ14<50)actions.push({type:'warn',icon:'📉',title:`Occupation à ${occ14}%`,desc:`Le bien manque de réservations sur les 14 prochains jours. Priorité au remplissage.`,btn:'Voir pricing',rec:recoPrice});
  if(hotEvs.length)actions.push({type:'warn',icon:'🎉',title:`Événement local : ${hotEvs[0].name.slice(0,28)}…`,desc:`Hausse possible de ${hotEvs[0].boost||10}% sur les dates concernées.`,btn:'Appliquer',rec:Math.max(recoPrice,Math.round(basePrice*(1+(hotEvs[0].boost||10)/100)))});
  if(note!=='—'&&+note<4)actions.push({type:'urgent',icon:'⭐',title:`Note Airbnb basse : ${note}/5`,desc:`Contrôler ménage, photos ou annonce avant d\u2019augmenter les prix.`,btn:'Modifier',edit:true});
  if(!pendingM.length)actions.push({type:'warn',icon:'🧹',title:'Aucun ménage prévu',desc:'Créer une mission CleanyQ pour sécuriser l\u2019exploitation.',btn:'Créer',mission:true});
  if(!actions.length)actions.push({type:'',icon:'✅',title:'Aucune action urgente',desc:'Le bien est correctement piloté pour les prochains jours.',btn:'Modifier',edit:true});
  const actionsHtml=actions.slice(0,5).map(x=>`<div class="rq-action-v2 ${x.type}"><div class="rq-action-icon">${x.icon}</div><div><div class="rq-action-title">${esc(x.title)}</div><div class="rq-action-desc">${esc(x.desc)}</div></div><button class="rq-button-secondary" onclick="${x.mission?'openMissionModal()':x.edit?`openEdit('${a.id}')`:`applyAI('${a.id}',${x.rec||recoPrice})`}">${esc(x.btn)}</button></div>`).join('');

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
            <div style="width:110px;height:110px;border-radius:50%;background:conic-gradient(${score>=75?'#10B981':score>=50?'#F59E0B':'#EF4444'} ${score}%,rgba(255,255,255,.18) 0);display:flex;align-items:center;justify-content:center;padding:8px;margin:0 auto 6px">
              <div style="width:100%;height:100%;border-radius:50%;background:linear-gradient(135deg,rgba(36,16,92,.97),rgba(124,58,237,.74));display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.18)">
                <div style="font-size:34px;font-weight:950;letter-spacing:-1px;color:#fff;line-height:1">${score}</div>
                <div style="font-size:9px;text-transform:uppercase;letter-spacing:.8px;font-weight:900;color:rgba(255,255,255,.65);margin-top:4px">EVA Score</div>
              </div>
            </div>
            <div style="font-size:10px;color:rgba(255,255,255,.55);font-weight:700">${score>=75?'Bien performant':score>=50?'À optimiser':'Action requise'}</div>
            <div style="font-size:9px;color:rgba(255,255,255,.35);margin-top:2px">EVA Engine · temps réel</div>
          </div>
        </div>
        <div class="rq-hero-kpis">
          <div class="rq-hero-kpi"><div class="rq-hero-kpi-label">Net ce mois</div><div class="rq-hero-kpi-value">${net>=0?'+':''}${net}€</div><div class="rq-hero-kpi-sub">CA ${rev}€ · charges ${charges}€</div></div>
          <div class="rq-hero-kpi"><div class="rq-hero-kpi-label">Occupation 14j</div><div class="rq-hero-kpi-value">${occ14}%</div><div class="rq-hero-kpi-sub">${14-free14}/14 nuits réservées</div></div>
          <div class="rq-hero-kpi"><div class="rq-hero-kpi-label">Revenu à récupérer</div><div class="rq-hero-kpi-value">${potential}€</div><div class="rq-hero-kpi-sub">sur nuits libres proches</div></div>
          <div class="rq-hero-kpi"><div class="rq-hero-kpi-label">Actions</div><div class="rq-hero-kpi-value">${actions.filter(x=>x.type).length}</div><div class="rq-hero-kpi-sub">priorités opérationnelles</div></div>
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
      <section class="rq-reco-card ${recoClass}">
        <div class="rq-reco-main"><div><div class="rq-reco-kicker">🎯 EVA recommande</div><div class="rq-reco-title">${esc(recoTitle)}</div></div><div class="rq-reco-price">${recoPrice}€<br><span>prix conseillé</span></div></div>
        <div class="rq-reason-list">${recoReasons.slice(0,4).map(r=>`<div class="rq-reason-item"><b>${esc(r[0])}</b><br>${esc(r[1])}</div>`).join('')}</div>
        <div class="rq-reco-footer"><span class="rq-impact-pill">💰 ${esc(impactText)}</span><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="rq-button-primary" onclick="applyAI('${a.id}',${recoPrice})">Appliquer ${recoPrice}€</button><button class="rq-button-secondary" onclick="openEdit('${a.id}')">Ajuster</button></div></div>
      </section>

      <div class="rq-detail-grid">
        <div style="display:flex;flex-direction:column;gap:16px">
          <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">📅 7 prochaines nuits</div><div class="rq-card-sub-v2">Cliquez une nuit libre pour appliquer son prix conseillé.</div></div><span class="rq-health-badge ${freeTonight?'danger':(free14>4?'warn':'')}" style="color:#17122E;background:#F8F4FF"><span class="rq-health-dot"></span>${free14} libres / 14j</span></div><div class="rq-nights-grid">${nightsHtml}</div></section>
          <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">🎯 Actions du jour</div><div class="rq-card-sub-v2">Priorité au remplissage : une nuit vide rapporte 0€.</div></div></div><div class="rq-actions-list">${actionsHtml}</div></section>
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

      <section class="rq-card-v2"><div class="rq-card-head-v2"><div><div class="rq-card-title-v2">⚙️ Modifier / compléter le bien</div><div class="rq-card-sub-v2">Accès rapide aux réglages importants.</div></div></div><div class="rq-edit-panel"><div class="rq-edit-tile" onclick="openEdit('${a.id}')"><div class="rq-edit-icon">🏠</div><div class="rq-edit-title">Informations</div><div class="rq-edit-sub">Nom, ville, adresse, emoji.</div></div><div class="rq-edit-tile" onclick="openEdit('${a.id}')"><div class="rq-edit-icon">💸</div><div class="rq-edit-title">Pricing</div><div class="rq-edit-sub">Prix actuel, plancher, dégressif.</div></div><div class="rq-edit-tile" onclick="openMissionModal()"><div class="rq-edit-icon">🧹</div><div class="rq-edit-title">Ménage</div><div class="rq-edit-sub">Créer une mission CleanyQ.</div></div><div class="rq-edit-tile" onclick="goTo('smoobu',document.querySelectorAll('.nav-item')[6])"><div class="rq-edit-icon">🔗</div><div class="rq-edit-title">Synchronisation</div><div class="rq-edit-sub">Smoobu, réservations, prix.</div></div></div></section>
    </div>`;
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
function goTo(page,btn){
  closeSidebarMobile();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  if(btn)btn.classList.add('active');
  if(page==='calendrier'){renderCalendarPage();renderCalendar();}
  if(page==='reservations')renderReservationsPage();
  if(page==='parc'){try{renderParcTable();}catch(e){console.warn('renderParcTable',e);}}
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
  if(page==='eva-audit'){if(typeof renderEvaAuditPage==='function')renderEvaAuditPage();}
}

/* ====================================================
   SCANNER EVA — expérience 3 phases
   Phase 1 : Hero  |  Phase 2 : Wizard  |  Phase 3 : Rapport
   ==================================================== */

const SCANNER_STEPS=[
  {id:'address',question:'Où se situe le bien ?',type:'address',placeholder:'Ex : 12 rue Bannier, 45000 Orléans'},
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
  {id:'loyer',question:'Quel est le loyer mensuel du logement ?',type:'number',placeholder:'Ex : 950',suffix:'€ / mois'},
  {id:'standing',question:'Comment qualifieriez-vous le standing du logement ?',type:'choice',choices:[
    {val:'eco',label:'Économique',icon:'💰',desc:'Fonctionnel, accessible, prix attractif'},
    {val:'std',label:'Standard',icon:'⭐',desc:'Bon niveau, équipements complets'},
    {val:'prem',label:'Premium',icon:'💎',desc:'Haut de gamme, expérience soignée'}
  ]}
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

function scannerPrevStep(){
  if(scannerStep>0){scannerStep--;renderScannerStep();}
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
    'EVA analyse le quartier\u2026',
    'EVA étudie les événements locaux\u2026',
    'EVA compare les logements similaires\u2026',
    'EVA estime le potentiel réel\u2026',
    'EVA calcule votre EVA Score\u2026'
  ];
  analysisEl.innerHTML=`<div class="scn-analysis-card">
    <div class="scn-analysis-icon">🧠</div>
    <div class="scn-analysis-title">EVA analyse votre bien</div>
    <div class="scn-analysis-sub">Cela prend quelques instants — EVA croise plusieurs sources de données.</div>
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
      setTimeout(scannerShowReport,700);
    }
  },1100);
  // Lance le vrai moteur en arrière-plan
  const lat=document.getElementById('scanner-free-lat')?.value;
  const lng=document.getElementById('scanner-free-lng')?.value;
  if(lat&&lng)try{runEvaScannerFree();}catch(e){console.warn('scanner bg',e);}
}

function scannerShowReport(){
  document.getElementById('scn-analysis').style.display='none';
  const rep=document.getElementById('scn-report');
  rep.style.display='block';
  const loyer=scannerData.loyer||900;
  const standing=scannerData.standing||'std';
  const voyageurs=+(scannerData.voyageurs||4);
  const chambres=+(scannerData.chambres||1);
  const basePrice=standing==='prem'?140:standing==='std'?95:65;
  const adjPrice=basePrice+voyageurs*4+chambres*8;
  const annual=Math.round(adjPrice*0.72*365*0.68/100)*100;
  const netYield=Math.round((annual-loyer*12)/((loyer*12)*(standing==='prem'?18:14))*1000)/10;
  const score=Math.min(98,Math.round(62+voyageurs*2+chambres*3+(standing==='prem'?18:standing==='std'?8:0)));
  const dashArr=Math.round(score*2.639);
  const v=score>=80
    ?{icon:'✅',label:'À saisir',color:'#059669',bg:'#ECFDF5',border:'#BBF7D0'}
    :score>=65
    ?{icon:'⚠️',label:'À négocier',color:'#D97706',bg:'#FFFBEB',border:'#FDE68A'}
    :{icon:'❌',label:'À éviter',color:'#DC2626',bg:'#FEF2F2',border:'#FECACA'};
  rep.innerHTML=`<div class="scn-report">
    <div class="scn-report-header">
      <div class="scn-report-address">📍 ${scannerData.address||'Bien analysé'}</div>
      <button class="scn-reset" onclick="renderScannerPage()"><i class="ti ti-refresh"></i> Nouvelle analyse</button>
    </div>
    <div class="scn-report-hero">
      <div class="scn-score-ring">
        <svg viewBox="0 0 100 100" width="130" height="130">
          <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="10"/>
          <circle cx="50" cy="50" r="42" fill="none" stroke="white" stroke-width="10"
            stroke-dasharray="${dashArr} 264" stroke-linecap="round" transform="rotate(-90 50 50)"/>
        </svg>
        <div class="scn-score-inner">
          <div class="scn-score-num">${score}</div>
          <div class="scn-score-lbl">EVA Score</div>
        </div>
      </div>
      <div class="scn-report-kpis">
        <div class="scn-kpi">
          <div class="scn-kpi-label">Verdict EVA</div>
          <div class="scn-kpi-verdict" style="color:${v.color};background:${v.bg};border:1px solid ${v.border}">${v.icon} ${v.label}</div>
        </div>
        <div class="scn-kpi">
          <div class="scn-kpi-label">Prix conseillé</div>
          <div class="scn-kpi-value">${adjPrice} €<span class="scn-kpi-unit"> /nuit</span></div>
        </div>
        <div class="scn-kpi">
          <div class="scn-kpi-label">Potentiel annuel estimé</div>
          <div class="scn-kpi-value">${annual.toLocaleString('fr-FR')} €</div>
        </div>
        <div class="scn-kpi">
          <div class="scn-kpi-label">Rentabilité nette estimée</div>
          <div class="scn-kpi-value">${netYield} %</div>
        </div>
      </div>
    </div>
    <div class="scn-why">
      <div class="scn-why-title">Pourquoi ce score ?</div>
      <div class="scn-why-grid">
        <div class="scn-why-item scn-why-ok"><i class="ti ti-check"></i> Forte demande le week-end</div>
        <div class="scn-why-item scn-why-ok"><i class="ti ti-check"></i> Événements récurrents à proximité</div>
        <div class="scn-why-item scn-why-ok"><i class="ti ti-check"></i> Faible concurrence ${standing==='prem'?'ultra-':''}premium</div>
        ${voyageurs>=6?'<div class="scn-why-item scn-why-ok"><i class="ti ti-check"></i> Capacité d\'accueil compétitive</div>':''}
        <div class="scn-why-item scn-why-warn"><i class="ti ti-alert-triangle"></i> Saisonnalité marquée en janvier</div>
        ${netYield<10?'<div class="scn-why-item scn-why-warn"><i class="ti ti-alert-triangle"></i> Loyer à surveiller par rapport au CA</div>':''}
      </div>
    </div>
    <div class="scn-reco-block">
      <div class="scn-reco-icon">🤖</div>
      <div class="scn-reco-text">
        <strong>EVA estime</strong> que ce logement présente ${score>=80?'un fort potentiel':'un potentiel modéré'} pour une activité de location courte durée.
        Le loyer représente ${Math.round(loyer*12/annual*100)} % du chiffre d'affaires potentiel.
        ${netYield>=12?' La rentabilité nette estimée est attractive dans les conditions actuelles du marché.':' Une renégociation du loyer améliorerait significativement la rentabilité.'}
      </div>
    </div>
    <div class="scn-report-actions">
      <button class="btn btn-purple" onclick="showToast('Fonctionnalité disponible en version finale.')">
        <i class="ti ti-building-plus"></i> Ajouter ce bien à mon parc
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
  // Show switcher only if both modules active
  const switcher=document.getElementById('mode-switcher');
  const hasBoth=userModules.includes('solo')&&userModules.includes('concierge');
  if(switcher)switcher.style.display=hasBoth?'flex':'none';
  // If only concierge, auto switch
  if(userModules.includes('concierge')&&!userModules.includes('solo'))switchMode('concierge');
  else if(!userModules.includes('concierge')&&userModules.includes('solo'))switchMode('solo');
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
    const rev=revTx.reduce((s,t)=>s+Math.abs(t.amount),0)||aptRes.reduce((s,r)=>s+(r.price_total||0),0);
    const totalFixes=ac.filter(c=>c.type==='fixe').reduce((s,c)=>s+(c.amount||0),0);
    const totalVarsUnit=ac.filter(c=>c.type==='variable'&&c.category!=='commission_plateforme').reduce((s,c)=>s+(c.amount||0),0);
    const commPct=ac.find(c=>c.category==='commission_plateforme')?.amount||0;
    const totalVars=totalVarsUnit*(nbRes||1);
    const commAmount=Math.round(rev*commPct/100);
    const charges=totalFixes+totalVars+commAmount;
    const net=rev-charges;
    const marge=rev>0?Math.round(net/rev*100):0;
    const proprio=isConcierge?proprietaires.find(p=>p.id===a.proprietaire_id):null;
    const concComm=proprio?Math.round(rev*(proprio.commission||20)/100):0;

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
          <span style="color:#8A8A99">Charges variables (${d.nbRes} résa${d.nbRes>1?'s':''})</span>
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
  apparts.forEach(a=>{const ac=chargesData.filter(c=>c.appartement_id===a.id);totalFixesMensuel+=ac.filter(c=>c.type==='fixe').reduce((s,c)=>s+(c.amount||0),0);totalVarParRes+=ac.filter(c=>c.type==='variable'&&c.category!=='commission_plateforme').reduce((s,c)=>s+(c.amount||0),0);commPctMoy+=ac.find(c=>c.category==='commission_plateforme')?.amount||0;prixMoyenNuit+=a.price||0;});
  prixMoyenNuit=nbApparts?Math.round(prixMoyenNuit/nbApparts):90;commPctMoy=nbApparts?Math.round(commPctMoy/nbApparts):3;
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
  try{
    // Supabase OAuth Google — redirige vers Google puis revient sur l\u2019URL actuelle
    const redirectTo=window.location.origin+window.location.pathname;
    const res=await fetch(`${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`,{
      method:'GET',
      headers:{'apikey':SB_KEY}
    });
    if(res.url&&res.url.includes('accounts.google.com')){
      window.location.href=res.url;
    } else {
      // Fallback : ouvrir directement l\u2019URL OAuth Supabase
      window.location.href=`${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
    }
  }catch(e){
    showErr('login-error','Connexion Google indisponible. Utilisez votre email et mot de passe.');
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
function renderProfit360(){
  const el=document.getElementById('profit360-content');if(!el)return;
  const sources=typeof evaGetSources==='function'?evaGetSources():{};

  if(!apparts.length){
    el.innerHTML=`<div class="p360-empty">
      <div style="font-size:40px;margin-bottom:14px">📊</div>
      <div style="font-size:18px;font-weight:800;color:#0B0722;font-family:Sora,sans-serif;margin-bottom:8px">Ajoutez des biens à votre parc</div>
      <div style="font-size:13px;color:#8A8A99;line-height:1.65">EVA analysera la rentabilité réelle de chaque logement.</div>
    </div>`;
    return;
  }

  // ── Calculs par logement ──
  const month=new Date().toISOString().slice(0,7);
  const aptStats=apparts.map(a=>{
    const charges=chargesData.filter(c=>c.appartement_id===a.id);
    const fixedMonthly=charges.filter(c=>c.type==='fixe').reduce((s,c)=>s+(c.amount||0),0);
    const varPerRes=charges.filter(c=>c.type==='variable'&&c.category!=='commission_plateforme').reduce((s,c)=>s+(c.amount||0),0);
    const commPct=charges.find(c=>c.category==='commission_plateforme')?.amount||3;
    const aptRes=reservations.filter(r=>r.appartement_id===a.id&&r.date_from&&r.date_from.startsWith(month));
    const monthRev=aptRes.reduce((s,r)=>s+(r.price_total||0),0);
    const nbRes=aptRes.length;
    const varTotal=varPerRes*nbRes+Math.round(monthRev*commPct/100);
    const totalCharges=fixedMonthly+varTotal;
    const netMonthly=monthRev-totalCharges;
    const netAnnual=netMonthly*12;
    const occ=getOccupancyRate(a,30);
    let verdict,verdictIcon,verdictColor,verdictBg,verdictBorder;
    if(netMonthly>=800){verdict='À conserver';verdictIcon='✅';verdictColor='#059669';verdictBg='#ECFDF5';verdictBorder='#BBF7D0';}
    else if(netMonthly>=200){verdict='À optimiser';verdictIcon='⚠️';verdictColor='#D97706';verdictBg='#FFFBEB';verdictBorder='#FDE68A';}
    else{verdict='À remettre en question';verdictIcon='❌';verdictColor='#DC2626';verdictBg='#FEF2F2';verdictBorder='#FECACA';}
    return{a,netMonthly,netAnnual,monthRev,totalCharges,occ,verdict,verdictIcon,verdictColor,verdictBg,verdictBorder};
  }).sort((x,y)=>y.netMonthly-x.netMonthly);

  const totalNetMonthly=aptStats.reduce((s,r)=>s+r.netMonthly,0);
  const totalNetAnnual=totalNetMonthly*12;

  // ── HERO ──
  const heroHtml=`
    <div class="p360-hero">
      <div class="p360-hero-inner">
        <div class="opp-kicker">RentyQ × Profit 360°</div>
        <h2 class="opp-title">La vérité financière de votre parc.</h2>
        <p class="opp-sub">Découvrez ce que chaque logement vous rapporte réellement après charges.</p>
        <div class="opp-kpi-row">
          <div class="opp-kpi-main">
            <div class="opp-kpi-main-value">${totalNetMonthly>=0?'+':''}${totalNetMonthly} €</div>
            <div class="opp-kpi-main-label">profit net mensuel</div>
            <div class="opp-kpi-secondary">${totalNetAnnual>=0?'+':''}${totalNetAnnual.toLocaleString('fr-FR')} € / an</div>
          </div>
          <div class="opp-hero-ctas">
            <button class="btn btn-purple" onclick="document.getElementById('p360-ranking').scrollIntoView({behavior:'smooth'})"><i class="ti ti-chart-bar"></i> Analyser mon profit</button>
            <button class="btn" onclick="document.getElementById('p360-ranking').scrollIntoView({behavior:'smooth'})"><i class="ti ti-building"></i> Comparer mes logements</button>
          </div>
        </div>
      </div>
    </div>`;

  // ── CLASSEMENT ──
  const rankingHtml=`
    <div id="p360-ranking" style="margin-bottom:1.25rem">
      <div class="opp-section-label">Classement EVA de vos logements</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${aptStats.map((r,i)=>`
          <div class="p360-apt-card">
            <div class="p360-apt-rank">${i+1}</div>
            <div style="font-size:20px">${r.a.emoji||'🏠'}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:700;color:#0B0722;margin-bottom:2px">${escapeHtml(r.a.name||'Bien')}</div>
              <div style="font-size:11px;color:#8A8A99">${r.occ}% occupation · CA ${r.monthRev} € · Charges ${r.totalCharges} €</div>
            </div>
            <div class="p360-net">
              <div class="p360-net-monthly" style="color:${r.netMonthly>=0?'#059669':'#DC2626'}">${r.netMonthly>=0?'+':''}${r.netMonthly} €<span class="p360-unit"> / mois</span></div>
              <div class="p360-net-annual" style="color:${r.netAnnual>=0?'#8A8A99':'#DC2626'}">${r.netAnnual>=0?'+':''}${r.netAnnual.toLocaleString('fr-FR')} € / an</div>
            </div>
            <div class="p360-verdict" style="color:${r.verdictColor};background:${r.verdictBg};border:1px solid ${r.verdictBorder}">${r.verdictIcon} ${r.verdict}</div>
          </div>`).join('')}
      </div>
    </div>`;

  // ── LEVIERS EVA ──
  const leviers=[
    {icon:'📅',title:'Augmenter les tarifs week-end',monthly:120,annual:1440},
    {icon:'🧹',title:'Réduire le coût ménage',monthly:60,annual:720},
    {icon:'🏨',title:'Activer Booking.com',monthly:165,annual:1980}
  ];
  const leviersHtml=`
    <div style="margin-bottom:1.25rem">
      <div class="opp-section-label">Leviers EVA pour augmenter votre profit</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        ${leviers.map(l=>`
          <div class="p360-levier">
            <div class="p360-levier-icon">${l.icon}</div>
            <div class="p360-levier-title">${l.title}</div>
            <div class="p360-levier-monthly">+${l.monthly} €<span class="p360-unit"> / mois</span></div>
            <div class="p360-levier-annual">+${l.annual.toLocaleString('fr-FR')} € / an</div>
          </div>`).join('')}
      </div>
    </div>`;

  // ── RECOMMANDATION EVA ──
  const worst=aptStats[aptStats.length-1];
  const recoText=worst&&worst.netMonthly<200
    ?`EVA estime que <strong>${escapeHtml(worst.a.name||'votre dernier bien')}</strong> mobilise du temps sans générer suffisamment de valeur. Une optimisation ou une sortie du parc doit être envisagée.`
    :`EVA estime que votre parc est <strong>bien équilibré</strong>. Concentrez vos efforts sur les leviers ci-dessus pour maximiser votre profit mensuel.`;
  const recoHtml=`
    <div class="p360-reco">
      <div class="p360-reco-icon">🤖</div>
      <div class="p360-reco-text">${recoText}</div>
    </div>`;

  // ── SAISIE MANUELLE (preserved) ──
  const manualHtml=`
    <div style="margin-top:1rem">
      <button onclick="p360OpenManualEntry()" class="btn"><i class="ti ti-edit"></i> Saisir mes données manuellement</button>
      <div id="p360-manual-entry" style="display:none"></div>
    </div>`;

  el.innerHTML=heroHtml+rankingHtml+leviersHtml+recoHtml+manualHtml;
}


/* ===== end PROFIT 360 ===== */



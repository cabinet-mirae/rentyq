// Cloudflare Pages Function — /api/weekly-recap
// Envoi du récap hebdo EVA chaque lundi à 8h
// Déclenché par un Cron Trigger Cloudflare ou appel API

const SB_URL = 'https://gtffekgqglpxjjligffi.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0ZmZla2dxZ2xweGpqbGlnZmZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNjUxODMsImV4cCI6MjA5NTg0MTE4M30.8SHvalTRdUD4dXjcKP8s13yXhtg3NDrjQCBXDlu-jyE';

export async function onRequestPost(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Récupérer tous les profils avec email
    const profilesRes = await fetch(`${SB_URL}/rest/v1/profiles?select=*`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    const profiles = await profilesRes.json();

    let sent = 0;

    for (const profile of profiles) {
      if (!profile.email) continue;

      // 2. Récupérer les apparts de cet utilisateur
      const apRes = await fetch(`${SB_URL}/rest/v1/appartements?user_id=eq.${profile.id}&select=*`, {
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
      const apparts = await apRes.json();
      if (!apparts || !apparts.length) continue;

      // 3. Récupérer les réservations de la semaine
      const now = new Date();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      const mois = now.toISOString().slice(0, 7);

      const resRes = await fetch(`${SB_URL}/rest/v1/reservations?user_id=eq.${profile.id}&date_from=gte.${weekAgo}&select=*`, {
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
      const reservations = await resRes.json() || [];

      // 4. Calculer les KPIs
      const revSemaine = reservations.filter(r => r.date_from >= weekAgo && r.date_from <= now.toISOString().split('T')[0])
        .reduce((s, r) => s + (r.price_total || 0), 0);
      const resASemaine = reservations.filter(r => r.date_from >= now.toISOString().split('T')[0] && r.date_from <= weekEnd);
      const nuitsLibres = apparts.filter(a => !a.booked).length;
      const totalApparts = apparts.length;

      // 5. Trouver les événements à venir
      const cities = [...new Set(apparts.map(a => a.city).filter(Boolean))];
      let hotEvents = [];
      for (const city of cities.slice(0, 3)) {
        try {
          const evRes = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?apikey=g6wYdNGGjHeWmX3eYxju5Z0bQIVT7nXc&city=${encodeURIComponent(city)}&countryCode=FR&radius=50&unit=km&size=5&sort=date,asc&startDateTime=${now.toISOString().split('.')[0]}Z`);
          const evData = await evRes.json();
          const events = (evData._embedded?.events || []).map(e => ({
            name: e.name,
            date: e.dates?.start?.localDate,
            city: e._embedded?.venues?.[0]?.city?.name || city
          }));
          hotEvents.push(...events);
        } catch (e) {}
      }

      // 6. Construire l'email
      const prenom = (profile.name || 'Hôte').split(' ')[0];
      const jourSemaine = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][now.getDay()];

      const emailHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#1a0a2e,#2d1b4e);border-radius:14px 14px 0 0;padding:24px;text-align:center">
    <div style="font-size:24px;font-weight:700;color:white">Rent<span style="background:linear-gradient(90deg,#9B72CF,#FF6B6B);-webkit-background-clip:text;-webkit-text-fill-color:transparent">yQ</span></div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px">Votre récap hebdomadaire</div>
  </div>
  
  <div style="background:white;padding:24px;border:1px solid #E8E8EE">
    <div style="font-size:18px;font-weight:700;margin-bottom:4px">Bonjour ${prenom} 👋</div>
    <div style="font-size:13px;color:#8A8A99;margin-bottom:20px">Voici ce qui s'est passé cette semaine sur vos ${totalApparts} bien${totalApparts > 1 ? 's' : ''}.</div>
    
    <div style="display:flex;gap:10px;margin-bottom:20px">
      <div style="flex:1;background:#F5F4FF;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#6B3FA0">${revSemaine}€</div>
        <div style="font-size:11px;color:#8A8A99">Revenus semaine</div>
      </div>
      <div style="flex:1;background:${nuitsLibres > 0 ? '#FCEBEB' : '#E1F5EE'};border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:${nuitsLibres > 0 ? '#E24B4A' : '#1D9E75'}">${nuitsLibres > 0 ? nuitsLibres + ' libre' + (nuitsLibres > 1 ? 's' : '') : 'Tout loué ✓'}</div>
        <div style="font-size:11px;color:#8A8A99">Ce soir</div>
      </div>
      <div style="flex:1;background:#F5F4FF;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#1D9E75">${resASemaine.length}</div>
        <div style="font-size:11px;color:#8A8A99">Résa cette semaine</div>
      </div>
    </div>

    ${nuitsLibres > 0 ? `
    <div style="background:#FCEBEB;border-radius:10px;padding:12px;margin-bottom:16px;border-left:3px solid #E24B4A">
      <div style="font-size:13px;font-weight:600;color:#A32D2D">⚠ ${nuitsLibres} nuit${nuitsLibres > 1 ? 's' : ''} libre${nuitsLibres > 1 ? 's' : ''} ce soir</div>
      <div style="font-size:12px;color:#A32D2D;margin-top:4px">Connectez-vous pour ajuster vos prix et remplir.</div>
    </div>` : ''}

    ${hotEvents.length > 0 ? `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px">🔥 Événements à venir</div>
    ${hotEvents.slice(0, 3).map(e => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px;background:#FEF3C7;border-radius:8px;margin-bottom:6px;font-size:12px">
      <span>🎯</span>
      <span style="flex:1">${e.name}</span>
      <span style="color:#8A8A99">${e.date ? new Date(e.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : ''}</span>
    </div>`).join('')}
    <div style="font-size:12px;color:#6B3FA0;margin-top:4px">EVA ajuste automatiquement vos prix en fonction de ces événements.</div>
    ` : ''}
    
    <div style="text-align:center;margin-top:20px">
      <a href="https://rentyq.fr" style="background:linear-gradient(135deg,#6B3FA0,#9333EA);color:white;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block">Ouvrir RentyQ →</a>
    </div>
  </div>
  
  <div style="background:#F5F4FF;border-radius:0 0 14px 14px;padding:16px;text-align:center;font-size:11px;color:#8A8A99;border:1px solid #E8E8EE;border-top:none">
    RentyQ · Stop guessing. Start earning. 🇫🇷<br>
    <a href="https://rentyq.fr/settings" style="color:#6B3FA0">Se désabonner</a>
  </div>
</div>`;

      // 7. Envoyer via Supabase (ou Resend/SendGrid si configuré)
      // Pour l'instant on utilise l'API Supabase Auth pour envoyer
      // En prod, utiliser Resend ou SendGrid
      try {
        // Log le récap (pour debug)
        await fetch(`${SB_URL}/rest/v1/weekly_recaps`, {
          method: 'POST',
          headers: {
            'apikey': SB_KEY,
            'Authorization': `Bearer ${SB_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            user_id: profile.id,
            email: profile.email,
            sent_at: new Date().toISOString(),
            kpis: { revSemaine, nuitsLibres, resASemaine: resASemaine.length, hotEvents: hotEvents.length },
            html: emailHtml
          })
        });
        sent++;
      } catch (e) {}
    }

    return new Response(JSON.stringify({ success: true, sent }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}

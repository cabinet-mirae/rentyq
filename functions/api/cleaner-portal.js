// Cloudflare Pages Function — /api/cleaner-portal
//
// Portail cleaner CleanyQ V1 (Sprint 3). Toutes les opérations de lecture/écriture scopées à
// UNE cleaner (identifiée par son token) passent par cette Function, qui utilise la clé de
// SERVICE Supabase (jamais exposée au navigateur) pour contourner la RLS — exactement comme
// le fait déjà ce projet pour Smoobu/Stripe (logique privilégiée côté serveur uniquement).
//
// Important : on ne touche à AUCUNE politique RLS existante sur cleaners / cleaning_missions /
// cleaning_reports. Ces tables restent strictement "auth.uid() = user_id" côté gestionnaire.
// Le cloisonnement cleaner se fait ici, dans le code de la Function, pas dans la base.
//
// Variable d'environnement requise (à configurer dans Cloudflare Pages > Settings > Environment
// variables, JAMAIS dans le code) : SUPABASE_SERVICE_ROLE_KEY.

const SB_URL = 'https://gtffekgqglpxjjligffi.supabase.co';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

// Diagnostic — visiter /api/cleaner-portal directement dans un navigateur (GET) répond ceci.
// Permet de vérifier, sans accès au dashboard Cloudflare :
// 1. Que la Function est bien déployée à ce chemin (sinon : 404 de Cloudflare, pas cette réponse)
// 2. Que SUPABASE_SERVICE_ROLE_KEY est bien configurée (sans jamais révéler sa valeur)
export async function onRequestGet(context) {
  const hasKey = !!(context.env && context.env.SUPABASE_SERVICE_ROLE_KEY);
  return new Response(JSON.stringify({
    status: 'cleaner-portal function reachable',
    service_role_key_configured: hasKey,
    hint: hasKey ? 'OK — la clé est configurée.' : 'SUPABASE_SERVICE_ROLE_KEY est absente des variables d\'environnement Cloudflare Pages.'
  }), { headers: { 'Content-Type': 'application/json' } });
}

// Petit wrapper PostgREST avec la clé de service.
async function sb(context, path, opts = {}) {
  const serviceKey = context.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY manquante côté serveur (variable d\'environnement Cloudflare Pages non configurée)');
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...(opts.headers || {})
    },
    body: opts.body
  });
}

// Résout une cleaner à partir d'un token. Ne renvoie JAMAIS rien si le token est vide/absent —
// on ne veut surtout pas qu'une requête sans token matche une ligne par accident.
async function resolveCleaner(context, token) {
  if (!token || typeof token !== 'string') return null;
  const res = await sb(context, `cleaners?token=eq.${encodeURIComponent(token)}&select=*`);
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Vérifie que la mission appartient bien à CETTE cleaner — sans ce check, une cleaner pourrait
// manipuler n'importe quel missionId dans le payload et agir sur la mission d'une autre cleaner.
async function resolveOwnedMission(context, missionId, cleanerId) {
  if (!missionId) return null;
  const res = await sb(context, `cleaning_missions?id=eq.${encodeURIComponent(missionId)}&cleaner_id=eq.${encodeURIComponent(cleanerId)}&select=*`);
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function onRequestPost(context) {
  const headers = corsHeaders();
  try {
    const contentType = context.request.headers.get('content-type') || '';

    // ── Upload de photo (multipart/form-data) ──
    if (contentType.includes('multipart/form-data')) {
      const form = await context.request.formData();
      const token = form.get('token');
      const bucket = form.get('bucket');
      const file = form.get('file');

      if (!['cleaning-completions', 'cleaning-reports'].includes(bucket)) {
        return new Response(JSON.stringify({ error: 'bucket invalide' }), { status: 400, headers });
      }
      const cleaner = await resolveCleaner(context, token);
      if (!cleaner) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers });
      if (!file || typeof file === 'string') return new Response(JSON.stringify({ error: 'fichier manquant' }), { status: 400, headers });

      const serviceKey = context.env.SUPABASE_SERVICE_ROLE_KEY;
      const ext = (file.name || 'photo.jpg').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${cleaner.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

      const uploadRes = await fetch(`${SB_URL}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': file.type || 'image/jpeg'
        },
        body: file
      });
      if (!uploadRes.ok) {
        const detail = await uploadRes.text();
        return new Response(JSON.stringify({ error: 'upload_failed', detail }), { status: 502, headers });
      }
      const publicUrl = `${SB_URL}/storage/v1/object/public/${bucket}/${path}`;
      return new Response(JSON.stringify({ url: publicUrl }), { headers });
    }

    // ── Actions JSON ──
    const body = await context.request.json();
    const { action, token } = body || {};

    if (action === 'auth') {
      const cleaner = await resolveCleaner(context, token);
      if (!cleaner) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers });

      // Dernier accès — non-bloquant, on ne fait pas attendre la cleaner pour ça.
      sb(context, `cleaners?id=eq.${cleaner.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ last_access_at: new Date().toISOString() })
      }).catch(() => {});

      const missionsRes = await sb(context, `cleaning_missions?cleaner_id=eq.${cleaner.id}&select=*&order=date.asc`);
      const missions = missionsRes.ok ? (await missionsRes.json() || []) : [];

      // Une seule requête pour tous les logements concernés (pas de N+1).
      const aptIds = [...new Set(missions.map(m => m.appartement_id).filter(Boolean))];
      let apartments = [];
      if (aptIds.length) {
        const aptRes = await sb(context, `appartements?id=in.(${aptIds.join(',')})&select=id,name,emoji,address,city,code_porte,code_boite_cles,wifi_code,consignes_cleaner`);
        apartments = aptRes.ok ? (await aptRes.json() || []) : [];
      }

      return new Response(JSON.stringify({
        cleaner: { id: cleaner.id, name: cleaner.name, city: cleaner.city },
        missions,
        apartments
      }), { headers });
    }

    if (action === 'startMission') {
      const cleaner = await resolveCleaner(context, token);
      if (!cleaner) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers });
      const mission = await resolveOwnedMission(context, body.missionId, cleaner.id);
      if (!mission) return new Response(JSON.stringify({ error: 'mission_not_found' }), { status: 404, headers });

      const res = await sb(context, `cleaning_missions?id=eq.${mission.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'en_cours', started_at: new Date().toISOString() })
      });
      const updated = res.ok ? await res.json() : null;
      return new Response(JSON.stringify({ mission: Array.isArray(updated) && updated[0] ? updated[0] : null }), { headers });
    }

    if (action === 'completeMission') {
      const cleaner = await resolveCleaner(context, token);
      if (!cleaner) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers });
      const mission = await resolveOwnedMission(context, body.missionId, cleaner.id);
      if (!mission) return new Response(JSON.stringify({ error: 'mission_not_found' }), { status: 404, headers });

      const photos = Array.isArray(body.photos) ? body.photos : [];
      const res = await sb(context, `cleaning_missions?id=eq.${mission.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'terminee',
          completed_at: new Date().toISOString(),
          completion_photos: photos,
          problem_reported: false
        })
      });
      const updated = res.ok ? await res.json() : null;
      return new Response(JSON.stringify({ mission: Array.isArray(updated) && updated[0] ? updated[0] : null }), { headers });
    }

    if (action === 'reportProblem') {
      const cleaner = await resolveCleaner(context, token);
      if (!cleaner) return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers });
      const mission = await resolveOwnedMission(context, body.missionId, cleaner.id);
      if (!mission) return new Response(JSON.stringify({ error: 'mission_not_found' }), { status: 404, headers });

      const photos = Array.isArray(body.photos) ? body.photos : [];

      await sb(context, `cleaning_missions?id=eq.${mission.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({
          status: 'probleme',
          problem_reported: true,
          completed_at: new Date().toISOString(),
          completion_photos: photos
        })
      });

      const reportRes = await sb(context, `cleaning_reports`, {
        method: 'POST',
        body: JSON.stringify({
          mission_id: mission.id,
          user_id: mission.user_id,
          appartement_id: mission.appartement_id,
          cleaner_id: cleaner.id,
          report_type: body.reportType || 'autre',
          comment: body.comment || null,
          photos,
          resolved: false
        })
      });
      const report = reportRes.ok ? await reportRes.json() : null;
      return new Response(JSON.stringify({ ok: true, report: Array.isArray(report) && report[0] ? report[0] : null }), { headers });
    }

    return new Response(JSON.stringify({ error: 'unknown_action' }), { status: 400, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'server_error', detail: err.message }), { status: 500, headers });
  }
}

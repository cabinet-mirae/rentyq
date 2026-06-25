// Cloudflare Pages Function — /api/easy-concierge
//
// Sprint 0.2 — Parcours utilisateur Easy Concierge. Remplace entièrement la version
// Sprint 0 / Étape 2 (qui lisait 3 variables d'environnement globales). Cette version
// résout l'utilisateur appelant à partir de son JWT Supabase (déjà envoyé par
// secureHeaders() sur tout appel via functionCall()), et lit ses identifiants Easy
// Concierge dans la table pms_connections — jamais un compte global, jamais un user_id
// fourni par le client.
//
// Actions supportées (POST, body JSON {action, ...}) :
//   { action: 'test', tenant, apiKey }                 — teste des identifiants AVANT
//                                                          enregistrement. N'écrit rien.
//   { action: 'sync-properties', connection_id }       — lit la connexion pms_connections
//                                                          de l'utilisateur connecté, importe
//                                                          ses logements dans appartements.
//
// Variables d'environnement Cloudflare Pages requises :
//   SUPABASE_SERVICE_ROLE_KEY  — déjà utilisée par cleaner-portal.js / weekly-recap.js.
//   EASY_CONCIERGE_BASE_URL    — fallback global si pms_connections.base_url est vide
//                                (URL d'infra, pas un secret par utilisateur).
//
// ⚠️ Comme pour la version précédente : le contrat exact de pagination de l'API publique
// Easy Concierge n'est pas confirmé. extractItems()/fetchAllProperties() restent défensifs.

const SB_URL = 'https://gtffekgqglpxjjligffi.supabase.co';
// Clé anonyme Supabase (publique par nature — déjà présente dans app.js et weekly-recap.js,
// jamais un secret). Utilisée uniquement pour vérifier le JWT de l'appelant via /auth/v1/user.
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0ZmZla2dxZ2xweGpqbGlnZmZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNjUxODMsImV4cCI6MjA5NTg0MTE4M30.8SHvalTRdUD4dXjcKP8s13yXhtg3NDrjQCBXDlu-jyE';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: corsHeaders() });
}

// ── Résout l'utilisateur appelant à partir de son JWT Supabase. Ne fait JAMAIS confiance
// à un user_id envoyé dans le corps de la requête. ──
async function resolveUserId(context) {
  const authHeader = context.request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user.id : null;
  } catch (e) {
    return null;
  }
}

// ── Wrapper PostgREST avec la clé de service — même logique privilégiée que
// cleaner-portal.js / weekly-recap.js, jamais exposée au navigateur. ──
async function sb(context, path, opts = {}) {
  const serviceKey = context.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY manquante côté serveur.');
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    },
    body: opts.body
  });
}

// ── Extraction défensive de la liste de logements depuis la réponse Easy Concierge —
// plusieurs formes courantes essayées plutôt que de supposer une seule structure. ──
function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.properties)) return body.properties;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.results)) return body.results;
  return [];
}

// ── Un seul appel resource=properties avec des identifiants donnés en paramètres
// (jamais lus depuis l'environnement directement — toujours passés explicitement, pour
// que 'test' et 'sync-properties' utilisent strictement le même chemin de code). ──
async function fetchPropertiesPage({ baseUrl, apiKey, tenant, page, perPage }) {
  const url = new URL(baseUrl);
  url.searchParams.set('resource', 'properties');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  // ⚠️ Hypothèse à confirmer : tenant transmis en query param (voir note Sprint 0 Étape 2).
  if (tenant) url.searchParams.set('tenant', tenant);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  });
  const rawBody = await res.text();
  let parsedBody = null;
  try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch (e) { /* non-JSON géré ci-dessous */ }

  if (!res.ok) {
    const detail = parsedBody ? JSON.stringify(parsedBody).slice(0, 300) : rawBody.slice(0, 300);
    throw new Error(`Easy Concierge a répondu ${res.status} : ${detail}`);
  }
  if (parsedBody === null) {
    throw new Error('Réponse Easy Concierge non-JSON.');
  }
  return extractItems(parsedBody);
}

// ── Récupère toutes les pages, avec un garde-fou dur à 50 pages. ──
async function fetchAllProperties({ baseUrl, apiKey, tenant }) {
  const perPage = 100;
  let page = 1;
  let all = [];
  while (page <= 50) {
    const items = await fetchPropertiesPage({ baseUrl, apiKey, tenant, page, perPage });
    all = all.concat(items);
    if (items.length < perPage) break;
    page++;
  }
  return all;
}

// ── action=test : identifiants reçus directement du front, jamais lus en base, rien
// n'est écrit. Protégé par JWT uniquement pour éviter qu'un tiers utilise ce endpoint
// comme oracle de test de clés API volées — pas pour une logique d'appartenance. ──
async function handleTest(context, body) {
  const userId = await resolveUserId(context);
  if (!userId) return json({ success: false, error: 'unauthorized' }, 401);

  const { tenant, apiKey, baseUrl } = body || {};
  if (!tenant || !apiKey) {
    return json({ success: false, error: 'missing_tenant_or_api_key' }, 400);
  }
  const effectiveBaseUrl = baseUrl || context.env.EASY_CONCIERGE_BASE_URL;
  if (!effectiveBaseUrl) return json({ success: false, error: 'missing_base_url' }, 500);

  try {
    const items = await fetchPropertiesPage({ baseUrl: effectiveBaseUrl, apiKey, tenant, page: 1, perPage: 5 });
    return json({ success: true, sample_count: items.length });
  } catch (e) {
    return json({ success: false, error: e.message });
  }
}

// ── action=sync-properties : connection_id reçu du front, mais la connexion est
// systématiquement revérifiée contre le user_id résolu depuis le JWT — jamais l'inverse. ──
async function handleSyncProperties(context, body) {
  const userId = await resolveUserId(context);
  if (!userId) return json({ inserted: 0, updated: 0, errors: [{ message: 'unauthorized' }] }, 401);

  const { connection_id } = body || {};
  if (!connection_id) {
    return json({ inserted: 0, updated: 0, errors: [{ message: 'connection_id manquant' }] }, 400);
  }

  const connRes = await sb(context, `pms_connections?id=eq.${encodeURIComponent(connection_id)}&select=*`);
  if (!connRes.ok) {
    return json({ inserted: 0, updated: 0, errors: [{ message: 'lecture pms_connections en erreur' }] }, 500);
  }
  const connRows = await connRes.json();
  const conn = Array.isArray(connRows) && connRows[0] ? connRows[0] : null;
  if (!conn) return json({ inserted: 0, updated: 0, errors: [{ message: 'connexion introuvable' }] }, 404);
  if (conn.user_id !== userId) {
    // Ne jamais révéler si l'id existe pour un autre user — message générique volontaire.
    return json({ inserted: 0, updated: 0, errors: [{ message: 'connexion introuvable' }] }, 404);
  }
  if (conn.provider !== 'easy_concierge') {
    return json({ inserted: 0, updated: 0, errors: [{ message: 'provider incorrect pour ce endpoint' }] }, 400);
  }

  const effectiveBaseUrl = conn.base_url || context.env.EASY_CONCIERGE_BASE_URL;
  if (!effectiveBaseUrl) {
    return json({ inserted: 0, updated: 0, errors: [{ message: 'missing_base_url' }] }, 500);
  }

  let properties;
  try {
    properties = await fetchAllProperties({ baseUrl: effectiveBaseUrl, apiKey: conn.api_key, tenant: conn.tenant });
  } catch (e) {
    await sb(context, `pms_connections?id=eq.${conn.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ status: 'error', updated_at: new Date().toISOString() })
    }).catch(() => {});
    return json({ inserted: 0, updated: 0, errors: [{ message: 'easy_concierge_unreachable: ' + e.message }] }, 502);
  }

  let inserted = 0, updated = 0;
  const errors = [];

  for (const p of properties) {
    const propertyId = p && p.property_id != null ? String(p.property_id) : null;
    if (!propertyId) {
      errors.push({ property_id: null, message: 'property_id manquant — logement ignoré.' });
      continue;
    }

    try {
      const mainPhotoUrl = Array.isArray(p.photos) && p.photos[0] && p.photos[0].url ? p.photos[0].url : null;
      const amenitiesJson = Array.isArray(p.amenities) ? p.amenities : null;

      // Seulement les clés qu'on a réellement — jamais d'écrasement par null sur une
      // valeur déjà renseignée manuellement (et "name" est NOT NULL côté Supabase).
      const fields = {};
      if (p.name != null && p.name !== '') fields.name = p.name;
      if (p.city != null) fields.city = p.city;
      if (p.bedrooms != null) fields.bedrooms = p.bedrooms;
      if (p.bathrooms != null) fields.bathrooms = p.bathrooms;
      if (p.max_guests != null) fields.max_guests = p.max_guests;
      if (mainPhotoUrl !== null) fields.main_photo_url = mainPhotoUrl;
      if (amenitiesJson !== null) fields.amenities_json = amenitiesJson;

      // Anti-doublon : scopé explicitement à CE user_id — jamais juste source+external_id.
      const findRes = await sb(context, `appartements?user_id=eq.${userId}&source=eq.easy_concierge&external_id=eq.${encodeURIComponent(propertyId)}&select=id`);
      if (!findRes.ok) {
        errors.push({ property_id: propertyId, message: 'lecture appartements en erreur' });
        continue;
      }
      const existingRows = await findRes.json();
      const existing = Array.isArray(existingRows) && existingRows[0] ? existingRows[0] : null;

      if (existing) {
        const patchRes = await sb(context, `appartements?id=eq.${existing.id}`, {
          method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(fields)
        });
        if (!patchRes.ok) { errors.push({ property_id: propertyId, message: 'mise à jour en erreur' }); continue; }
        updated++;
      } else {
        const createBody = {
          ...fields,
          name: fields.name || `Logement Easy Concierge ${propertyId}`,
          user_id: userId,
          source: 'easy_concierge',
          external_id: propertyId
        };
        const postRes = await sb(context, 'appartements', {
          method: 'POST', prefer: 'return=minimal', body: JSON.stringify(createBody)
        });
        if (!postRes.ok) { errors.push({ property_id: propertyId, message: 'création en erreur' }); continue; }
        inserted++;
      }
    } catch (itemErr) {
      errors.push({ property_id: propertyId, message: itemErr.message });
    }
  }

  // La connexion fonctionne dès qu'on a pu lire Easy Concierge — même si certains items
  // individuels ont échoué (déjà tracés dans errors).
  await sb(context, `pms_connections?id=eq.${conn.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ status: 'connected', last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  }).catch(() => {});

  return json({ inserted, updated, errors });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const action = body && body.action;

    if (action === 'test') return await handleTest(context, body);
    if (action === 'sync-properties') return await handleSyncProperties(context, body);

    return json({ error: 'unknown_action', allowed_actions: ['test', 'sync-properties'] }, 400);
  } catch (err) {
    return json({ error: 'server_error', detail: err.message }, 500);
  }
}

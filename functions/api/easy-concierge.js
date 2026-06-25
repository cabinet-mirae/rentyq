// Cloudflare Pages Function — /api/easy-concierge
//
// Sprint 0 — Étape 2 : proxy GET-only entre RentyQ et l'API Easy Concierge.
//
// Rôle UNIQUE de ce fichier : relayer une lecture vers Easy Concierge en gardant la clé
// API côté serveur. Il ne transforme pas la donnée, n'écrit rien dans Supabase et ne
// touche à aucun autre fichier du projet. Le sync (syncEasyConcierge()) qui consommera
// ce proxy pour peupler appartements/reservations/reviews/reservation_financials est une
// étape ultérieure, volontairement hors scope ici.
//
// Usage :
//   GET /api/easy-concierge?resource=properties
//   GET /api/easy-concierge?resource=bookings&updated_since=2026-06-01&page=2
//
// Variables d'environnement requises (Cloudflare Pages > Settings > Environment variables,
// JAMAIS dans le code) :
//   EASY_CONCIERGE_API_KEY    — clé API Easy Concierge. Ne transite JAMAIS vers le front :
//                               elle est lue ici, côté serveur, et n'apparaît dans aucune
//                               réponse renvoyée au navigateur.
//   EASY_CONCIERGE_TENANT     — identifiant du tenant Easy Concierge.
//   EASY_CONCIERGE_BASE_URL   — URL de base de l'API Easy Concierge.
//
// ⚠️ Point à vérifier auprès du support Easy Concierge avant le premier vrai sync : je n'ai
// pas le contrat exact de leur API publique (pagination, forme de "tenant" dans la requête,
// noms exacts des paramètres). EASY_CONCIERGE_TENANT est transmis ici en query param
// `tenant=` par défaut — c'est une hypothèse raisonnable, pas une certitude. À corriger en
// une ligne (voir plus bas) si leur doc dit "header" ou "segment d'URL" à la place.

const ALLOWED_RESOURCES = ['properties', 'bookings', 'reviews', 'pricing', 'pricing-history', 'pricing-changes'];
const ALLOWED_PARAMS = ['from', 'to', 'updated_since', 'property_id', 'page', 'per_page'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

// GET uniquement — par design, ce proxy ne fait jamais d'écriture côté Easy Concierge.
export async function onRequestGet(context) {
  const headers = corsHeaders();

  try {
    const { EASY_CONCIERGE_API_KEY, EASY_CONCIERGE_TENANT, EASY_CONCIERGE_BASE_URL } = context.env || {};

    if (!EASY_CONCIERGE_API_KEY) {
      return new Response(JSON.stringify({
        error: 'missing_api_key',
        message: 'EASY_CONCIERGE_API_KEY est absente des variables d\u2019environnement Cloudflare Pages.'
      }), { status: 500, headers });
    }
    if (!EASY_CONCIERGE_BASE_URL) {
      return new Response(JSON.stringify({
        error: 'missing_base_url',
        message: 'EASY_CONCIERGE_BASE_URL est absente des variables d\u2019environnement Cloudflare Pages.'
      }), { status: 500, headers });
    }

    const incomingUrl = new URL(context.request.url);
    const resource = incomingUrl.searchParams.get('resource');

    if (!resource) {
      return new Response(JSON.stringify({
        error: 'missing_resource',
        message: 'Param\u00e8tre "resource" manquant.',
        allowed_resources: ALLOWED_RESOURCES
      }), { status: 400, headers });
    }

    if (!ALLOWED_RESOURCES.includes(resource)) {
      return new Response(JSON.stringify({
        error: 'resource_not_allowed',
        message: `Ressource "${resource}" non autoris\u00e9e.`,
        allowed_resources: ALLOWED_RESOURCES
      }), { status: 400, headers });
    }

    // Construction de l'URL Easy Concierge — uniquement les paramètres whitelistés sont
    // transmis. "resource" est un paramètre de routage de CE proxy ; on le retransmet tel
    // quel à Easy Concierge car leur doc l'utilise aussi pour sélectionner la ressource
    // (à ajuster si leur API attend plutôt un chemin du type /properties).
    const upstreamUrl = new URL(EASY_CONCIERGE_BASE_URL);
    upstreamUrl.searchParams.set('resource', resource);
    for (const param of ALLOWED_PARAMS) {
      const value = incomingUrl.searchParams.get(param);
      if (value !== null && value !== '') {
        upstreamUrl.searchParams.set(param, value);
      }
    }
    // ⚠️ Hypothèse à confirmer (voir note en tête de fichier) : tenant transmis en query param.
    if (EASY_CONCIERGE_TENANT) {
      upstreamUrl.searchParams.set('tenant', EASY_CONCIERGE_TENANT);
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${EASY_CONCIERGE_API_KEY}`,
          'Accept': 'application/json'
        }
      });
    } catch (fetchErr) {
      return new Response(JSON.stringify({
        error: 'easy_concierge_unreachable',
        message: 'Impossible de contacter Easy Concierge : ' + fetchErr.message
      }), { status: 502, headers });
    }

    if (upstreamRes.status === 429) {
      return new Response(JSON.stringify({
        error: 'rate_limited',
        message: 'Easy Concierge a r\u00e9pondu 429 (limite de requ\u00eates atteinte).',
        retry_after: upstreamRes.headers.get('Retry-After') || null
      }), { status: 429, headers });
    }

    const rawBody = await upstreamRes.text();
    let parsedBody = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch (parseErr) {
      // Réponse non-JSON (page d'erreur HTML, maintenance, etc.) — on ne la transmet pas
      // telle quelle au front, on la signale proprement avec un extrait pour debug.
      return new Response(JSON.stringify({
        error: 'easy_concierge_invalid_response',
        message: 'R\u00e9ponse Easy Concierge non-JSON.',
        upstream_status: upstreamRes.status,
        raw_excerpt: rawBody.slice(0, 500)
      }), { status: 502, headers });
    }

    if (!upstreamRes.ok) {
      return new Response(JSON.stringify({
        error: 'easy_concierge_error',
        upstream_status: upstreamRes.status,
        detail: parsedBody
      }), { status: upstreamRes.status, headers });
    }

    // Succès : le JSON Easy Concierge est renvoyé tel quel, sans transformation ni écriture.
    return new Response(JSON.stringify(parsedBody), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'server_error', detail: err.message }), { status: 500, headers });
  }
}

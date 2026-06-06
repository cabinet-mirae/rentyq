// Cloudflare Pages Function — /api/smoobu
const SMOOBU_API = 'https://login.smoobu.com/api';

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}

export async function onRequestPost(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const { action, apiKey, params } = await context.request.json();

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key manquante' }), { status: 400, headers });
    }

    const smoobuHeaders = {
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    };

    switch (action) {

      case 'testConnection': {
        const res = await fetch(`${SMOOBU_API}/apartments`, { headers: smoobuHeaders });
        const data = await res.json();
        return new Response(JSON.stringify({ success: res.ok, data }), { headers });
      }

      case 'getApartments': {
        const res = await fetch(`${SMOOBU_API}/apartments`, { headers: smoobuHeaders });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers });
      }

      case 'getReservations': {
        const from = params?.from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        const to = params?.to || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
        const res = await fetch(`${SMOOBU_API}/reservations?from=${from}&to=${to}&pageSize=100`, { headers: smoobuHeaders });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers });
      }

      case 'getRates': {
        const apartmentId = params?.apartmentId;
        if (!apartmentId) return new Response(JSON.stringify({ error: 'apartmentId manquant' }), { status: 400, headers });
        const from = params?.from || new Date().toISOString().slice(0, 10);
        const to = params?.to || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        const res = await fetch(`${SMOOBU_API}/rates?apartments[]=${apartmentId}&start_date=${from}&end_date=${to}`, { headers: smoobuHeaders });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers });
      }

      default:
        return new Response(JSON.stringify({ error: 'Action inconnue' }), { status: 400, headers });
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Erreur serveur: ' + err.message }), { status: 500, headers });
  }
}

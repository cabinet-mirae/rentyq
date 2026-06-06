// Cloudflare Pages Function — /api/events
const TM_KEY = 'g6wYdNGGjHeWmX3eYxju5Z0bQIVT7nXc';
const TM_API = 'https://app.ticketmaster.com/discovery/v2/events.json';

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
    const { city, countryCode, radius } = await context.request.json();

    if (!city) {
      return new Response(JSON.stringify({ error: 'Ville manquante' }), { status: 400, headers });
    }

    const params = new URLSearchParams({
      apikey: TM_KEY,
      city: city,
      countryCode: countryCode || 'FR',
      radius: radius || 20,
      unit: 'km',
      size: 20,
      sort: 'date,asc',
      startDateTime: new Date().toISOString().replace(/\.\d{3}/, ''),
      endDateTime: new Date(Date.now() + 90 * 86400000).toISOString().replace(/\.\d{3}/, '')
    });

    const res = await fetch(`${TM_API}?${params}`);
    const data = await res.json();

    const events = (data._embedded?.events || []).map(e => ({
      name: e.name,
      date: e.dates?.start?.localDate,
      time: e.dates?.start?.localTime,
      venue: e._embedded?.venues?.[0]?.name,
      city: e._embedded?.venues?.[0]?.city?.name || city,
      segment: e.classifications?.[0]?.segment?.name,
      genre: e.classifications?.[0]?.genre?.name,
      url: e.url,
      image: e.images?.[0]?.url
    }));

    return new Response(JSON.stringify(events), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Erreur serveur: ' + err.message }), { status: 500, headers });
  }
}

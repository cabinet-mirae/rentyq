// Cloudflare Pages Function — /api/events
// Combine Ticketmaster + OpenAgenda pour maximum de couverture
const TM_KEY = 'g6wYdNGGjHeWmX3eYxju5Z0bQIVT7nXc';
const TM_API = 'https://app.ticketmaster.com/discovery/v2/events.json';
const OA_API = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/records';

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

    // Fetch both APIs in parallel
    const [tmEvents, oaEvents] = await Promise.all([
      fetchTicketmaster(city, countryCode, radius),
      fetchOpenAgenda(city)
    ]);

    // Merge and deduplicate by name similarity
    const all = [...tmEvents, ...oaEvents];
    const seen = new Set();
    const unique = all.filter(e => {
      const key = e.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by date
    unique.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    return new Response(JSON.stringify(unique), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Erreur serveur: ' + err.message }), { status: 500, headers });
  }
}

async function fetchTicketmaster(city, countryCode, radius) {
  try {
    const now = new Date();
    const end = new Date(Date.now() + 180 * 86400000);
    const fmt = d => d.toISOString().split('.')[0] + 'Z';

    const params = new URLSearchParams({
      apikey: TM_KEY,
      city: city,
      countryCode: countryCode || 'FR',
      radius: String(radius || 30),
      unit: 'km',
      size: '50',
      sort: 'date,asc',
      startDateTime: fmt(now),
      endDateTime: fmt(end)
    });

    const res = await fetch(`${TM_API}?${params}`);
    const data = await res.json();

    return (data._embedded?.events || []).map(e => ({
      name: e.name,
      date: e.dates?.start?.localDate,
      time: e.dates?.start?.localTime,
      venue: e._embedded?.venues?.[0]?.name,
      city: e._embedded?.venues?.[0]?.city?.name || city,
      segment: e.classifications?.[0]?.segment?.name,
      genre: e.classifications?.[0]?.genre?.name,
      url: e.url,
      image: e.images?.[0]?.url,
      source: 'ticketmaster'
    }));
  } catch (e) {
    return [];
  }
}

async function fetchOpenAgenda(city) {
  try {
    const now = new Date().toISOString().split('T')[0];
    const end = new Date(Date.now() + 180 * 86400000).toISOString().split('T')[0];

    const params = new URLSearchParams({
      limit: '50',
      'refine': `location_city:${city}`,
      'where': `date_range >= "${now}"`,
      'order_by': 'date_range ASC'
    });

    const res = await fetch(`${OA_API}?${params}`);
    const data = await res.json();

    return (data.results || []).map(r => {
      const title = r.title_fr || r.title || r.longdescription_fr || '';
      const dateStr = r.firstdate_begin || r.date_range?.start || '';
      const date = dateStr ? dateStr.split('T')[0] : '';
      const keywords = r.keywords_fr || '';

      // Detect segment from keywords
      let segment = 'Misc';
      let genre = '';
      const kw = (keywords + ' ' + title).toLowerCase();
      if (kw.includes('concert') || kw.includes('musique') || kw.includes('festival') || kw.includes('jazz') || kw.includes('rock')) {
        segment = 'Music'; genre = 'Concert';
      } else if (kw.includes('sport') || kw.includes('marathon') || kw.includes('foot') || kw.includes('rugby') || kw.includes('course') || kw.includes('athl')) {
        segment = 'Sports'; genre = 'Sport';
      } else if (kw.includes('salon') || kw.includes('foire') || kw.includes('exposition') || kw.includes('marché') || kw.includes('brocante')) {
        segment = 'Arts'; genre = 'Salon/Foire';
      } else if (kw.includes('théâtre') || kw.includes('spectacle') || kw.includes('comédie') || kw.includes('danse') || kw.includes('cirque')) {
        segment = 'Arts'; genre = 'Spectacle';
      } else if (kw.includes('conférence') || kw.includes('congrès') || kw.includes('colloque') || kw.includes('séminaire') || kw.includes('forum')) {
        segment = 'Conference'; genre = 'Conférence';
      } else if (kw.includes('noël') || kw.includes('fête') || kw.includes('carnaval') || kw.includes('14 juillet') || kw.includes('patrimoine')) {
        segment = 'Festival'; genre = 'Fête locale';
      }

      return {
        name: title.length > 80 ? title.slice(0, 77) + '...' : title,
        date: date,
        time: null,
        venue: r.location_name || '',
        city: r.location_city || city,
        segment: segment,
        genre: genre,
        url: r.canonicalurl || '',
        image: r.image || null,
        source: 'openagenda'
      };
    }).filter(e => e.name && e.date);
  } catch (e) {
    return [];
  }
}

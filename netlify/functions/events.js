const TM_KEY = 'g6wYdNGGjHeWmX3eYxju5Z0bQIVT7nXc';

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { city, countryCode = 'FR', radius = 20, startDate, endDate } = JSON.parse(event.body || '{}');

    if (!city) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ville manquante' }) };
    }

    // Dates par défaut : aujourd'hui + 90 jours
    const now = new Date();
    const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const from = startDate || now.toISOString().split('T')[0] + 'T00:00:00Z';
    const to = endDate || future.toISOString().split('T')[0] + 'T00:00:00Z';

    const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${TM_KEY}&city=${encodeURIComponent(city)}&countryCode=${countryCode}&radius=${radius}&unit=km&startDateTime=${from}&endDateTime=${to}&size=50&sort=date,asc&locale=fr-fr,en-us`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return { statusCode: response.status, headers, body: JSON.stringify({ error: data.fault?.faultstring || 'Erreur Ticketmaster' }) };
    }

    const rawEvents = data._embedded?.events || [];

    // Transformer et enrichir les événements
    const events = rawEvents.map(e => {
      const venue = e._embedded?.venues?.[0];
      const date = e.dates?.start?.localDate;
      const attendance = estimateAttendance(e);
      const boost = estimatePriceBoost(e, attendance);
      const category = getCategory(e);

      return {
        id: e.id,
        name: e.name,
        date: date,
        date_label: formatDate(date),
        venue: venue?.name || '',
        city: venue?.city?.name || city,
        address: venue?.address?.line1 || '',
        category: category,
        emoji: getCategoryEmoji(category),
        url: e.url || '',
        image: e.images?.[0]?.url || '',
        attendance: attendance,
        attendance_label: formatAttendance(attendance),
        boost: boost,
        hot: boost >= 15,
        segment: e.classifications?.[0]?.segment?.name || ''
      };
    });

    // Trier par impact (boost décroissant)
    events.sort((a, b) => b.boost - a.boost);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        city,
        total: events.length,
        events: events
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur serveur: ' + err.message })
    };
  }
};

function estimateAttendance(event) {
  const venue = event._embedded?.venues?.[0];
  const capacity = venue?.generalInfo?.generalRule ? 50000 : null;
  const segment = event.classifications?.[0]?.segment?.name?.toLowerCase() || '';
  const genre = event.classifications?.[0]?.genre?.name?.toLowerCase() || '';

  // Estimation basée sur le type d'événement
  if (segment.includes('music')) {
    if (genre.includes('rock') || genre.includes('pop')) return 40000;
    if (genre.includes('classical') || genre.includes('jazz')) return 3000;
    return 15000;
  }
  if (segment.includes('sport')) return 30000;
  if (segment.includes('arts') || segment.includes('theatre')) return 2000;
  if (segment.includes('family')) return 8000;
  return 10000;
}

function estimatePriceBoost(event, attendance) {
  let boost = 0;
  const segment = event.classifications?.[0]?.segment?.name?.toLowerCase() || '';

  // Base selon affluence
  if (attendance >= 50000) boost = 25;
  else if (attendance >= 30000) boost = 20;
  else if (attendance >= 15000) boost = 15;
  else if (attendance >= 5000) boost = 10;
  else boost = 5;

  // Bonus sport
  if (segment.includes('sport')) boost += 5;

  // Bonus musique grands artistes
  if (segment.includes('music') && attendance >= 30000) boost += 3;

  return Math.min(boost, 35);
}

function getCategory(event) {
  const segment = event.classifications?.[0]?.segment?.name?.toLowerCase() || '';
  const genre = event.classifications?.[0]?.genre?.name?.toLowerCase() || '';
  if (segment.includes('music')) return 'music';
  if (segment.includes('sport')) return 'sport';
  if (segment.includes('arts') || segment.includes('theatre')) return 'arts';
  if (segment.includes('family')) return 'family';
  return 'other';
}

function getCategoryEmoji(category) {
  const map = { music: '🎵', sport: '🏆', arts: '🎭', family: '🎡', other: '📅' };
  return map[category] || '📅';
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatAttendance(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + ' 000';
  return n.toString();
}

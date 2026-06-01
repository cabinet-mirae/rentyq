exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { action, apiKey, params } = JSON.parse(event.body || '{}');

    if (!apiKey) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Clé API Smoobu manquante' })
      };
    }

    const SMOOBU_BASE = 'https://login.smoobu.com';
    const smoobuHeaders = {
      'Api-Key': apiKey,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    };

    let url = '';
    let response;
    let data;

    switch (action) {

      // Récupérer les appartements
      case 'getApartments':
        url = `${SMOOBU_BASE}/api/apartments`;
        response = await fetch(url, { headers: smoobuHeaders });
        data = await response.json();
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(data)
        };

      // Récupérer les réservations
      case 'getBookings':
        const from = params?.from || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
        const to = params?.to || new Date(Date.now() + 180*24*60*60*1000).toISOString().split('T')[0];
        const apartmentId = params?.apartmentId ? `&apartmentId=${params.apartmentId}` : '';
        url = `${SMOOBU_BASE}/api/reservations?from=${from}&to=${to}${apartmentId}&pageSize=100`;
        response = await fetch(url, { headers: smoobuHeaders });
        data = await response.json();
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(data)
        };

      // Récupérer les tarifs d'un appartement
      case 'getRates':
        const rateFrom = params?.from || new Date().toISOString().split('T')[0];
        const rateTo = params?.to || new Date(Date.now() + 90*24*60*60*1000).toISOString().split('T')[0];
        url = `${SMOOBU_BASE}/api/rates?apartments[]=${params.apartmentId}&start_date=${rateFrom}&end_date=${rateTo}`;
        response = await fetch(url, { headers: smoobuHeaders });
        data = await response.json();
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(data)
        };

      // Vérifier la clé API (test de connexion)
      case 'testConnection':
        url = `${SMOOBU_BASE}/api/me`;
        response = await fetch(url, { headers: smoobuHeaders });
        data = await response.json();
        if (response.ok) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, user: data })
          };
        } else {
          return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ success: false, error: 'Clé API invalide' })
          };
        }

      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Action inconnue : ' + action })
        };
    }

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur serveur : ' + err.message })
    };
  }
};

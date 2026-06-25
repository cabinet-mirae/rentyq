// Cloudflare Pages Function — /api/easy-concierge
//
// Sprint 0.3 — Connecteur Easy Concierge complet pour alimenter EVA.
// Actions supportées :
//   { action:'test', tenant, apiKey, baseUrl? }
//   { action:'sync-properties', connection_id }  // rétrocompatibilité : lance une sync complète V1
//   { action:'sync-all', connection_id }         // properties + bookings + reviews + pricing

const SB_URL = 'https://gtffekgqglpxjjligffi.supabase.co';
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

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function resolveUserId(context) {
  const authHeader = context.request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  try {
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: {
        apikey: SB_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) return null;

    const user = await res.json();
    return user && user.id ? user.id : null;
  } catch (e) {
    return null;
  }
}

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

async function readJsonSafe(res) {
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return { __raw: raw };
  }
}

function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.properties)) return body.properties;
  if (Array.isArray(body.bookings)) return body.bookings;
  if (Array.isArray(body.reviews)) return body.reviews;
  if (Array.isArray(body.pricing)) return body.pricing;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.results)) return body.results;
  return [];
}

function extractTotalPages(body) {
  if (!body || typeof body !== 'object') return null;
  const p = body.pagination || body.meta || body;
  const totalPages = p.total_pages || p.totalPages || p.pages || null;
  const n = Number(totalPages);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchResourcePage({ baseUrl, apiKey, tenant, resource, page = 1, perPage = 100, params = {} }) {
  const url = new URL(baseUrl);
  url.searchParams.set('resource', resource);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));

  if (tenant) url.searchParams.set('tenant', tenant);

  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });

  const body = await readJsonSafe(res);

  if (!res.ok) {
    const detail = body ? JSON.stringify(body).slice(0, 500) : '';
    throw new Error(`Easy Concierge ${resource} a répondu ${res.status} : ${detail}`);
  }

  if (!body || body.__raw) {
    throw new Error(`Réponse Easy Concierge ${resource} non-JSON.`);
  }

  return {
    body,
    items: extractItems(body),
    totalPages: extractTotalPages(body)
  };
}

async function fetchAllResource({ baseUrl, apiKey, tenant, resource, params = {}, perPage = 100, maxPages = 50 }) {
  let page = 1;
  let all = [];

  while (page <= maxPages) {
    const { items, totalPages } = await fetchResourcePage({
      baseUrl,
      apiKey,
      tenant,
      resource,
      page,
      perPage,
      params
    });

    all = all.concat(items);

    if (totalPages && page >= totalPages) break;
    if (!totalPages && items.length < perPage) break;

    page++;
  }

  return all;
}

async function fetchAllProperties(config) {
  return fetchAllResource({
    ...config,
    resource: 'properties',
    perPage: 100
  });
}

async function fetchAllBookings(config, params = {}) {
  return fetchAllResource({
    ...config,
    resource: 'bookings',
    params,
    perPage: 100,
    maxPages: 100
  });
}

async function fetchAllReviews(config, params = {}) {
  return fetchAllResource({
    ...config,
    resource: 'reviews',
    params,
    perPage: 100,
    maxPages: 100
  });
}

async function fetchPricingForProperty(config, propertyId) {
  return fetchAllResource({
    ...config,
    resource: 'pricing',
    params: {
      property_id: propertyId,
      from: todayIso(),
      to: addDaysIso(30)
    },
    perPage: 100,
    maxPages: 5
  });
}

async function handleTest(context, body) {
  const userId = await resolveUserId(context);
  if (!userId) return json({ success: false, error: 'unauthorized' }, 401);

  const { tenant, apiKey, baseUrl } = body || {};

  if (!tenant || !apiKey) {
    return json({ success: false, error: 'missing_tenant_or_api_key' }, 400);
  }

  const effectiveBaseUrl = baseUrl || context.env.EASY_CONCIERGE_BASE_URL;

  if (!effectiveBaseUrl) {
    return json({ success: false, error: 'missing_base_url' }, 500);
  }

  try {
    const { items } = await fetchResourcePage({
      baseUrl: effectiveBaseUrl,
      apiKey,
      tenant,
      resource: 'properties',
      page: 1,
      perPage: 5
    });

    return json({
      success: true,
      sample_count: items.length
    });
  } catch (e) {
    return json({
      success: false,
      error: e.message
    });
  }
}

async function getConnection(context, userId, connectionId) {
  if (!connectionId) throw new Error('connection_id manquant');

  const connRes = await sb(
    context,
    `pms_connections?id=eq.${encodeURIComponent(connectionId)}&select=*`
  );

  if (!connRes.ok) throw new Error('lecture pms_connections en erreur');

  const rows = await connRes.json();
  const conn = Array.isArray(rows) && rows[0] ? rows[0] : null;

  if (!conn || conn.user_id !== userId) throw new Error('connexion introuvable');
  if (conn.provider !== 'easy_concierge') throw new Error('provider incorrect pour ce endpoint');

  return conn;
}

async function getAppartementsMap(context, userId) {
  const res = await sb(
    context,
    `appartements?user_id=eq.${userId}&source=eq.easy_concierge&select=id,external_id,name`
  );

  if (!res.ok) throw new Error('lecture appartements en erreur');

  const rows = await res.json();
  const map = new Map();

  (Array.isArray(rows) ? rows : []).forEach(a => {
    if (a.external_id != null) map.set(String(a.external_id), a);
  });

  return map;
}

async function syncProperties(context, userId, config) {
  const properties = await fetchAllProperties(config);

  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const p of properties) {
    const propertyId = p && p.property_id != null ? String(p.property_id) : null;

    if (!propertyId) {
      errors.push({
        scope: 'properties',
        property_id: null,
        message: 'property_id manquant'
      });
      continue;
    }

    try {
      const mainPhotoUrl =
        Array.isArray(p.photos) && p.photos[0] && p.photos[0].url
          ? p.photos[0].url
          : null;

      const amenitiesJson = Array.isArray(p.amenities) ? p.amenities : null;

      const fields = {};

      if (p.name != null && p.name !== '') fields.name = p.name;
      if (p.city != null) fields.city = p.city;
      if (p.bedrooms != null) fields.bedrooms = p.bedrooms;
      if (p.bathrooms != null) fields.bathrooms = p.bathrooms;
      if (p.max_guests != null) fields.max_guests = p.max_guests;
      if (mainPhotoUrl !== null) fields.main_photo_url = mainPhotoUrl;
      if (amenitiesJson !== null) fields.amenities_json = amenitiesJson;

      const findRes = await sb(
        context,
        `appartements?user_id=eq.${userId}&source=eq.easy_concierge&external_id=eq.${encodeURIComponent(propertyId)}&select=id`
      );

      if (!findRes.ok) {
        errors.push({
          scope: 'properties',
          property_id: propertyId,
          message: 'lecture appartement en erreur'
        });
        continue;
      }

      const existing = (await findRes.json())[0];

      if (existing) {
        const patchRes = await sb(context, `appartements?id=eq.${existing.id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify(fields)
        });

        if (!patchRes.ok) {
          errors.push({
            scope: 'properties',
            property_id: propertyId,
            message: 'mise à jour logement en erreur'
          });
          continue;
        }

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
          method: 'POST',
          prefer: 'return=minimal',
          body: JSON.stringify(createBody)
        });

        if (!postRes.ok) {
          errors.push({
            scope: 'properties',
            property_id: propertyId,
            message: 'création logement en erreur'
          });
          continue;
        }

        inserted++;
      }
    } catch (e) {
      errors.push({
        scope: 'properties',
        property_id: propertyId,
        message: e.message
      });
    }
  }

  return { properties, inserted, updated, errors };
}

function normalizeBookingStatus(status) {
  return String(status || '').toLowerCase() === 'cancelled'
    ? 'cancelled'
    : 'confirmed';
}

async function syncOneBooking(context, userId, aptId, booking) {
  const bookingId =
    booking && booking.booking_id != null ? String(booking.booking_id) : null;

  if (!bookingId) {
    return {
      skipped: true,
      message: 'booking_id manquant'
    };
  }

  const fields = {
    user_id: userId,
    appartement_id: aptId,
    source: 'easy_concierge',
    external_booking_id: bookingId,
    date_from: booking.check_in || null,
    date_to: booking.check_out || null,
    nights: toNum(booking.nights, 0),
    guest_count: toNum(booking.guests, 1),
    guest_name: booking.guest_ref || 'Voyageur pseudonymisé',
    platform: booking.channel || 'other',
    status: normalizeBookingStatus(booking.status),
    price_total: toNum(booking.revenue, 0)
  };

  const findRes = await sb(
    context,
    `reservations?user_id=eq.${userId}&source=eq.easy_concierge&external_booking_id=eq.${encodeURIComponent(bookingId)}&select=id`
  );

  if (!findRes.ok) throw new Error('lecture réservation en erreur');

  const existing = (await findRes.json())[0];

  let action = 'inserted';
  let reservationId = null;

  if (existing) {
    reservationId = existing.id;

    const patchRes = await sb(context, `reservations?id=eq.${existing.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify(fields)
    });

    if (!patchRes.ok) throw new Error('mise à jour réservation en erreur');

    action = 'updated';
  } else {
    const postRes = await sb(context, 'reservations', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify(fields)
    });

    if (!postRes.ok) throw new Error('création réservation en erreur');

    const created = await postRes.json().catch(() => []);
    reservationId = created && created[0] ? created[0].id : null;
  }

  if (reservationId && booking.cleaning_fee != null) {
    const finBody = {
      reservation_id: reservationId,
      user_id: userId,
      source: 'easy_concierge',
      gross_amount: toNum(booking.revenue, 0),
      cleaning_fee: toNum(booking.cleaning_fee, 0),
      net_profit: null
    };

    await sb(context, 'reservation_financials', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(finBody)
    }).catch(() => {});
  }

  return { action };
}

async function syncBookings(context, userId, config, aptMap, properties) {
  let inserted = 0;
  let updated = 0;
  const errors = [];
  let bookingsTouched = 0;

  for (const p of properties) {
    const propertyId = p && p.property_id != null ? String(p.property_id) : null;
    if (!propertyId) continue;

    const apt = aptMap.get(propertyId);

    if (!apt) {
      errors.push({
        scope: 'bookings',
        property_id: propertyId,
        message: 'logement non trouvé côté RentyQ'
      });
      continue;
    }

    let bookings = [];

    try {
      bookings = await fetchAllBookings(config, {
        property_id: propertyId
      });
    } catch (e) {
      errors.push({
        scope: 'bookings',
        property_id: propertyId,
        message: e.message
      });
      continue;
    }

    for (const b of bookings) {
      try {
        if (b.property_id != null && String(b.property_id) !== propertyId) continue;

        const res = await syncOneBooking(context, userId, apt.id, b);

        if (res.action === 'inserted') inserted++;
        if (res.action === 'updated') updated++;

        bookingsTouched++;
      } catch (e) {
        errors.push({
          scope: 'bookings',
          property_id: propertyId,
          booking_id: b && b.booking_id,
          message: e.message
        });
      }
    }
  }

  if (bookingsTouched === 0) {
    errors.push({
      scope: 'bookings',
      message:
        'Aucune réservation importée. Vérifier que resource=bookings&property_id=<id> renvoie bien les réservations du logement.'
    });
  }

  return { inserted, updated, errors };
}

function normalizeOverallScore(raw) {
  const n = Number(raw);

  if (!Number.isFinite(n)) return null;

  if (n <= 5) return n;
  if (n <= 10) return Math.round((n / 2) * 100) / 100;

  return Math.round((n / 20) * 100) / 100;
}

async function syncReviews(context, userId, config, aptMap) {
  let inserted = 0;
  let updated = 0;
  const errors = [];

  let reviews = [];

  try {
    reviews = await fetchAllReviews(config);
  } catch (e) {
    return {
      inserted,
      updated,
      errors: [{ scope: 'reviews', message: e.message }]
    };
  }

  const payload = [];
  const aggregates = new Map();

  for (const r of reviews) {
    const propertyId = r && r.property_id != null ? String(r.property_id) : null;
    const apt = propertyId ? aptMap.get(propertyId) : null;

    if (!propertyId || !apt) {
      errors.push({
        scope: 'reviews',
        property_id: propertyId,
        message: 'logement non trouvé — avis ignoré'
      });
      continue;
    }

    const extId = `${propertyId}_${r.received_at || ''}_${r.channel || ''}`;
    const rating5 = normalizeOverallScore(r.overall_score);

    payload.push({
      user_id: userId,
      appartement_id: apt.id,
      source: 'easy_concierge',
      external_review_id: extId,

      platform: r.channel || null,

      overall_score: r.overall_score == null ? null : toNum(r.overall_score, null),
      rating: rating5,

      cleanliness_score:
        r.scores && r.scores.cleanliness != null ? toNum(r.scores.cleanliness, null) : null,

      communication_score:
        r.scores && r.scores.communication != null ? toNum(r.scores.communication, null) : null,

      location_score:
        r.scores && r.scores.location != null ? toNum(r.scores.location, null) : null,

      value_score:
        r.scores && r.scores.value != null ? toNum(r.scores.value, null) : null,

      checkin_score:
        r.scores && r.scores.checkin != null ? toNum(r.scores.checkin, null) : null,

      review_text: r.content || null,
      comment: r.content || null,

      review_date: r.received_at || null,
      created_at: r.received_at || new Date().toISOString()
    });

    if (rating5 != null) {
      const a = aggregates.get(apt.id) || { sum: 0, count: 0 };
      a.sum += rating5;
      a.count++;
      aggregates.set(apt.id, a);
    }
  }

  if (!payload.length) {
    return {
      inserted,
      updated,
      errors: errors.concat([{ scope: 'reviews', message: 'aucun avis exploitable à synchroniser' }])
    };
  }

  try {
    const upsertRes = await sb(context, 'reviews?on_conflict=source,external_review_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(payload)
    });

    if (!upsertRes.ok) {
      const detail = await upsertRes.text().catch(() => '');
      errors.push({
        scope: 'reviews',
        message: 'upsert batch reviews impossible : ' + detail.slice(0, 500)
      });
    } else {
      const rows = await upsertRes.json().catch(() => []);
      updated = Array.isArray(rows) ? rows.length : payload.length;
    }
  } catch (e) {
    errors.push({
      scope: 'reviews',
      message: 'upsert batch reviews erreur : ' + e.message
    });
  }

  const aggregatePayload = [];

  for (const [aptId, agg] of aggregates.entries()) {
    const note = agg.count ? Math.round((agg.sum / agg.count) * 100) / 100 : null;

    if (note != null) {
      aggregatePayload.push({
        id: aptId,
        note,
        nb_avis: agg.count
      });
    }
  }

  if (aggregatePayload.length) {
    try {
      const aggRes = await sb(context, 'appartements?on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(aggregatePayload)
      });

      if (!aggRes.ok) {
        const detail = await aggRes.text().catch(() => '');
        errors.push({
          scope: 'reviews_aggregate',
          message: 'upsert batch appartements note/nb_avis impossible : ' + detail.slice(0, 500)
        });
      }
    } catch (e) {
      errors.push({
        scope: 'reviews_aggregate',
        message: 'upsert batch appartements erreur : ' + e.message
      });
    }
  }

  return {
    inserted,
    updated,
    errors
  };
}

function extractPrice(item) {
  const candidates = [
    item.price,
    item.rate,
    item.night_price,
    item.amount,
    item.base_price
  ];

  for (const c of candidates) {
    const n = Number(c);

    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

async function syncPricing(context, config, aptMap, properties) {
  let pricingUpdated = 0;
  const errors = [];

  for (const p of properties) {
    const propertyId = p && p.property_id != null ? String(p.property_id) : null;
    if (!propertyId) continue;

    const apt = aptMap.get(propertyId);
    if (!apt) continue;

    try {
      const pricingRows = await fetchPricingForProperty(config, propertyId);

      let firstPrice = null;

      for (const row of pricingRows) {
        firstPrice = extractPrice(row);
        if (firstPrice != null) break;
      }

      if (firstPrice != null) {
        const patchRes = await sb(context, `appartements?id=eq.${apt.id}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({
            price: firstPrice
          })
        });

        if (!patchRes.ok) throw new Error('mise à jour price impossible');

        pricingUpdated++;
      } else {
        errors.push({
          scope: 'pricing',
          property_id: propertyId,
          message: 'aucun prix non nul trouvé sur 30 jours'
        });
      }
    } catch (e) {
      errors.push({
        scope: 'pricing',
        property_id: propertyId,
        message: e.message
      });
    }
  }

  return { pricingUpdated, errors };
}

async function handleSyncAll(context, body) {
  const userId = await resolveUserId(context);

  if (!userId) {
    return json({
      success: false,
      errors: [{ message: 'unauthorized' }]
    }, 401);
  }

  let conn;

  try {
    conn = await getConnection(context, userId, body && body.connection_id);
  } catch (e) {
    return json({
      success: false,
      errors: [{ message: e.message }]
    }, e.message.includes('introuvable') ? 404 : 400);
  }

  const baseUrl = conn.base_url || context.env.EASY_CONCIERGE_BASE_URL;

  if (!baseUrl) {
    return json({
      success: false,
      errors: [{ message: 'missing_base_url' }]
    }, 500);
  }

  const config = {
    baseUrl,
    apiKey: conn.api_key,
    tenant: conn.tenant
  };

  const errors = [];

  const summary = {
    success: true,

    propertiesInserted: 0,
    propertiesUpdated: 0,

    bookingsInserted: 0,
    bookingsUpdated: 0,

    reviewsInserted: 0,
    reviewsUpdated: 0,

    pricingUpdated: 0,

    errors
  };

  try {
    const propRes = await syncProperties(context, userId, config);

    summary.propertiesInserted = propRes.inserted;
    summary.propertiesUpdated = propRes.updated;
    errors.push(...propRes.errors);

    const aptMap = await getAppartementsMap(context, userId);

    const bookingsRes = await syncBookings(context, userId, config, aptMap, propRes.properties);

    summary.bookingsInserted = bookingsRes.inserted;
    summary.bookingsUpdated = bookingsRes.updated;
    errors.push(...bookingsRes.errors);

    const reviewsRes = await syncReviews(context, userId, config, aptMap);

    summary.reviewsInserted = reviewsRes.inserted;
    summary.reviewsUpdated = reviewsRes.updated;
    errors.push(...reviewsRes.errors);

    const pricingRes = await syncPricing(context, config, aptMap, propRes.properties);

    summary.pricingUpdated = pricingRes.pricingUpdated;
    errors.push(...pricingRes.errors);

    await sb(context, `pms_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({
        status: 'connected',
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});

    return json(summary);
  } catch (e) {
    await sb(context, `pms_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({
        status: 'error',
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});

    errors.push({
      scope: 'sync',
      message: e.message
    });

    summary.success = false;

    return json(summary, 500);
  }
}
async function getSyncContext(context, body) {
  const userId = await resolveUserId(context);
  if (!userId) throw new Error('unauthorized');

  const conn = await getConnection(context, userId, body && body.connection_id);

  const baseUrl = conn.base_url || context.env.EASY_CONCIERGE_BASE_URL;
  if (!baseUrl) throw new Error('missing_base_url');

  const config = {
    baseUrl,
    apiKey: conn.api_key,
    tenant: conn.tenant
  };

  return { userId, conn, config };
}

async function handleSyncPropertiesOnly(context, body) {
  try {
    const { userId, conn, config } = await getSyncContext(context, body);

    const propRes = await syncProperties(context, userId, config);

    await sb(context, `pms_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({
        status: 'connected',
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});

    return json({
      success: true,
      propertiesInserted: propRes.inserted,
      propertiesUpdated: propRes.updated,
      inserted: propRes.inserted,
      updated: propRes.updated,
      errors: propRes.errors || []
    });
  } catch (e) {
    return json({
      success: false,
      propertiesInserted: 0,
      propertiesUpdated: 0,
      errors: [{ scope: 'properties', message: e.message }]
    }, e.message === 'unauthorized' ? 401 : 500);
  }
}

async function handleSyncBookingsOnly(context, body) {
  try {
    const { userId, config } = await getSyncContext(context, body);

    const properties = await fetchAllProperties(config);
    const aptMap = await getAppartementsMap(context, userId);

    const bookingsRes = await syncBookings(context, userId, config, aptMap, properties);

    return json({
      success: true,
      bookingsInserted: bookingsRes.inserted,
      bookingsUpdated: bookingsRes.updated,
      errors: bookingsRes.errors || []
    });
  } catch (e) {
    return json({
      success: false,
      bookingsInserted: 0,
      bookingsUpdated: 0,
      errors: [{ scope: 'bookings', message: e.message }]
    }, e.message === 'unauthorized' ? 401 : 500);
  }
}

async function handleSyncReviewsOnly(context, body) {
  try {
    const { userId, config } = await getSyncContext(context, body);

    const aptMap = await getAppartementsMap(context, userId);
    const reviewsRes = await syncReviews(context, userId, config, aptMap);

    return json({
      success: true,
      reviewsInserted: reviewsRes.inserted,
      reviewsUpdated: reviewsRes.updated,
      errors: reviewsRes.errors || []
    });
  } catch (e) {
    return json({
      success: false,
      reviewsInserted: 0,
      reviewsUpdated: 0,
      errors: [{ scope: 'reviews', message: e.message }]
    }, e.message === 'unauthorized' ? 401 : 500);
  }
}

async function handleSyncPricingOnly(context, body) {
  try {
    const { userId, config } = await getSyncContext(context, body);

    const properties = await fetchAllProperties(config);
    const aptMap = await getAppartementsMap(context, userId);

    const pricingRes = await syncPricing(context, config, aptMap, properties);

    return json({
      success: true,
      pricingUpdated: pricingRes.pricingUpdated,
      errors: pricingRes.errors || []
    });
  } catch (e) {
    return json({
      success: false,
      pricingUpdated: 0,
      errors: [{ scope: 'pricing', message: e.message }]
    }, e.message === 'unauthorized' ? 401 : 500);
  }
}
export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const action = body && body.action;

    if (action === 'test') return await handleTest(context, body);

    if (action === 'sync-all') {
  return await handleSyncAll(context, body);
}

if (action === 'sync-properties') {
  return await handleSyncPropertiesOnly(context, body);
}

if (action === 'sync-bookings') {
  return await handleSyncBookingsOnly(context, body);
}

if (action === 'sync-reviews') {
  return await handleSyncReviewsOnly(context, body);
}

if (action === 'sync-pricing') {
  return await handleSyncPricingOnly(context, body);
}

    return json({
      error: 'unknown_action',
allowed_actions: ['test', 'sync-all', 'sync-properties', 'sync-bookings', 'sync-reviews', 'sync-pricing']    }, 400);
  } catch (err) {
    return json({
      error: 'server_error',
      detail: err.message
    }, 500);
  }
}

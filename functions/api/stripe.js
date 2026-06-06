// Cloudflare Pages Function — /api/stripe
const STRIPE_SECRET = 'sk_test_51TdYAi2KSiLvAG7LYgmnMjP9AaaNgKFQZ9Qnapy3CNjIZpJCpkJcR4UrRj8EwLojxw2HNYIZfgt0xTIZOiNYF77l00sUqeKgKy';
const SITE_URL = 'https://rentyq.fr';

const PLANS = {
  starter: { name: 'Starter', price: 2900, interval: 'month' },
  pro: { name: 'Pro', price: 7900, interval: 'month' },
};

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
    const { action, plan, email, customerId } = await context.request.json();

    switch (action) {

      case 'createCheckout': {
        if (!plan || !PLANS[plan]) {
          return new Response(JSON.stringify({ error: 'Plan invalide' }), { status: 400, headers });
        }

        const priceRes = await stripeRequest('POST', '/prices', {
          currency: 'eur',
          unit_amount: PLANS[plan].price,
          recurring: { interval: PLANS[plan].interval },
          product_data: { name: `RentiQ ${PLANS[plan].name}` }
        });

        if (priceRes.error) {
          return new Response(JSON.stringify({ error: priceRes.error.message }), { status: 400, headers });
        }

        const sessionData = {
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: priceRes.id, quantity: 1 }],
          success_url: `${SITE_URL}?payment=success&plan=${plan}`,
          cancel_url: `${SITE_URL}?payment=cancelled`,
          allow_promotion_codes: true,
          subscription_data: {
            trial_period_days: 14,
            metadata: { plan, site: 'rentiq' }
          }
        };

        if (email) sessionData.customer_email = email;

        const session = await stripeRequest('POST', '/checkout/sessions', sessionData);

        if (session.error) {
          return new Response(JSON.stringify({ error: session.error.message }), { status: 400, headers });
        }

        return new Response(JSON.stringify({ url: session.url, sessionId: session.id }), { headers });
      }

      case 'getSubscription': {
        if (!customerId) {
          return new Response(JSON.stringify({ error: 'Customer ID manquant' }), { status: 400, headers });
        }

        const subs = await stripeRequest('GET', `/subscriptions?customer=${customerId}&status=active&limit=1`);

        if (subs.data && subs.data.length > 0) {
          const sub = subs.data[0];
          return new Response(JSON.stringify({
            active: true,
            plan: sub.metadata?.plan || 'starter',
            status: sub.status,
            trial_end: sub.trial_end,
            current_period_end: sub.current_period_end
          }), { headers });
        }

        return new Response(JSON.stringify({ active: false }), { headers });
      }

      case 'createPortal': {
        if (!customerId) {
          return new Response(JSON.stringify({ error: 'Customer ID manquant' }), { status: 400, headers });
        }

        const portal = await stripeRequest('POST', '/billing_portal/sessions', {
          customer: customerId,
          return_url: SITE_URL
        });

        return new Response(JSON.stringify({ url: portal.url }), { headers });
      }

      default:
        return new Response(JSON.stringify({ error: 'Action inconnue' }), { status: 400, headers });
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Erreur serveur: ' + err.message }), { status: 500, headers });
  }
}

async function stripeRequest(method, path, data) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };

  if (data && (method === 'POST' || method === 'PUT')) {
    opts.body = toFormData(data);
  }

  const res = await fetch(`https://api.stripe.com/v1${path}`, opts);
  return await res.json();
}

function toFormData(obj, prefix) {
  const parts = [];
  for (const key in obj) {
    if (obj[key] === undefined || obj[key] === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      parts.push(toFormData(obj[key], fullKey));
    } else if (Array.isArray(obj[key])) {
      obj[key].forEach((item, i) => {
        if (typeof item === 'object') {
          parts.push(toFormData(item, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(obj[key])}`);
    }
  }
  return parts.join('&');
}

const STRIPE_SECRET = 'sk_test_51TdYAi2KSiLvAG7LYgmnMjP9AaaNgKFQZ9Qnapy3CNjIZpJCpkJcR4UrRj8EwLojxw2HNYIZfgt0xTIZOiNYF77l00sUqeKgKy';
const SITE_URL = 'https://effervescent-puppy-a152df.netlify.app';

const PLANS = {
  starter: { name: 'Starter', price: 2900, interval: 'month' },
  pro: { name: 'Pro', price: 7900, interval: 'month' },
};

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
    const { action, plan, email, customerId, subscriptionId } = JSON.parse(event.body || '{}');

    switch (action) {

      // Créer une session de paiement Stripe Checkout
      case 'createCheckout': {
        if (!plan || !PLANS[plan]) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Plan invalide' }) };
        }

        // Créer ou récupérer le prix dans Stripe
        const priceRes = await stripeRequest('POST', '/prices', {
          currency: 'eur',
          unit_amount: PLANS[plan].price,
          recurring: { interval: PLANS[plan].interval },
          product_data: { name: `Sublyfe ${PLANS[plan].name}` }
        });

        if (priceRes.error) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: priceRes.error.message }) };
        }

        // Créer la session Checkout
        const sessionData = {
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: priceRes.id, quantity: 1 }],
          success_url: `${SITE_URL}?payment=success&plan=${plan}`,
          cancel_url: `${SITE_URL}?payment=cancelled`,
          allow_promotion_codes: true,
          subscription_data: {
            trial_period_days: 14,
            metadata: { plan, site: 'sublyfe' }
          }
        };

        if (email) sessionData.customer_email = email;

        const session = await stripeRequest('POST', '/checkout/sessions', sessionData);

        if (session.error) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: session.error.message }) };
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ url: session.url, sessionId: session.id })
        };
      }

      // Récupérer l'abonnement actif d'un customer
      case 'getSubscription': {
        if (!customerId) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Customer ID manquant' }) };
        }

        const subs = await stripeRequest('GET', `/subscriptions?customer=${customerId}&status=active&limit=1`);

        if (subs.data && subs.data.length > 0) {
          const sub = subs.data[0];
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              active: true,
              plan: sub.metadata?.plan || 'starter',
              status: sub.status,
              trial_end: sub.trial_end,
              current_period_end: sub.current_period_end
            })
          };
        }

        return { statusCode: 200, headers, body: JSON.stringify({ active: false }) };
      }

      // Créer un portail client pour gérer l'abonnement
      case 'createPortal': {
        if (!customerId) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Customer ID manquant' }) };
        }

        const portal = await stripeRequest('POST', '/billing_portal/sessions', {
          customer: customerId,
          return_url: SITE_URL
        });

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ url: portal.url })
        };
      }

      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Action inconnue' }) };
    }

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur serveur: ' + err.message })
    };
  }
};

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


const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const CryptoJS = require('crypto-js');
const router = express.Router();

// Cette route utilise la service key (bypass RLS) -- toutes les tables
// grocery_* sont deny-by-default sans elle, voir migrations Supabase.
let supabase = null;
const getSupabase = () => {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set');
  supabase = createClient(url, key);
  return supabase;
};

// PostgREST plafonne un select a 1000 lignes par defaut -- necessaire pour
// grocery_purchase_history (3000+ lignes)
async function fetchAll(table, select) {
  const sb = getSupabase();
  const rows = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb.from(table).select(select).range(offset, offset + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

// ---------------------------------------------------------------------
// SYNC MAXI (historique de commandes -- incrementale, basee sur order_number)
// ---------------------------------------------------------------------

const MAXI_API_BASE = 'https://api.pcexpress.ca/pcx-bff/api/v1/ecommerce/v2/maxi/customers';
const MAXI_API_HEADERS_BASE = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'fr',
  'Business-User-Agent': 'PCXWEB',
  'Content-Type': 'application/json',
  Origin: 'https://www.maxi.ca',
  Referer: 'https://www.maxi.ca/',
  'Site-Banner': 'maxi',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'is-helios-account': 'true',
  'x-apikey': 'C1xujSegT5j3ap3yexJjqhOfELwGKYvz',
  'x-application-type': 'Web',
  'x-loblaw-tenant-id': 'ONLINE_GROCERIES',
};

async function getMaxiToken(sb) {
  const { data, error } = await sb
    .from('grocery_secrets')
    .select('value_encrypted, expires_at')
    .eq('key', 'maxi_access_token')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { token: null, expired: null };
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error('ENCRYPTION_KEY manquante');
  const token = CryptoJS.AES.decrypt(data.value_encrypted, encKey).toString(CryptoJS.enc.Utf8);
  const expired = data.expires_at ? new Date(data.expires_at) < new Date() : null;
  return { token, expired };
}

// Compare l'historique Maxi a ce qu'on a deja (order_number = cle de dedup),
// n'importe que les commandes manquantes. Ne touche jamais au panier Maxi
// lui-meme -- lecture seule sur l'API PC Express.
async function syncMaxiOrders(sb) {
  const { token, expired } = await getMaxiToken(sb);
  if (!token) return { success: false, error: 'Aucun token Maxi enregistré.' };
  if (expired) return { success: false, error: 'Token Maxi expiré -- reconnecte-toi sur Maxi.ca et recolle-le.' };

  const headers = { ...MAXI_API_HEADERS_BASE, Authorization: `bearer ${token}` };

  const historyRes = await fetch(`${MAXI_API_BASE}/historical-orders`, { headers });
  if (!historyRes.ok) {
    if (historyRes.status === 401 || historyRes.status === 403) {
      return { success: false, error: 'Token Maxi invalide ou expiré -- reconnecte-toi et recolle-le.' };
    }
    return { success: false, error: `Erreur API Maxi (${historyRes.status})` };
  }
  const historyData = await historyRes.json();
  const orderList = Array.isArray(historyData) ? historyData : (historyData.orderHistory || historyData.orders || []);

  const { data: existingOrders, error: existErr } = await sb.from('grocery_orders').select('order_number');
  if (existErr) throw existErr;
  const existingSet = new Set(existingOrders.map((o) => o.order_number));

  const newSummaries = orderList.filter((o) => {
    const num = o.id || o.code || o.orderNumber;
    return num && !existingSet.has(String(num));
  });

  const { count: totalBefore } = await sb.from('grocery_orders').select('id', { count: 'exact', head: true });

  if (newSummaries.length === 0) {
    return { success: true, new_orders: 0, total_orders: totalBefore, message: 'Données à jour, aucune nouvelle commande.' };
  }

  const products = new Map();
  const ordersRows = [];
  const purchaseRows = [];

  for (const summary of newSummaries) {
    const orderNumber = String(summary.id || summary.code || summary.orderNumber);
    const detailRes = await fetch(`${MAXI_API_BASE}/historical-orders/${orderNumber}`, { headers });
    const detail = detailRes.ok ? await detailRes.json() : summary;

    const od = detail.orderDetails || {};
    const booking = od.booking || {};
    const pickup = booking.pickupLocation || {};
    const orderDate = booking.pickupStartDate;
    if (!orderDate) continue; // sans date on ne peut pas la situer dans l'historique

    const orderId = crypto.randomUUID();
    ordersRows.push({
      id: orderId,
      order_number: orderNumber,
      order_type: od.orderType === 'ONLINE' ? 'online' : 'offline',
      store_id: pickup.storeId || null,
      store_name: pickup.name || null,
      order_date: orderDate,
      subtotal: od.subTotal ?? null,
      total_price: od.totalPrice ?? null,
      total_price_with_tax: od.totalPriceWithTax ?? null,
      total_items: od.totalItems ?? null,
      points_earned: detail.pointsEarned ?? null,
      points_redeemed: detail.pointsRedeemed ?? null,
      raw_payload: {
        comment: od.comment ?? null,
        paymentType: od.paymentType ?? null,
        status: od.status ?? null,
        appliedVouchers: od.appliedVouchers ?? null,
      },
    });

    for (const entry of od.entries || []) {
      const p = entry.product || {};
      const articleNumber = p.articleNumber ? String(p.articleNumber) : null;
      if (!articleNumber) continue; // items sans code produit (comptoir/boulangerie), pas rattachables
      const weight = entry.weight ?? null;

      if (!products.has(articleNumber)) {
        products.set(articleNumber, {
          article_number: articleNumber,
          product_name: p.productName || articleNumber,
          brand: p.brand || null,
          is_weighted: weight != null,
          product_url: p.link ? `https://www.maxi.ca/fr${p.link}` : null,
          image_url: p.primaryImage || null,
        });
      }

      purchaseRows.push({
        id: crypto.randomUUID(),
        order_id: orderId,
        article_number: articleNumber,
        quantity: entry.quantity ?? null,
        weight,
        unit_price: entry.unitPrice ?? null,
        total_price: entry.totalPrice ?? null,
        purchased_at: orderDate,
      });
    }

    await new Promise((r) => setTimeout(r, 150)); // ne pas marteler l'API Maxi
  }

  if (products.size) {
    const { error: prodErr } = await sb
      .from('grocery_products')
      .upsert([...products.values()], { onConflict: 'article_number' });
    if (prodErr) throw prodErr;
  }
  if (ordersRows.length) {
    const { error: ordErr } = await sb.from('grocery_orders').insert(ordersRows);
    if (ordErr) throw ordErr;
  }
  for (let i = 0; i < purchaseRows.length; i += 500) {
    const { error: purchErr } = await sb.from('grocery_purchase_history').insert(purchaseRows.slice(i, i + 500));
    if (purchErr) throw purchErr;
  }

  return {
    success: true,
    new_orders: ordersRows.length,
    total_orders: (totalBefore || 0) + ordersRows.length,
    message: `${ordersRows.length} nouvelle(s) commande(s) importée(s).`,
  };
}

// POST /api/epicerie/sync-orders  (declenchement manuel)
router.post('/sync-orders', async (req, res) => {
  try {
    const sb = getSupabase();
    const result = await syncMaxiOrders(sb);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------

function rangeToSince(range) {
  const d = new Date();
  switch ((range || 'ALL').toUpperCase()) {
    case 'L30D': d.setDate(d.getDate() - 30); return d;
    case 'L90D': d.setDate(d.getDate() - 90); return d;
    case 'L120D': d.setDate(d.getDate() - 120); return d;
    case 'L6M': d.setMonth(d.getMonth() - 6); return d;
    case 'L1Y': d.setFullYear(d.getFullYear() - 1); return d;
    case 'L2Y': d.setFullYear(d.getFullYear() - 2); return d;
    default: return null; // ALL
  }
}

// GET /api/epicerie/dashboard/top-products?limit=50&range=L90D
router.get('/dashboard/top-products', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const since = rangeToSince(req.query.range);
    const sb = getSupabase();

    let orderCountQuery = sb.from('grocery_orders').select('id', { count: 'exact', head: true });
    if (since) orderCountQuery = orderCountQuery.gte('order_date', since.toISOString());
    const { count: totalOrders, error: countErr } = await orderCountQuery;
    if (countErr) throw countErr;

    let lines = await fetchAll('grocery_purchase_history', 'order_id, article_number, quantity, weight, unit_price, purchased_at');
    if (since) lines = lines.filter((l) => new Date(l.purchased_at) >= since);

    const byProduct = new Map();
    for (const l of lines) {
      if (!byProduct.has(l.article_number)) byProduct.set(l.article_number, { orderIds: new Set(), qty: [], weights: [], prices: [] });
      const e = byProduct.get(l.article_number);
      e.orderIds.add(l.order_id);
      if (l.quantity > 0) e.qty.push(l.quantity);
      if (l.weight != null) e.weights.push(l.weight);
      if (l.unit_price != null) e.prices.push(l.unit_price);
    }

    const ranked = [...byProduct.entries()]
      .map(([article_number, e]) => ({
        article_number,
        orders: e.orderIds.size,
        frequency_pct: totalOrders ? Math.round((e.orderIds.size / totalOrders) * 1000) / 10 : 0,
        avg_qty: e.qty.length ? Math.round(e.qty.reduce((a, b) => a + b, 0) / e.qty.length) : null,
        // au poids (bananes, fromage, viande...): quantity vaut 0, seul le poids a du sens
        avg_weight: e.weights.length ? Math.round((e.weights.reduce((a, b) => a + b, 0) / e.weights.length) * 100) / 100 : null,
        avg_price: e.prices.length ? Math.round((e.prices.reduce((a, b) => a + b, 0) / e.prices.length) * 100) / 100 : null,
      }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, limit);

    const { data: products, error: prodErr } = await sb
      .from('grocery_products')
      .select('article_number, product_name, brand, is_weighted, image_url')
      .in('article_number', ranked.map((r) => r.article_number));
    if (prodErr) throw prodErr;
    const byArticle = new Map(products.map((p) => [p.article_number, p]));

    const { data: rules, error: rulesErr } = await sb
      .from('grocery_product_rules')
      .select('article_number, blacklisted, whitelisted')
      .in('article_number', ranked.map((r) => r.article_number));
    if (rulesErr) throw rulesErr;
    const byRule = new Map(rules.map((r) => [r.article_number, r]));

    res.json({
      success: true,
      total_orders: totalOrders,
      products: ranked.map((r) => ({
        ...r,
        ...byArticle.get(r.article_number),
        blacklisted: !!byRule.get(r.article_number)?.blacklisted,
        whitelisted: !!byRule.get(r.article_number)?.whitelisted,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

// GET /api/epicerie/config
router.get('/config', async (req, res) => {
  try {
    const sb = getSupabase();
    const [configRes, householdRes, rulesRes, tokenRes] = await Promise.all([
      sb.from('grocery_config').select('*'),
      sb.from('grocery_household_config').select('*').order('updated_at', { ascending: false }).limit(1),
      sb.from('grocery_product_rules').select('*').order('updated_at', { ascending: false }),
      sb.from('grocery_secrets').select('captured_at, expires_at').eq('key', 'maxi_access_token').maybeSingle(),
    ]);
    if (configRes.error) throw configRes.error;
    if (householdRes.error) throw householdRes.error;
    if (rulesRes.error) throw rulesRes.error;
    if (tokenRes.error) throw tokenRes.error;

    // thumbnail + nom produit pour l'affichage blacklist/whitelist -- sans ca
    // les regles n'affichent qu'un numero d'article illisible
    const ruleArticleNumbers = rulesRes.data.map((r) => r.article_number);
    const { data: ruleProducts, error: ruleProdErr } = await sb
      .from('grocery_products')
      .select('article_number, product_name, image_url')
      .in('article_number', ruleArticleNumbers.length ? ruleArticleNumbers : ['']);
    if (ruleProdErr) throw ruleProdErr;
    const ruleProductByArticle = new Map(ruleProducts.map((p) => [p.article_number, p]));
    const rules = rulesRes.data.map((r) => ({
      ...r,
      product_name: ruleProductByArticle.get(r.article_number)?.product_name || null,
      image_url: ruleProductByArticle.get(r.article_number)?.image_url || null,
    }));

    const tokenExpired = tokenRes.data?.expires_at ? new Date(tokenRes.data.expires_at) < new Date() : null;

    res.json({
      success: true,
      config: configRes.data,
      household: householdRes.data[0] || null,
      rules,
      token: tokenRes.data
        ? { present: true, captured_at: tokenRes.data.captured_at, expires_at: tokenRes.data.expires_at, expired: tokenExpired }
        : { present: false },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/epicerie/config  { key, value }
router.put('/config', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ success: false, error: 'key requis' });
    const sb = getSupabase();
    const { error } = await sb
      .from('grocery_config')
      .upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/epicerie/household-config
router.put('/household-config', async (req, res) => {
  try {
    const { eliane_present_week, julie_present_week, next_pattern_date } = req.body;
    const sb = getSupabase();
    const { data: existing, error: findErr } = await sb.from('grocery_household_config').select('id').limit(1);
    if (findErr) throw findErr;

    const payload = { eliane_present_week, julie_present_week, next_pattern_date, updated_at: new Date().toISOString() };
    const { error } = existing?.[0]
      ? await sb.from('grocery_household_config').update(payload).eq('id', existing[0].id)
      : await sb.from('grocery_household_config').insert(payload);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// NEXT_GROCERY_CONFIG -- config ponctuelle par cycle de planification,
// consommee par la skill externe maxi-reco-items (voir grocery_agent_log).
// Budget et presence Julie/Eliane ne sont PAS dupliques ici -- lus depuis
// grocery_config (palier actif) et grocery_household_config (presence
// hebdo), fusionnes en lecture seule dans la reponse GET.
//
// Cycle de statuts: draft -> ready -> recommendation_in_progress ->
// recommendation_ready -> approved -> queue_updated -> completed, avec
// branches changes_requested (retour a recommendation_in_progress),
// cancelled (depuis n'importe quel statut) et error. Michel controle
// draft/ready/changes_requested/approved/cancelled ; maxi-reco-items
// controle recommendation_in_progress/recommendation_ready/queue_updated/
// completed/error. Un changement de statut ici ne declenche jamais
// d'execution automatique -- maxi-reco-items va lire l'etat quand on
// l'appelle separement.
// ---------------------------------------------------------------------

const NEXT_CONFIG_FIELDS = [
  'status', 'target_date_or_week', 'dinner_count', 'additional_people_count', 'max_prep_time',
  'meal_types', 'temporary_preferences', 'temporary_exclusions', 'recurring_whitelist_policy',
  'substitution_policy', 'notes', 'approved_at',
];

// Enrichit un cycle next_config avec le palier de budget actif et la
// presence Julie/Eliane -- valeurs derivees, jamais stockees ici.
async function enrichNextConfig(sb, config) {
  if (!config) return null;
  const [{ data: configRows }, { data: householdRows }] = await Promise.all([
    sb.from('grocery_config').select('key, value').in('key', ['grocery_budget_tier_selected', 'grocery_budget_tier_1_min', 'grocery_budget_tier_1_max', 'grocery_budget_tier_2_min', 'grocery_budget_tier_2_max', 'grocery_budget_tier_3_min', 'grocery_budget_tier_3_max']),
    sb.from('grocery_household_config').select('eliane_present_week, julie_present_week').order('updated_at', { ascending: false }).limit(1),
  ]);
  const cfg = Object.fromEntries((configRows || []).map((r) => [r.key, r.value]));
  const selectedTier = cfg.grocery_budget_tier_selected || '1';
  const household = householdRows?.[0] || {};
  const julie = !!household.julie_present_week;
  const eliane = !!household.eliane_present_week;
  const peopleCount = Math.min(8, Math.max(1, 1 + (julie ? 1 : 0) + (eliane ? 1 : 0) + (config.additional_people_count || 0)));

  return {
    ...config,
    julie_present: julie,
    eliane_present: eliane,
    people_count: peopleCount,
    budget_tier_selected: selectedTier,
    budget_min: cfg[`grocery_budget_tier_${selectedTier}_min`] || null,
    budget_max: cfg[`grocery_budget_tier_${selectedTier}_max`] || null,
  };
}

// GET /api/epicerie/next-config  (le cycle de planification le plus recent, ou null)
router.get('/next-config', async (req, res) => {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('grocery_next_config')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    res.json({ success: true, config: await enrichNextConfig(sb, data?.[0] || null) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/epicerie/next-config  (demarre un nouveau cycle de planification)
router.post('/next-config', async (req, res) => {
  try {
    const sb = getSupabase();
    const payload = {};
    for (const f of NEXT_CONFIG_FIELDS) if (req.body[f] !== undefined) payload[f] = req.body[f];
    const { data, error } = await sb.from('grocery_next_config').insert(payload).select().single();
    if (error) throw error;
    res.json({ success: true, config: await enrichNextConfig(sb, data) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/epicerie/next-config/:id
router.put('/next-config/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    const payload = {};
    for (const f of NEXT_CONFIG_FIELDS) if (req.body[f] !== undefined) payload[f] = req.body[f];
    if (payload.status === 'approved' && !payload.approved_at) payload.approved_at = new Date().toISOString();
    payload.updated_at = new Date().toISOString();

    const { data, error } = await sb.from('grocery_next_config').update(payload).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, config: await enrichNextConfig(sb, data) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/epicerie/product-rules  (creer/mettre a jour une regle -- blacklist, whitelist, qte preferee)
router.post('/product-rules', async (req, res) => {
  try {
    const { article_number, blacklisted, whitelisted, preferred_qty, notes, category } = req.body;
    if (!article_number) return res.status(400).json({ success: false, error: 'article_number requis' });
    const sb = getSupabase();
    const { data: existing, error: findErr } = await sb
      .from('grocery_product_rules')
      .select('id')
      .eq('article_number', article_number)
      .limit(1);
    if (findErr) throw findErr;

    // `category` sert a classer un produit whitelisté (Éliane/Julie/Ménage) pour
    // le futur moteur de suggestions -- colonne deja presente dans le schema,
    // jamais exploitee avant.
    const payload = { article_number, blacklisted, whitelisted, preferred_qty, notes, category, updated_at: new Date().toISOString() };
    const { error } = existing?.[0]
      ? await sb.from('grocery_product_rules').update(payload).eq('id', existing[0].id)
      : await sb.from('grocery_product_rules').insert(payload);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/epicerie/product-rules/:id  (retirer completement une regle blacklist/whitelist)
router.delete('/product-rules/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    const { error } = await sb.from('grocery_product_rules').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/epicerie/token  (sauvegarde le token Maxi chiffre)
// Le JWT Maxi encode sa propre expiration (claim `exp`, epoch seconds) --
// utilise comme fallback quand expires_at n'est pas fourni explicitement
// (ex: token colle via Telegram, pas de champ date a remplir la-bas).
function decodeJwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

async function saveMaxiToken(sb, token, expiresAt) {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error('ENCRYPTION_KEY manquante');
  const encrypted = CryptoJS.AES.encrypt(token, encKey).toString();
  const { error } = await sb.from('grocery_secrets').upsert(
    {
      key: 'maxi_access_token',
      value_encrypted: encrypted,
      captured_at: new Date().toISOString(),
      expires_at: expiresAt || decodeJwtExpiry(token),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
  if (error) throw error;
  // token frais = bon moment pour rattraper les commandes manquantes
  return syncMaxiOrders(sb);
}

router.post('/token', async (req, res) => {
  try {
    const { token, expires_at } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'token requis' });
    const sb = getSupabase();
    const syncResult = await saveMaxiToken(sb, token, expires_at || null);
    res.json({ success: true, sync: syncResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// LISTE DES COMMANDES (historique)
// ---------------------------------------------------------------------

// GET /api/epicerie/orders?limit=50
router.get('/orders', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const sb = getSupabase();
    const { data, error } = await sb
      .from('grocery_orders')
      .select('id, order_number, order_type, store_name, order_date, total_price, total_items, points_earned')
      .order('order_date', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ success: true, orders: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/epicerie/orders/:id  (detail avec les lignes d'achat)
router.get('/orders/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    const { data: order, error: orderErr } = await sb
      .from('grocery_orders')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (orderErr) throw orderErr;

    const { data: lines, error: linesErr } = await sb
      .from('grocery_purchase_history')
      .select('id, article_number, quantity, weight, unit_price, total_price, grocery_products(product_name, brand, image_url, product_url, is_weighted)')
      .eq('order_id', req.params.id);
    if (linesErr) throw linesErr;

    const { data: rules, error: rulesErr } = await sb
      .from('grocery_product_rules')
      .select('article_number, blacklisted, whitelisted')
      .in('article_number', lines.map((l) => l.article_number));
    if (rulesErr) throw rulesErr;
    const ruleByArticle = new Map(rules.map((r) => [r.article_number, r]));

    const { data: durationRow } = await sb
      .from('grocery_config')
      .select('value')
      .eq('key', 'price_compare_duration_months')
      .maybeSingle();
    const durationMonths = parseInt(durationRow?.value || '6', 10);
    const since = new Date();
    since.setMonth(since.getMonth() - durationMonths);

    const articleNumbers = lines.map((l) => l.article_number);
    const { data: priceHistory, error: priceErr } = await sb
      .from('grocery_purchase_history')
      .select('article_number, unit_price, purchased_at')
      .in('article_number', articleNumbers)
      .gte('purchased_at', since.toISOString());
    if (priceErr) throw priceErr;

    const pricesByArticle = new Map();
    for (const row of priceHistory) {
      if (row.unit_price == null) continue;
      if (!pricesByArticle.has(row.article_number)) pricesByArticle.set(row.article_number, []);
      pricesByArticle.get(row.article_number).push(row.unit_price);
    }

    const enrichedLines = lines.map((l) => {
      const prices = pricesByArticle.get(l.article_number) || [];
      return {
        ...l,
        avg_price_paid: prices.length ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 : null,
        blacklisted: !!ruleByArticle.get(l.article_number)?.blacklisted,
        whitelisted: !!ruleByArticle.get(l.article_number)?.whitelisted,
      };
    });

    res.json({ success: true, order, lines: enrichedLines, price_compare_duration_months: durationMonths });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// CIRCULAIRE (API native Maxi/PC Express -- pas de token requis, seule
// la x-apikey publique suffit, teste explicitement)
// ---------------------------------------------------------------------

const DEALS_URL = 'https://api.pcexpress.ca/pcx-bff/api/v1/products/deals';
const DEALS_SIZE = 48;

function formatUnitPrice(comparisonPrices) {
  if (!comparisonPrices?.length) return null;
  return comparisonPrices.map((c) => `${c.value.toFixed(2)} $/${c.unit}`).join(' · ');
}

async function fetchDealsPage(storeId, page) {
  const res = await fetch(DEALS_URL, {
    method: 'POST',
    headers: MAXI_API_HEADERS_BASE,
    body: JSON.stringify({
      pagination: { from: page, size: DEALS_SIZE },
      banner: 'maxi',
      cartId: '00000000-0000-0000-0000-000000000000',
      lang: 'fr',
      date: new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).replace(/\//g, ''),
      storeId,
      pickupType: 'DELIVERY',
      offerType: 'ALL',
    }),
  });
  if (!res.ok) throw new Error(`deals fetch a echoue (page ${page}): ${res.status}`);
  return res.json();
}

// Refresh complet du circulaire depuis l'API native -- pagination.from est
// un numero de PAGE (pas un offset d'items), et l'API renvoie elle-meme des
// doublons exacts (meme `code`) qu'il faut dedupliquer avant insertion.
async function refreshFlyerDeals(sb) {
  const { data: storeRow } = await sb.from('grocery_config').select('value').eq('key', 'maxi_store_id').maybeSingle();
  const storeId = storeRow?.value || '8981';

  const first = await fetchDealsPage(storeId, 0);
  const total = first.pagination?.totalResults || 0;
  const pages = Math.ceil(total / DEALS_SIZE);

  const byCode = new Map();
  for (const item of first.results || []) if (item.code) byCode.set(item.code, item);
  for (let page = 1; page < pages; page++) {
    const d = await fetchDealsPage(storeId, page);
    for (const item of d.results || []) if (item.code) byCode.set(item.code, item);
    await new Promise((r) => setTimeout(r, 150));
  }

  const rows = [...byCode.values()]
    .filter((item) => item.articleNumber)
    .map((item) => {
      const price = item.prices?.price;
      const wasPrice = item.prices?.wasPrice;
      const memberPrice = item.prices?.memberOnlyPrice;
      const image = item.imageAssets?.[0];
      return {
        sku: item.code,
        article_number: String(item.articleNumber),
        name: item.name,
        brand: item.brand || null,
        price_text: price?.value != null ? price.value.toFixed(2) : null,
        original_price: wasPrice?.value ?? null,
        member_price: memberPrice?.value ?? null,
        unit_price_text: formatUnitPrice(item.prices?.comparisonPrices),
        categories: [],
        valid_from: null,
        valid_to: price?.expiryDate || null,
        in_store_only: false,
        image_url: image?.mediumUrl || image?.largeUrl || image?.thumbnailUrl || null,
        aisle: item.aisle || null,
        product_url: item.link ? `https://www.maxi.ca${item.link}` : null,
        stock_status: item.stockStatus || null,
        badge_label: item.badges?.dealBadge?.name || item.badges?.dealBadge?.type || null,
      };
    });

  const { error: delErr } = await sb.from('grocery_flyer_items').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (delErr) throw delErr;
  const { error: insErr } = await sb.from('grocery_flyer_items').insert(rows);
  if (insErr) throw insErr;

  const syncedAt = new Date().toISOString();
  await sb.from('grocery_config').upsert({ key: 'flyer_last_synced_at', value: syncedAt }, { onConflict: 'key' });

  return { success: true, count: rows.length, store_id: storeId, synced_at: syncedAt, message: `${rows.length} spéciaux importés (magasin ${storeId}).` };
}

// POST /api/epicerie/refresh-flyer  (declenchement manuel)
router.post('/refresh-flyer', async (req, res) => {
  try {
    const sb = getSupabase();
    const result = await refreshFlyerDeals(sb);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/epicerie/flyer
router.get('/flyer', async (req, res) => {
  try {
    const sb = getSupabase();
    // fetchAll (pas .select('*') direct) -- le circulaire natif Maxi tourne
    // autour de ~1800 items, au-dela du plafond de 1000 lignes de PostgREST.
    // Meme raisonnement pour product_rules/products/purchase_history ci-dessous:
    // on recupere les tables au complet plutot qu'un .in(articleNumbers) dont
    // l'URL deviendrait enorme (~1800 numeros d'article).
    const items = await fetchAll('grocery_flyer_items', '*');
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const rules = await fetchAll('grocery_product_rules', 'article_number, blacklisted, whitelisted');
    const ruleByArticle = new Map(rules.map((r) => [r.article_number, r]));

    // deja achete = l'article existe dans notre historique (grocery_products)
    const knownProducts = await fetchAll('grocery_products', 'article_number');
    const knownSet = new Set(knownProducts.map((p) => p.article_number));

    const { data: durationRow } = await sb
      .from('grocery_config')
      .select('value')
      .eq('key', 'price_compare_duration_months')
      .maybeSingle();
    const durationMonths = parseInt(durationRow?.value || '6', 10);
    const since = new Date();
    since.setMonth(since.getMonth() - durationMonths);

    const recentPurchases = (await fetchAll('grocery_purchase_history', 'article_number, purchased_at'))
      .filter((row) => row.purchased_at >= since.toISOString());
    const purchaseCountByArticle = new Map();
    for (const row of recentPurchases) {
      purchaseCountByArticle.set(row.article_number, (purchaseCountByArticle.get(row.article_number) || 0) + 1);
    }

    res.json({
      success: true,
      price_compare_duration_months: durationMonths,
      items: items.map((it) => ({
        ...it,
        blacklisted: !!ruleByArticle.get(it.article_number)?.blacklisted,
        whitelisted: !!ruleByArticle.get(it.article_number)?.whitelisted,
        previously_purchased: knownSet.has(it.article_number),
        recent_purchases: purchaseCountByArticle.get(it.article_number) || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// RECHERCHE (historique complet + circulaire actuel)
// ---------------------------------------------------------------------

// GET /api/epicerie/search?q=fromage
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, items: [] });
    const sb = getSupabase();

    const { data: products, error: prodErr } = await sb
      .from('grocery_products')
      .select('article_number, product_name, brand, image_url, product_url, is_weighted')
      .or(`product_name.ilike.%${q}%,brand.ilike.%${q}%`)
      .limit(50);
    if (prodErr) throw prodErr;

    const articleNumbers = products.map((p) => p.article_number);

    const { data: durationRow } = await sb
      .from('grocery_config')
      .select('value')
      .eq('key', 'price_compare_duration_months')
      .maybeSingle();
    const durationMonths = parseInt(durationRow?.value || '6', 10);
    const since = new Date();
    since.setMonth(since.getMonth() - durationMonths);

    const { data: priceHistory, error: priceErr } = await sb
      .from('grocery_purchase_history')
      .select('article_number, unit_price, quantity, weight, purchased_at')
      .in('article_number', articleNumbers.length ? articleNumbers : [''])
      .gte('purchased_at', since.toISOString());
    if (priceErr) throw priceErr;
    const statsByArticle = new Map();
    for (const row of priceHistory) {
      if (!statsByArticle.has(row.article_number)) {
        statsByArticle.set(row.article_number, { prices: [], purchases: 0, qty: 0, weight: 0 });
      }
      const s = statsByArticle.get(row.article_number);
      if (row.unit_price != null) s.prices.push(row.unit_price);
      s.purchases += 1;
      if (row.quantity > 0) s.qty += row.quantity;
      if (row.weight != null) s.weight += row.weight;
    }

    const { data: flyerMatches, error: flyerErr } = await sb
      .from('grocery_flyer_items')
      .select('article_number, price_text, valid_to')
      .in('article_number', articleNumbers.length ? articleNumbers : ['']);
    if (flyerErr) throw flyerErr;
    const flyerByArticle = new Map(flyerMatches.map((f) => [f.article_number, f]));

    const { data: rules, error: rulesErr } = await sb
      .from('grocery_product_rules')
      .select('article_number, blacklisted, whitelisted')
      .in('article_number', articleNumbers.length ? articleNumbers : ['']);
    if (rulesErr) throw rulesErr;
    const ruleByArticle = new Map(rules.map((r) => [r.article_number, r]));

    res.json({
      success: true,
      price_compare_duration_months: durationMonths,
      items: products.map((p) => {
        const s = statsByArticle.get(p.article_number);
        const prices = s?.prices || [];
        const flyer = flyerByArticle.get(p.article_number);
        return {
          ...p,
          avg_price_paid: prices.length ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 : null,
          recent_purchases: s?.purchases || 0,
          recent_qty: p.is_weighted ? Math.round((s?.weight || 0) * 100) / 100 : (s?.qty || 0),
          on_flyer: !!flyer,
          flyer_price_text: flyer?.price_text || null,
          blacklisted: !!ruleByArticle.get(p.article_number)?.blacklisted,
          whitelisted: !!ruleByArticle.get(p.article_number)?.whitelisted,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// PROCHAINE COMMANDE (editable)
// ---------------------------------------------------------------------

// GET /api/epicerie/next-order  (la semaine la plus recente dans grocery_cart_queue)
router.get('/next-order', async (req, res) => {
  try {
    const sb = getSupabase();
    const { data: weekRow, error: weekErr } = await sb
      .from('grocery_cart_queue')
      .select('week_of')
      .order('week_of', { ascending: false })
      .limit(1);
    if (weekErr) throw weekErr;

    const weekOf = weekRow?.[0]?.week_of || null;
    if (!weekOf) return res.json({ success: true, week_of: null, items: [] });

    const { data, error } = await sb
      .from('grocery_cart_queue')
      .select('*')
      .eq('week_of', weekOf)
      .order('product_name');
    if (error) throw error;

    const articleNumbers = data.map((it) => it.article_number);

    const { data: products, error: prodErr } = await sb
      .from('grocery_products')
      .select('article_number, image_url, is_weighted')
      .in('article_number', articleNumbers);
    if (prodErr) throw prodErr;
    const productByArticle = new Map(products.map((p) => [p.article_number, p]));

    const { data: rules, error: rulesErr } = await sb
      .from('grocery_product_rules')
      .select('article_number, blacklisted, whitelisted')
      .in('article_number', articleNumbers);
    if (rulesErr) throw rulesErr;
    const ruleByArticle = new Map(rules.map((r) => [r.article_number, r]));

    const { data: durationRow } = await sb
      .from('grocery_config')
      .select('value')
      .eq('key', 'price_compare_duration_months')
      .maybeSingle();
    const durationMonths = parseInt(durationRow?.value || '6', 10);
    const since = new Date();
    since.setMonth(since.getMonth() - durationMonths);

    const { data: priceHistory, error: priceErr } = await sb
      .from('grocery_purchase_history')
      .select('article_number, unit_price, purchased_at')
      .in('article_number', articleNumbers)
      .order('purchased_at', { ascending: false });
    if (priceErr) throw priceErr;

    const priceStats = new Map();
    for (const row of priceHistory) {
      if (row.unit_price == null) continue;
      if (!priceStats.has(row.article_number)) {
        priceStats.set(row.article_number, { lastPrice: row.unit_price, recentPrices: [] });
      }
      if (new Date(row.purchased_at) >= since) {
        priceStats.get(row.article_number).recentPrices.push(row.unit_price);
      }
    }

    const items = data.map((it) => {
      const stats = priceStats.get(it.article_number);
      const avgPrice = stats?.recentPrices.length
        ? stats.recentPrices.reduce((a, b) => a + b, 0) / stats.recentPrices.length
        : null;
      return {
        ...it,
        image_url: productByArticle.get(it.article_number)?.image_url || null,
        is_weighted: !!productByArticle.get(it.article_number)?.is_weighted,
        last_price_paid: stats?.lastPrice ?? null,
        avg_price_paid: avgPrice != null ? Math.round(avgPrice * 100) / 100 : null,
        blacklisted: !!ruleByArticle.get(it.article_number)?.blacklisted,
        whitelisted: !!ruleByArticle.get(it.article_number)?.whitelisted,
      };
    });

    res.json({ success: true, week_of: weekOf, price_compare_duration_months: durationMonths, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/epicerie/next-order  (ajouter un item manuellement -- week_of optionnel,
// utilise la semaine deja affichee dans Prochaine commande si omis)
router.post('/next-order', async (req, res) => {
  try {
    const { article_number, product_name, product_url, image_url, brand, quantity, added_reason } = req.body;
    let { week_of } = req.body;
    if (!article_number) {
      return res.status(400).json({ success: false, error: 'article_number requis' });
    }
    const sb = getSupabase();

    // grocery_cart_queue.article_number a une FK vers grocery_products --
    // un item du circulaire (ou trouvé ailleurs) jamais acheté avant n'y
    // existe pas encore. On cree une fiche minimale au besoin (DO NOTHING
    // si elle existe deja, pour ne pas ecraser de meilleures donnees).
    const { error: stubErr } = await sb.from('grocery_products').upsert(
      {
        article_number,
        product_name: product_name || article_number,
        brand: brand || null,
        image_url: image_url || null,
        product_url: product_url || null,
      },
      { onConflict: 'article_number', ignoreDuplicates: true }
    );
    if (stubErr) throw stubErr;

    if (!week_of) {
      const { data: weekRow } = await sb
        .from('grocery_cart_queue')
        .select('week_of')
        .order('week_of', { ascending: false })
        .limit(1);
      if (weekRow?.[0]?.week_of) {
        week_of = weekRow[0].week_of;
      } else {
        const d = new Date();
        const diff = (7 - d.getDay()) % 7 || 7;
        d.setDate(d.getDate() + diff);
        week_of = d.toISOString().slice(0, 10);
      }
    }

    const { error } = await sb.from('grocery_cart_queue').insert({
      week_of,
      article_number,
      product_name: product_name || article_number,
      product_url: product_url || null,
      quantity: quantity || 1,
      status: 'pending',
      added_reason: added_reason || 'other',
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/epicerie/generate-list  (recalcule la liste de la semaine a venir --
// meme logique que backend/grocery/generate-list.js, dupliquee ici parce que ce
// service et le service grocery isole n'ont pas de code partage entre les deux
// process Railway. Appelee automatiquement par le frontend quand le seuil change.)
// Selection des produits "recurrents" (frequence >= seuil configure) et
// whitelistes, blacklist toujours exclue -- partagee entre /generate-list
// (remplace tout le panier de la semaine) et /add-recurring-whitelist
// (complete un panier existant sans rien supprimer).
async function computeRecurringWhitelistRows(sb) {
  const { data: thresholdRow } = await sb
    .from('grocery_config')
    .select('value')
    .eq('key', 'list_frequency_threshold')
    .maybeSingle();
  const threshold = parseFloat(thresholdRow?.value || '0.15');

  const { count: totalOrders, error: countErr } = await sb
    .from('grocery_orders')
    .select('id', { count: 'exact', head: true });
  if (countErr) throw countErr;

  const lines = await fetchAll('grocery_purchase_history', 'order_id, article_number, quantity, weight');

  const { data: rules, error: rulesErr } = await sb
    .from('grocery_product_rules')
    .select('article_number, blacklisted, whitelisted, preferred_qty');
  if (rulesErr) throw rulesErr;
  const blacklist = new Set(rules.filter((r) => r.blacklisted).map((r) => r.article_number));
  const whitelist = new Set(rules.filter((r) => r.whitelisted && !r.blacklisted).map((r) => r.article_number));
  const preferredQty = new Map(rules.filter((r) => r.preferred_qty).map((r) => [r.article_number, r.preferred_qty]));

  const byProduct = new Map();
  for (const l of lines) {
    if (blacklist.has(l.article_number)) continue;
    if (!byProduct.has(l.article_number)) byProduct.set(l.article_number, { orderIds: new Set(), qty: [], weights: [] });
    const e = byProduct.get(l.article_number);
    e.orderIds.add(l.order_id);
    if (l.quantity > 0) e.qty.push(l.quantity);
    if (l.weight != null) e.weights.push(l.weight);
  }

  const chosen = new Map(); // article_number -> { quantity, reason }
  for (const [articleNumber, e] of byProduct) {
    const freq = e.orderIds.size / totalOrders;
    if (freq >= threshold) {
      const avgQty = e.qty.length ? Math.round(e.qty.reduce((a, b) => a + b, 0) / e.qty.length) : 1;
      // au poids (bananes, fromage...): la quantite entiere n'a pas de sens,
      // on propose le poids moyen historique en kg a la place
      const avgWeight = e.weights.length ? Math.round((e.weights.reduce((a, b) => a + b, 0) / e.weights.length) * 100) / 100 : 1;
      chosen.set(articleNumber, {
        quantity: preferredQty.get(articleNumber) || Math.max(1, avgQty),
        weightQuantity: avgWeight,
        reason: 'frequency',
      });
    }
  }
  for (const articleNumber of whitelist) {
    if (!chosen.has(articleNumber)) {
      const e = byProduct.get(articleNumber);
      const avgWeight = e?.weights.length ? Math.round((e.weights.reduce((a, b) => a + b, 0) / e.weights.length) * 100) / 100 : 1;
      chosen.set(articleNumber, { quantity: preferredQty.get(articleNumber) || 1, weightQuantity: avgWeight, reason: 'whitelist' });
    }
  }

  const { data: products, error: prodErr } = await sb
    .from('grocery_products')
    .select('article_number, product_name, product_url, is_weighted')
    .in('article_number', [...chosen.keys()]);
  if (prodErr) throw prodErr;
  const byArticle = new Map(products.map((p) => [p.article_number, p]));

  const d = new Date();
  const diff = (7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  const weekOf = d.toISOString().slice(0, 10);

  const rows = [...chosen.entries()].map(([articleNumber, c]) => {
    const p = byArticle.get(articleNumber);
    return {
      week_of: weekOf,
      article_number: articleNumber,
      product_name: p?.product_name || articleNumber,
      product_url: p?.product_url || null,
      quantity: p?.is_weighted ? c.weightQuantity : c.quantity,
      status: 'pending',
      added_reason: c.reason,
    };
  });

  return { weekOf, rows };
}

router.post('/generate-list', async (req, res) => {
  try {
    const sb = getSupabase();
    const { weekOf, rows } = await computeRecurringWhitelistRows(sb);

    const { error: delErr } = await sb.from('grocery_cart_queue').delete().eq('week_of', weekOf);
    if (delErr) throw delErr;
    if (rows.length) {
      const { error: insErr } = await sb.from('grocery_cart_queue').insert(rows);
      if (insErr) throw insErr;
    }

    res.json({ success: true, week_of: weekOf, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/epicerie/add-recurring-whitelist -- complete le panier ACTIF
// (semaine la plus recente en cours, sinon en cree une) avec les produits
// recurrents/whitelistes manquants. N'efface jamais rien -- contrairement a
// /generate-list, preserve tout ce qui est deja dans la queue (ajouts
// manuels de Michel, items d'un autre agent, etc.), ignore juste les
// articles deja presents.
router.post('/add-recurring-whitelist', async (req, res) => {
  try {
    const sb = getSupabase();

    const { data: weekRow, error: weekErr } = await sb
      .from('grocery_cart_queue')
      .select('week_of')
      .order('week_of', { ascending: false })
      .limit(1);
    if (weekErr) throw weekErr;

    const { weekOf: computedWeek, rows: candidates } = await computeRecurringWhitelistRows(sb);
    const targetWeek = weekRow?.[0]?.week_of || computedWeek;

    const { data: existing, error: existErr } = await sb
      .from('grocery_cart_queue')
      .select('article_number')
      .eq('week_of', targetWeek);
    if (existErr) throw existErr;
    const existingSet = new Set(existing.map((e) => e.article_number));

    const toAdd = [];
    const alreadyPresent = [];
    for (const c of candidates) {
      const row = { ...c, week_of: targetWeek };
      if (existingSet.has(c.article_number)) alreadyPresent.push(row);
      else toAdd.push(row);
    }

    if (toAdd.length) {
      const { error: insErr } = await sb.from('grocery_cart_queue').insert(toAdd);
      if (insErr) throw insErr;
    }

    res.json({
      success: true,
      week_of: targetWeek,
      added: toAdd,
      already_present: alreadyPresent,
      added_count: toAdd.length,
      already_present_count: alreadyPresent.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/epicerie/next-order/:id  (modifier quantite/status d'un item)
router.put('/next-order/:id', async (req, res) => {
  try {
    const { quantity, status, added_reason } = req.body;
    const payload = {};
    if (quantity !== undefined) payload.quantity = quantity;
    if (status !== undefined) payload.status = status;
    if (added_reason !== undefined) payload.added_reason = added_reason;
    const sb = getSupabase();
    const { error } = await sb.from('grocery_cart_queue').update(payload).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/epicerie/next-order/:id  (retirer un item)
router.delete('/next-order/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    const { error } = await sb.from('grocery_cart_queue').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/epicerie/next-order?week_of=2026-08-10&reason=ALL|frequency|...
// reset du panier de la semaine -- au complet (reason=ALL/absent) ou juste
// un type d'ajout (ex: retirer tout ce qui vient du circulaire pour recommencer)
router.delete('/next-order', async (req, res) => {
  try {
    const { week_of, reason } = req.query;
    if (!week_of) return res.status(400).json({ success: false, error: 'week_of requis' });
    const sb = getSupabase();
    let query = sb.from('grocery_cart_queue').delete().eq('week_of', week_of);
    if (reason && reason !== 'ALL') query = query.eq('added_reason', reason);
    const { data, error } = await query.select('id');
    if (error) throw error;
    res.json({ success: true, deleted: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// COMPARATIF COMMANDE REELLE vs PANIER PLANIFIE + TELEGRAM
// ---------------------------------------------------------------------

// chat_id Telegram -> prenom, seuls admis a declencher /reset ou /status
const TELEGRAM_AUTHORIZED_CHATS = {
  '8551058793': 'Michel',
  '8616082335': 'Julie',
};

async function sendTelegramMessage(chatId, text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { console.error('TELEGRAM_BOT_TOKEN manquant -- message non envoye'); return; }
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// /historical-orders (utilise par syncMaxiOrders) ne montre une commande
// qu'une fois pleinement traitee/livree cote Maxi -- delai decouvert au
// premier test reel (commande invisible plusieurs minutes apres checkout).
// Cet endpoint-ci montre les commandes EN COURS (soumise, prete pour
// ramassage/livraison, etc.) immediatement apres le checkout.
const MAXI_ORDERS_STATUS_URL = `${MAXI_API_BASE}/orders?status=SUBMITTED,READY_FOR_ACTION,READY_FOR_PICK_UP,COMPLETED`;

async function fetchPendingOrders(token) {
  const res = await fetch(MAXI_ORDERS_STATUS_URL, { headers: { ...MAXI_API_HEADERS_BASE, Authorization: `bearer ${token}` } });
  if (!res.ok) throw new Error(`Erreur API Maxi orders-status (${res.status})`);
  const data = await res.json();
  return data.orders || [];
}

function mapOrderEntries(order) {
  const entries = order.cart?.entries || [];
  return entries
    .map((e) => ({
      article_number: e.product?.articleNumber ? String(e.product.articleNumber) : null,
      product_name: e.product?.productName || null,
      brand: e.product?.brand || null,
      image_url: e.product?.primaryImage || null,
      quantity: e.quantity,
      unit_price: e.unitPrice ?? null,
      total_price: e.totalPrice ?? null,
    }))
    .filter((l) => l.article_number);
}

// Snapshot du panier actif (avant reset) + lecture des commandes en cours
// (pas l'historique -- voir MAXI_ORDERS_STATUS_URL ci-dessus) + diff par
// article_number. N'efface PAS le panier -- l'appelant decide du reset.
async function compareCartToLastOrder(sb) {
  const { token, expired } = await getMaxiToken(sb);
  if (!token || expired) return { success: false, error: 'Token Maxi expiré ou manquant.' };

  const { data: weekRow, error: weekErr } = await sb
    .from('grocery_cart_queue')
    .select('week_of')
    .order('week_of', { ascending: false })
    .limit(1);
  if (weekErr) throw weekErr;
  const weekOf = weekRow?.[0]?.week_of;
  if (!weekOf) return { success: false, error: 'Aucun panier actif à comparer.' };

  const { data: cartItems, error: cartErr } = await sb
    .from('grocery_cart_queue')
    .select('article_number, product_name, quantity')
    .eq('week_of', weekOf);
  if (cartErr) throw cartErr;

  const pendingOrders = await fetchPendingOrders(token);
  if (!pendingOrders.length) {
    return {
      success: false,
      error: "Aucune commande en cours trouvée sur Maxi -- elle n'est peut-être pas encore visible côté serveur juste après le checkout. Réessaie dans quelques minutes, le panier n'a pas été touché.",
    };
  }

  // la plus recente si plusieurs commandes en cours (cas rare)
  const order = [...pendingOrders].sort((a, b) => new Date(b.created) - new Date(a.created))[0];
  const orderLines = mapOrderEntries(order);

  const orderByArticle = new Map(orderLines.map((l) => [l.article_number, l]));
  const cartByArticle = new Map(cartItems.map((it) => [it.article_number, it]));

  const missing = cartItems.filter((it) => !orderByArticle.has(it.article_number));
  const extra = orderLines.filter((l) => !cartByArticle.has(l.article_number));
  const matched = cartItems
    .filter((it) => orderByArticle.has(it.article_number))
    .map((it) => ({ ...orderByArticle.get(it.article_number), planned_quantity: it.quantity }));

  return {
    success: true,
    week_of: weekOf,
    order_number: order.cart?.orderNumber ? String(order.cart.orderNumber) : String(order.id),
    order_date: order.created,
    delivery_status: order.deliveryStatus || null,
    planned_count: cartItems.length,
    matched_count: matched.length,
    missing,
    extra,
    matched,
  };
}

async function persistComparison(sb, comparison, triggeredBy) {
  await sb.from('grocery_order_comparisons').insert({
    week_of: comparison.week_of,
    order_number: comparison.order_number,
    order_date: comparison.order_date,
    delivery_status: comparison.delivery_status || null,
    planned_count: comparison.planned_count,
    matched_count: comparison.matched_count,
    missing_items: comparison.missing,
    extra_items: comparison.extra,
    matched_items: comparison.matched || [],
    triggered_by: triggeredBy,
  });
}

const DELIVERY_STATUS_LABELS = {
  SUBMITTED: 'soumise',
  READY_FOR_ACTION: 'en préparation',
  READY_FOR_PICK_UP: 'prête pour ramassage/livraison',
  COMPLETED: 'complétée',
};

function formatComparisonMessage(comparison) {
  const statusLabel = DELIVERY_STATUS_LABELS[comparison.delivery_status] || comparison.delivery_status || 'statut inconnu';
  const lines = [
    `✅ Commande #${comparison.order_number} (${statusLabel}) comparée au panier planifié (semaine du ${comparison.week_of}).`,
    `${comparison.matched_count}/${comparison.planned_count} items planifiés retrouvés dans la commande.`,
  ];
  if (comparison.missing.length) {
    lines.push(`⚠️ Planifiés mais absents de la commande: ${comparison.missing.map((m) => m.product_name).join(', ')}`);
  }
  if (comparison.extra.length) {
    lines.push(`➕ Achetés mais pas planifiés: ${comparison.extra.length} item(s)`);
  }
  lines.push('Panier vidé.');
  return lines.join('\n');
}

// POST /api/epicerie/reset-and-compare  (declenchement web -- meme flux que /reset via Telegram)
router.post('/reset-and-compare', async (req, res) => {
  try {
    const sb = getSupabase();
    const { token, expired } = await getMaxiToken(sb);
    if (!token || expired) {
      return res.json({ success: false, error: 'Token Maxi expiré ou manquant -- reconnecte-toi sur Maxi.ca et recolle-le avant de comparer.' });
    }
    const comparison = await compareCartToLastOrder(sb);
    if (!comparison.success) return res.json(comparison);

    await persistComparison(sb, comparison, req.body?.triggered_by || 'web');
    await sb.from('grocery_cart_queue').delete().eq('week_of', comparison.week_of);

    res.json(comparison);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/epicerie/telegram-webhook  (commandes /reset et /status, chat_id whiteliste)
router.post('/telegram-webhook', async (req, res) => {
  res.json({ ok: true }); // ack immediat -- Telegram retry si pas de reponse rapide
  try {
    // Cette route est exemptee de l'auth Supabase (voir middleware/auth.js) --
    // Telegram s'authentifie via ce header secret plutot qu'une session utilisateur.
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) return;

    const message = req.body?.message;
    const chatId = String(message?.chat?.id || '');
    const text = (message?.text || '').trim();
    if (!TELEGRAM_AUTHORIZED_CHATS[chatId]) return; // expediteur non autorise, ignore silencieusement

    const sb = getSupabase();

    if (text === '/status') {
      const { token, expired } = await getMaxiToken(sb);
      const status = !token ? 'Aucun token enregistré.' : expired ? '⚠️ Token expiré.' : '✅ Token valide.';
      const hint = !token || expired ? '\nRéponds avec /token <ton_nouveau_token> pour le mettre à jour directement ici.' : '';
      await sendTelegramMessage(chatId, `Statut token Maxi: ${status}${hint}`);
      return;
    }

    if (text.startsWith('/token')) {
      const newToken = text.slice('/token'.length).trim();
      if (!newToken) {
        await sendTelegramMessage(chatId, "❌ Envoie /token suivi du token collé juste après (ex: /token eyJ...).");
        return;
      }
      try {
        await saveMaxiToken(sb, newToken, null);
        await sendTelegramMessage(chatId, '✅ Token Maxi mis à jour et commandes synchronisées.');
      } catch (err) {
        await sendTelegramMessage(chatId, `❌ Erreur en sauvegardant le token: ${err.message}`);
      }
      return;
    }

    if (text === '/reset') {
      const { token, expired } = await getMaxiToken(sb);
      if (!token || expired) {
        await sendTelegramMessage(chatId, '⚠️ Token Maxi expiré ou manquant. Réponds avec /token <ton_nouveau_token> puis renvoie /reset.');
        return;
      }
      const comparison = await compareCartToLastOrder(sb);
      if (!comparison.success) {
        await sendTelegramMessage(chatId, `❌ ${comparison.error}`);
        return;
      }
      await persistComparison(sb, comparison, `telegram:${TELEGRAM_AUTHORIZED_CHATS[chatId]}`);
      await sb.from('grocery_cart_queue').delete().eq('week_of', comparison.week_of);
      await sendTelegramMessage(chatId, formatComparisonMessage(comparison));
    }
  } catch (err) {
    console.error('Erreur webhook telegram:', err.message);
  }
});

// GET /api/epicerie/order-comparisons?limit=10
router.get('/order-comparisons', async (req, res) => {
  try {
    const sb = getSupabase();
    const limit = parseInt(req.query.limit || '10', 10);
    const { data, error } = await sb
      .from('grocery_order_comparisons')
      .select('*')
      .order('compared_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ success: true, comparisons: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/epicerie/pending-orders -- commandes en cours (pas encore livrees/
// dans l'historique), lecture directe depuis Maxi, rien de persiste ici.
router.get('/pending-orders', async (req, res) => {
  try {
    const sb = getSupabase();
    const { token, expired } = await getMaxiToken(sb);
    if (!token || expired) return res.json({ success: false, error: 'Token Maxi expiré ou manquant.' });

    const orders = await fetchPendingOrders(token);
    const mapped = orders
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .map((o) => ({
        id: o.id,
        order_number: o.cart?.orderNumber ? String(o.cart.orderNumber) : String(o.id),
        created: o.created,
        delivery_status: o.deliveryStatus || null,
        delivery_status_label: DELIVERY_STATUS_LABELS[o.deliveryStatus] || o.deliveryStatus || 'statut inconnu',
        // deadline pour encore ajouter/modifier des items avant que le magasin
        // commence la preparation -- passe une fois le statut READY_FOR_ACTION
        cutoff_date: o.cutOffDate || o.cart?.cutOffDate || null,
        pickup_start_date: o.cart?.booking?.pickupStartDate || null,
        store_name: o.cart?.booking?.pickupLocation?.name || null,
        total_items: o.cart?.totalItems ?? null,
        total_price: o.cart?.totalPrice ?? null,
        items: mapOrderEntries(o),
      }));
    res.json({ success: true, orders: mapped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// AGENT LOG -- canal asynchrone entre agents (ex: un agent navigateur qui
// remplit le vrai panier sur maxi.ca) et ce systeme. Chaque agent ecrit/lit
// quand il est actif -- pas de connexion live entre les deux.
// message_type: 'info' | 'warning' | 'error' | 'done'
// ---------------------------------------------------------------------

// POST /api/epicerie/agent-log  { agent_name, message_type, message, payload?, week_of? }
router.post('/agent-log', async (req, res) => {
  try {
    const { agent_name, message_type, message, payload, week_of } = req.body;
    if (!agent_name || !message_type) return res.status(400).json({ success: false, error: 'agent_name et message_type requis' });
    const sb = getSupabase();
    const { data, error } = await sb
      .from('grocery_agent_log')
      .insert({ agent_name, message_type, message: message || null, payload: payload || null, week_of: week_of || null })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, entry: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/epicerie/agent-log?limit=20
router.get('/agent-log', async (req, res) => {
  try {
    const sb = getSupabase();
    const limit = parseInt(req.query.limit || '20', 10);
    const { data, error } = await sb
      .from('grocery_agent_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ success: true, entries: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/epicerie/agent-log/:id  (marquer comme lu)
router.put('/agent-log/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    const { error } = await sb.from('grocery_agent_log').update({ read_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

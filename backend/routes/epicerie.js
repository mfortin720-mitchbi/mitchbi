const express = require('express');
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

    let lines = await fetchAll('grocery_purchase_history', 'order_id, article_number, quantity, unit_price, purchased_at');
    if (since) lines = lines.filter((l) => new Date(l.purchased_at) >= since);

    const byProduct = new Map();
    for (const l of lines) {
      if (!byProduct.has(l.article_number)) byProduct.set(l.article_number, { orderIds: new Set(), qty: [], prices: [] });
      const e = byProduct.get(l.article_number);
      e.orderIds.add(l.order_id);
      if (l.quantity > 0) e.qty.push(l.quantity);
      if (l.unit_price != null) e.prices.push(l.unit_price);
    }

    const ranked = [...byProduct.entries()]
      .map(([article_number, e]) => ({
        article_number,
        orders: e.orderIds.size,
        frequency_pct: totalOrders ? Math.round((e.orderIds.size / totalOrders) * 1000) / 10 : 0,
        avg_qty: e.qty.length ? Math.round(e.qty.reduce((a, b) => a + b, 0) / e.qty.length) : null,
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

    const tokenExpired = tokenRes.data?.expires_at ? new Date(tokenRes.data.expires_at) < new Date() : null;

    res.json({
      success: true,
      config: configRes.data,
      household: householdRes.data[0] || null,
      rules: rulesRes.data,
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

// POST /api/epicerie/product-rules  (creer/mettre a jour une regle -- blacklist, whitelist, qte preferee)
router.post('/product-rules', async (req, res) => {
  try {
    const { article_number, blacklisted, whitelisted, preferred_qty, notes } = req.body;
    if (!article_number) return res.status(400).json({ success: false, error: 'article_number requis' });
    const sb = getSupabase();
    const { data: existing, error: findErr } = await sb
      .from('grocery_product_rules')
      .select('id')
      .eq('article_number', article_number)
      .limit(1);
    if (findErr) throw findErr;

    const payload = { article_number, blacklisted, whitelisted, preferred_qty, notes, updated_at: new Date().toISOString() };
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
router.post('/token', async (req, res) => {
  try {
    const { token, expires_at } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'token requis' });
    const encKey = process.env.ENCRYPTION_KEY;
    if (!encKey) throw new Error('ENCRYPTION_KEY manquante');

    const encrypted = CryptoJS.AES.encrypt(token, encKey).toString();
    const sb = getSupabase();
    const { error } = await sb.from('grocery_secrets').upsert(
      {
        key: 'maxi_access_token',
        value_encrypted: encrypted,
        captured_at: new Date().toISOString(),
        expires_at: expires_at || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );
    if (error) throw error;
    res.json({ success: true });
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
      .select('id, article_number, quantity, weight, unit_price, total_price, grocery_products(product_name, brand, image_url)')
      .eq('order_id', req.params.id);
    if (linesErr) throw linesErr;

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
      };
    });

    res.json({ success: true, order, lines: enrichedLines, price_compare_duration_months: durationMonths });
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
      .select('article_number, image_url')
      .in('article_number', articleNumbers);
    if (prodErr) throw prodErr;
    const imageByArticle = new Map(products.map((p) => [p.article_number, p.image_url]));

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
        image_url: imageByArticle.get(it.article_number) || null,
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

// POST /api/epicerie/next-order  (ajouter un item manuellement)
router.post('/next-order', async (req, res) => {
  try {
    const { week_of, article_number, product_name, product_url, quantity, added_reason } = req.body;
    if (!week_of || !article_number) {
      return res.status(400).json({ success: false, error: 'week_of et article_number requis' });
    }
    const sb = getSupabase();
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
router.post('/generate-list', async (req, res) => {
  try {
    const sb = getSupabase();

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

    const lines = await fetchAll('grocery_purchase_history', 'order_id, article_number, quantity');

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
      if (!byProduct.has(l.article_number)) byProduct.set(l.article_number, { orderIds: new Set(), qty: [] });
      const e = byProduct.get(l.article_number);
      e.orderIds.add(l.order_id);
      if (l.quantity > 0) e.qty.push(l.quantity);
    }

    const chosen = new Map(); // article_number -> { quantity, reason }
    for (const [articleNumber, e] of byProduct) {
      const freq = e.orderIds.size / totalOrders;
      if (freq >= threshold) {
        const avgQty = e.qty.length ? Math.round(e.qty.reduce((a, b) => a + b, 0) / e.qty.length) : 1;
        chosen.set(articleNumber, { quantity: preferredQty.get(articleNumber) || Math.max(1, avgQty), reason: 'frequency' });
      }
    }
    for (const articleNumber of whitelist) {
      if (!chosen.has(articleNumber)) {
        chosen.set(articleNumber, { quantity: preferredQty.get(articleNumber) || 1, reason: 'whitelist' });
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
        quantity: p?.is_weighted ? 1 : c.quantity,
        status: 'pending',
        added_reason: c.reason,
      };
    });

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

// PUT /api/epicerie/next-order/:id  (modifier quantite/status d'un item)
router.put('/next-order/:id', async (req, res) => {
  try {
    const { quantity, status } = req.body;
    const payload = {};
    if (quantity !== undefined) payload.quantity = quantity;
    if (status !== undefined) payload.status = status;
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

module.exports = router;

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

// GET /api/epicerie/dashboard/top-products?limit=50
router.get('/dashboard/top-products', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const sb = getSupabase();

    const { count: totalOrders, error: countErr } = await sb
      .from('grocery_orders')
      .select('id', { count: 'exact', head: true });
    if (countErr) throw countErr;

    const lines = await fetchAll('grocery_purchase_history', 'order_id, article_number, quantity');

    const byProduct = new Map();
    for (const l of lines) {
      if (!byProduct.has(l.article_number)) byProduct.set(l.article_number, { orderIds: new Set(), qty: [] });
      const e = byProduct.get(l.article_number);
      e.orderIds.add(l.order_id);
      if (l.quantity > 0) e.qty.push(l.quantity);
    }

    const ranked = [...byProduct.entries()]
      .map(([article_number, e]) => ({
        article_number,
        orders: e.orderIds.size,
        frequency_pct: Math.round((e.orderIds.size / totalOrders) * 1000) / 10,
        avg_qty: e.qty.length ? Math.round(e.qty.reduce((a, b) => a + b, 0) / e.qty.length) : null,
      }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, limit);

    const { data: products, error: prodErr } = await sb
      .from('grocery_products')
      .select('article_number, product_name, brand, is_weighted')
      .in('article_number', ranked.map((r) => r.article_number));
    if (prodErr) throw prodErr;
    const byArticle = new Map(products.map((p) => [p.article_number, p]));

    res.json({
      success: true,
      total_orders: totalOrders,
      products: ranked.map((r) => ({ ...r, ...byArticle.get(r.article_number) })),
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

// POST /api/epicerie/product-rules  (creer/mettre a jour une regle -- blacklist, qte preferee)
router.post('/product-rules', async (req, res) => {
  try {
    const { article_number, blacklisted, preferred_qty, notes } = req.body;
    if (!article_number) return res.status(400).json({ success: false, error: 'article_number requis' });
    const sb = getSupabase();
    const { data: existing, error: findErr } = await sb
      .from('grocery_product_rules')
      .select('id')
      .eq('article_number', article_number)
      .limit(1);
    if (findErr) throw findErr;

    const payload = { article_number, blacklisted, preferred_qty, notes, updated_at: new Date().toISOString() };
    const { error } = existing?.[0]
      ? await sb.from('grocery_product_rules').update(payload).eq('id', existing[0].id)
      : await sb.from('grocery_product_rules').insert(payload);
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
      .select('id, article_number, quantity, weight, unit_price, total_price, grocery_products(product_name, brand)')
      .eq('order_id', req.params.id);
    if (linesErr) throw linesErr;

    res.json({ success: true, order, lines });
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

    res.json({ success: true, week_of: weekOf, items: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/epicerie/next-order  (ajouter un item manuellement)
router.post('/next-order', async (req, res) => {
  try {
    const { week_of, article_number, product_name, product_url, quantity } = req.body;
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
    });
    if (error) throw error;
    res.json({ success: true });
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

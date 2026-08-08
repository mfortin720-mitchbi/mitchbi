require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getConfig(key, fallback) {
  const { data, error } = await supabase.from('grocery_config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : fallback;
}

function nextSunday() {
  const d = new Date();
  const diff = (7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function generateList() {
  const threshold = parseFloat(await getConfig('list_frequency_threshold', '0.15'));

  const { count: totalOrders, error: countErr } = await supabase
    .from('grocery_orders')
    .select('id', { count: 'exact', head: true });
  if (countErr) throw countErr;

  // pagine explicitement -- PostgREST plafonne a 1000 lignes/requete par
  // defaut, et on a 3000+ lignes d'achat
  const lines = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error: pageErr } = await supabase
      .from('grocery_purchase_history')
      .select('order_id, article_number, quantity, weight')
      .range(offset, offset + PAGE - 1);
    if (pageErr) throw pageErr;
    lines.push(...page);
    if (page.length < PAGE) break;
  }

  // agrege en JS -- volume modeste (quelques milliers de lignes), pas
  // besoin d'une fonction Postgres pour ca
  const byProduct = new Map();
  for (const line of lines) {
    if (!byProduct.has(line.article_number)) {
      byProduct.set(line.article_number, { orderIds: new Set(), quantities: [] });
    }
    const entry = byProduct.get(line.article_number);
    entry.orderIds.add(line.order_id);
    if (line.quantity && line.quantity > 0) entry.quantities.push(line.quantity);
  }

  const qualifying = [];
  for (const [articleNumber, entry] of byProduct) {
    const freq = entry.orderIds.size / totalOrders;
    if (freq >= threshold) {
      const avgQty = entry.quantities.length
        ? Math.round(entry.quantities.reduce((a, b) => a + b, 0) / entry.quantities.length)
        : 1;
      qualifying.push({ articleNumber, freq, quantity: Math.max(1, avgQty) });
    }
  }
  qualifying.sort((a, b) => b.freq - a.freq);

  const { data: products, error: prodErr } = await supabase
    .from('grocery_products')
    .select('article_number, product_name, product_url, is_weighted')
    .in('article_number', qualifying.map((q) => q.articleNumber));
  if (prodErr) throw prodErr;
  const productByArticle = new Map(products.map((p) => [p.article_number, p]));

  const weekOf = nextSunday();

  const rows = qualifying.map((q) => {
    const p = productByArticle.get(q.articleNumber);
    return {
      week_of: weekOf,
      article_number: q.articleNumber,
      product_name: p.product_name,
      product_url: p.product_url,
      quantity: p.is_weighted ? 1 : q.quantity,
      status: 'pending',
    };
  });

  // repartir a neuf pour cette semaine si le script est relance
  const { error: delErr } = await supabase.from('grocery_cart_queue').delete().eq('week_of', weekOf);
  if (delErr) throw delErr;

  const { error: insErr } = await supabase.from('grocery_cart_queue').insert(rows);
  if (insErr) throw insErr;

  console.log(`Liste generee pour le ${weekOf}: ${rows.length} produits (seuil ${threshold * 100}%)`);
  for (const r of rows) console.log(`  - ${r.product_name} x${r.quantity}`);
}

generateList().catch((err) => {
  console.error('Erreur generation liste:', err.message);
  process.exit(1);
});

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Endpoint natif Maxi/PC Express (pas Flipp) -- ne necessite PAS de bearer
// token, seule la x-apikey publique suffit (teste explicitement: 200 sans
// Authorization, 401 seulement si x-apikey est retire).
const DEALS_URL = 'https://api.pcexpress.ca/pcx-bff/api/v1/products/deals';
const DEALS_HEADERS = {
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
const SIZE = 48;

async function getConfig(key, fallback) {
  const { data, error } = await supabase.from('grocery_config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data?.value ?? fallback;
}

// ATTENTION: `pagination.from` est un numero de PAGE (0, 1, 2...), pas un
// offset d'items -- confirme empiriquement (from=50 avec size=48 renvoie
// les items 2400-2432, pas 0 resultat comme le donnerait un offset naif).
async function fetchPage(storeId, page) {
  const res = await fetch(DEALS_URL, {
    method: 'POST',
    headers: DEALS_HEADERS,
    body: JSON.stringify({
      pagination: { from: page, size: SIZE },
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

function formatUnitPrice(comparisonPrices) {
  if (!comparisonPrices?.length) return null;
  return comparisonPrices.map((c) => `${c.value.toFixed(2)} $/${c.unit}`).join(' · ');
}

async function importDeals() {
  const storeId = await getConfig('maxi_store_id', '8981');

  const first = await fetchPage(storeId, 0);
  const total = first.pagination?.totalResults || 0;
  const pages = Math.ceil(total / SIZE);
  console.log(`storeId=${storeId}, total=${total}, pages=${pages}`);

  const byCode = new Map();
  for (const item of first.results || []) if (item.code) byCode.set(item.code, item);

  for (let page = 1; page < pages; page++) {
    const d = await fetchPage(storeId, page);
    for (const item of d.results || []) if (item.code) byCode.set(item.code, item);
    if (page % 10 === 0) console.log(`  page ${page}/${pages}... ${byCode.size} items cumules`);
    await new Promise((r) => setTimeout(r, 150));
  }

  // ~730/2432 resultats sont des doublons exacts (meme `code`) renvoyes par
  // l'API elle-meme -- dedupe via la Map ci-dessus avant insertion.
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

  // Refresh complet a chaque run, coherent avec le cycle hebdomadaire des
  // specials (les vieux prix n'ont plus de valeur une fois perimes).
  const { error: delErr } = await supabase
    .from('grocery_flyer_items')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (delErr) throw delErr;

  const { error: insErr } = await supabase.from('grocery_flyer_items').insert(rows);
  if (insErr) throw insErr;

  console.log(`Circulaire (API native Maxi) importe: ${rows.length} items (storeId ${storeId})`);
}

importDeals().catch((err) => {
  console.error('Erreur import circulaire (deals):', err.message);
  process.exit(1);
});

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getConfig(key) {
  const { data, error } = await supabase.from('grocery_config').select('value').eq('key', key).single();
  if (error) throw new Error(`grocery_config['${key}'] introuvable: ${error.message}`);
  return data.value;
}

async function importFlyer() {
  const catalogId = await getConfig('flyer_catalog_id');
  const accessToken = await getConfig('flyer_access_token');

  const url = `https://dam.flippenterprise.net/hosted/publication/${catalogId}/products?display_type=all&locale=fr&access_token=${accessToken}`;
  const res = await fetch(url, {
    headers: {
      accept: '*/*',
      'accept-language': 'fr',
      origin: 'https://www.maxi.ca',
      referer: 'https://www.maxi.ca/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`Flipp fetch a echoue: ${res.status}`);
  const items = await res.json();

  // ~14% des items du circulaire n'ont pas de sku (promos generiques type
  // "30$ depenses en fruits et legumes", coupons) -- rien a rattacher a un
  // produit precis, on les ignore
  const skuItems = items.filter((item) => item.sku);

  // sku Flipp = "<article_number>_<unite>" (ex: 20026703001_KG) -- meme
  // prefixe numerique que grocery_products.article_number
  const rows = skuItems.map((item) => ({
    sku: item.sku,
    article_number: item.sku ? item.sku.split('_')[0] : null,
    name: item.name,
    brand: item.brand || null,
    price_text: item.price_text || null,
    original_price: item.original_price,
    categories: item.categories || [],
    valid_from: item.valid_from,
    valid_to: item.valid_to,
    in_store_only: !!item.in_store_only,
  }));

  // Refresh complet a chaque run -- plus simple qu'un upsert et coherent
  // avec le cycle hebdomadaire du circulaire (les vieux specials n'ont
  // plus de valeur une fois perimes)
  const { error: delErr } = await supabase
    .from('grocery_flyer_items')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (delErr) throw delErr;

  const { error: insErr } = await supabase.from('grocery_flyer_items').insert(rows);
  if (insErr) throw insErr;

  console.log(`Circulaire importe: ${rows.length} items (catalog ${catalogId}, valide ${rows[0]?.valid_from} -> ${rows[0]?.valid_to})`);
}

importFlyer().catch((err) => {
  console.error('Erreur import circulaire:', err.message);
  process.exit(1);
});

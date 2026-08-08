/**
 * SPIKE JETABLE — test rapide, étape 1 seulement.
 *
 * Question: est-ce que puppeteer-extra + plugin stealth suffit à passer
 * Akamai sur la simple page d'accueil (avant même le login)?
 *
 * Si ÇA bloque encore ici, inutile d'aller plus loin avec le stealth JS —
 * le blocage est probablement au niveau réseau/TLS, pas juste JS fingerprint.
 *
 * Lancer: node probe-stealth-homepage.js
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  console.log('=== SPIKE STEALTH: page d\'accueil seulement ===\n');
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  try {
    const resp = await page.goto('https://www.maxi.ca/fr', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200));

    console.log('status HTTP:', resp && resp.status());
    console.log('title:', title);
    console.log('début du body:', bodyText.replace(/\n/g, ' '));

    const blocked = /access denied|edgesuite/i.test(bodyText) || /access denied/i.test(title);
    console.log('\n' + (blocked ? '❌ TOUJOURS BLOQUÉ (stealth insuffisant)' : '✅ PAGE CHARGÉE (stealth a fonctionné!)'));
  } catch (err) {
    console.error('ERREUR:', err.message);
  }

  console.log('\nLa fenêtre reste ouverte pour inspection visuelle — ferme-la manuellement.');
})();

/**
 * SPIKE JETABLE — pas du code de prod, pas appelé par le service grocery.
 *
 * But: répondre à UNE question avant d'investir dans l'automatisation panier —
 * est-ce qu'un navigateur piloté par Puppeteer peut se connecter à un compte
 * Maxi.ca et ajouter un item au panier sans être bloqué (CAPTCHA, détection
 * anti-bot, vérification 2FA "nouvel appareil")?
 *
 * Ce script ne stocke AUCUN mot de passe. Le navigateur s'ouvre visible,
 * TOI tu tapes tes identifiants et gères tout CAPTCHA/2FA à l'écran — le
 * script attend que tu confirmes avant de continuer.
 *
 * Ne teste PAS le risque #2 (IP datacenter Railway) — ça, c'est un test
 * séparé à faire une fois déployé, voir README.md du dossier spike.
 *
 * Lancer: node backend/grocery/spike/probe-checkout.js
 */
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const puppeteer = require('puppeteer'); // résolu depuis backend/node_modules

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const SESSION_FILE = path.join(__dirname, 'session-state.local.json');
const SEARCH_TERM = 'bananes'; // item test, faible enjeu si le clic va jusqu'au bout

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function shot(page, name) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`   📸 ${file}`);
}

async function main() {
  const report = [];
  const log = (label, ok, detail = '') => {
    report.push({ label, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  };

  console.log('\n=== SPIKE: navigation + add-to-cart sur Maxi.ca ===\n');

  const browser = await puppeteer.launch({
    headless: false, // visible exprès: toi tu gères login/CAPTCHA
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  try {
    console.log('1. Chargement de maxi.ca...');
    const resp = await page.goto('https://www.maxi.ca/', { waitUntil: 'networkidle2', timeout: 60000 });
    await shot(page, '1-home');
    log('Page d\'accueil chargée', resp && resp.ok(), `status ${resp && resp.status()}`);

    await ask('\n👉 Connecte-toi manuellement (bouton Connexion, identifiants, CAPTCHA/2FA si demandé).\n   Appuie sur Entrée ici une fois connecté... ');
    await shot(page, '2-post-login');
    log('Capture post-login prise', true, 'vérifie visuellement le screenshot: es-tu bien connecté?');

    console.log(`\n2. Recherche "${SEARCH_TERM}"...`);
    // Sélecteur de recherche à ajuster si besoin — on tente plusieurs patterns courants
    const searchSelectors = ['input[type="search"]', 'input[name="search"]', '#search-input', '[data-testid="search-bar-input"]'];
    let searched = false;
    for (const sel of searchSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(SEARCH_TERM, { delay: 50 });
        await el.press('Enter');
        searched = true;
        break;
      }
    }
    if (!searched) {
      await ask(`   Sélecteur de recherche non trouvé automatiquement. Cherche "${SEARCH_TERM}" toi-même, puis appuie sur Entrée... `);
    }
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
    await shot(page, '3-search-results');
    log('Résultats de recherche affichés', true, searched ? 'auto' : 'manuel');

    await ask('\n👉 Je vais tenter de cliquer "Ajouter au panier" sur le premier résultat.\n   Entrée pour continuer, Ctrl+C pour arrêter ici sans toucher au panier... ');

    const addToCartSelectors = [
      'button[data-testid*="add-to-cart"]',
      'button[aria-label*="Ajouter"]',
      'button[class*="add-to-cart"]',
      'button:has-text("Ajouter")',
    ];
    let added = false;
    for (const sel of addToCartSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          added = true;
          break;
        }
      } catch (_) { /* selector non supporté, on essaie le suivant */ }
    }
    await shot(page, '4-after-add-attempt');
    log('Ajout panier automatique', added, added ? '' : 'sélecteur non trouvé — inspecte le HTML du bouton et note-le pour la prochaine itération');

    if (!added) {
      const manual = await ask('   Tu peux cliquer "Ajouter" toi-même pour voir si LE SITE bloque quoi que ce soit une fois connecté (pas le script). Fait? (o/n) ');
      log('Ajout panier manuel testé par toi', /^o/i.test(manual));
    }

    console.log('\n3. Sauvegarde de la session (cookies) pour un futur test de réutilisation...');
    const cookies = await page.cookies();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
    log('Session sauvegardée localement', true, SESSION_FILE);

  } catch (err) {
    log('Erreur inattendue', false, err.message);
  }

  console.log('\n=== RÉSUMÉ ===');
  for (const r of report) console.log(`${r.ok ? 'OK  ' : 'FAIL'} — ${r.label}${r.detail ? ' (' + r.detail + ')' : ''}`);
  console.log('\nScreenshots dans:', SCREENSHOT_DIR);
  console.log('Le navigateur reste ouvert — ferme-le manuellement quand tu as fini d\'inspecter la page.');
  rl.close();
}

main();

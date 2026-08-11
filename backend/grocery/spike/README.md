# Spike — dérisquer l'automatisation panier Maxi.ca

Dossier jetable. Rien ici n'est appelé par le service `backend/grocery/` en
production — c'est un test unique pour répondre à une question avant d'écrire
le vrai scraper/bot.

## Question posée

Est-ce qu'un navigateur piloté par Puppeteer peut naviguer sur Maxi.ca,
se connecter, et ajouter un item au panier — sans être bloqué (CAPTCHA,
détection anti-bot, vérification "nouvel appareil")?

## Comment lancer

```bash
cd backend/grocery/spike
node probe-checkout.js
```

Un Chrome visible s'ouvre. Le script attend que tu te connectes toi-même
(identifiants + CAPTCHA/2FA si demandé), confirme dans le terminal, puis
tente une recherche + ajout panier automatique. Rien n'est envoyé nulle
part — tout reste local.

## Ce que ce test NE couvre PAS

- **Risque IP datacenter** : ce spike tourne depuis ta machine (IP résidentielle).
  Le vrai risque de prod, c'est Railway qui a une IP datacenter — Maxi/PC Express
  peut réagir différemment (re-demander une vérification à chaque déploiement).
  Ça se testera une fois le service `backend/grocery` déployé une première fois,
  en mode lecture seule (scraping specials) avant de toucher au panier.
- **Mode headless** : ce spike tourne en `headless: false` exprès, pour que tu
  gères le login visuellement. La prod tournera headless — à valider séparément
  si le headless se fait bloquer différemment du mode visible.

## Fichiers générés (gitignorés, jamais commités)

- `screenshots/` — captures à chaque étape, pour documenter ce qui s'est passé
- `session-state.local.json` — cookies de session, pour un futur test de
  réutilisation de session sans re-login

## Prochaine étape selon résultat

| Résultat observé | Action |
|---|---|
| Login + recherche + ajout panier OK, pas de CAPTCHA | On code le scraper/bot avec Puppeteer tel quel |
| CAPTCHA au login mais pas ensuite | Login reste manuel une fois (session réutilisée), automatiser seulement recherche + panier |
| Blocage direct dès la navigation | Réévaluer Puppeteer vs Playwright + plugin stealth, ou abandonner l'automatisation panier et garder le flux "bot prépare le lien, toi tu cliques" du PRD original |

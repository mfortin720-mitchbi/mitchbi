const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { BigQuery } = require('@google-cloud/bigquery');
const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Same trusted infra config as routes/tradingImperium.js
const PROJECT_ID = 'royaldistributing';
const DATASET_ID = 'trading';
const LOCATION = 'northamerica-northeast1';

let bigquery = null;
const getBigQuery = () => {
  if (bigquery) return bigquery;
  const raw = process.env.BIGQUERY_TRADING_CREDENTIALS;
  if (!raw) throw new Error('BIGQUERY_TRADING_CREDENTIALS env var is not set');
  const credentials = JSON.parse(raw);
  bigquery = new BigQuery({ credentials, projectId: PROJECT_ID });
  return bigquery;
};

async function queryBigQuery(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(trimmed)) {
    throw new Error('Seules les requêtes SELECT sont autorisées.');
  }
  const [rows] = await getBigQuery().query({ query: trimmed, location: LOCATION, maxResults: 200 });
  return rows;
}

// Condensed copy of the README tab (frontend/src/pages/Readme.jsx) so the
// assistant knows the pipeline/Telegram/config.py workflow without needing
// to fetch the page itself.
const README_CONTEXT = `
COMMENT ÇA MARCHE
Un script Python (trading_monitor.py) tourne toutes les 5 minutes sur le ForexVPS et lit l'état réel de
chaque compte MT5 via l'API officielle MetaTrader5 (lecture seule, jamais d'ordre envoyé) — balance,
equity, positions ouvertes, deals fermés. Tout est envoyé dans BigQuery (royaldistributing.trading), lu
par ce backend Express (Railway) et affiché sur mitchbi.com (Vercel).

COMPTES SUIVIS (6)
- Hola Prime — 112119 (hola_1, 50K), 112109 (hola_2, 50K), 124582 (hola_3, 25K)
- FundedNext — 14114959 (fundednext, 50K)
- Alpha Capital — 2779521 (alpha_1, 50K), 2779506 (alpha_2, 50K)
account_id est la clé stable (ex. hola_3), login est le numéro MT5 réel qui change à chaque nouvelle phase
de challenge, initial_login conserve le tout premier login pour la traçabilité.

NOTIFICATIONS TELEGRAM AUTOMATIQUES
Nouveau trade ouvert, trade fermé (P&L), suivi de challenge initié, nouvelle phase démarrée, challenge
complété/breach/statut mis à jour.

COMMANDES TELEGRAM ENTRANTES
/completed <login>, /breached <login>, /funded <login>, /ongoing <login> — login = numéro MT5 ou account_id.
Applique un override de challenge_status pris en compte au prochain cycle (5 min), jusqu'à ce que
config.py soit édité pour ce compte (l'édition du fichier l'emporte alors automatiquement).

CONFIG.PY (sur le VPS, C:\\TradingMonitor\\config.py)
Liste MT5_ACCOUNTS, champs ajustables par compte: challenge_phase, challenge_target, challenge_status
(ongoing/completed/breached/funded), phase_start_date, phase_end_date, login (change à chaque nouvelle
phase). Pas de redémarrage requis, la tâche planifiée relance le script à chaque cycle.

PIÈGES CONNUS
- Symboles avec suffixe broker (GBPUSD.raw chez Alpha Capital) : le regroupement par symbole ignore tout
  ce qui suit le premier point pour bien agréger avec le GBPUSD propre des autres firmes.
- L'historique de balance quotidien est reconstruit depuis les deals (pas un simple snapshot), partitionné
  par account_id + login ensemble : un changement de login démarre sa propre courbe.
`.trim();

// Condensé de README_TABLES.md (repo trading-monitor) -- lineage complet des tables/vues BigQuery.
const SCHEMA_CONTEXT = `
LINEAGE -- 4 tables BRUTES écrites directement par trading_monitor.py (cycle de 5 min sur le VPS), tout le
reste est des VUES SQL calculées par-dessus (rien n'écrit dedans directement) :
  accounts_snapshot_v2 ← mt5.account_info()+positions_get()   trade_deals ← mt5.history_deals_get()
  price_bars ← mt5.copy_rates_range(symbol, M1)                challenge_phases ← config.py

DEUX IDENTIFIANTS, sens différent : account_id = étiquette interne stable (ex. 'hola_3'), ne change jamais,
sert à tracer une license à travers ses phases. login = vrai numéro de compte MT5, CHANGE à chaque nouvelle
phase de challenge. Préfère toujours login pour filtrer/afficher ; account_id seulement pour le lineage.

TABLES/VUES DISPONIBLES (accessibles via l'outil query_bigquery) :
- accounts_snapshot_v2 : snapshot brut de chaque compte toutes les 5 min (balance, equity, drawdown_pct,
  positions ouvertes, terminal_connected...). Pour "l'état actuel", préfère latest_accounts_view (dédupliquée).
- latest_accounts_view : accounts_snapshot_v2 dédupliquée à la dernière ligne par account_id, + pnl/pnl_pct calculés.
- daily_accounts_view : dernier snapshot du jour par compte -- historique court (depuis le démarrage du poller).
- trade_deals : deals bruts MT5, une exécution = une ligne. Un trade fermé = 2+ deals partageant le même
  position_id (entrée entry_name='IN', sortie 'OUT'/'INOUT'/'OUT_BY'). Les deals non-trade (type_name
  BALANCE/CHARGE/CREDIT/CORRECTION) sont des dépôts/resets, PAS des trades -- voir account_events_view.
- trades_view : trade_deals regroupés par position_id = un trade complet par ligne (symbol, direction,
  entry_price, exit_price, net_pnl = SUM(profit)+SUM(commission)+SUM(swap), close_reason, is_closed,
  closed_at). Les positions encore OUVERTES n'apparaissent PAS ici -- utilise
  latest_accounts_view.positions pour ça. C'est la table à utiliser pour tout historique de trades.
- account_events_view : deals non-trade classifiés (event_type: account_created/reset/withdrawal_or_correction).
- daily_balance_history_view : historique quotidien de balance RECONSTRUIT depuis trade_deals (plus long et
  plus fiable que daily_accounts_view), partitionné par (account_id, login) -- un changement de login
  (nouvelle phase) démarre sa propre courbe au lieu de prolonger celle de la phase précédente.
- price_bars : bougies M1 du flux broker RÉEL de chaque compte (pas Yahoo Finance), une par (account_id, symbol).
- challenge_phases : historique append-only des changements de phase/statut (recorded_at, account_id, login,
  initial_login, firm, challenge_phase, challenge_target, deposit, challenge_status, phase_start_date,
  phase_end_date, change_reason).
- latest_challenge_view : dernier état de challenge par account_id (le plus récent de challenge_phases).

PIÈGES : utilise STARTS_WITH(symbol, 'X') plutôt que = (suffixe broker .raw chez Alpha Capital). Si un trade
semble manquer malgré une fermeture confirmée par le solde, c'est un problème MT5 connu où
history_deals_get(date_from, date_to) peut manquer un deal existant -- trading_monitor.py a un filet de
sécurité (sync_missed_closures) qui le recherche directement par ticket de position.
`.trim();

const TOOLS = [
  {
    name: 'query_bigquery',
    description: `Exécute une requête SQL SELECT en lecture seule sur le dataset royaldistributing.trading (données de trading MT5 des 6 comptes prop firm). ${SCHEMA_CONTEXT}`,
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Requête SQL SELECT (BigQuery Standard SQL), sans point-virgule final.' }
      },
      required: ['sql']
    }
  }
];

function buildSystemPrompt(email) {
  return `Tu es NexusIQ, l'assistant AI personnel de ${email} pour MitchBI.

MitchBI est actuellement composé de deux modules actifs : Trader Desk (scan d'instruments futures/DCA) et
Trading Imperium (suivi en direct de 6 comptes MT5 en challenge prop firm). Les autres modules visibles
dans le code (Invoices, Analytics, Scripts, Scraper, Connections génériques) sont soit désactivés soit non
utilisés actuellement — ne prétends pas y avoir accès.

Tu as accès à l'outil query_bigquery pour répondre avec des vraies données de trading (balances, trades,
phases de challenge, événements). Utilise-le dès qu'une question porte sur des chiffres réels plutôt que
de deviner. Tu n'as PAS accès à GitHub ni au code source du projet.

Voici tout ce qu'il faut savoir sur le pipeline et les processus (extrait du README de l'app) :
${README_CONTEXT}

Tu es direct, précis et professionnel. Tu réponds en français sauf si on te parle en anglais. Cite les
chiffres exacts retournés par query_bigquery, n'invente jamais de valeur.

Ta réponse est rendue en Markdown (GFM) dans l'interface. Pour toute donnée tabulaire (résultats de
query_bigquery avec plusieurs lignes/colonnes, comparaisons, sommaires), utilise un vrai tableau Markdown
(| Colonne | ... |) plutôt qu'une liste ou du texte aligné manuellement -- il s'affichera comme un vrai
tableau, pas comme du texte brut.

Il y a un nombre limité d'appels à query_bigquery par message. Pour une analyse portant sur les 6 comptes
(ex. un forecast, une comparaison), regroupe les comptes dans UNE requête (WHERE login IN (...) ou pas de
filtre + GROUP BY login) plutôt que d'interroger chaque compte séparément -- ça évite d'épuiser tes appels
avant d'avoir toutes les données.`;
}

router.post('/', async (req, res) => {
  try {
    const { messages, email } = req.body;
    const conversation = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    const system = buildSystemPrompt(email || 'utilisateur');
    let finalText = null;

    for (let i = 0; i < 8 && finalText === null; i++) {
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 2048,
        system,
        tools: TOOLS,
        messages: conversation
      });

      if (response.stop_reason !== 'tool_use') {
        finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        break;
      }

      conversation.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        try {
          const rows = await queryBigQuery(block.input.sql);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(rows).slice(0, 8000) });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Erreur: ${e.message}`, is_error: true });
        }
      }
      conversation.push({ role: 'user', content: toolResults });
    }

    res.json({ response: finalText || "Désolé, je n'ai pas pu générer de réponse." });
  } catch (err) {
    console.error('Assistant error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

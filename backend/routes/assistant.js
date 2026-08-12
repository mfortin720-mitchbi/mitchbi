const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { BigQuery } = require('@google-cloud/bigquery');
const { createClient } = require('@supabase/supabase-js');
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

// Memoire de NexusIQ, sur Supabase (meme instance que le module Epicerie --
// SUPABASE_URL / SUPABASE_SERVICE_KEY sont deja configures sur Railway, voir
// routes/epicerie.js). Deux tables, deux roles distincts :
//   assistant_memory            -- curee: l'assistant y ecrit lui-meme (outil
//                                  save_memory) uniquement ce qui merite d'etre
//                                  retenu (preference, correction, fait de
//                                  projet). Relue au debut de chaque conversation
//                                  et injectee dans le system prompt.
//   assistant_conversation_log  -- transcript brut, une ligne par message
//                                  (user et assistant), pour audit/relecture
//                                  seulement -- jamais relue comme contexte.
// RLS activee sans policy sur les deux (deny-by-default), meme convention que
// grocery_agent_log -- seule la service key (utilisee ici) peut y ecrire/lire.
let supabase = null;
const getSupabase = () => {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set');
  supabase = createClient(url, key);
  return supabase;
};

async function loadMemoryContext(email) {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('assistant_memory')
      .select('memory_type, summary, content, created_at')
      .or(`user_email.eq.${email},user_email.is.null`)
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    // Chronologique dans le prompt (plus lisible), plus recent en dernier.
    return data.reverse()
      .map(m => `[${m.memory_type}] ${m.summary}\n${m.content}`)
      .join('\n\n');
  } catch (e) {
    console.error('[assistant] loadMemoryContext failed:', e.message);
    return null;
  }
}

async function saveMemory(email, { memory_type, summary, content }) {
  const sb = getSupabase();
  const { error } = await sb
    .from('assistant_memory')
    .insert({ user_email: email || null, memory_type, summary, content });
  if (error) throw error;
}

async function logConversation(email, role, content) {
  try {
    const sb = getSupabase();
    const { error } = await sb
      .from('assistant_conversation_log')
      .insert({ user_email: email || null, role, content: (content || '').slice(0, 20000) });
    if (error) throw error;
  } catch (e) {
    // Le transcript est un journal d'audit, pas un chemin critique -- une
    // panne d'ecriture ne doit jamais faire echouer la conversation.
    console.error('[assistant] logConversation failed:', e.message);
  }
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

COMPTES SUIVIS (8)
- Hola Prime — 112119 (hola_1, 50K), 112109 (hola_2, 50K), 124582 (hola_3, 25K)
- FundedNext — 14169076 (fundednext, 50K, Phase 2 -- initial_login 14114959)
- Alpha Capital — 2779521 (alpha_1, 50K), 2779506 (alpha_2, 50K), 2860198 (alpha_3, 50K)
- The5ers — 26571576 (the5ers_1, High Stakes V, 100K)
account_id est la clé stable (ex. hola_3), login est le numéro MT5 réel qui change à chaque nouvelle phase
de challenge, initial_login conserve le tout premier login pour la traçabilité.

NOTIFICATIONS TELEGRAM AUTOMATIQUES
Nouveau trade ouvert, trade fermé (P&L), suivi de challenge initié, nouvelle phase démarrée, challenge
complété/breach/statut mis à jour, EA détaché (plus aucun nouveau trade tant qu'il n'est pas rattaché) et
changement de config EA détecté (Risk:reward, min trading days...).

COMMANDES TELEGRAM ENTRANTES
Lecture instantanée (traitées par un processus toujours actif, telegram_listener.py, pas besoin d'attendre
le cycle de 5 min) : /listing [filtre], /status <login>, /positions, /refresh, /all.
Override de statut (pris en compte au prochain cycle de 5 min) : /completed <login>, /breached <login>,
/funded <login>, /ongoing <login> — login = numéro MT5 ou account_id. Reste actif jusqu'à ce que config.py
soit édité pour ce compte (l'édition du fichier l'emporte alors automatiquement).

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
LINEAGE -- 5 tables BRUTES écrites directement par trading_monitor.py (cycle de 5 min sur le VPS), tout le
reste est des VUES SQL calculées par-dessus (rien n'écrit dedans directement) :
  accounts_snapshot_v2 ← mt5.account_info()+positions_get()   trade_deals ← mt5.history_deals_get()
  price_bars ← mt5.copy_rates_range(symbol, M1)                challenge_phases ← config.py
  ea_config ← logs Print() propres à l'EA (MQL5\\Logs\\, pas l'API MT5) -- config (Risk:reward, min
  trading days...) et statut attaché/détaché

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
- ea_config : historique append-only de la config EA + statut attaché/détaché, une ligne par changement détecté.
- latest_ea_config_view : dernier état connu de la config EA + statut attaché/détaché par account_id.

PIÈGES : utilise STARTS_WITH(symbol, 'X') plutôt que = (suffixe broker .raw chez Alpha Capital). Si un trade
semble manquer malgré une fermeture confirmée par le solde, c'est un problème MT5 connu où
history_deals_get(date_from, date_to) peut manquer un deal existant -- trading_monitor.py a un filet de
sécurité (sync_missed_closures) qui le recherche directement par ticket de position.
`.trim();

const TOOLS = [
  {
    name: 'query_bigquery',
    description: `Exécute une requête SQL SELECT en lecture seule sur le dataset royaldistributing.trading (données de trading MT5 des comptes prop firm). ${SCHEMA_CONTEXT}`,
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Requête SQL SELECT (BigQuery Standard SQL), sans point-virgule final.' }
      },
      required: ['sql']
    }
  }
];

// Outil séparé de TOOLS -- volontairement PAS mêlé à la boucle principale.
// Il a d'abord été ajouté à TOOLS avec une instruction "utilise-le même en plein
// milieu de l'échange", et le modèle s'est mis à l'intercaler entre des appels
// query_bigquery pendant des analyses déjà lourdes (ex: vérification MFE
// chronologique bougie par bougie), épuisant le budget de 8 itérations avant
// de produire une réponse finale (bug constaté en prod le 2026-08-12). La
// mémorisation tourne maintenant dans un second appel léger, après coup, qui
// ne partage pas ce budget -- voir maybeExtractMemories().
const SAVE_MEMORY_TOOL = {
  name: 'save_memory',
  description: `Enregistre une information à retenir pour les prochaines conversations (mémoire persistante). Utilise-la dès qu'une information mérite d'être retenue :
- 'user' : qui est l'utilisateur, ses préférences, son style de trading, son niveau de connaissance.
- 'feedback' : une correction ou une confirmation sur la façon de répondre ou d'analyser (ex: "ne pas donner de chiffres sans les vérifier chronologiquement", "cette façon de simuler le P&L était la bonne approche").
- 'project' : un fait ou une décision sur un compte/challenge/stratégie en cours (ex: un changement de RR décidé, un compte qui approche d'un seuil, pourquoi une décision a été prise).
- 'reference' : un pointeur vers une info ou un outil externe utile pour plus tard.
N'enregistre PAS un fait déjà disponible via query_bigquery (ex: le solde actuel d'un compte) -- ces données sont toujours interrogeables en direct et n'ont pas besoin d'être mémorisées. Une mémoire doit rester utile après coup : inclus le "pourquoi" si pertinent, pas juste le "quoi". Appelle l'outil une fois par élément distinct à retenir (0, 1 ou plusieurs appels).`,
  input_schema: {
    type: 'object',
    properties: {
      memory_type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
      summary: { type: 'string', description: 'Résumé en une ligne (~100 caractères).' },
      content: { type: 'string', description: 'Contenu complet à retenir, avec le contexte/pourquoi si pertinent.' }
    },
    required: ['memory_type', 'summary', 'content']
  }
};

async function maybeExtractMemories(email, userText, assistantText) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: `Tu relis un échange entre l'utilisateur et NexusIQ (l'assistant AI de MitchBI) pour décider ce qui mérite d'être retenu pour les prochaines conversations. Appelle save_memory pour chaque élément distinct qui vaut la peine d'être mémorisé (préférence exprimée, correction/confirmation sur une façon de faire, décision ou fait de projet important). S'il n'y a rien à retenir de cet échange précis (ex: une simple question factuelle déjà répondue via les données), n'appelle aucun outil. Ne produis aucun texte, uniquement des appels d'outil ou rien.`,
      tools: [SAVE_MEMORY_TOOL],
      messages: [
        { role: 'user', content: userText },
        { role: 'assistant', content: assistantText },
      ]
    });
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'save_memory') {
        await saveMemory(email, block.input);
      }
    }
  } catch (e) {
    console.error('[assistant] maybeExtractMemories failed:', e.message);
  }
}

function buildSystemPrompt(email, memoryContext) {
  return `Tu es NexusIQ, l'assistant AI personnel de ${email} pour MitchBI.

MitchBI est actuellement composé de deux modules actifs : Trader Desk (scan d'instruments futures/DCA) et
Trading Imperium (suivi en direct de plusieurs comptes MT5 en challenge prop firm). Les autres modules
visibles dans le code (Invoices, Analytics, Scripts, Scraper, Connections génériques) sont soit désactivés
soit non utilisés actuellement — ne prétends pas y avoir accès.

Tu as accès à l'outil query_bigquery pour répondre avec des vraies données de trading (balances, trades,
phases de challenge, événements). Utilise-le dès qu'une question porte sur des chiffres réels plutôt que
de deviner. Tu n'as PAS accès à GitHub ni au code source du projet.

Voici tout ce qu'il faut savoir sur le pipeline et les processus (extrait du README de l'app) :
${README_CONTEXT}

${memoryContext ? `MÉMOIRE -- ce que tu as retenu de vos échanges précédents (le plus récent en dernier), utilise-la pour rester cohérent d'une conversation à l'autre sans qu'on ait à tout te répéter :\n${memoryContext}\n` : ''}
Tu es direct, précis et professionnel. Tu réponds en français sauf si on te parle en anglais. Cite les
chiffres exacts retournés par query_bigquery, n'invente jamais de valeur.

Ta réponse est rendue en Markdown (GFM) dans l'interface. Pour toute donnée tabulaire (résultats de
query_bigquery avec plusieurs lignes/colonnes, comparaisons, sommaires), utilise un vrai tableau Markdown
(| Colonne | ... |) plutôt qu'une liste ou du texte aligné manuellement -- il s'affichera comme un vrai
tableau, pas comme du texte brut.

Il y a un nombre limité d'appels à query_bigquery par message. Pour une analyse portant sur plusieurs
comptes (ex. un forecast, une comparaison), regroupe les comptes dans UNE requête (WHERE login IN (...) ou
pas de filtre + GROUP BY login) plutôt que d'interroger chaque compte séparément -- ça évite d'épuiser tes
appels avant d'avoir toutes les données.`;
}

router.post('/', async (req, res) => {
  try {
    const { messages, email } = req.body;
    const conversation = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    // Le dernier message de la liste est le tour utilisateur qu'on vient de recevoir
    // (le frontend renvoie tout l'historique à chaque appel) -- transcript brut, audit only.
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.role === 'user') {
      const text = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content);
      await logConversation(email, 'user', text);
    }

    const memoryContext = await loadMemoryContext(email || null);
    const system = buildSystemPrompt(email || 'utilisateur', memoryContext);
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
          if (block.name === 'query_bigquery') {
            const rows = await queryBigQuery(block.input.sql);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(rows).slice(0, 8000) });
          } else {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Outil inconnu: ${block.name}`, is_error: true });
          }
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Erreur: ${e.message}`, is_error: true });
        }
      }
      conversation.push({ role: 'user', content: toolResults });
    }

    const reply = finalText || "Désolé, je n'ai pas pu générer de réponse.";
    await logConversation(email, 'assistant', reply);
    res.json({ response: reply });

    // Fire-and-forget: décide après coup si quelque chose de cet échange mérite
    // d'être mémorisé. Ne bloque pas la réponse et ne partage pas le budget
    // d'itérations de la boucle principale (voir commentaire sur SAVE_MEMORY_TOOL).
    if (finalText && lastUserMsg?.role === 'user') {
      const userText = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content);
      maybeExtractMemories(email, userText, reply).catch(e => console.error('[assistant] memory extraction error:', e.message));
    }
  } catch (err) {
    console.error('Assistant error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

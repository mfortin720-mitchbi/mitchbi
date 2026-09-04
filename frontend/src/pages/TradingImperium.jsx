import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { apiFetch } from '../services/api';

const GREEN = '#1D9E75';
const RED = '#D85A30';
const BLUE = '#378ADD';
const GOLD = '#E8A838';
const MUTED = '#8b93a5'; // labels/sous-titres — plus lisible que le gris foncé d'origine

const FIRM_COLORS = { 'Hola Prime': '#378ADD', 'FundedNext': '#E8A838', 'Alpha Capital': '#1D9E75' };
const firmColor = f => FIRM_COLORS[f] || '#9B59B6';

// Couleurs des marqueurs de trades sur le graphique — volontairement distinctes du
// vert/rouge des chandeliers (déjà pris) pour rester lisibles par-dessus le prix.
const LOGIN_MARKER_COLORS = ['#378ADD', '#9B59B6', '#00BCD4', '#FF6EC7', '#7CB342', '#F4A300'];

const fmtMoney = v => v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;

// % du gain requis pour ce challenge déjà réalisé : (equity - deposit) / (target - deposit). >=100% =
// target atteint, 0-99% = en chemin, <0% = en perte (sous le deposit de départ).
const challengeProgress = acc => {
  if (acc.challenge_target == null || acc.deposit == null) return null;
  const span = acc.challenge_target - acc.deposit;
  if (!span) return null;
  return ((acc.equity - acc.deposit) / span) * 100;
};
const progressColor = p => p == null ? MUTED : p >= 100 ? GREEN : p > 0 ? GOLD : RED;

// BigQuery TIMESTAMP fields come back from the backend as a string with NO timezone marker
// (e.g. "2026-08-02 14:30:00.000000" -- a UTC instant, but written without the "Z"). `new Date(...)`
// on a marker-less date-time string is interpreted as LOCAL browser time per the JS spec, which
// silently shifted every trade time by the viewer's UTC offset (4h in Montreal during EDT) --
// exactly what showed up as trade markers sitting ~4h right of the matching price move on the
// Trades chart. Force UTC by normalizing to "T"-separated + trailing "Z" before parsing.
const toUtcIso = v => {
  if (!v) return null;
  const s = String(v);
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  return /[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
};
const fmtDateTime = v => v ? new Date(toUtcIso(v)).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' }) : '—';

// Le graphique de prix affiche l'heure en UTC, tout court -- une tentative précédente d'afficher
// "l'heure serveur MT5" (+3h, calibrée sur l'horloge du chart MT5) a créé un décalage de 3h avec
// l'onglet Trade/History de MT5 (2026-08-03 : entrée à 10h25 dans MT5, 13h25 dans mitchBI) -- le chart
// et l'onglet Trade de MT5 n'utilisent visiblement PAS la même convention d'heure entre eux. Plutôt que
// de deviner laquelle des deux horloges MT5 suivre (et casser l'alignement marqueur/bougie sur CE
// graphique, qui doivent absolument rester sur la même échelle entre eux), on revient à UTC pur partout
// -- la seule valeur non ambiguë, directement dérivée des timestamps BigQuery via toUtcIso.

// Charge Plotly une seule fois (même pattern que Trader.jsx)
const usePlotly = () => {
  const [ready, setReady] = useState(!!window.Plotly);
  useEffect(() => {
    if (window.Plotly) { setReady(true); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.26.0/plotly.min.js';
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);
  return ready;
};

const PlotDiv = ({ traces, layout, deps, autoscaleY, uirevision }) => {
  const ref = useRef(null);
  const plotlyReady = usePlotly();
  useEffect(() => {
    if (!plotlyReady || !ref.current || !traces) return;
    const gd = ref.current;
    // Plotly.react (pas newPlot) + uirevision stable : un rafraîchissement silencieux (nouvelles
    // bougies, même symbole/compte/période) garde le zoom/pan actuel au lieu de repartir en vue
    // complète à chaque redraw -- newPlot recrée le graphique au complet à chaque fois, perdant le
    // zoom. uirevision change seulement quand on change vraiment de symbole/compte/période/interval
    // (voir l'appel plus bas), auquel cas on VEUT repartir en vue complète.
    window.Plotly.react(gd, traces, {
      template: 'plotly_dark',
      margin: { t: 50, l: 55, r: 20, b: 50 },
      uirevision: uirevision ?? true,
      ...layout
    }, { responsive: true, displayModeBar: false });

    if (!autoscaleY) return;

    // Par défaut, Plotly ne réajuste PAS l'axe des prix quand on zoome/scroll sur le temps (zoom sur le
    // graphique principal ou en glissant le range slider) -- l'axe Y garde l'échelle de TOUTES les
    // données même une fois zoomé sur 2 heures. On recalcule le range Y à partir des valeurs visibles
    // dans la fenêtre X actuelle à chaque changement de zoom.
    const rescaleY = (x0, x1) => {
      const t0 = x0 != null ? new Date(x0).getTime() : -Infinity;
      const t1 = x1 != null ? new Date(x1).getTime() : Infinity;
      let min = Infinity, max = -Infinity;
      for (const trace of gd.data || []) {
        const xs = trace.x || [];
        const collect = arr => {
          if (!arr) return;
          for (let i = 0; i < xs.length; i++) {
            const xt = new Date(xs[i]).getTime();
            if (Number.isNaN(xt) || xt < t0 || xt > t1) continue;
            const v = arr[i];
            if (v == null) continue;
            if (v < min) min = v;
            if (v > max) max = v;
          }
        };
        if (trace.type === 'candlestick') { collect(trace.low); collect(trace.high); }
        else collect(trace.y);
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return;
      const pad = (max - min) * 0.08;
      window.Plotly.relayout(gd, { 'yaxis.range': [min - pad, max + pad], 'yaxis.autorange': false });
    };

    const onRelayout = ev => {
      if (ev['xaxis.autorange']) { window.Plotly.relayout(gd, { 'yaxis.autorange': true }); return; }
      const x0 = ev['xaxis.range[0]'];
      const x1 = ev['xaxis.range[1]'];
      if (x0 != null || x1 != null) rescaleY(x0, x1);
    };
    // newPlot recréait tout le graphique (et donc ses listeners) à chaque redraw -- react() garde la
    // même instance, donc sans ça chaque rafraîchissement silencieux empilerait un nouveau listener
    // plotly_relayout par-dessus les précédents.
    gd.removeAllListeners('plotly_relayout');
    gd.on('plotly_relayout', onRelayout);
  }, [plotlyReady, autoscaleY, ...(deps || [])]);
  return <div ref={ref} style={{ width: '100%' }} />;
};

// IMPORTANT: forwarder toutes les props (onClick inclus) au div — sinon les cases cliquables ne réagissent pas.
const Card = ({ children, style, ...rest }) => (
  <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16, ...style }} {...rest}>
    {children}
  </div>
);

const AccountStatus = (acc) => {
  if (!acc.terminal_connected) return { label: '🔴 Déconnecté', color: RED };
  if (!acc.trade_allowed) return { label: '🟠 Trading désactivé', color: GOLD };
  return { label: '🟢 Actif', color: GREEN };
};

const CHALLENGE_STATUS_COLORS = { ongoing: BLUE, completed: GREEN, breached: RED, funded: '#9B59B6' };
const CHALLENGE_STATUS_SUFFIX = { completed: ' ✓', breached: ' ✗', funded: ' 💰' };
const PHASE2_COLOR = '#00BCD4'; // fond du badge pour toute license en phase/stage 2+ (statut "ongoing")

// Numéro de phase extrait du texte libre challenge_phase (ex. "Stellar 2-Step (Phase 2)" -> 2,
// "Alpha Pro (Stage 1)" -> 1) -- générique entre firmes plutôt que de chercher "Phase 2" en dur
// dans le texte, pour rester correct si une firme a une Phase/Stage 3+.
const phaseNumber = phaseText => {
  const m = /(?:phase|stage)\s*(\d+)/i.exec(phaseText || '');
  return m ? Number(m[1]) : null;
};

export default function TradingImperium({ activeTab = 'overview', onTabChange }) {
  const [accounts, setAccounts] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  // Cases à cocher au-dessus des cases de comptes -- masque les licences désactivées (breached)
  // par défaut sans les faire disparaître de latest_accounts_view (qui garde toute licence déjà
  // vue, même retirée de MT5_ACCOUNTS -- voir ADDING_ACCOUNTS.md). hiddenLogins n'est peuplé
  // qu'une fois, à la première liste de comptes reçue -- décocher/recocher ensuite reste un choix
  // manuel de session, jamais réécrasé par un refresh de /accounts.
  const [hiddenLogins, setHiddenLogins] = useState(() => new Set());
  const [visibilityInitialized, setVisibilityInitialized] = useState(false);
  const [events, setEvents] = useState([]);
  const [eaConfigs, setEaConfigs] = useState([]); // état/config EA par compte, voir loadEaConfigs
  const [eaModalLogin, setEaModalLogin] = useState(null); // login affiché dans la popup [EA], null = fermée
  const [phaseHistory, setPhaseHistory] = useState([]); // phases/logins passés (superseded), voir loadPhaseHistory
  const [signalPerf, setSignalPerf] = useState([]); // winrate réel vs seuil de rentabilité par signal EA, voir loadSignalPerformance

  // Onglet MFE Tracker -- Maximum Favorable Excursion des trades perdants (jusqu'où le prix est
  // allé avant de retourner au SL), voir loadMfeLosers. Regroupable par jour/symbole/build/firme,
  // tout côté client -- le dataset (un row par perte) est petit, pas besoin d'un aller-retour par vue.
  const [mfeLosers, setMfeLosers] = useState([]);
  const [mfeLoading, setMfeLoading] = useState(false);
  const [mfeError, setMfeError] = useState(null);
  const [mfeGroupBy, setMfeGroupBy] = useState('day'); // 'day' | 'symbol' | 'build' | 'firm'
  const [mfeDateFrom, setMfeDateFrom] = useState(''); // vide = pas de borne, plage complète par défaut
  const [mfeDateTo, setMfeDateTo] = useState('');
  const [rrOptimal, setRrOptimal] = useState(null); // synthèse pertes+gagnants -> R:R optimal, voir loadRrOptimal
  const [rrLoading, setRrLoading] = useState(false);

  const [filterFirm, setFilterFirm] = useState('all');
  const [filterLogin, setFilterLogin] = useState('all');
  const [filterSymbol, setFilterSymbol] = useState('all');
  // Onglet Trades uniquement -- vide = pas de filtre de date (tous les trades), même convention
  // que 'all' pour les autres filtres de cet onglet.
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyRequestId = useRef(0);

  const [trades, setTrades] = useState([]);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [tradesViewMode, setTradesViewMode] = useState('list'); // 'list' | 'summary' | 'chart'
  const [summaryGroupBy, setSummaryGroupBy] = useState('login'); // 'login' | 'symbol' | 'date'

  // ── Trades › Graphique (prix réel du broker via price_bars + entrées/sorties par login) ────
  // chartSymbol/chartLogin sont dérivés de filterSymbol/filterLogin (pas un état séparé) : avant, il y
  // avait 2 étages de filtres qui ne se parlaient pas (le filtre du haut et celui du graphique). Un seul
  // maintenant -- cliquer une case compte, le filtre du haut, ou la pastille du graphique font tous la
  // même chose.
  const [chartPeriod, setChartPeriod] = useState('5d');
  const [chartInterval, setChartInterval] = useState('5m');
  const [chartCandles, setChartCandles] = useState([]);
  const [loadingChart, setLoadingChart] = useState(false);
  const [chartError, setChartError] = useState(null);
  const [chartSelectedLogins, setChartSelectedLogins] = useState(() => new Set()); // filtre compte (pastilles cliquables)
  const [chartSelectedTradeKeys, setChartSelectedTradeKeys] = useState(() => new Set()); // trades cliqués dans la liste (multi-sélection)
  const tradeKey = t => `${t.login}_${t.position_id}`;

  const loadAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const res = await apiFetch('/api/trading-imperium/accounts');
      const d = await res.json();
      if (d.success) setAccounts(d.accounts);
    } catch (e) { console.error(e); }
    finally { setLoadingAccounts(false); }
  };

  const loadEaConfigs = async () => {
    try {
      const res = await apiFetch('/api/trading-imperium/ea-config');
      const d = await res.json();
      if (d.success) setEaConfigs(d.configs);
    } catch (e) { console.error(e); }
  };

  const loadEvents = async () => {
    try {
      const res = await apiFetch('/api/trading-imperium/events');
      const d = await res.json();
      if (d.success) setEvents(d.events);
    } catch (e) { console.error(e); }
  };

  const loadPhaseHistory = async () => {
    try {
      const res = await apiFetch('/api/trading-imperium/phase-history');
      const d = await res.json();
      if (d.success) setPhaseHistory(d.phases);
    } catch (e) { console.error(e); }
  };

  const loadSignalPerformance = async () => {
    try {
      const res = await apiFetch('/api/trading-imperium/signal-performance');
      const d = await res.json();
      if (d.success) setSignalPerf(d.accounts);
    } catch (e) { console.error(e); }
  };

  const loadMfeLosers = async () => {
    setMfeLoading(true);
    setMfeError(null);
    try {
      const res = await apiFetch('/api/trading-imperium/mfe-losers');
      const d = await res.json();
      if (d.success) setMfeLosers(d.trades);
      else setMfeError(d.error || 'Erreur inconnue');
    } catch (e) { setMfeError(e.message); }
    finally { setMfeLoading(false); }
  };

  const loadRrOptimal = async () => {
    setRrLoading(true);
    try {
      const res = await apiFetch('/api/trading-imperium/rr-optimal');
      const d = await res.json();
      if (d.success) setRrOptimal(d);
    } catch (e) { console.error(e); }
    finally { setRrLoading(false); }
  };

  const loadHistory = async () => {
    // Cliquer un compte déclenche 2 fetch en rafale (le clic lui-même, puis l'effet qui aligne
    // filterSymbol sur le symbole du compte) -- sans ce garde, celui qui répond en dernier gagne,
    // même si c'est le premier (symbole pas encore à jour) qui a fini après coup. D'où le
    // graphique qui s'affichait puis disparaissait.
    const requestId = ++historyRequestId.current;
    setLoadingHistory(true);
    try {
      const params = new URLSearchParams();
      if (filterFirm !== 'all') params.set('firm', filterFirm);
      if (filterLogin !== 'all') params.set('login', filterLogin);
      if (filterSymbol !== 'all') params.set('symbol', filterSymbol);
      const res = await apiFetch(`/api/trading-imperium/history?${params}`);
      const d = await res.json();
      if (requestId !== historyRequestId.current) return; // une requête plus récente est déjà partie
      if (d.success) setHistory(d.history);
    } catch (e) { console.error(e); }
    finally { if (requestId === historyRequestId.current) setLoadingHistory(false); }
  };

  const loadTrades = async () => {
    setLoadingTrades(true);
    try {
      const params = new URLSearchParams();
      if (filterLogin !== 'all') params.set('login', filterLogin);
      if (filterSymbol !== 'all') params.set('symbol', filterSymbol);
      if (filterDateFrom) params.set('from', filterDateFrom);
      if (filterDateTo) params.set('to', `${filterDateTo}T23:59:59`);
      const res = await apiFetch(`/api/trading-imperium/trades?${params}`);
      const d = await res.json();
      if (d.success) setTrades(d.trades);
    } catch (e) { console.error(e); }
    finally { setLoadingTrades(false); }
  };

  // silent=true (rafraîchissement automatique en arrière-plan) garde l'ancien graphique affiché pendant
  // le fetch au lieu de le vider -- sinon le graphique clignoterait (vide → chargement → rempli) toutes
  // les 60s. silent=false (bouton Refresh, changement de compte/symbole/période) réinitialise normalement.
  const loadChart = async (silent = false) => {
    if (!chartLogin) return;
    if (!silent) { setLoadingChart(true); setChartCandles([]); setChartError(null); }
    try {
      const params = new URLSearchParams({ login: chartLogin, period: chartPeriod, interval: chartInterval });
      const res = await apiFetch(`/api/trading-imperium/chart?${params}`);
      const d = await res.json();
      if (d.success) setChartCandles(d.candles); else if (!silent) setChartError(d.error || 'Erreur inconnue');
    } catch (e) { console.error(e); if (!silent) setChartError(e.message); }
    finally { if (!silent) setLoadingChart(false); }
  };

  useEffect(() => { loadAccounts(); loadEvents(); loadEaConfigs(); loadPhaseHistory(); loadSignalPerformance(); }, []);
  useEffect(() => { if (activeTab === 'overview') loadHistory(); }, [activeTab, filterFirm, filterLogin, filterSymbol]);
  useEffect(() => { if (activeTab === 'trades') loadTrades(); }, [activeTab, filterLogin, filterSymbol, filterDateFrom, filterDateTo]);
  useEffect(() => { if (activeTab === 'analyse' && !mfeLosers.length && !mfeLoading) loadMfeLosers(); }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeTab === 'analyse' && !rrOptimal && !rrLoading) loadRrOptimal(); }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (visibilityInitialized || accounts.length === 0) return;
    setHiddenLogins(new Set(accounts.filter(a => a.challenge_status === 'breached').map(a => a.login)));
    setVisibilityInitialized(true);
  }, [accounts, visibilityInitialized]);
  const visibleAccounts = useMemo(() => accounts.filter(a => !hiddenLogins.has(a.login)), [accounts, hiddenLogins]);

  const firms = useMemo(() => [...new Set(accounts.map(a => a.license_firm))], [accounts]);
  const symbols = useMemo(() => [...new Set(accounts.map(a => a.algo_symbol).filter(Boolean))].sort(), [accounts]);

  // Choisir un compte sélectionne automatiquement son symbole (chaque compte n'en trade qu'un seul).
  useEffect(() => {
    if (filterLogin === 'all') return;
    const acc = accounts.find(a => a.login === filterLogin);
    if (acc?.algo_symbol && acc.algo_symbol !== filterSymbol) setFilterSymbol(acc.algo_symbol);
  }, [filterLogin, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Symbole/compte du graphique : dérivés de filterSymbol/filterLogin, pas un état séparé (voir note plus haut).
  const chartSymbol = filterSymbol !== 'all' ? filterSymbol : (symbols[0] || null);
  // Comptes qui tradent ce symbole -- price_bars vient du broker de CE compte précis (pas d'une source
  // générique), donc plusieurs comptes sur le même symbole (ex. USDCHF: hola_1 et alpha_1) ont chacun
  // leur propre flux de prix, comme regarder le chart directement dans MT5.
  const chartSymbolAccounts = useMemo(
    () => accounts.filter(a => a.algo_symbol === chartSymbol),
    [accounts, chartSymbol]
  );
  const chartLogin = (filterLogin !== 'all' && chartSymbolAccounts.some(a => a.login === filterLogin))
    ? filterLogin
    : (chartSymbolAccounts[0]?.login ?? null);

  useEffect(() => {
    if (activeTab === 'trades' && tradesViewMode === 'chart' && chartLogin) loadChart();
  }, [activeTab, tradesViewMode, chartLogin, chartPeriod, chartInterval]);

  // price_bars se met à jour toutes les 5 min côté pipeline. Le setInterval(60s) seul ne suffit pas :
  // les navigateurs throttlent (voire gèlent) les timers d'un onglet en arrière-plan pendant longtemps,
  // donc un onglet mitchbi resté ouvert-mais-pas-au-premier-plan pendant des heures ne se rafraîchit
  // presque plus, et affiche un graphique figé sur des données vieilles de plusieurs heures au retour --
  // confirmé le 2026-08-03 (graphique figé à 14h47 MT5 alors qu'on était à 18h15). document.visibilitychange
  // n'est PAS soumis à ce throttling : on force un rafraîchissement immédiat dès que l'onglet redevient
  // visible, en plus du polling normal pendant qu'il reste affiché au premier plan.
  useEffect(() => {
    if (!(activeTab === 'trades' && tradesViewMode === 'chart' && chartLogin)) return;
    const refresh = () => { loadChart(true); loadAccounts(); };
    const id = setInterval(refresh, 60000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [activeTab, tradesViewMode, chartLogin, chartPeriod, chartInterval]);

  // login -> "Firme login" pour afficher un libellé clair partout (au lieu de account_id du genre "hola_3")
  const accountLabel = useMemo(() => {
    const map = {};
    for (const a of accounts) map[a.login] = `${a.license_firm} ${a.login}`;
    return map;
  }, [accounts]);
  const labelForLogin = login => accountLabel[login] || login;

  const totals = useMemo(() => {
    const balance = accounts.reduce((s, a) => s + (a.balance || 0), 0);
    const equity = accounts.reduce((s, a) => s + (a.equity || 0), 0);
    const deposit = accounts.reduce((s, a) => s + (a.deposit || 0), 0);
    const pnl = equity - deposit;
    return { balance, equity, deposit, pnl, pnlPct: deposit ? (pnl / deposit) * 100 : 0 };
  }, [accounts]);

  // Clique sur une case compte → filtre (le symbole suit automatiquement). Reste dans Trades si on y
  // est déjà -- ne force la Vue d'ensemble que si on clique depuis un autre onglet.
  const selectAccount = login => {
    setFilterLogin(prev => (prev === login ? 'all' : login));
    if (activeTab !== 'trades') onTabChange?.('overview');
  };

  // ── Graphique évolution (Overview) ────────────────────────────────────────
  const historyByLogin = useMemo(() => {
    const map = {};
    for (const row of history) {
      if (!map[row.login]) map[row.login] = [];
      map[row.login].push(row);
    }
    return map;
  }, [history]);

  const resetEvents = useMemo(
    () => events.filter(e => e.event_type === 'reset' && (filterLogin === 'all' || e.login === filterLogin)),
    [events, filterLogin]
  );

  // MFE Tracker -- 4 paliers de "combien le prix s'est approché d'un TP avant de retourner au SL",
  // mêmes seuils que trading-monitor's MAXIMUM_FAVORABLE_EXCURSION.MD. Regroupé côté client par la
  // dimension choisie (mfeGroupBy) -- petit dataset (un row par perte), pas besoin de re-fetch par vue.
  const MFE_BUCKETS = [
    { key: 'under12', label: '< 1.2R (jamais rescapable)', test: r => r < 1.2, color: '#3a4256' },
    { key: 'b1214', label: '1.2 – 1.4R', test: r => r >= 1.2 && r < 1.4, color: '#5a76b8' },
    { key: 'b1416', label: '1.4 – 1.6R', test: r => r >= 1.4 && r < 1.6, color: '#7b9de0' },
    { key: 'over16', label: '≥ 1.6R', test: r => r >= 1.6, color: '#bcd2ff' },
  ];
  const mfeGroupKey = t => {
    if (mfeGroupBy === 'day') return toUtcIso(t.closed_at?.value || t.closed_at)?.slice(0, 10) ?? '?';
    if (mfeGroupBy === 'symbol') return t.symbol ? t.symbol.split('.')[0] : '?';
    if (mfeGroupBy === 'build') return t.variant ? `Build ${t.variant}` : 'Build inconnu';
    if (mfeGroupBy === 'firm') return t.firm || '?';
    return '?';
  };
  // Filtre de dates -- vide des deux côtés par défaut (plage complète), appliqué avant le
  // regroupement. Comparaison en chaînes "YYYY-MM-DD" (même convention que toUtcIso), pas besoin
  // de parser des Date ici.
  const mfeFiltered = useMemo(() => {
    if (!mfeDateFrom && !mfeDateTo) return mfeLosers;
    return mfeLosers.filter(t => {
      const day = toUtcIso(t.closed_at?.value || t.closed_at)?.slice(0, 10);
      if (!day) return false;
      if (mfeDateFrom && day < mfeDateFrom) return false;
      if (mfeDateTo && day > mfeDateTo) return false;
      return true;
    });
  }, [mfeLosers, mfeDateFrom, mfeDateTo]);

  const mfeGrouped = useMemo(() => {
    const map = {};
    for (const t of mfeFiltered) {
      if (t.mfe_r == null) continue;
      const key = mfeGroupKey(t);
      if (!map[key]) map[key] = { key, under12: 0, b1214: 0, b1416: 0, over16: 0, total: 0, net_pnl: 0 };
      const bucket = MFE_BUCKETS.find(b => b.test(t.mfe_r)) || MFE_BUCKETS[0];
      map[key][bucket.key] += 1;
      map[key].total += 1;
      map[key].net_pnl += t.net_pnl || 0;
    }
    const arr = Object.values(map);
    arr.sort(mfeGroupBy === 'day' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.total - a.total);
    return arr;
  }, [mfeFiltered, mfeGroupBy]); // eslint-disable-line react-hooks/exhaustive-deps
  const mfeTotals = useMemo(() => {
    const t = { under12: 0, b1214: 0, b1416: 0, over16: 0, total: 0 };
    for (const g of mfeGrouped) { t.under12 += g.under12; t.b1214 += g.b1214; t.b1416 += g.b1416; t.over16 += g.over16; t.total += g.total; }
    return t;
  }, [mfeGrouped]);

  // Nombre de trades fermés par jour, tous comptes filtrés confondus (barres, axe droit)
  const dailyTradeCounts = useMemo(() => {
    const map = {};
    for (const row of history) {
      const day = row.day.value || row.day;
      map[day] = (map[day] || 0) + (row.trades_closed || 0);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [history]);

  // Sommaire Trades — groupe les trades filtrés par login, symbole ou jour de fermeture (UTC).
  const tradesSummary = useMemo(() => {
    const map = {};
    for (const t of trades) {
      let key;
      if (summaryGroupBy === 'login') key = t.login;
      // Normalise le symbole (retire le suffixe broker, ex: "GBPUSD.raw" -> "GBPUSD") pour que
      // toutes les firmes tradant le même instrument s'agrègent ensemble.
      else if (summaryGroupBy === 'symbol') key = t.symbol.split('.')[0];
      else key = toUtcIso(t.closed_at?.value || t.closed_at).slice(0, 10);
      if (!map[key]) map[key] = { key, total: 0, wins: 0, losses: 0, pnl: 0, logins: new Set() };
      map[key].total += 1;
      if (t.net_pnl >= 0) map[key].wins += 1; else map[key].losses += 1;
      map[key].pnl += t.net_pnl;
      map[key].logins.add(t.login);
    }
    return Object.values(map)
      .map(row => ({ ...row, loginCount: row.logins.size }))
      // Par date : chronologique (plus récent en premier). Par login/symbole : par volume de trades.
      .sort((a, b) => summaryGroupBy === 'date' ? b.key.localeCompare(a.key) : b.total - a.total);
  }, [trades, summaryGroupBy]);

  // Graphique Trades — bougies Yahoo Finance + entrées/sorties de chaque login qui a tradé ce symbole,
  // une trace par login (segments entrée->sortie séparés par des null) pour pouvoir les toggler dans la légende.
  // Les trades dont l'ouverture/fermeture tombe hors de la période de bougies chargée sont exclus (sinon
  // ils flottent sans bougie derrière, ex: un trade du 5 juillet affiché sur une fenêtre de 10 jours) --
  // excludedCount permet d'avertir l'utilisateur plutôt que de les faire disparaître silencieusement.
  const {
    traces: chartTraces, excludedCount: chartExcludedCount,
    tradeList: chartTradeList, accountPills: chartAccountPills
  } = useMemo(() => {
    if (!chartCandles.length) return { traces: [], excludedCount: 0, tradeList: [], accountPills: [] };
    const candleTrace = {
      type: 'candlestick',
      x: chartCandles.map(c => new Date(c.ts).toISOString()),
      open: chartCandles.map(c => c.open),
      high: chartCandles.map(c => c.high),
      low: chartCandles.map(c => c.low),
      close: chartCandles.map(c => c.close),
      increasing: { line: { color: GREEN } },
      decreasing: { line: { color: RED } },
      name: chartSymbol
    };

    const minTs = chartCandles[0].ts;
    const maxTs = chartCandles[chartCandles.length - 1].ts;
    const allSymbolTrades = trades.filter(t => t.symbol.split('.')[0] === chartSymbol);
    const chartTrades = allSymbolTrades.filter(t => {
      const openedTs = new Date(toUtcIso(t.opened_at?.value || t.opened_at)).getTime();
      return openedTs >= minTs && openedTs <= maxTs;
    });
    const excludedCount = allSymbolTrades.length - chartTrades.length;

    // Couleur stable par compte, assignée une fois pour tous les trades de la fenêtre (avant tout
    // filtre de sélection) -- sert aux marqueurs, à la liste, et aux pastilles cliquables ci-dessous,
    // pour que la couleur d'un compte reste la même peu importe ce qui est filtré/sélectionné.
    const loginOrder = [...new Set(chartTrades.map(t => t.login))];
    const loginColors = {};
    loginOrder.forEach((login, i) => { loginColors[login] = LOGIN_MARKER_COLORS[i % LOGIN_MARKER_COLORS.length]; });

    // Ce qui apparaît sur le GRAPHIQUE : priorité aux trades sélectionnés individuellement dans la
    // liste, sinon au filtre de comptes (pastilles), sinon tout. La LISTE plus bas n'est filtrée que
    // par compte (jamais par trade sélectionné) pour pouvoir continuer à cliquer d'autres trades à
    // ajouter à la sélection sans qu'ils disparaissent de la liste.
    const chartVisibleTrades = chartSelectedTradeKeys.size
      ? chartTrades.filter(t => chartSelectedTradeKeys.has(tradeKey(t)))
      : chartSelectedLogins.size
      ? chartTrades.filter(t => chartSelectedLogins.has(t.login))
      : chartTrades;

    const byLogin = {};
    for (const t of chartVisibleTrades) (byLogin[t.login] ||= []).push(t);

    // Trois informations distinctes par marqueur : couleur de fond = compte, forme = sens (▲ achat /
    // ▼ vente à l'entrée, ● à la sortie), contour = résultat (vert = gain, rouge = perte). Le P&L
    // compact s'affiche aussi directement au point de sortie (label sur le graphique, pas juste au
    // survol). Sur un perdant fermé au SL, une deuxième ligne affiche le MFE en R (Maximum
    // Favorable Excursion -- le meilleur multiple de R atteint avant le retour au SL, calculé par
    // trading_monitor.py's sync_trade_mfe() -- voir MAXIMUM_FAVORABLE_EXCURSION.MD dans le repo
    // trading-monitor). Absent sur les gagnants : leur SL réel n'est jamais enregistré (seul un
    // trade fermé AU SL laisse un commentaire de deal exploitable), donc leur vrai R:R n'est pas
    // calculable ici -- ne pas l'inventer. Une ligne pointillée relie chaque entrée à sa sortie,
    // dans la couleur du compte -- séparée par un null entre chaque trade pour ne pas chaîner les
    // trades entre eux.
    const compactPnl = v => `${v >= 0 ? '+' : '-'}$${Math.round(Math.abs(v))}`;
    const tradeTraces = Object.entries(byLogin).map(([login, ts]) => {
      const loginColor = loginColors[login];
      const x = [], y = [], symbol = [], borderColor = [], hovertext = [], dispText = [];
      for (const t of ts) {
        const win = t.net_pnl >= 0;
        const resultColor = win ? GREEN : RED;
        const hasMfe = !win && t.mfe_r !== null && t.mfe_r !== undefined;
        const exitLabel = hasMfe ? `${compactPnl(t.net_pnl)}<br>MFE ${Number(t.mfe_r).toFixed(1)}R` : compactPnl(t.net_pnl);
        x.push(toUtcIso(t.opened_at?.value || t.opened_at), toUtcIso(t.closed_at?.value || t.closed_at), null);
        y.push(t.entry_price, t.exit_price, null);
        symbol.push(t.direction === 'BUY' ? 'triangle-up' : 'triangle-down', 'circle', 'circle');
        borderColor.push(resultColor, resultColor, 'rgba(0,0,0,0)');
        dispText.push('', exitLabel, '');
        hovertext.push(
          `${labelForLogin(Number(login))} · ${t.direction} · Entrée ${t.entry_price}`,
          `${labelForLogin(Number(login))} · Sortie ${t.exit_price} · P&L ${fmtMoney(t.net_pnl)} (${win ? 'gain' : 'perte'})` +
            (hasMfe ? ` · MFE ${Number(t.mfe_r).toFixed(2)}R avant le SL (${t.mfe_peak_count ?? '?'} sommets)` : ''),
          ''
        );
      }
      return {
        type: 'scatter', mode: 'lines+markers+text',
        x, y, name: labelForLogin(Number(login)),
        line: { width: 1.5, color: loginColor, dash: 'dot' },
        marker: { size: 12, symbol, color: loginColor, line: { width: 2.5, color: borderColor } },
        text: dispText, textposition: 'top center', textfont: { size: 10, color: '#fff' },
        hovertext, hoverinfo: 'text'
      };
    });

    // Liste compacte pour le panneau sous le graphique (pastille de couleur au lieu du nom complet
    // du compte, qui prend trop de place quand il y a beaucoup de trades) -- filtrée par compte
    // seulement (voir note plus haut sur pourquoi elle ne se filtre pas par trade sélectionné).
    const tradeList = [...chartTrades]
      .filter(t => !chartSelectedLogins.size || chartSelectedLogins.has(t.login))
      .sort((a, b) => new Date(toUtcIso(b.closed_at?.value || b.closed_at)) - new Date(toUtcIso(a.closed_at?.value || a.closed_at)))
      .map(t => ({ ...t, color: loginColors[t.login] || MUTED }));

    const accountPills = loginOrder.map(login => ({ login: Number(login), color: loginColors[login] }));

    // Position OUVERTE de chartLogin sur ce symbole, si applicable -- trades_view ne couvre QUE les
    // trades FERMÉS (is_closed=TRUE), un trade encore en cours n'y apparaît jamais, même pas son entrée.
    // On la tire plutôt de latest_accounts_view.positions (déjà chargée dans `accounts`) pour la montrer
    // quand même : ▲/▼ à l'entrée (comme un trade fermé), ◆ au prix actuel avec le P&L flottant, contour
    // bleu (résultat pas encore déterminé, contrairement au vert/rouge des trades fermés).
    const openAcct = accounts.find(a => a.login === chartLogin);
    const openPositions = (openAcct?.positions || []).filter(p => p.symbol.split('.')[0] === chartSymbol);
    let openTrace = null;
    if (openPositions.length) {
      const openColor = loginColors[chartLogin] ?? LOGIN_MARKER_COLORS[loginOrder.length % LOGIN_MARKER_COLORS.length];
      const lastCandleIso = new Date(chartCandles[chartCandles.length - 1].ts).toISOString();
      const x = [], y = [], symbol = [], dispText = [], hovertext = [];
      for (const p of openPositions) {
        x.push(toUtcIso(p.time_open?.value || p.time_open), lastCandleIso, null);
        y.push(p.price_open, p.price_current, null);
        symbol.push(p.type === 'BUY' ? 'triangle-up' : 'triangle-down', 'diamond', 'circle');
        dispText.push('', `${p.profit >= 0 ? '+' : '-'}$${Math.round(Math.abs(p.profit))} (en cours)`, '');
        hovertext.push(
          `${labelForLogin(chartLogin)} · ${p.type} · Entrée ${p.price_open} (position ouverte)`,
          `${labelForLogin(chartLogin)} · En cours · Prix actuel ${p.price_current} · P&L flottant ${fmtMoney(p.profit)}`,
          ''
        );
      }
      openTrace = {
        type: 'scatter', mode: 'lines+markers+text',
        x, y, name: `${labelForLogin(chartLogin)} (en cours)`,
        line: { width: 1.5, color: openColor, dash: 'dash' },
        marker: { size: 13, symbol, color: openColor, line: { width: 2.5, color: BLUE } },
        text: dispText, textposition: 'top center', textfont: { size: 10, color: BLUE },
        hovertext, hoverinfo: 'text'
      };
    }

    return {
      traces: [candleTrace, ...tradeTraces, ...(openTrace ? [openTrace] : [])],
      excludedCount, tradeList, accountPills
    };
  }, [chartCandles, trades, chartSymbol, chartSelectedLogins, chartSelectedTradeKeys, accounts, chartLogin]);

  // Repartir à zéro sur la sélection compte/trades quand on change de symbole -- sinon un login/trade
  // sélectionné pour un symbole reste actif (et invisible) en changeant de symbole.
  useEffect(() => {
    setChartSelectedLogins(new Set());
    setChartSelectedTradeKeys(new Set());
  }, [chartSymbol]);

  // Cliquer une pastille de compte = filtre dur (graphique + liste). Repart à zéro sur la sélection de
  // trades précis pour éviter que le graphique reste bloqué sur un ancien trade sélectionné.
  const toggleChartLogin = login => {
    setChartSelectedTradeKeys(new Set());
    setChartSelectedLogins(prev => {
      const next = new Set(prev);
      if (next.has(login)) next.delete(login); else next.add(login);
      return next;
    });
  };

  // Cliquer un trade dans la liste = ajoute/retire ce trade de la sélection (multi-sélection) --
  // ne filtre JAMAIS la liste elle-même, seulement le graphique, pour pouvoir continuer à cliquer
  // d'autres trades sans qu'ils disparaissent.
  const toggleChartTrade = t => {
    const key = tradeKey(t);
    setChartSelectedTradeKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const clearChartSelection = () => {
    setChartSelectedLogins(new Set());
    setChartSelectedTradeKeys(new Set());
  };

  // Comptes à surligner dans la rangée de pastilles : sélectionnés explicitement, ou compte d'un
  // trade actuellement sélectionné dans la liste (highlight implicite demandé).
  const chartHighlightedLogins = useMemo(() => {
    const set = new Set(chartSelectedLogins);
    for (const t of chartTradeList) if (chartSelectedTradeKeys.has(tradeKey(t))) set.add(t.login);
    return set;
  }, [chartSelectedLogins, chartSelectedTradeKeys, chartTradeList]);

  // Total des resets/topups par login (account_events_view) — n'a de sens qu'en groupement par login,
  // pas par symbole. Sert à montrer que le P&L Net (trading pur) peut être compensé par un reset côté firme.
  const resetsByLogin = useMemo(() => {
    const map = {};
    for (const e of events) {
      if (e.event_type === 'reset') map[e.login] = (map[e.login] || 0) + (e.amount || 0);
    }
    return map;
  }, [events]);

  // Totaux de la table Sommaire, tous groupes confondus -- recalculés depuis les sommes (pas une
  // moyenne des taux par ligne, qui serait faussée si les groupes ont des volumes très différents).
  const tradesSummaryTotals = useMemo(() => {
    const total = tradesSummary.reduce((s, r) => s + r.total, 0);
    const wins = tradesSummary.reduce((s, r) => s + r.wins, 0);
    const losses = tradesSummary.reduce((s, r) => s + r.losses, 0);
    const pnl = tradesSummary.reduce((s, r) => s + r.pnl, 0);
    const loginCount = new Set(trades.map(t => t.login)).size;
    const resetSum = summaryGroupBy === 'login'
      ? tradesSummary.reduce((s, r) => s + (resetsByLogin[r.key] || 0), 0)
      : null;
    return { total, wins, losses, pnl, loginCount, resetSum };
  }, [tradesSummary, trades, summaryGroupBy, resetsByLogin]);

  // Totaux de la table Liste (P&L net seulement -- les autres colonnes ne s'agrègent pas).
  const tradesListTotalPnl = useMemo(() => trades.reduce((s, t) => s + t.net_pnl, 0), [trades]);

  return (
    <div>
      {/* ── Bandeau balance — toujours visible, 6 indicateurs sur une seule ligne ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
        {[
          { label: 'Balance totale', value: fmtMoney(totals.balance) },
          { label: 'Equity totale', value: fmtMoney(totals.equity) },
          { label: 'Deposit total', value: fmtMoney(totals.deposit) },
          { label: 'P&L global', value: fmtMoney(totals.pnl), color: totals.pnl >= 0 ? GREEN : RED },
          { label: 'P&L %', value: fmtPct(totals.pnlPct), color: totals.pnlPct >= 0 ? GREEN : RED },
          { label: 'Comptes actifs', value: `${accounts.filter(a => a.terminal_connected).length}/${accounts.length || 6}` },
        ].map(k => (
          <Card key={k.label} style={{ padding: '9px 12px' }}>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k.label}</div>
            <div style={{ fontSize: 17, fontWeight: 600, color: k.color || '#fff' }}>{k.value}</div>
          </Card>
        ))}
      </div>

      {loadingAccounts && <div style={{ color: MUTED, fontSize: 13, padding: 14, textAlign: 'center' }}>⏳ Chargement des comptes...</div>}

      {/* ── Filtre de cases : tous les logins, désactivés (breached) décochés par défaut ── */}
      {!loadingAccounts && accounts.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {accounts.map(a => {
            const checked = !hiddenLogins.has(a.login);
            const disabled = a.challenge_status === 'breached';
            return (
              <label key={a.login} title={disabled ? 'Licence désactivée (breached)' : ''} style={{
                display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer',
                padding: '4px 9px', borderRadius: 5, border: '0.5px solid #1e2130',
                background: checked ? 'transparent' : '#1a1d27',
                color: checked ? '#ccc' : MUTED
              }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setHiddenLogins(prev => {
                    const next = new Set(prev);
                    if (checked) next.add(a.login); else next.delete(a.login);
                    return next;
                  })}
                  style={{ accentColor: BLUE, cursor: 'pointer' }}
                />
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: firmColor(a.license_firm), flexShrink: 0 }} />
                {a.license_firm} — {a.login}{disabled ? ' ⚠' : ''}
              </label>
            );
          })}
        </div>
      )}

      {!loadingAccounts && visibleAccounts.length === 0 && (
        <div style={{ color: MUTED, fontSize: 13, padding: 14, textAlign: 'center' }}>Tous les comptes sont masqués -- coche-en un ci-dessus.</div>
      )}

      {!loadingAccounts && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: 10, marginBottom: 14 }}>
          {visibleAccounts.map(acc => {
            const status = AccountStatus(acc);
            const selected = filterLogin === acc.login;
            const hasPosition = acc.open_positions_count > 0;
            const progress = challengeProgress(acc);
            const phaseNum = phaseNumber(acc.challenge_phase);
            // Le vrai passage de phase = target ET un minimum de jours de trading -- pas le
            // target seul. Découvert sur FundedNext 14114959 : le solde a dépassé le target de
            // Phase 1 dès le 4e jour, mais la firme n'a fait avancer le compte en Phase 2 que le
            // 5e jour (son vrai minimum). min_trading_days vient de config.py (par firme, voir
            // trading_monitor.py) ; trading_days_count est calculé côté backend depuis
            // trades_view. Si l'un des deux est absent (pas encore configuré), on ne bloque pas.
            const targetReached = progress != null && progress >= 100;
            const daysComplete = acc.min_trading_days == null || (acc.trading_days_count ?? 0) >= acc.min_trading_days;
            const justReachedTarget = acc.challenge_status === 'ongoing' && targetReached && daysComplete;
            // Target atteint mais jours de trading minimum pas encore comblés -- exactement le
            // cas FundedNext qui a motivé tout ça : on ne veut plus jamais annoncer "target
            // atteint" tant que ce n'est pas vraiment complet, mais on veut quand même montrer
            // la progression plutôt que de rester silencieux.
            const awaitingMinDays = acc.challenge_status === 'ongoing' && targetReached && !daysComplete;
            // Phase 2+ prend le pas sur la couleur de statut par défaut (bleu "ongoing") -- un
            // statut terminal (completed/breached/funded) reste prioritaire, plus important à
            // signaler clairement que le numéro de phase.
            const phaseBadgeColor = (acc.challenge_status === 'ongoing' && phaseNum >= 2)
              ? PHASE2_COLOR
              : (CHALLENGE_STATUS_COLORS[acc.challenge_status] || MUTED);
            return (
              <Card
                key={acc.login}
                onClick={() => selectAccount(acc.login)}
                style={{
                  padding: '11px 12px',
                  cursor: 'pointer',
                  border: hasPosition
                    ? `2px solid ${justReachedTarget ? GREEN : '#fff'}`
                    : justReachedTarget
                    ? `1.5px solid ${GREEN}`
                    : `0.5px solid ${firmColor(acc.license_firm)}33`,
                  boxShadow: selected ? `0 0 0 2px ${BLUE}` : 'none'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: firmColor(acc.license_firm) }} />
                  <div>
                    <div style={{ fontWeight: 600, color: '#fff', fontSize: 12 }}>{acc.license_firm} — {acc.login}</div>
                    <div style={{ fontSize: 11, color: MUTED }}>{acc.algo_symbol || acc.symbols_trading || '—'}</div>
                  </div>
                  <div style={{ marginLeft: 'auto', fontSize: 11, color: status.color }}>{status.label}</div>
                </div>
                {acc.challenge_phase && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 7 }}>
                    <div style={{
                      display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                      color: phaseBadgeColor,
                      background: `${phaseBadgeColor}22`,
                      border: `0.5px solid ${phaseBadgeColor}55`
                    }}>
                      {phaseNum >= 2 && '🚀 '}{acc.challenge_phase}{CHALLENGE_STATUS_SUFFIX[acc.challenge_status] || ''}
                    </div>
                    {justReachedTarget ? (
                      <div title="Balance/équité au-dessus du target -- pas encore marqué complété dans config.py" style={{
                        display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700,
                        color: GREEN, padding: '1px 6px', borderRadius: 4,
                        background: `${GREEN}22`, border: `0.5px solid ${GREEN}66`
                      }}>
                        🎯 Target atteint
                      </div>
                    ) : awaitingMinDays ? (
                      <div title={`Target atteint mais ${acc.trading_days_count ?? 0}/${acc.min_trading_days} jours de trading requis -- pas encore un passage officiel`} style={{
                        display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700,
                        color: GOLD, padding: '1px 6px', borderRadius: 4,
                        background: `${GOLD}22`, border: `0.5px solid ${GOLD}66`
                      }}>
                        ⏳ {acc.trading_days_count ?? 0}/{acc.min_trading_days}j
                      </div>
                    ) : progress != null && (
                      <div title="Progression vers le target" style={{
                        display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600,
                        color: progressColor(progress)
                      }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: progressColor(progress) }} />
                        {progress.toFixed(1)}%
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                  <div><div style={{ fontSize: 10, color: MUTED }}>BALANCE</div><div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{fmtMoney(acc.balance)}</div></div>
                  <div>
                    <div style={{ fontSize: 10, color: MUTED }}>EQUITY</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{fmtMoney(acc.equity)}</div>
                      <div title="Nombre de trades du login actuel, dans sa phase en cours" style={{ fontSize: 10, color: MUTED }}>
                        · {acc.total_trades ?? 0} trade{(acc.total_trades ?? 0) >= 2 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                  <div><div style={{ fontSize: 10, color: MUTED }}>P&amp;L</div><div style={{ fontSize: 12, color: acc.pnl >= 0 ? GREEN : RED }}>{fmtMoney(acc.pnl)} ({fmtPct(acc.pnl_pct)})</div></div>
                  <div><div style={{ fontSize: 10, color: MUTED }}>DRAWDOWN</div><div style={{ fontSize: 12, color: acc.drawdown_pct > 0 ? RED : '#ccc' }}>{fmtPct(acc.drawdown_pct)}</div></div>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6 }}>
                  <div style={{ fontSize: 10, color: MUTED }}>{acc.open_positions_count} position(s) · maj {fmtDateTime(acc.last_updated?.value || acc.last_updated)}</div>
                  {(() => {
                    const eaConfig = eaConfigs.find(c => c.login === acc.login);
                    if (!eaConfig) return null;
                    const detached = eaConfig.attached === false;
                    const rr = eaConfig.config?.['Strategy.Risk : reward'];
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                        {rr != null && (
                          <div style={{ fontSize: 10, fontWeight: 700, color: BLUE }}>R:R {rr}</div>
                        )}
                        <button
                          onClick={e => { e.stopPropagation(); setEaModalLogin(acc.login); }}
                          title={detached ? `EA détaché : ${eaConfig.reason || ''}` : 'Voir la config EA'}
                          style={{
                            flexShrink: 0, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                            cursor: 'pointer', color: detached ? RED : MUTED,
                            background: detached ? `${RED}22` : 'transparent',
                            border: `0.5px solid ${detached ? RED : MUTED}55`
                          }}
                        >
                          {detached ? '⚠ EA' : '⚙ EA'}
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Filtres (Overview + Trades) ────────────────────────────────── */}
      {(activeTab === 'overview' || activeTab === 'trades') && (
        <Card style={{ padding: '10px 16px', marginBottom: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {activeTab === 'overview' && (
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Firme</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {['all', ...firms].map(f => (
                  <button key={f} onClick={() => setFilterFirm(f)} style={{
                    padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                    border: '0.5px solid', borderColor: filterFirm === f ? BLUE : '#1e2130',
                    background: filterFirm === f ? '#0d1f35' : 'transparent',
                    color: filterFirm === f ? BLUE : MUTED
                  }}>{f === 'all' ? 'Toutes' : f}</button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Symbole</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {['all', ...symbols].map(s => (
                <button key={s} onClick={() => { setFilterSymbol(s); setFilterLogin('all'); }} style={{
                  padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                  border: '0.5px solid', borderColor: filterSymbol === s ? GOLD : '#1e2130',
                  background: filterSymbol === s ? '#2b1f0a' : 'transparent',
                  color: filterSymbol === s ? GOLD : MUTED
                }}>{s === 'all' ? 'Tous' : s}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Compte (ou clique une case ci-dessus)</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {['all', ...accounts.map(a => a.login)].map(login => (
                <button key={login} onClick={() => setFilterLogin(login)} style={{
                  padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                  border: '0.5px solid', borderColor: filterLogin === login ? BLUE : '#1e2130',
                  background: filterLogin === login ? '#0d1f35' : 'transparent',
                  color: filterLogin === login ? BLUE : MUTED
                }}>{login === 'all' ? 'Tous' : labelForLogin(login)}</button>
              ))}
            </div>
          </div>
          {activeTab === 'trades' && (
            <>
              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Du</div>
                <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} style={{
                  background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 5,
                  color: '#fff', fontSize: 12, padding: '5px 8px'
                }} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Au</div>
                <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} style={{
                  background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 5,
                  color: '#fff', fontSize: 12, padding: '5px 8px'
                }} />
              </div>
              {(filterDateFrom || filterDateTo) && (
                <button onClick={() => { setFilterDateFrom(''); setFilterDateTo(''); }} style={{
                  padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12, alignSelf: 'flex-end',
                  border: '0.5px solid #1e2130', background: 'transparent', color: MUTED
                }}>Effacer les dates</button>
              )}
            </>
          )}
        </Card>
      )}

      {/* ── Vue d'ensemble : graphique évolution ───────────────────────── */}
      {activeTab === 'overview' && (
        <Card>
          {loadingHistory && <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>⏳ Chargement de l'historique...</div>}
          {!loadingHistory && history.length === 0 && (
            <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>Aucune donnée pour ce filtre.</div>
          )}
          {!loadingHistory && history.length > 0 && (
            <PlotDiv
              traces={[
                ...Object.entries(historyByLogin).map(([login, rows]) => ({
                  type: 'scatter', mode: 'lines+markers',
                  x: rows.map(r => r.day.value || r.day),
                  y: rows.map(r => r.balance),
                  name: labelForLogin(Number(login)),
                  line: { width: 2 },
                  yaxis: 'y'
                })),
                {
                  type: 'bar',
                  x: dailyTradeCounts.map(([day]) => day),
                  y: dailyTradeCounts.map(([, count]) => count),
                  name: 'Trades/jour',
                  marker: { color: 'rgba(150,150,150,0.35)' },
                  yaxis: 'y2'
                }
              ]}
              layout={{
                title: 'Évolution de la balance par compte (barres = trades fermés/jour)',
                height: 380,
                xaxis: { title: 'Date' },
                yaxis: { title: 'Balance (USD)' },
                yaxis2: { title: 'Trades/jour', overlaying: 'y', side: 'right', showgrid: false, rangemode: 'tozero' },
                shapes: resetEvents.map(e => ({
                  type: 'line', xref: 'x', yref: 'paper',
                  x0: toUtcIso(e.event_time.value || e.event_time), x1: toUtcIso(e.event_time.value || e.event_time),
                  y0: 0, y1: 1,
                  line: { color: GOLD, dash: 'dash', width: 1 }
                })),
                annotations: resetEvents.map(e => ({
                  x: toUtcIso(e.event_time.value || e.event_time), y: 1, yref: 'paper',
                  text: 'Reset', showarrow: false, font: { color: GOLD, size: 10 }
                }))
              }}
              deps={[history.length, resetEvents.length, dailyTradeCounts.length]}
            />
          )}
        </Card>
      )}

      {/* ── Signal scorecard : winrate réel vs seuil de rentabilité, par signal EA ────── */}
      {activeTab === 'overview' && signalPerf.length > 0 && (() => {
        const lossGroup = signalPerf.filter(a => a.bucket === 'loss');
        const profitGroup = signalPerf.filter(a => a.bucket === 'profit');
        const groupTotal = g => g.reduce((s, a) => s + (a.net_pnl || 0), 0);
        const groupWinrateRange = g => {
          if (!g.length) return '—';
          const rates = g.map(a => a.winrate);
          const lo = Math.min(...rates), hi = Math.max(...rates);
          return lo === hi ? `${lo.toFixed(1)}%` : `${lo.toFixed(1)}–${hi.toFixed(1)}%`;
        };
        const fmtSigned = v => `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v)).toLocaleString('fr-CA')} $`;
        const sorted = [...signalPerf].sort((a, b) => a.winrate - a.threshold - (b.winrate - b.threshold));

        return (
          <Card style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 4 }}>Winrate réel vs seuil de rentabilité, par signal EA</div>
            <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 14 }}>
              Seuil calculé depuis les gains/pertes moyens réels de chaque compte (pas le R:R configuré de l'EA) — classement MACRO/SWEEP vs MICRO basé sur le nom du signal, à valider.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div style={{ background: 'rgba(216,90,48,0.08)', border: `0.5px solid rgba(216,90,48,0.3)`, borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 10.5, letterSpacing: '0.05em', textTransform: 'uppercase', color: RED, marginBottom: 6 }}>Signal MACRO / SWEEP</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: RED }}>{fmtSigned(groupTotal(lossGroup))}</div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{lossGroup.length} compte(s), winrate {groupWinrateRange(lossGroup)}</div>
              </div>
              <div style={{ background: 'rgba(29,158,117,0.08)', border: `0.5px solid rgba(29,158,117,0.3)`, borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 10.5, letterSpacing: '0.05em', textTransform: 'uppercase', color: GREEN, marginBottom: 6 }}>Signal MICRO (autres)</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: GREEN }}>{fmtSigned(groupTotal(profitGroup))}</div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{profitGroup.length} compte(s), winrate {groupWinrateRange(profitGroup)}</div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sorted.map(a => {
                const above = a.winrate >= (a.threshold ?? 0);
                const barColor = above ? GREEN : RED;
                const fillPct = Math.min(a.winrate, 100);
                const threshPct = Math.min(a.threshold ?? 0, 100);
                return (
                  <div key={a.account_id} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 90px', gap: 14, alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{labelForLogin(a.login)}</div>
                      <div style={{ fontSize: 10, color: MUTED, marginTop: 2, wordBreak: 'break-word' }}>{a.symbol} · {a.signal || 'signal inconnu'}</div>
                    </div>
                    <div>
                      <div style={{ position: 'relative', height: 8, background: '#1e2130', borderRadius: 5 }}>
                        <div style={{ position: 'absolute', inset: 0, width: `${fillPct}%`, background: barColor, borderRadius: 5 }} />
                        {a.threshold != null && (
                          <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${threshPct}%`, width: 2, background: '#fff', opacity: 0.6 }} />
                        )}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: MUTED, marginTop: 4 }}>
                        <span>{a.winrate.toFixed(1)}% réel</span>
                        <span>seuil {a.threshold != null ? `${a.threshold.toFixed(1)}%` : '—'}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: a.net_pnl >= 0 ? GREEN : RED }}>{fmtSigned(a.net_pnl)}</div>
                      <div style={{ fontSize: 10, color: MUTED }}>{a.trades} trades</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })()}

      {/* ── Historique : phases/logins passés (superseded) ─────────────── */}
      {activeTab === 'overview' && phaseHistory.length > 0 && (
        <Card style={{ padding: 0, overflow: 'hidden', marginTop: 14 }}>
          <div style={{ padding: '12px 16px 0', fontSize: 13, fontWeight: 600, color: '#fff' }}>Historique</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '0.5px solid #1e2130', color: MUTED, textAlign: 'left' }}>
                  {['Compte', 'Étape', 'Statut', 'Balance', 'Balance max.', 'P&L', 'Drawdown', 'Mise à jour'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {phaseHistory.map((p, i) => {
                  // Le statut brut d'une phase passée reste souvent "ongoing" (jamais explicitement
                  // marqué "completed" avant le passage au login suivant) -- une phase superseded qui
                  // n'est ni breached ni funded a nécessairement été réussie (sinon pas de nouveau
                  // login pour ce même account_id), donc affichée comme complétée quel que soit le
                  // statut brut stocké.
                  const display = p.challenge_status === 'breached'
                    ? { label: 'Breached', color: RED }
                    : p.challenge_status === 'funded'
                      ? { label: 'Funded', color: '#9B59B6' }
                      : { label: 'Complété', color: GREEN };
                  const pnl = p.last_balance != null && p.deposit != null ? p.last_balance - p.deposit : null;
                  const pnlPct = pnl != null && p.deposit ? (pnl / p.deposit) * 100 : null;
                  return (
                    <tr key={`${p.account_id}-${p.login}-${i}`} style={{ borderBottom: '0.5px solid #1a1d27' }}>
                      <td style={{ padding: '8px 12px', color: '#ccc' }}>
                        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: firmColor(p.firm), marginRight: 6 }} />
                        {p.firm} — {p.login}
                      </td>
                      <td style={{ padding: '8px 12px', color: '#ccc' }}>{p.challenge_phase || '—'}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                          color: display.color, background: `${display.color}22`, border: `0.5px solid ${display.color}55`
                        }}>{display.label}</span>
                      </td>
                      <td style={{ padding: '8px 12px', color: '#fff', fontWeight: 600 }}>{fmtMoney(p.last_balance)}</td>
                      <td style={{ padding: '8px 12px', color: MUTED }}>{fmtMoney(p.max_balance)}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 600, color: pnl >= 0 ? GREEN : RED }}>
                        {fmtMoney(pnl)} {pnlPct != null && `(${fmtPct(pnlPct)})`}
                      </td>
                      <td style={{ padding: '8px 12px', color: GOLD }}>{p.last_drawdown != null ? `${Number(p.last_drawdown).toFixed(2)}%` : '—'}</td>
                      <td style={{ padding: '8px 12px', color: MUTED }}>{fmtDateTime(p.last_seen?.value || p.last_seen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── Trades ──────────────────────────────────────────────────────── */}
      {activeTab === 'trades' && (
        <>
          <Card style={{ padding: '10px 16px', marginBottom: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Affichage</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[{ id: 'list', label: 'Liste' }, { id: 'summary', label: 'Sommaire' }, { id: 'chart', label: 'Graphique' }].map(v => (
                  <button key={v.id} onClick={() => setTradesViewMode(v.id)} style={{
                    padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                    border: '0.5px solid', borderColor: tradesViewMode === v.id ? BLUE : '#1e2130',
                    background: tradesViewMode === v.id ? '#0d1f35' : 'transparent',
                    color: tradesViewMode === v.id ? BLUE : MUTED
                  }}>{v.label}</button>
                ))}
              </div>
            </div>
            {tradesViewMode === 'summary' && (
              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Grouper par</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[{ id: 'login', label: 'Login' }, { id: 'symbol', label: 'Symbole' }, { id: 'date', label: 'Date' }].map(g => (
                    <button key={g.id} onClick={() => setSummaryGroupBy(g.id)} style={{
                      padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                      border: '0.5px solid', borderColor: summaryGroupBy === g.id ? GOLD : '#1e2130',
                      background: summaryGroupBy === g.id ? '#2b1f0a' : 'transparent',
                      color: summaryGroupBy === g.id ? GOLD : MUTED
                    }}>{g.label}</button>
                  ))}
                </div>
              </div>
            )}
            {tradesViewMode === 'chart' && (
              <>
                {chartSymbolAccounts.length > 1 && (
                  <div>
                    <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>
                      Compte (flux de prix -- {chartSymbolAccounts.length} comptes tradent {chartSymbol})
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {chartSymbolAccounts.map(a => (
                        <button key={a.login} onClick={() => setFilterLogin(a.login)} style={{
                          padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                          border: '0.5px solid', borderColor: chartLogin === a.login ? BLUE : '#1e2130',
                          background: chartLogin === a.login ? '#0d1f35' : 'transparent',
                          color: chartLogin === a.login ? BLUE : MUTED
                        }}>{labelForLogin(a.login)}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Période</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {['5d', '10d', '30d'].map(p => (
                      <button key={p} onClick={() => setChartPeriod(p)} style={{
                        padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                        border: '0.5px solid', borderColor: chartPeriod === p ? BLUE : '#1e2130',
                        background: chartPeriod === p ? '#0d1f35' : 'transparent',
                        color: chartPeriod === p ? BLUE : MUTED
                      }}>{p}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Intervalle</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {['1m', '5m', '15m'].map(iv => (
                      <button key={iv} onClick={() => setChartInterval(iv)} style={{
                        padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                        border: '0.5px solid', borderColor: chartInterval === iv ? GREEN : '#1e2130',
                        background: chartInterval === iv ? '#0d2b1a' : 'transparent',
                        color: chartInterval === iv ? GREEN : MUTED
                      }}>{iv}</button>
                    ))}
                  </div>
                </div>
                <button onClick={loadChart} style={{
                  padding: '6px 16px', borderRadius: 5, border: 'none', background: BLUE,
                  color: '#fff', cursor: 'pointer', fontSize: 12, alignSelf: 'flex-end'
                }}>↺ Refresh</button>
              </>
            )}
          </Card>

          {tradesViewMode === 'chart' && (
            <Card>
              {loadingChart && <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>⏳ Chargement du flux MT5...</div>}
              {!loadingChart && chartError && (
                <div style={{ color: RED, fontSize: 13, padding: 40, textAlign: 'center' }}>❌ {chartError}</div>
              )}
              {!loadingChart && !chartError && chartCandles.length === 0 && (
                <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>
                  {chartLogin ? 'Aucune donnée de prix pour ce compte/période.' : 'Sélectionne un symbole.'}
                </div>
              )}
              {!loadingChart && chartCandles.length > 0 && (
                <>
                  {chartExcludedCount > 0 && (
                    <div style={{
                      fontSize: 12, color: GOLD, background: '#2b1f0a', border: '0.5px solid #4a3a15',
                      borderRadius: 6, padding: '8px 12px', marginBottom: 10
                    }}>
                      ⚠️ {chartExcludedCount} trade(s) sur {chartSymbol} sont hors de la période affichée
                      ({chartPeriod}) et ne sont pas montrés — élargis la période pour les voir.
                    </div>
                  )}
                  {chartAccountPills.length > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span style={{ fontSize: 11, color: MUTED, marginRight: 2 }}>Filtrer par compte :</span>
                      {chartAccountPills.map(p => {
                        const active = chartSelectedLogins.has(p.login);
                        const highlighted = chartHighlightedLogins.has(p.login);
                        return (
                          <button key={p.login} onClick={() => toggleChartLogin(p.login)} style={{
                            display: 'flex', alignItems: 'center', gap: 5,
                            padding: '4px 10px', borderRadius: 20, cursor: 'pointer', fontSize: 12,
                            border: `1.5px solid ${highlighted ? p.color : '#1e2130'}`,
                            background: active ? `${p.color}22` : 'transparent',
                            color: highlighted ? '#fff' : MUTED,
                            boxShadow: highlighted && !active ? `0 0 0 2px ${p.color}55` : 'none'
                          }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color }} />
                            {labelForLogin(p.login)}
                          </button>
                        );
                      })}
                      {(chartSelectedLogins.size > 0 || chartSelectedTradeKeys.size > 0) && (
                        <button onClick={clearChartSelection} style={{
                          padding: '4px 10px', borderRadius: 20, cursor: 'pointer', fontSize: 12,
                          border: '1.5px solid #1e2130', background: 'transparent', color: MUTED
                        }}>✕ Effacer la sélection</button>
                      )}
                    </div>
                  )}
                  {/* deps inclut le timestamp de la dernière bougie, pas seulement chartCandles.length --
                      sur une fenêtre glissante (5j de bougies 5m), le NOMBRE de bougies reste quasi
                      constant en continu (les vieilles sortent de la fenêtre au même rythme que les
                      neuves entrent), donc .length seul ne change presque jamais : le rafraîchissement
                      silencieux (60s) mettait bien chartCandles à jour en React, mais PlotDiv ne
                      redessinait jamais avec les nouvelles données -- le graphique restait figé à l'écran
                      sur le dernier vrai redraw (confirmé 2026-08-03 par comparaison directe avec MT5). */}
                  <PlotDiv
                    traces={chartTraces}
                    autoscaleY
                    uirevision={`${chartSymbol}-${chartLogin}-${chartPeriod}-${chartInterval}`}
                    layout={{
                      title: `${chartSymbol} — entrées/sorties par compte (${chartInterval}) · flux: ${labelForLogin(chartLogin)}`,
                      height: 480,
                      paper_bgcolor: '#13151f',
                      plot_bgcolor: '#13151f',
                      font: { color: '#ccc' },
                      xaxis: {
                        type: 'date',
                        title: 'Heure (UTC)',
                        rangeslider: { visible: true, bgcolor: '#0f1117', bordercolor: '#1e2130' },
                        gridcolor: '#1e2130'
                      },
                      yaxis: { title: 'Prix', gridcolor: '#1e2130' },
                      legend: { bgcolor: 'rgba(0,0,0,0)', font: { color: '#ccc' } }
                    }}
                    deps={[chartCandles[chartCandles.length - 1]?.ts, chartCandles.length, chartTraces.length, chartExcludedCount, chartSelectedLogins.size, chartSelectedTradeKeys.size]}
                  />
                  <div style={{ fontSize: 11, color: MUTED, marginTop: 8, textAlign: 'center' }}>
                    Couleur de fond = compte · ▲ = achat, ▼ = vente (entrée), ● = sortie ·{' '}
                    contour <span style={{ color: GREEN }}>vert</span> = gain,{' '}
                    <span style={{ color: RED }}>rouge</span> = perte ·{' '}
                    contour <span style={{ color: BLUE }}>bleu</span> ◆ = position encore ouverte
                  </div>

                  {chartTradeList.length > 0 && (
                    <div style={{ marginTop: 14, borderTop: '0.5px solid #1e2130', paddingTop: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                        <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Trades affichés ({chartTradeList.length})
                          {chartSelectedTradeKeys.size > 0 && ` · ${chartSelectedTradeKeys.size} sélectionné(s)`}
                        </div>
                        {chartSelectedTradeKeys.size > 0 && (
                          <button onClick={clearChartSelection} style={{
                            marginLeft: 'auto', padding: '2px 10px', borderRadius: 20, cursor: 'pointer', fontSize: 11,
                            border: '1px solid #1e2130', background: 'transparent', color: MUTED
                          }}>✕ Effacer</button>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: MUTED, marginBottom: 6 }}>
                        Clique un ou plusieurs trades pour les isoler sur le graphique ci-dessus.
                      </div>
                      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <tbody>
                            {chartTradeList.map((t, i) => {
                              const selected = chartSelectedTradeKeys.has(tradeKey(t));
                              return (
                                <tr key={i} onClick={() => toggleChartTrade(t)} style={{
                                  borderBottom: '0.5px solid #1a1d27', cursor: 'pointer',
                                  background: selected ? `${t.color}1a` : 'transparent'
                                }}>
                                  <td style={{ padding: '5px 8px', width: 16 }}>
                                    <span title={labelForLogin(t.login)} style={{
                                      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                      background: t.color, boxShadow: selected ? `0 0 0 2px ${t.color}55` : 'none'
                                    }} />
                                  </td>
                                  <td style={{ padding: '5px 8px', width: 16, color: t.direction === 'BUY' ? GREEN : RED }}>
                                    {t.direction === 'BUY' ? '▲' : '▼'}
                                  </td>
                                  <td style={{ padding: '5px 8px', color: MUTED, whiteSpace: 'nowrap' }}>
                                    {fmtDateTime(t.closed_at?.value || t.closed_at)}
                                  </td>
                                  <td style={{ padding: '5px 8px', color: '#ccc', whiteSpace: 'nowrap' }}>
                                    {t.entry_price} → {t.exit_price}
                                  </td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: t.net_pnl >= 0 ? GREEN : RED }}>
                                    {fmtMoney(t.net_pnl)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </Card>
          )}

          {tradesViewMode !== 'chart' && (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {loadingTrades && <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>⏳ Chargement des trades...</div>}
            {!loadingTrades && trades.length === 0 && (
              <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>Aucun trade complété pour ce filtre.</div>
            )}

            {!loadingTrades && trades.length > 0 && tradesViewMode === 'list' && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '0.5px solid #1e2130', color: MUTED, textAlign: 'left' }}>
                      {['Compte', 'Symbole', 'Sens', 'Ouvert', 'Fermé', 'Entrée', 'Sortie', 'P&L net', 'Raison'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => (
                      <tr key={i} style={{ borderBottom: '0.5px solid #1a1d27' }}>
                        <td style={{ padding: '8px 12px', color: '#ccc' }}>{labelForLogin(t.login)}</td>
                        <td style={{ padding: '8px 12px', color: '#ccc' }}>{t.symbol}</td>
                        <td style={{ padding: '8px 12px', color: t.direction === 'BUY' ? GREEN : RED }}>{t.direction}</td>
                        <td style={{ padding: '8px 12px', color: MUTED }}>{fmtDateTime(t.opened_at?.value || t.opened_at)}</td>
                        <td style={{ padding: '8px 12px', color: MUTED }}>{fmtDateTime(t.closed_at?.value || t.closed_at)}</td>
                        <td style={{ padding: '8px 12px', color: '#ccc' }}>{t.entry_price}</td>
                        <td style={{ padding: '8px 12px', color: '#ccc' }}>{t.exit_price}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 600, color: t.net_pnl >= 0 ? GREEN : RED }}>{fmtMoney(t.net_pnl)}</td>
                        <td style={{ padding: '8px 12px', color: MUTED }}>{t.close_reason}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '1px solid #1e2130' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: '#fff' }}>TOTAL ({trades.length})</td>
                      <td colSpan={6} />
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: tradesListTotalPnl >= 0 ? GREEN : RED }}>{fmtMoney(tradesListTotalPnl)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {!loadingTrades && trades.length > 0 && tradesViewMode === 'summary' && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '0.5px solid #1e2130', color: MUTED, textAlign: 'left' }}>
                      {[
                        summaryGroupBy === 'login' ? 'Login' : summaryGroupBy === 'symbol' ? 'Symbole' : 'Date',
                        'Total Trades', 'Gagnants', 'Perdants',
                        'Win Rate', 'Loss Rate', 'P&L Net',
                        ...(summaryGroupBy === 'login' ? ['Reset'] : ['Logins actifs'])
                      ].map(h => (
                        <th key={h} style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tradesSummary.map(row => {
                      const winRate = row.total ? (row.wins / row.total) * 100 : 0;
                      const lossRate = row.total ? (row.losses / row.total) * 100 : 0;
                      const winDominant = row.wins >= row.losses;
                      const reset = resetsByLogin[row.key];
                      return (
                        <tr key={row.key} style={{ borderBottom: '0.5px solid #1a1d27' }}>
                          <td style={{ padding: '8px 12px', color: '#fff', fontWeight: 600 }}>
                            {summaryGroupBy === 'login' ? labelForLogin(row.key) : row.key}
                          </td>
                          <td style={{ padding: '8px 12px', color: '#ccc' }}>{row.total}</td>
                          <td style={{ padding: '8px 12px', color: GREEN }}>{row.wins}</td>
                          <td style={{ padding: '8px 12px', color: RED }}>{row.losses}</td>
                          <td style={{ padding: '8px 12px', color: winDominant ? GREEN : MUTED, fontWeight: winDominant ? 600 : 400 }}>{winRate.toFixed(2)}%</td>
                          <td style={{ padding: '8px 12px', color: !winDominant ? RED : MUTED, fontWeight: !winDominant ? 600 : 400 }}>{lossRate.toFixed(2)}%</td>
                          <td style={{ padding: '8px 12px', fontWeight: 600, color: row.pnl >= 0 ? GREEN : RED }}>{fmtMoney(row.pnl)}</td>
                          {summaryGroupBy === 'login' ? (
                            <td style={{ padding: '8px 12px', color: reset ? GOLD : MUTED, fontWeight: reset ? 600 : 400 }}>
                              {reset ? `+${fmtMoney(reset)}` : '—'}
                            </td>
                          ) : (
                            <td style={{ padding: '8px 12px', color: '#ccc' }}>{row.loginCount}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '1px solid #1e2130' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: '#fff' }}>TOTAL</td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: '#fff' }}>{tradesSummaryTotals.total}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: GREEN }}>{tradesSummaryTotals.wins}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: RED }}>{tradesSummaryTotals.losses}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: '#fff' }}>
                        {tradesSummaryTotals.total ? ((tradesSummaryTotals.wins / tradesSummaryTotals.total) * 100).toFixed(2) : '0.00'}%
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: '#fff' }}>
                        {tradesSummaryTotals.total ? ((tradesSummaryTotals.losses / tradesSummaryTotals.total) * 100).toFixed(2) : '0.00'}%
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 700, color: tradesSummaryTotals.pnl >= 0 ? GREEN : RED }}>{fmtMoney(tradesSummaryTotals.pnl)}</td>
                      {summaryGroupBy === 'login' ? (
                        <td style={{ padding: '8px 12px', fontWeight: 700, color: GOLD }}>
                          {tradesSummaryTotals.resetSum ? `+${fmtMoney(tradesSummaryTotals.resetSum)}` : '—'}
                        </td>
                      ) : (
                        <td style={{ padding: '8px 12px', fontWeight: 700, color: '#fff' }}>{tradesSummaryTotals.loginCount}</td>
                      )}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
          )}
        </>
      )}

      {/* ── Événements ──────────────────────────────────────────────────── */}
      {activeTab === 'events' && (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {events.length === 0 && (
            <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>Aucun événement.</div>
          )}
          {events.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '0.5px solid #1e2130', color: MUTED, textAlign: 'left' }}>
                    {['Compte', 'Date', 'Type', 'Montant', 'Commentaire'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid #1a1d27' }}>
                      <td style={{ padding: '8px 12px', color: '#ccc' }}>{labelForLogin(e.login)}</td>
                      <td style={{ padding: '8px 12px', color: MUTED }}>{fmtDateTime(e.event_time?.value || e.event_time)}</td>
                      <td style={{ padding: '8px 12px', color: e.event_type === 'reset' ? GOLD : '#ccc' }}>{e.event_type}</td>
                      <td style={{ padding: '8px 12px', color: e.amount >= 0 ? GREEN : RED }}>{fmtMoney(e.amount)}</td>
                      <td style={{ padding: '8px 12px', color: MUTED }}>{e.comment}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ── Config EA (comparatif entre licenses) ──────────────────────── */}
      {activeTab === 'config' && (
        <Card style={{ padding: 0 }}>
          {eaConfigs.length === 0 ? (
            <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>Aucune config EA disponible.</div>
          ) : (() => {
            // Regroupe par section (le préfixe avant le premier "." -- "Risk", "Strategy",
            // "Minimum trading days") -- l'union de toutes les clés vues sur tous les comptes,
            // au cas où des variantes d'EA différentes n'ont pas exactement les mêmes paramètres.
            const sections = {};
            eaConfigs.forEach(c => {
              Object.keys(c.config || {}).forEach(key => {
                const [section, ...rest] = key.split('.');
                const label = rest.join('.');
                (sections[section] ||= new Set()).add(label);
              });
            });
            const sortedAccounts = [...accounts].sort((a, b) =>
              (a.license_firm || '').localeCompare(b.license_firm || '') || a.login - b.login
            );
            // Colonnes de valeurs volontairement étroites avec retour à la ligne (maxWidth + wrap)
            // plutôt que nowrap -- sinon le tableau devient illisiblement large avec 7 comptes.
            const cellStyle = { padding: '7px 10px', borderBottom: '0.5px solid #1a1d27', color: '#ccc', fontSize: 12, textAlign: 'left', maxWidth: 110, whiteSpace: 'normal', wordBreak: 'break-word' };
            const labelCellStyle = { ...cellStyle, maxWidth: 220, whiteSpace: 'normal', textAlign: 'left' };
            const headStyle = { padding: '8px 10px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em', color: MUTED, textAlign: 'left', position: 'sticky', top: 0, background: '#13151f', zIndex: 1 };
            return (
              <div style={{ overflow: 'auto', maxHeight: '72vh' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                  <thead>
                    <tr style={{ borderBottom: '0.5px solid #1e2130' }}>
                      <th style={{ ...headStyle, width: 220 }}>Paramètre</th>
                      {sortedAccounts.map(acc => (
                        <th key={acc.login} style={{ ...headStyle, width: 110 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: firmColor(acc.license_firm), flexShrink: 0 }} />
                            {acc.license_firm} — {acc.login}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ ...labelCellStyle, fontWeight: 600, color: '#fff' }}>Statut EA</td>
                      {sortedAccounts.map(acc => {
                        const cfg = eaConfigs.find(c => c.login === acc.login);
                        const detached = cfg?.attached === false;
                        return (
                          <td key={acc.login} style={{ ...cellStyle, color: detached ? RED : GREEN, fontWeight: 600 }}
                              title={detached ? cfg?.reason : ''}>
                            {cfg ? (detached ? '⚠ Détaché' : '● Attaché') : '—'}
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td style={{ ...labelCellStyle, fontWeight: 600, color: '#fff' }}>Version EA</td>
                      {sortedAccounts.map(acc => {
                        const cfg = eaConfigs.find(c => c.login === acc.login);
                        return <td key={acc.login} style={cellStyle}>{cfg?.ea_version || '—'}</td>;
                      })}
                    </tr>
                    {Object.entries(sections).map(([section, keys]) => (
                      <Fragment key={section}>
                        <tr>
                          <td colSpan={sortedAccounts.length + 1} style={{
                            padding: '8px 10px 4px', fontSize: 10, color: MUTED, textTransform: 'uppercase',
                            letterSpacing: '0.05em', fontWeight: 600, borderTop: '1px solid #1e2130', textAlign: 'left'
                          }}>{section}</td>
                        </tr>
                        {[...keys].sort().map(label => {
                          const isRR = label.toLowerCase().includes('risk : reward');
                          return (
                            <tr key={`${section}.${label}`}>
                              <td style={{ ...labelCellStyle, color: isRR ? BLUE : '#ccc', fontWeight: isRR ? 700 : 400 }}>{label}</td>
                              {sortedAccounts.map(acc => {
                                const cfg = eaConfigs.find(c => c.login === acc.login);
                                const val = cfg?.config?.[`${section}.${label}`];
                                return (
                                  <td key={acc.login} style={{ ...cellStyle, color: isRR ? BLUE : '#ccc', fontWeight: isRR ? 700 : 400 }}>
                                    {val ?? '—'}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </Card>
      )}

      {/* ── Popup config EA d'un compte (déclenchée par le badge [EA] des cases) ────────── */}
      {eaModalLogin != null && (() => {
        const cfg = eaConfigs.find(c => c.login === eaModalLogin);
        const acc = accounts.find(a => a.login === eaModalLogin);
        if (!cfg) return null;
        const detached = cfg.attached === false;
        return (
          <div
            onClick={() => setEaModalLogin(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
            }}
          >
            <div onClick={e => e.stopPropagation()} style={{
              background: '#13151f', border: '0.5px solid #1e2130', borderRadius: 10,
              padding: 20, maxWidth: 480, width: '100%', maxHeight: '80vh', overflowY: 'auto'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontWeight: 600, color: '#fff', fontSize: 14 }}>
                  {acc ? `${acc.license_firm} — ${acc.login}` : eaModalLogin} · Config EA
                </div>
                <button onClick={() => setEaModalLogin(null)} style={{
                  background: 'none', border: 'none', color: MUTED, fontSize: 16, cursor: 'pointer', padding: 4
                }}>✕</button>
              </div>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 12 }}>{cfg.ea_version || '—'}</div>
              <div style={{
                fontSize: 12, fontWeight: 600, marginBottom: 12, padding: '6px 10px', borderRadius: 6,
                color: detached ? RED : GREEN, background: detached ? `${RED}22` : `${GREEN}22`,
                border: `0.5px solid ${detached ? RED : GREEN}55`
              }}>
                {detached ? '⚠ EA détaché' : '● EA attaché'} — {cfg.reason}
              </div>
              {Object.entries(
                Object.entries(cfg.config || {}).reduce((acc2, [key, val]) => {
                  const [section, ...rest] = key.split('.');
                  (acc2[section] ||= []).push([rest.join('.'), val]);
                  return acc2;
                }, {})
              ).map(([section, entries]) => (
                <div key={section} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{section}</div>
                  {entries.map(([label, val]) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '3px 0', borderBottom: '0.5px solid #1a1d27' }}>
                      <span style={{ color: MUTED }}>{label}</span>
                      <span style={{ color: '#ccc', textAlign: 'right' }}>{val}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── MFE Tracker (Maximum Favorable Excursion) : jusqu'où le prix est allé avant le SL ── */}
      {activeTab === 'analyse' && (
        <div>
          <Card style={{ padding: '12px 16px', marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 2 }}>MFE Tracker — Maximum Favorable Excursion</div>
            <div style={{ fontSize: 11.5, color: MUTED }}>
              Pour chaque perte fermée au SL, le meilleur R atteint avant le retour au SL — calculé en direct par trading-monitor (<code>trade_mfe</code>), pas un R:R hypothétique.
            </div>
          </Card>

          <Card style={{ padding: '10px 16px', marginBottom: 14, display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Regrouper par</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {[
                  { id: 'day', label: 'Jour' },
                  { id: 'symbol', label: 'Symbole' },
                  { id: 'build', label: 'Build' },
                  { id: 'firm', label: 'Prop firm' },
                ].map(opt => (
                  <button key={opt.id} onClick={() => setMfeGroupBy(opt.id)} style={{
                    padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                    border: '0.5px solid', borderColor: mfeGroupBy === opt.id ? BLUE : '#1e2130',
                    background: mfeGroupBy === opt.id ? '#0d1f35' : 'transparent',
                    color: mfeGroupBy === opt.id ? BLUE : MUTED, fontWeight: mfeGroupBy === opt.id ? 600 : 400
                  }}>{opt.label}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Du</div>
              <input type="date" value={mfeDateFrom} onChange={e => setMfeDateFrom(e.target.value)} style={{
                background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 5,
                color: '#fff', fontSize: 12, padding: '5px 8px'
              }} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Au</div>
              <input type="date" value={mfeDateTo} onChange={e => setMfeDateTo(e.target.value)} style={{
                background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 5,
                color: '#fff', fontSize: 12, padding: '5px 8px'
              }} />
            </div>
            {(mfeDateFrom || mfeDateTo) && (
              <button onClick={() => { setMfeDateFrom(''); setMfeDateTo(''); }} style={{
                padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                border: '0.5px solid #1e2130', background: 'transparent', color: MUTED
              }}>Plage complète</button>
            )}
            {mfeLoading && <span style={{ fontSize: 12, color: MUTED }}>⏳ Chargement...</span>}
          </Card>

          {mfeError && (
            <Card style={{ padding: 16, marginBottom: 14, color: RED, fontSize: 13 }}>❌ {mfeError}</Card>
          )}

          {!mfeLoading && mfeFiltered.length > 0 && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }}>
                <Card style={{ padding: '14px 16px' }}>
                  <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, marginBottom: 6 }}>Pertes SL analysées</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: '#fff' }}>{mfeTotals.total}</div>
                </Card>
                <Card style={{ padding: '14px 16px', background: 'rgba(29,158,117,0.08)', border: `0.5px solid rgba(29,158,117,0.3)` }}>
                  <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: GREEN, marginBottom: 6 }}>Ont atteint ≥ 1.2R avant le SL</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: GREEN }}>
                    {mfeTotals.b1214 + mfeTotals.b1416 + mfeTotals.over16}
                    <span style={{ fontSize: 13, fontWeight: 400, marginLeft: 6 }}>({fmtPct((mfeTotals.b1214 + mfeTotals.b1416 + mfeTotals.over16) / mfeTotals.total * 100)})</span>
                  </div>
                </Card>
                <Card style={{ padding: '14px 16px', background: 'rgba(55,138,221,0.08)', border: `0.5px solid rgba(55,138,221,0.3)` }}>
                  <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: BLUE, marginBottom: 6 }}>Ont atteint ≥ 1.6R avant le SL</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: BLUE }}>
                    {mfeTotals.over16}
                    <span style={{ fontSize: 13, fontWeight: 400, marginLeft: 6 }}>({fmtPct(mfeTotals.over16 / mfeTotals.total * 100)})</span>
                  </div>
                </Card>
              </div>

              <Card style={{ marginBottom: 14 }}>
                <PlotDiv
                  traces={MFE_BUCKETS.map(b => ({
                    type: 'bar', x: mfeGrouped.map(g => g.key), y: mfeGrouped.map(g => g[b.key]),
                    name: b.label, marker: { color: b.color }
                  }))}
                  layout={{
                    title: 'Pertes SL par ' + ({ day: 'jour', symbol: 'symbole', build: 'build', firm: 'prop firm' }[mfeGroupBy]) + ' — palier de MFE atteint',
                    barmode: 'stack', height: 380,
                    paper_bgcolor: '#13151f', plot_bgcolor: '#13151f',
                    font: { color: MUTED, size: 11 },
                    legend: { orientation: 'h', y: -0.25, font: { color: '#ccc', size: 11 } },
                    xaxis: { tickangle: mfeGroupBy === 'day' ? -90 : 0, gridcolor: '#1e2130', linecolor: '#1e2130', color: MUTED },
                    yaxis: { title: 'Trades', gridcolor: '#1e2130', linecolor: '#1e2130', color: MUTED, zerolinecolor: '#1e2130' },
                    bargap: 0.25,
                  }}
                  deps={[mfeGrouped]}
                />
              </Card>

              <Card style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '0.5px solid #1e2130', color: MUTED, textAlign: 'left' }}>
                        {[
                          { id: 'day', label: 'Jour' }, { id: 'symbol', label: 'Symbole' },
                          { id: 'build', label: 'Build' }, { id: 'firm', label: 'Prop firm' },
                        ].filter(h => h.id === mfeGroupBy).map(h => (
                          <th key={h.id} style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h.label}</th>
                        ))}
                        <th style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>Total</th>
                        {MFE_BUCKETS.map(b => (
                          <th key={b.key} style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{b.label}</th>
                        ))}
                        <th style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mfeGrouped.map(g => (
                        <tr key={g.key} style={{ borderBottom: '0.5px solid #1a1d27' }}>
                          <td style={{ padding: '8px 12px', color: '#fff', fontWeight: 600 }}>{g.key}</td>
                          <td style={{ padding: '8px 12px', color: '#ccc' }}>{g.total}</td>
                          {MFE_BUCKETS.map(b => (
                            <td key={b.key} style={{ padding: '8px 12px', color: g[b.key] ? '#ccc' : MUTED }}>{g[b.key] || '—'}</td>
                          ))}
                          <td style={{ padding: '8px 12px', fontWeight: 600, color: g.net_pnl >= 0 ? GREEN : RED }}>{fmtMoney(g.net_pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}

          {!mfeLoading && mfeFiltered.length === 0 && !mfeError && (
            <Card style={{ padding: 40, textAlign: 'center', color: MUTED, fontSize: 13 }}>
              {mfeLosers.length === 0 ? "Aucune perte SL analysée pour l'instant." : 'Aucune perte SL dans cette plage de dates.'}
            </Card>
          )}

          {/* ── Synthèse : où placer le R:R, combine trade_mfe + trade_mfe_win ──────── */}
          <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', margin: '28px 0 12px' }}>Où placer le R:R — synthèse perdants + gagnants</div>
          {rrLoading && !rrOptimal && (
            <Card style={{ padding: 40, textAlign: 'center', color: MUTED, fontSize: 13 }}>⏳ Calcul en cours...</Card>
          )}
          {rrOptimal && (() => {
            const fmtD = v => `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v)).toLocaleString('fr-CA')} $`;
            const bestR = rrOptimal.best.r;
            return (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14 }}>
                  <Card style={{ padding: '14px 16px' }}>
                    <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, marginBottom: 6 }}>P&amp;L réel (R:R ~1.8)</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: rrOptimal.actual_total >= 0 ? GREEN : RED }}>{fmtD(rrOptimal.actual_total)}</div>
                  </Card>
                  <Card style={{ padding: '14px 16px', background: 'rgba(155,140,245,0.08)', border: '0.5px solid rgba(155,140,245,0.35)' }}>
                    <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#9B59B6', marginBottom: 6 }}>R:R optimal simulé</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#9B59B6' }}>{bestR.toFixed(2)}</div>
                  </Card>
                  <Card style={{ padding: '14px 16px' }}>
                    <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, marginBottom: 6 }}>$ simulé à {bestR.toFixed(2)}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: GREEN }}>{fmtD(rrOptimal.best.total_dollars)}</div>
                  </Card>
                  <Card style={{ padding: '14px 16px' }}>
                    <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: MUTED, marginBottom: 6 }}>Gain vs réel</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: GREEN }}>{fmtD(rrOptimal.best.total_dollars - rrOptimal.actual_total)}</div>
                  </Card>
                </div>

                <Card style={{ marginBottom: 14 }}>
                  <PlotDiv
                    traces={[{
                      type: 'bar',
                      x: rrOptimal.sweep.map(s => s.r.toFixed(2)),
                      y: rrOptimal.sweep.map(s => s.total_dollars),
                      text: rrOptimal.sweep.map(s => `winrate ${s.winrate.toFixed(1)}%`),
                      hovertemplate: '%{x}R : %{y:,.0f}$<br>%{text}<extra></extra>',
                      marker: {
                        color: rrOptimal.sweep.map(s => (s.total_dollars >= 0 ? GREEN : RED)),
                        line: {
                          color: rrOptimal.sweep.map(s => (s.r === bestR ? '#9B59B6' : 'rgba(0,0,0,0)')),
                          width: rrOptimal.sweep.map(s => (s.r === bestR ? 2.5 : 0)),
                        },
                      },
                    }]}
                    layout={{
                      title: '$ total simulé par R:R candidat',
                      height: 340,
                      paper_bgcolor: '#13151f', plot_bgcolor: '#13151f',
                      font: { color: MUTED, size: 11 },
                      showlegend: false,
                      xaxis: { title: 'R:R', gridcolor: '#1e2130', linecolor: '#1e2130', color: MUTED },
                      yaxis: { title: '$', gridcolor: '#1e2130', linecolor: '#1e2130', color: MUTED, zerolinecolor: '#3a4256' },
                      bargap: 0.15,
                    }}
                    deps={[rrOptimal]}
                  />
                </Card>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Card style={{ padding: '14px 16px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 10 }}>Perdants — trade_mfe</div>
                    {[
                      ['Trades fermés au SL analysés', rrOptimal.losers.count],
                      ['MFE moyen avant le SL', `${rrOptimal.losers.avg_mfe.toFixed(2)}R`],
                      ['MFE médian', `${rrOptimal.losers.median_mfe.toFixed(2)}R`],
                      [`Auraient touché ≥ ${bestR.toFixed(2)}R avant le SL`, `${rrOptimal.losers.at_best_r} (${fmtPct(rrOptimal.losers.at_best_r / rrOptimal.losers.count * 100)})`],
                    ].map(([label, val]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '6px 0', borderBottom: '0.5px solid #1e2130', color: '#ccc' }}>
                        <span style={{ color: MUTED }}>{label}</span><span>{val}</span>
                      </div>
                    ))}
                  </Card>
                  <Card style={{ padding: '14px 16px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 10 }}>Gagnants — fenêtre étendue post-TP</div>
                    {[
                      ['Trades fermés au TP analysés', rrOptimal.winners.count],
                      ['R laissé sur la table — moyenne', `${rrOptimal.winners.avg_left_on_table.toFixed(2)}R`],
                      ['R laissé sur la table — médian', `${rrOptimal.winners.median_left_on_table.toFixed(2)}R`],
                      ['Auraient dépassé le TP réel (>0.1R)', `${rrOptimal.winners.beyond_tp} (${fmtPct(rrOptimal.winners.beyond_tp / rrOptimal.winners.count * 100)})`],
                    ].map(([label, val]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '6px 0', borderBottom: '0.5px solid #1e2130', color: '#ccc' }}>
                        <span style={{ color: MUTED }}>{label}</span><span>{val}</span>
                      </div>
                    ))}
                  </Card>
                </div>

                <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.7, marginTop: 14 }}>
                  « P&amp;L réel » ne couvre que les trades fermés au SL ou au TP (fermetures manuelles exclues des deux côtés). Le R candidat est appliqué uniformément aux 8 comptes, alors qu'en réalité hola_3 tourne à 1.7 et les autres à 1.8. Assume que les mêmes signaux d'entrée/prix se seraient produits avec un TP différent -- hypothèse standard pour ce type de backtest.
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* ── Architecture : schéma complet du pipeline, statique -- aucun fetch ────────────── */}
      {activeTab === 'architecture' && (
        <div>
          <Card style={{ padding: '12px 16px', marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 2 }}>Architecture — trading-monitor + mitchbi</div>
            <div style={{ fontSize: 11.5, color: MUTED }}>
              7 licences MT5, lues toutes les 5 minutes, écrites dans BigQuery, et servies à Discord et à mitchbi.com. Le vrai chemin des données -- et les deux garde-fous ajoutés après que le cycle se soit figé, deux fois, en une semaine.
            </div>
          </Card>

          <Card style={{ padding: 12, marginBottom: 4, overflowX: 'auto' }}>
            <svg viewBox="0 0 1240 800" style={{ display: 'block', width: '100%', height: 'auto', minWidth: 900 }} role="img" aria-label="Le pipeline part de 7 terminaux MT5 sur le VPS, lus par trading_monitor.py toutes les 5 minutes sous la garde d'un watchdog qui le tue s'il se fige, écrit dans BigQuery, et alimente Discord, mitchbi.com et un dashboard local Flask.">
              <defs>
                <marker id="arch-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#8b93a5" />
                </marker>
                <marker id="arch-arrow-alert" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={RED} />
                </marker>
              </defs>

              {/* VPS boundary */}
              <rect x="20" y="20" width="1200" height="300" fill={BLUE} fillOpacity="0.06" stroke={BLUE} strokeWidth="1.2" strokeDasharray="5 4" rx="14" />
              <text x="36" y="40" fontSize="10.5" letterSpacing="0.08em" fill={MUTED} fontFamily="monospace">FOREXVPS · WINDOWS SERVER 2022</text>

              {/* MT5 farm */}
              <rect x="45" y="50" width="1150" height="115" fill="#13151f" stroke={BLUE} strokeWidth="1.4" rx="9" />
              <text x="65" y="75" fontSize="14.5" fontWeight="600" fill="#fff">7× terminaux MT5</text>
              <text x="65" y="93" fontSize="11.5" fill={MUTED}>1 processus + 1 EA Imperium attaché, par compte</text>
              <text x="65" y="114" fontSize="10.5" fill={MUTED} fontFamily="monospace">136795·Hola Prime   134530·Hola Prime   124582·Hola Prime   14178484·FundedNext</text>
              <text x="65" y="131" fontSize="10.5" fill={MUTED} fontFamily="monospace">2779521·Alpha Capital   2779506·Alpha Capital   2860198·Alpha Capital</text>
              <text x="65" y="150" fontSize="11" fill={RED}>26571576·The5ers — retiré (breach 2026-08-31, terminal figé sur "Authorization failed")</text>

              {/* Row 2 */}
              <rect x="45" y="205" width="300" height="95" fill="#13151f" stroke={BLUE} strokeWidth="1.4" rx="9" />
              <text x="65" y="230" fontSize="13" fontWeight="600" fill="#fff" fontFamily="monospace">discord_listener.py</text>
              <text x="65" y="248" fontSize="11.5" fill={MUTED}>process continu · depuis 8/23</text>
              <text x="65" y="264" fontSize="11.5" fill={MUTED}>instance MT5Monitor partagée</text>
              <text x="65" y="282" fontSize="11.5" fill={MUTED}>commandes /status /positions /sanity…</text>

              <rect x="375" y="205" width="480" height="95" fill="#13151f" stroke={BLUE} strokeWidth="1.4" rx="9" />
              <text x="395" y="230" fontSize="13" fontWeight="600" fill="#fff" fontFamily="monospace">trading_monitor.py</text>
              <text x="395" y="248" fontSize="11.5" fill={MUTED}>tâche planifiée · 1 cycle / 5 min · 7 comptes en séquence</text>
              <text x="395" y="266" fontSize="10.5" fill={MUTED} fontFamily="monospace">mt5_connect_probe.py → sonde isolée, timeout 20s, avant chaque compte</text>
              <text x="395" y="284" fontSize="11.5" fill={MUTED}>écrit heartbeat après chaque cycle complété</text>

              <rect x="885" y="205" width="310" height="95" fill="#13151f" stroke={BLUE} strokeWidth="1.4" rx="9" />
              <text x="905" y="230" fontSize="13" fontWeight="600" fill="#fff" fontFamily="monospace">watchdog.py</text>
              <text x="905" y="248" fontSize="11.5" fill={MUTED}>tâche planifiée · toutes les 10 min</text>
              <text x="905" y="264" fontSize="11.5" fill={MUTED}>lit le heartbeat</text>
              <text x="905" y="282" fontSize="11.5" fill={RED}>tue le process + alerte si figé &gt;15 min</text>

              {/* BigQuery */}
              <rect x="345" y="380" width="550" height="95" fill="#13151f" stroke={GOLD} strokeWidth="1.4" rx="9" />
              <text x="365" y="405" fontSize="14.5" fontWeight="600" fill="#fff">BigQuery — royaldistributing.trading</text>
              <text x="365" y="425" fontSize="10.5" fill={MUTED} fontFamily="monospace">accounts_snapshot_v2 · trade_deals · price_bars · ea_config</text>
              <text x="365" y="441" fontSize="10.5" fill={MUTED} fontFamily="monospace">challenge_phases · trade_mfe · trade_mfe_win</text>
              <text x="365" y="459" fontSize="11.5" fill={MUTED}>+ vues : latest_accounts_view, trades_view, daily_balance_history_view…</text>

              {/* Discord */}
              <rect x="45" y="560" width="420" height="130" fill="#13151f" stroke={GREEN} strokeWidth="1.4" rx="9" />
              <text x="65" y="585" fontSize="14.5" fontWeight="600" fill="#fff">Discord — #trading_ea</text>
              <text x="65" y="605" fontSize="11.5" fill={MUTED}>notifications : trade ouvert/fermé, breach, alerte watchdog</text>
              <text x="65" y="623" fontSize="10.5" fill={MUTED} fontFamily="monospace">/status /positions /sanity /refresh</text>
              <text x="65" y="639" fontSize="10.5" fill={MUTED} fontFamily="monospace">/ea /ask /completed /breached /funded</text>
              <text x="65" y="659" fontSize="11" fill={MUTED}>canal unique, bot + commandes texte</text>

              {/* Railway / Vercel */}
              <rect x="525" y="560" width="340" height="85" fill="#13151f" stroke={GREEN} strokeWidth="1.4" rx="9" />
              <text x="545" y="588" fontSize="14.5" fontWeight="600" fill="#fff">Backend — Railway</text>
              <text x="545" y="606" fontSize="11.5" fill={MUTED}>Node / Express</text>
              <text x="545" y="623" fontSize="10.5" fill={MUTED} fontFamily="monospace">routes /api/trading-imperium/*</text>

              <rect x="525" y="690" width="340" height="85" fill="#13151f" stroke={GREEN} strokeWidth="1.4" rx="9" />
              <text x="545" y="718" fontSize="14.5" fontWeight="600" fill="#fff">mitchbi.com — Vercel</text>
              <text x="545" y="736" fontSize="11.5" fill={MUTED}>React · auth via Supabase</text>
              <text x="545" y="753" fontSize="11.5" fill={MUTED}>Overview · Trades · MFE Tracker · Config EA</text>

              {/* Flask / Claude */}
              <rect x="905" y="560" width="290" height="85" fill="#13151f" stroke={GREEN} strokeWidth="1.4" rx="9" />
              <text x="925" y="588" fontSize="14.5" fontWeight="600" fill="#fff">Dashboard local — Flask</text>
              <text x="925" y="606" fontSize="11.5" fill={MUTED}>sur le VPS, usage interne</text>
              <text x="925" y="623" fontSize="11.5" fill={MUTED}>équité, P&amp;L, positions</text>

              <rect x="905" y="690" width="290" height="85" fill="#13151f" stroke={GREEN} strokeWidth="1.4" rx="9" />
              <text x="925" y="718" fontSize="14.5" fontWeight="600" fill="#fff">Trading IQ</text>
              <text x="925" y="736" fontSize="10.5" fill={MUTED} fontFamily="monospace">assistant_agent.py → Claude API</text>
              <text x="925" y="753" fontSize="11.5" fill={MUTED}>questions en langage naturel</text>

              {/* Arrows */}
              <line x1="615" y1="165" x2="615" y2="203" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="628" y="188" fontSize="10.5" fill={MUTED}>sonde + lecture</text>

              <line x1="885" y1="252" x2="857" y2="252" stroke={RED} strokeWidth="1.5" strokeDasharray="4 3" markerEnd="url(#arch-arrow-alert)" />
              <text x="748" y="245" fontSize="10.5" fill={RED} textAnchor="middle">tue si figé</text>

              <line x1="615" y1="300" x2="615" y2="378" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="628" y="343" fontSize="10.5" fill={MUTED}>écrit (7 tables)</text>

              <line x1="195" y1="203" x2="195" y2="167" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="207" y="188" fontSize="10.5" fill={MUTED}>lecture live</text>

              <polyline points="300,300 300,340 400,340 400,378" fill="none" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="330" y="333" fontSize="10.5" fill={MUTED}>lit</text>

              <line x1="195" y1="300" x2="195" y2="558" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="207" y="435" fontSize="10.5" fill={MUTED}>commandes / réponses</text>

              <polyline points="420,300 420,335 280,335 280,558" fill="none" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="286" y="328" fontSize="10.5" fill={MUTED}>notifications</text>

              <polyline points="950,300 950,358 380,358 380,558" fill="none" stroke={RED} strokeWidth="1.5" strokeDasharray="4 3" markerEnd="url(#arch-arrow-alert)" />
              <text x="660" y="351" fontSize="10.5" fill={RED} textAnchor="middle">alerte watchdog</text>

              <line x1="695" y1="560" x2="695" y2="477" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="708" y="522" fontSize="10.5" fill={MUTED}>lecture SQL</text>

              <line x1="695" y1="690" x2="695" y2="647" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="708" y="672" fontSize="10.5" fill={MUTED}>fetch /api/*</text>

              <polyline points="1050,560 1050,510 850,510 850,477" fill="none" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="945" y="503" fontSize="10.5" fill={MUTED}>lecture</text>

              <line x1="1050" y1="690" x2="1050" y2="647" stroke="#8b93a5" strokeWidth="1.4" opacity="0.75" markerEnd="url(#arch-arrow)" />
              <text x="1063" y="672" fontSize="10.5" fill={MUTED}>questions</text>
            </svg>
          </Card>

          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 11.5, color: MUTED, margin: '10px 4px 20px' }}>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: BLUE, marginRight: 6, verticalAlign: 'middle' }} />processus sur le VPS</span>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: GOLD, marginRight: 6, verticalAlign: 'middle' }} />entrepôt de données</span>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: GREEN, marginRight: 6, verticalAlign: 'middle' }} />consommateurs (cloud)</span>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: RED, marginRight: 6, verticalAlign: 'middle' }} />filet de sécurité / alerte</span>
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: BLUE, margin: '20px 0 10px' }}>Le moteur — forexvps · windows</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px,1fr))', gap: 10, marginBottom: 20 }}>
            {[
              { t: 'trading_monitor.py', d: 'Tâche planifiée toutes les 5 minutes. Pour chacun des 7 comptes actifs, en séquence : sonde de connexion, lecture du solde/équité/positions, synchronisation des deals, des price bars, de la config EA, et calcul du MFE sur les trades fraîchement fermés.' },
              { t: 'mt5_connect_probe.py', d: "mt5.initialize() est un appel DLL bloquant qu'aucun timeout Python ne peut interrompre de l'intérieur. La sonde le lance dans un sous-processus jetable et le tue de force au bout de 20s s'il ne répond pas — ajoutée le 2026-09-02." },
              { t: 'watchdog.py', d: "La sonde protège sa propre tentative de connexion, pas les appels réels qui suivent. Le 2026-09-03, le cycle s'est quand même figé — sur un compte parfaitement sain (hola_3). Le watchdog lit un fichier heartbeat écrit après chaque cycle réussi ; passé 15 minutes de silence, il tue le process bloqué et alerte sur Discord." },
              { t: 'discord_listener.py', d: 'Process continu (pas une tâche planifiée) qui garde une instance MT5Monitor partagée en mémoire pour répondre aux commandes texte instantanément — certaines lisent BigQuery, d\'autres relisent MT5 en direct.' },
            ].map(c => (
              <Card key={c.t} style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 6, fontFamily: 'monospace' }}>{c.t}</div>
                <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6 }}>{c.d}</div>
              </Card>
            ))}
          </div>

          <div style={{ fontSize: 13, fontWeight: 600, color: GOLD, margin: '20px 0 10px' }}>L'entrepôt — google cloud</div>
          <Card style={{ padding: '14px 16px', marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 6, fontFamily: 'monospace' }}>royaldistributing.trading</div>
            <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginBottom: 8 }}>
              Un projet BigQuery unique. Chaque table est append-only ou tenue à jour par <code>account_id</code> — l'identifiant stable d'une licence à travers ses changements de phase/login, jamais réutilisé.
            </div>
            <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6 }}>
              <code>latest_accounts_view</code> garde la dernière ligne connue de chaque compte pour toujours, même un compte retiré de la liste active — la cause exacte du bug du 4 septembre où une position d'un compte breaché continuait de s'afficher comme ouverte.
            </div>
          </Card>

          <div style={{ fontSize: 13, fontWeight: 600, color: GREEN, margin: '20px 0 10px' }}>Les consommateurs — lecture seule</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px,1fr))', gap: 10, marginBottom: 20 }}>
            {[
              { t: 'Discord', d: 'Deux chemins distincts vers le même canal : trading_monitor.py pousse ses notifications directement à chaque cycle, pendant que discord_listener.py répond aux commandes en continu, indépendamment du cycle des 5 minutes.' },
              { t: 'mitchbi.com', d: 'Vercel (React) appelle Railway (Node) via /api/trading-imperium/* ; Railway seul a les identifiants BigQuery. L\'authentification passe par Supabase — chaque appel porte un jeton de session.' },
              { t: 'Dashboard local + Trading IQ', d: 'Un Flask minimal sur le VPS même, pour un accès rapide sans passer par le web. Le panneau Trading IQ délègue les questions en langage naturel à Claude via assistant_agent.py.' },
            ].map(c => (
              <Card key={c.t} style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 6 }}>{c.t}</div>
                <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6 }}>{c.d}</div>
              </Card>
            ))}
          </div>

          <Card style={{ padding: '16px 18px', border: `0.5px solid ${RED}55`, background: '#1a1113' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: RED, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 12 }}>Historique récent — ce que le schéma ne montre pas</div>
            {[
              ['2026-08-31', 'The5ers 26571576 breach ; son terminal se met à refuser l\'authentification.'],
              ['2026-09-01→03', 'mt5.initialize() se fige indéfiniment sur ce terminal, bloquant tout le cycle derrière lui pendant 19h+ d\'affilée — deux fois. mt5_connect_probe.py ajouté le 09-02, mais le 09-03 le gel a re-frappé sur hola_3, un compte sain : la sonde protège sa propre tentative, pas les appels réels qui suivent.'],
              ['2026-09-03', 'watchdog.py ajouté comme filet de sécurité externe : peu importe où ça gèle dans le cycle, le temps de récupération reste borné à ~15 min.'],
              ['2026-09-04', '/positions corrigé pour ne lire que les comptes actifs — la position fantôme de The5ers ne peut plus s\'afficher comme "ouverte" indéfiniment.'],
            ].map(([date, text]) => (
              <div key={date} style={{ display: 'flex', gap: 12, fontSize: 12.5, color: '#ccc', marginBottom: 10, lineHeight: 1.6 }}>
                <span style={{ fontFamily: 'monospace', color: RED, flexShrink: 0, fontSize: 11.5, paddingTop: 1 }}>{date}</span>
                <span>{text}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

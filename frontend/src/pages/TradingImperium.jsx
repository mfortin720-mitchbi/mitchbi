import { useState, useEffect, useRef, useMemo } from 'react';
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

const PlotDiv = ({ traces, layout, deps, autoscaleY }) => {
  const ref = useRef(null);
  const plotlyReady = usePlotly();
  useEffect(() => {
    if (!plotlyReady || !ref.current || !traces) return;
    const gd = ref.current;
    window.Plotly.newPlot(gd, traces, {
      template: 'plotly_dark',
      margin: { t: 50, l: 55, r: 20, b: 50 },
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

const CHALLENGE_STATUS_COLORS = { ongoing: BLUE, completed: GREEN, breached: RED };
const CHALLENGE_STATUS_SUFFIX = { completed: ' ✓', breached: ' ✗' };

export default function TradingImperium({ activeTab = 'overview', onTabChange }) {
  const [accounts, setAccounts] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [events, setEvents] = useState([]);

  const [filterFirm, setFilterFirm] = useState('all');
  const [filterLogin, setFilterLogin] = useState('all');
  const [filterSymbol, setFilterSymbol] = useState('all');

  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const [trades, setTrades] = useState([]);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [tradesViewMode, setTradesViewMode] = useState('list'); // 'list' | 'summary' | 'chart'
  const [summaryGroupBy, setSummaryGroupBy] = useState('login'); // 'login' | 'symbol'

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

  const loadEvents = async () => {
    try {
      const res = await apiFetch('/api/trading-imperium/events');
      const d = await res.json();
      if (d.success) setEvents(d.events);
    } catch (e) { console.error(e); }
  };

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const params = new URLSearchParams();
      if (filterFirm !== 'all') params.set('firm', filterFirm);
      if (filterLogin !== 'all') params.set('login', filterLogin);
      if (filterSymbol !== 'all') params.set('symbol', filterSymbol);
      const res = await apiFetch(`/api/trading-imperium/history?${params}`);
      const d = await res.json();
      if (d.success) setHistory(d.history);
    } catch (e) { console.error(e); }
    finally { setLoadingHistory(false); }
  };

  const loadTrades = async () => {
    setLoadingTrades(true);
    try {
      const params = new URLSearchParams();
      if (filterLogin !== 'all') params.set('login', filterLogin);
      if (filterSymbol !== 'all') params.set('symbol', filterSymbol);
      const res = await apiFetch(`/api/trading-imperium/trades?${params}`);
      const d = await res.json();
      if (d.success) setTrades(d.trades);
    } catch (e) { console.error(e); }
    finally { setLoadingTrades(false); }
  };

  const loadChart = async () => {
    if (!chartLogin) return;
    setLoadingChart(true);
    setChartCandles([]); // évite d'afficher les bougies d'un compte précédent si ce fetch échoue
    setChartError(null);
    try {
      const params = new URLSearchParams({ login: chartLogin, period: chartPeriod, interval: chartInterval });
      const res = await apiFetch(`/api/trading-imperium/chart?${params}`);
      const d = await res.json();
      if (d.success) setChartCandles(d.candles); else setChartError(d.error || 'Erreur inconnue');
    } catch (e) { console.error(e); setChartError(e.message); }
    finally { setLoadingChart(false); }
  };

  useEffect(() => { loadAccounts(); loadEvents(); }, []);
  useEffect(() => { if (activeTab === 'overview') loadHistory(); }, [activeTab, filterFirm, filterLogin, filterSymbol]);
  useEffect(() => { if (activeTab === 'trades') loadTrades(); }, [activeTab, filterLogin, filterSymbol]);

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

  // Nombre de trades fermés par jour, tous comptes filtrés confondus (barres, axe droit)
  const dailyTradeCounts = useMemo(() => {
    const map = {};
    for (const row of history) {
      const day = row.day.value || row.day;
      map[day] = (map[day] || 0) + (row.trades_closed || 0);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [history]);

  // Sommaire Trades — groupe les trades filtrés par login ou par symbole
  const tradesSummary = useMemo(() => {
    const map = {};
    for (const t of trades) {
      // Normalise le symbole (retire le suffixe broker, ex: "GBPUSD.raw" -> "GBPUSD")
      // pour que tous les firmes tradant le même instrument s'agrègent ensemble.
      const key = summaryGroupBy === 'login' ? t.login : t.symbol.split('.')[0];
      if (!map[key]) map[key] = { key, total: 0, wins: 0, losses: 0, pnl: 0, logins: new Set() };
      map[key].total += 1;
      if (t.net_pnl >= 0) map[key].wins += 1; else map[key].losses += 1;
      map[key].pnl += t.net_pnl;
      map[key].logins.add(t.login);
    }
    return Object.values(map)
      .map(row => ({ ...row, loginCount: row.logins.size }))
      .sort((a, b) => b.total - a.total);
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
    // survol). Une ligne pointillée relie chaque entrée à sa sortie, dans la couleur du compte --
    // séparée par un null entre chaque trade pour ne pas chaîner les trades entre eux.
    const compactPnl = v => `${v >= 0 ? '+' : '-'}$${Math.round(Math.abs(v))}`;
    const tradeTraces = Object.entries(byLogin).map(([login, ts]) => {
      const loginColor = loginColors[login];
      const x = [], y = [], symbol = [], borderColor = [], hovertext = [], dispText = [];
      for (const t of ts) {
        const win = t.net_pnl >= 0;
        const resultColor = win ? GREEN : RED;
        x.push(toUtcIso(t.opened_at?.value || t.opened_at), toUtcIso(t.closed_at?.value || t.closed_at), null);
        y.push(t.entry_price, t.exit_price, null);
        symbol.push(t.direction === 'BUY' ? 'triangle-up' : 'triangle-down', 'circle', 'circle');
        borderColor.push(resultColor, resultColor, 'rgba(0,0,0,0)');
        dispText.push('', compactPnl(t.net_pnl), '');
        hovertext.push(
          `${labelForLogin(Number(login))} · ${t.direction} · Entrée ${t.entry_price}`,
          `${labelForLogin(Number(login))} · Sortie ${t.exit_price} · P&L ${fmtMoney(t.net_pnl)} (${win ? 'gain' : 'perte'})`,
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

      {!loadingAccounts && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: 10, marginBottom: 14 }}>
          {accounts.map(acc => {
            const status = AccountStatus(acc);
            const selected = filterLogin === acc.login;
            const hasPosition = acc.open_positions_count > 0;
            const progress = challengeProgress(acc);
            return (
              <Card
                key={acc.login}
                onClick={() => selectAccount(acc.login)}
                style={{
                  padding: '11px 12px',
                  cursor: 'pointer',
                  border: hasPosition ? '2px solid #fff' : `0.5px solid ${firmColor(acc.license_firm)}33`,
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
                      color: CHALLENGE_STATUS_COLORS[acc.challenge_status] || MUTED,
                      background: `${CHALLENGE_STATUS_COLORS[acc.challenge_status] || MUTED}22`,
                      border: `0.5px solid ${CHALLENGE_STATUS_COLORS[acc.challenge_status] || MUTED}55`
                    }}>
                      {acc.challenge_phase}{CHALLENGE_STATUS_SUFFIX[acc.challenge_status] || ''}
                    </div>
                    {progress != null && (
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
                  <div><div style={{ fontSize: 10, color: MUTED }}>EQUITY</div><div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{fmtMoney(acc.equity)}</div></div>
                  <div><div style={{ fontSize: 10, color: MUTED }}>P&amp;L</div><div style={{ fontSize: 12, color: acc.pnl >= 0 ? GREEN : RED }}>{fmtMoney(acc.pnl)} ({fmtPct(acc.pnl_pct)})</div></div>
                  <div><div style={{ fontSize: 10, color: MUTED }}>DRAWDOWN</div><div style={{ fontSize: 12, color: acc.drawdown_pct > 0 ? RED : '#ccc' }}>{fmtPct(acc.drawdown_pct)}</div></div>
                </div>
                <div style={{ fontSize: 10, color: MUTED }}>{acc.open_positions_count} position(s) · maj {fmtDateTime(acc.last_updated?.value || acc.last_updated)}</div>
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
                  {[{ id: 'login', label: 'Login' }, { id: 'symbol', label: 'Symbole' }].map(g => (
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
                  <PlotDiv
                    traces={chartTraces}
                    autoscaleY
                    layout={{
                      title: `${chartSymbol} — entrées/sorties par compte (${chartInterval}) · flux: ${labelForLogin(chartLogin)}`,
                      height: 480,
                      paper_bgcolor: '#13151f',
                      plot_bgcolor: '#13151f',
                      font: { color: '#ccc' },
                      xaxis: {
                        type: 'date',
                        rangeslider: { visible: true, bgcolor: '#0f1117', bordercolor: '#1e2130' },
                        gridcolor: '#1e2130'
                      },
                      yaxis: { title: 'Prix', gridcolor: '#1e2130' },
                      legend: { bgcolor: 'rgba(0,0,0,0)', font: { color: '#ccc' } }
                    }}
                    deps={[chartCandles.length, chartTraces.length, chartExcludedCount, chartSelectedLogins.size, chartSelectedTradeKeys.size]}
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
                </table>
              </div>
            )}

            {!loadingTrades && trades.length > 0 && tradesViewMode === 'summary' && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '0.5px solid #1e2130', color: MUTED, textAlign: 'left' }}>
                      {[
                        summaryGroupBy === 'login' ? 'Login' : 'Symbole', 'Total Trades', 'Gagnants', 'Perdants',
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
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';

const API = import.meta.env.VITE_API_URL;

const ALL_INSTRUMENTS = {
  'MGC=F':  { name: 'Micro Gold',       emoji: '🥇', category: 'Metals',  topstep: true },
  'GC=F':   { name: 'Gold',             emoji: '🏅', category: 'Metals',  topstep: true },
  'MES=F':  { name: 'Micro E-mini S&P', emoji: '📈', category: 'Equity',  topstep: true },
  'ES=F':   { name: 'E-mini S&P 500',   emoji: '📊', category: 'Equity',  topstep: true },
  'MNQ=F':  { name: 'Micro Nasdaq',     emoji: '💻', category: 'Equity',  topstep: true },
  'NQ=F':   { name: 'E-mini Nasdaq',    emoji: '🖥',  category: 'Equity',  topstep: true },
  'M2K=F':  { name: 'Micro Russell',    emoji: '📉', category: 'Equity',  topstep: true },
  'RTY=F':  { name: 'Russell 2000',     emoji: '🏦', category: 'Equity',  topstep: true },
  'MCL=F':  { name: 'Micro Crude Oil',  emoji: '🛢',  category: 'Energy',  topstep: true },
  'CL=F':   { name: 'Crude Oil',        emoji: '⛽', category: 'Energy',  topstep: true },
  '6E=F':   { name: 'Euro FX',          emoji: '💶', category: 'FX',      topstep: false },
  'ZB=F':   { name: '30Y T-Bond',       emoji: '🏛',  category: 'Rates',   topstep: false },
};

const RSI_COLOR = r => !r ? '#555' : r > 70 ? '#D85A30' : r < 30 ? '#378ADD' : '#1D9E75';
const RSI_LABEL = r => !r ? '—' : r > 70 ? '🔴 Suracheté' : r < 30 ? '🔵 Survendu' : '🟢 Neutre';

const DEFAULT_ANALYZE_PROMPT = `Rôle: Expert en probabilités Gold (MGC). 1 tick = 1$
Méthode: Grille DCA 3 contrats (-200t, -400t). Danger = Short Streak > 600t.
License TopStep 50K Combine, perte maximale $2000.
Heures EXCLUES (America/Montreal): 9h15-10h15, 18h-18h30, 22h-5h45

1. 📊 Analyse Horaire: À quelles heures les vagues > 400-600 ticks se produisent-elles?
2. ⚠️ Risque SL: % qui dépasse 600t et état du RSI à ce moment
3. 🔍 Patterns: Y a-t-il un pattern dans les déclenchements?
4. 🎯 Verdict: Ma grille est-elle adaptée à cet instrument maintenant?
5. 📐 RSI optimal: Quel RSI de départ est sécuritaire pour mon DCA?
6. ❓ Questions de session: 3 questions clés avant de trader
7. 🕐 Meilleures heures de trading selon ma méthode?

En français, précis et actionnable.`;

const DEFAULT_SCAN_PROMPT = `Tu es un expert en trading de futures. Analyse ces instruments pour ma méthode DCA.
Méthode: 3 contrats, entrée -200t et -400t, SL max 600t, TopStep 50K ($2000 max loss).
Heures exclues (America/Montreal): 9h15-10h15, 18h-18h30, 22h-5h45

1. 🏆 Meilleur instrument du moment et pourquoi
2. 🚦 Statut de chaque instrument (Favorable/Neutre/Dangereux)  
3. ⚠️ Alertes importantes
4. 💡 Conseil pour la session actuelle

Sois direct, en français, max 300 mots.`;

// Charge Plotly une seule fois
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

const PlotDiv = ({ id, traces, layout, deps }) => {
  const ref = useRef(null);
  const plotlyReady = usePlotly();
  useEffect(() => {
    if (!plotlyReady || !ref.current || !traces) return;
    window.Plotly.newPlot(ref.current, traces, {
      template: 'plotly_dark',
      margin: { t: 50, l: 55, r: 20, b: 50 },
      ...layout
    }, { responsive: true, displayModeBar: false });
  }, [plotlyReady, ...(deps || [])]);
  return <div ref={ref} style={{ width: '100%' }} />;
};

export default function Trader() {
  const [selectedTickers, setSelectedTickers] = useState(['MGC=F', 'MES=F', 'MNQ=F']);
  const [params, setParams]   = useState({ rsiWindow: 9, slMax: 600, dca1: 200, dca2: 400, streakMin: 3 });
  const [period, setPeriod]   = useState('10d');
  const [interval, setIval]   = useState('5m');
  const [analyzePrompt, setAnalyzePrompt] = useState(DEFAULT_ANALYZE_PROMPT);
  const [scanPrompt, setScanPrompt]       = useState(DEFAULT_SCAN_PROMPT);
  const [showPrompts, setShowPrompts]     = useState(false);

  const [scanning, setScanning]       = useState(false);
  const [scanResults, setScanResults] = useState(null);
  const [recommendation, setRecommendation] = useState('');
  const [currentHour, setCurrentHour] = useState(null);

  const [selectedTicker, setSelectedTicker] = useState(null);
  const [loadingData, setLoadingData]       = useState(false);
  const [detailData, setDetailData]         = useState(null);
  const [analyzing, setAnalyzing]           = useState(false);
  const [claudeAnalysis, setClaudeAnalysis] = useState(null);

  const toggleTicker = t => setSelectedTickers(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t]);

  const scan = async () => {
    if (!selectedTickers.length) return;
    setScanning(true); setScanResults(null); setRecommendation('');
    try {
      const res = await fetch(`${API}/api/trader/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: selectedTickers, period, interval, params, scanPrompt })
      });
      const d = await res.json();
      if (d.success) { setScanResults(d.results); setRecommendation(d.recommendation); setCurrentHour(d.currentHour); }
    } catch (e) { console.error(e); }
    finally { setScanning(false); }
  };

  const openDetail = async (ticker) => {
    setSelectedTicker(ticker); setDetailData(null); setClaudeAnalysis(null); setLoadingData(true);
    try {
      const res = await fetch(`${API}/api/trader/data`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, period, interval, params })
      });
      const d = await res.json();
      if (d.success) setDetailData(d);
    } catch (e) { console.error(e); }
    finally { setLoadingData(false); }
  };

  const runClaude = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`${API}/api/trader/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: selectedTicker, period, interval, params, analyzePrompt })
      });
      const d = await res.json();
      if (d.success) setClaudeAnalysis(d.claudeAnalysis);
    } catch (e) { console.error(e); }
    finally { setAnalyzing(false); }
  };

  const categories = [...new Set(Object.values(ALL_INSTRUMENTS).map(i => i.category))];

  // ── VUE DÉTAILLÉE ──────────────────────────────────────────────────────────
  if (selectedTicker) {
    const info = ALL_INSTRUMENTS[selectedTicker];
    const a = detailData?.analysis;

    return (
      <div>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <button onClick={() => setSelectedTicker(null)} style={{ padding: '6px 14px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 13 }}>← Retour</button>
          <span style={{ fontSize: 22 }}>{info.emoji}</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>{info.name} ({selectedTicker})</div>
            <div style={{ fontSize: 12, color: '#444' }}>{info.category} · TopStep {info.topstep ? '✅' : '❌'}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['5d','10d','30d'].map(p => (
              <button key={p} onClick={() => { setPeriod(p); openDetail(selectedTicker); }} style={{ padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12, border: '0.5px solid', borderColor: period===p?'#378ADD':'#1e2130', background: period===p?'#0d1f35':'transparent', color: period===p?'#378ADD':'#555' }}>{p}</button>
            ))}
            {['1m','5m','15m'].map(iv => (
              <button key={iv} onClick={() => { setIval(iv); openDetail(selectedTicker); }} style={{ padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12, border: '0.5px solid', borderColor: interval===iv?'#1D9E75':'#1e2130', background: interval===iv?'#0d2b1a':'transparent', color: interval===iv?'#1D9E75':'#555' }}>{iv}</button>
            ))}
            <button onClick={() => openDetail(selectedTicker)} style={{ padding: '5px 14px', borderRadius: 5, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 12 }}>↺ Refresh</button>
          </div>
        </div>

        {loadingData && (
          <div style={{ color: '#444', fontSize: 13, padding: 60, textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>⏳</div>Chargement Yahoo Finance...
          </div>
        )}

        {!loadingData && a && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: 10 }}>
              {[
                { label: 'Prix', value: a.currentPrice?.toFixed(2) },
                { label: 'RSI actuel', value: a.currentRSI, color: RSI_COLOR(a.currentRSI), sub: RSI_LABEL(a.currentRSI) },
                { label: 'HL% moyen', value: `${a.summary.avgHLPct}%` },
                { label: 'Max Short', value: `${a.summary.maxShortStreak}t`, color: a.summary.maxShortStreak > 600 ? '#D85A30' : '#1D9E75' },
                { label: '% SL breach', value: `${a.slBreach}%`, color: parseFloat(a.slBreach) > 30 ? '#D85A30' : '#1D9E75' },
                { label: 'Dominance', value: a.summary.dominance },
                { label: 'Jours analysés', value: a.dailyStats?.length },
              ].map(k => (
                <div key={k.label} style={{ background: '#13151f', borderRadius: 8, border: '0.5px solid #1e2130', padding: '10px 14px' }}>
                  <div style={{ fontSize: 10, color: '#444', marginBottom: 3, textTransform: 'uppercase' }}>{k.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: k.color||'#fff' }}>{k.value}</div>
                  {k.sub && <div style={{ fontSize: 11, color: k.color||'#555', marginTop: 2 }}>{k.sub}</div>}
                </div>
              ))}
            </div>

            {/* Statut session */}
            <div style={{ background: a.isExcluded?'#2b0d0d':'#0d2b1a', borderRadius: 8, padding: '10px 16px', fontSize: 13, color: a.isExcluded?'#D85A30':'#1D9E75', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>{a.isExcluded?'🔴':'🟢'}</span>
              <span style={{ fontWeight: 500 }}>{a.isExcluded ? 'HORS HEURES DE TRADING — Ne pas trader' : 'SESSION ACTIVE'}</span>
            </div>

            {/* 1. Candlestick — TOUTES les données */}
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
              <PlotDiv
                traces={[{
                  type: 'candlestick',
                  x: a.candleData.map(d => new Date(d.localMs)),
                  open: a.candleData.map(d => d.open),
                  high: a.candleData.map(d => d.high),
                  low:  a.candleData.map(d => d.low),
                  close: a.candleData.map(d => d.close),
                  increasing: { line: { color: '#26a69a' } },
                  decreasing: { line: { color: '#ef5350' } },
                  name: selectedTicker
                }]}
                layout={{ title: `${selectedTicker} — Chandelles (${interval})`, xaxis: { rangeslider: { visible: false } }, height: 320 }}
                deps={[a.candleData.length]}
              />
            </div>

            {/* 2. RSI — TOUTES les données (pas de slice) */}
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
              <PlotDiv
                traces={[{
                  type: 'scatter',
                  x: a.candleData.filter(d => d.rsi !== null).map(d => new Date(d.localMs)),
                  y: a.candleData.filter(d => d.rsi !== null).map(d => d.rsi),
                  name: 'RSI', line: { color: '#9B59B6', width: 1.5 },
                  fill: 'tozeroy', fillcolor: 'rgba(155,89,182,0.08)'
                }]}
                layout={{
                  title: `RSI (${params.rsiWindow} périodes) — Valeurs brutes`,
                  height: 220,
                  yaxis: { range: [0, 100] },
                  shapes: [
                    { type:'line', y0:70, y1:70, x0:0, x1:1, xref:'paper', line:{ color:'#ef5350', dash:'dash', width:1 } },
                    { type:'line', y0:30, y1:30, x0:0, x1:1, xref:'paper', line:{ color:'#26a69a', dash:'dash', width:1 } },
                  ]
                }}
                deps={[a.candleData.length, params.rsiWindow]}
              />
            </div>

            {/* 3. Tick Pressure + Structure côte à côte — TOUS les jours */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
                <PlotDiv
                  traces={[
                    { type:'bar', x: a.dailyStats.map(d=>d.date), y: a.dailyStats.map(d=>d.totalLong), name:'Total Long', marker:{color:'#26a69a'} },
                    { type:'bar', x: a.dailyStats.map(d=>d.date), y: a.dailyStats.map(d=>d.totalShort), name:'Total Short', marker:{color:'#ef5350'} },
                    { type:'scatter', x: a.dailyStats.map(d=>d.date), y: a.dailyStats.map(d=>d.netDelta), name:'Net Delta', line:{color:'white', width:2, dash:'dot'} },
                  ]}
                  layout={{ title:'Comparaison Pression Acheteuse vs Vendeuse par Jour', barmode:'relative', height:300, xaxis:{title:'Date'}, yaxis:{title:'Nombre de Ticks'} }}
                  deps={[a.dailyStats.length]}
                />
              </div>
              <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
                <PlotDiv
                  traces={[
                    { type:'scatter', x: a.dailyStats.map(d=>d.date), y: a.dailyStats.map(d=>d.high),  name:'High',  line:{color:'#26a69a',width:2}, mode:'lines+markers', marker:{size:5} },
{ type:'scatter', x: a.dailyStats.map(d=>d.date), y: a.dailyStats.map(d=>d.low),   name:'Low',   line:{color:'#ef5350',width:2}, mode:'lines+markers', marker:{size:5} },
{ type:'scatter', x: a.dailyStats.map(d=>d.date), y: a.dailyStats.map(d=>d.close), name:'Close', line:{color:'#E8A838',width:2,dash:'dot'}, mode:'lines+markers', marker:{symbol:'diamond',size:5,color:'#E8A838'} },
                  ]}
                  layout={{ title:'Structure de Prix (High/Low/Close)', height:300,legend: { bgcolor:'rgba(0,0,0,0)', font:{color:'#ccc'} }, xaxis:{title:'Date'}, yaxis:{title:'Prix (USD)'} }}
                  deps={[a.dailyStats.length]}
                />
              </div>
            </div>

            {/* 4. Volatilité HL% — TOUS les jours */}
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
              <PlotDiv
                traces={[{
                  type:'bar',
                  x: a.dailyStats.map(d=>d.date),
                  y: a.dailyStats.map(d=>d.hlDeltaPct),
                  name:'Range %',
                  marker:{ color:'#d4af37' },
                  hovertemplate:'%{y:.1f}%<extra></extra>'
                }]}
                layout={{ title:'Volatilité Relative (HL_Delta%) — Tous les jours', height:240, xaxis:{title:'Date'}, yaxis:{title:'Pourcentage (%)'} }}
                deps={[a.dailyStats.length]}
              />
            </div>

            {/* 5. Dashboard Streaks 3x2 — TOUS les jours */}
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
              <PlotDiv
                traces={[
                  // Row 1: Puissance
                  { type:'bar', x:a.streakByDay.map(d=>d.date), y:a.streakByDay.map(d=>d.maxLongTicks),          name:'Long Max (ticks)',  marker:{color:'#26a69a'}, xaxis:'x',  yaxis:'y'  },
                  { type:'bar', x:a.streakByDay.map(d=>d.date), y:a.streakByDay.map(d=>d.maxShortTicks),         name:'Short Max (ticks)', marker:{color:'#ef5350'}, xaxis:'x',  yaxis:'y'  },
                  // Row 1 col 2: Endurance
                  { type:'bar', x:a.streakByDay.map(d=>d.date), y:a.streakByDay.map(d=>d.maxLongLen),            name:'Durée Long',        marker:{color:'#80cbc4'}, xaxis:'x2', yaxis:'y2' },
                  { type:'bar', x:a.streakByDay.map(d=>d.date), y:a.streakByDay.map(d=>-d.maxShortLen),          name:'Durée Short',       marker:{color:'#ffab91'}, xaxis:'x2', yaxis:'y2' },
                  // Row 2: Contrats
                  { type:'bar', x:a.streakByDay.map(d=>d.date), y:a.streakByDay.map(d=>d.longContracts),         name:'Ct Long',           marker:{color:'#b2dfdb'}, xaxis:'x3', yaxis:'y3' },
                  { type:'bar', x:a.streakByDay.map(d=>d.date), y:a.streakByDay.map(d=>-d.shortContracts),       name:'Ct Short',          marker:{color:'#ffccbc'}, xaxis:'x3', yaxis:'y3' },
                  // Row 2 col 2: Volume
                  { type:'bar', x:a.streakByDay.map(d=>d.date), y:a.streakByDay.map(d=>d.totalVolume),           name:'Volume',            marker:{color:'#9fa8da'}, xaxis:'x4', yaxis:'y4' },
                  // Row 3: Histogrammes horaires
                  { type:'histogram', x:a.longHours,  name:'H-Long',  marker:{color:'#26a69a'}, xaxis:'x5', yaxis:'y5', xbins:{start:0,end:24,size:1} },
                  { type:'histogram', x:a.shortHours, name:'H-Short', marker:{color:'#ef5350'}, xaxis:'x6', yaxis:'y6', xbins:{start:0,end:24,size:1} },
                ]}
                layout={{
                  title: `Dashboard Analytique Streaks — ${selectedTicker}`,
                  height: 1050,
                  grid: { rows:3, columns:2, pattern:'independent', roworder:'top to bottom' },
                  barmode: 'relative',
                  showlegend: false,
                  annotations: [
                    { text:'Puissance des Records (Ticks)',       xref:'paper', yref:'paper', x:0.22, y:1.01,  showarrow:false, font:{color:'#aaa',size:12} },
                    { text:'Endurance (Nb Bougies)',              xref:'paper', yref:'paper', x:0.78, y:1.01,  showarrow:false, font:{color:'#aaa',size:12} },
                    { text:'Potentiel en Contrats (Base 200t)',   xref:'paper', yref:'paper', x:0.22, y:0.655, showarrow:false, font:{color:'#aaa',size:12} },
                    { text:'Volume Total Session',                xref:'paper', yref:'paper', x:0.78, y:0.655, showarrow:false, font:{color:'#aaa',size:12} },
                    { text:'Fréquence vagues Long / Heure',       xref:'paper', yref:'paper', x:0.22, y:0.31,  showarrow:false, font:{color:'#aaa',size:12} },
                    { text:'Fréquence vagues Short Critique / Heure', xref:'paper', yref:'paper', x:0.78, y:0.31, showarrow:false, font:{color:'#aaa',size:12} },
                  ],
                  xaxis5: { title:'Heure' }, xaxis6: { title:'Heure' },
                }}
                deps={[a.streakByDay.length, a.longHours.length]}
              />
            </div>

            {/* 6. Distribution Short Streaks critiques */}
            {a.shortDist?.length > 0 && (
              <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
                <PlotDiv
                  traces={[{
                    type: 'histogram',
                    x: a.shortDist,
                    name: 'Short Streaks critiques',
                    marker: { color: '#ef5350' },
                    nbinsx: 20,
                  }]}
                  layout={{
                    title: `Distribution des Baisses Critiques (≥${params.slMax} ticks) — Heures de trading`,
                    height: 260,
                    xaxis: { title: 'Magnitude (ticks)' },
                    yaxis: { title: 'Fréquence' }
                  }}
                  deps={[a.shortDist.length]}
                />
              </div>
            )}

            {/* 7. Analyse Claude */}
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '0.5px solid #1e2130', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>✦</span>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>Analyse Claude — {info.name}</span>
                {!claudeAnalysis && !analyzing && (
                  <button onClick={runClaude} style={{ marginLeft: 'auto', padding: '6px 18px', borderRadius: 6, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
                    ✦ Lancer l'analyse Claude
                  </button>
                )}
                {analyzing && <span style={{ marginLeft: 'auto', fontSize: 12, color: '#444' }}>⏳ Claude analyse...</span>}
                {claudeAnalysis && (
                  <button onClick={runClaude} style={{ marginLeft: 'auto', padding: '4px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 12 }}>↺ Relancer</button>
                )}
              </div>
              {!claudeAnalysis && !analyzing && (
                <div style={{ padding: '32px 20px', textAlign: 'center', color: '#444', fontSize: 13 }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>✦</div>
                  Visualise les graphiques, puis lance l'analyse Claude quand tu es prêt
                </div>
              )}
              {analyzing && (
                <div style={{ padding: '32px 20px', textAlign: 'center', color: '#444', fontSize: 13 }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
                  Claude analyse les vagues critiques et les patterns...
                </div>
              )}
              {claudeAnalysis && (
                <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.8, color: '#ccc', whiteSpace: 'pre-wrap' }}>
                  {claudeAnalysis}
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    );
  }

  // ── VUE PRINCIPALE ─────────────────────────────────────────────────────────
  return (
    <div>
      {/* Paramètres DCA + Prompts */}
      <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '14px 20px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Paramètres de la méthode</div>
          <button onClick={() => setShowPrompts(!showPrompts)} style={{ marginLeft: 'auto', padding: '4px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 12 }}>
            {showPrompts ? '▲ Cacher prompts' : '▼ Modifier prompts Claude'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: showPrompts ? 16 : 0 }}>
          {[
            { label: 'RSI Window', key: 'rsiWindow', min: 5,  max: 21  },
            { label: 'SL Max (t)', key: 'slMax',     min: 100, max: 1000 },
            { label: 'DCA 1 (t)',  key: 'dca1',      min: 50,  max: 500  },
            { label: 'DCA 2 (t)',  key: 'dca2',      min: 100, max: 800  },
            { label: 'Streak Min', key: 'streakMin', min: 1,   max: 10   },
          ].map(p => (
            <div key={p.key}>
              <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>{p.label}</div>
              <input type="number" value={params[p.key]} min={p.min} max={p.max}
                onChange={e => setParams(prev => ({ ...prev, [p.key]: parseInt(e.target.value) }))}
                style={{ width: 70, padding: '5px 8px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 13, textAlign: 'center' }} />
            </div>
          ))}
          <div>
            <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Période</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {['5d','10d','30d'].map(p => (
                <button key={p} onClick={() => setPeriod(p)} style={{ padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12, border: '0.5px solid', borderColor: period===p?'#378ADD':'#1e2130', background: period===p?'#0d1f35':'transparent', color: period===p?'#378ADD':'#555' }}>{p}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Intervalle</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {['1m','5m','15m'].map(iv => (
                <button key={iv} onClick={() => setIval(iv)} style={{ padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12, border: '0.5px solid', borderColor: interval===iv?'#1D9E75':'#1e2130', background: interval===iv?'#0d2b1a':'transparent', color: interval===iv?'#1D9E75':'#555' }}>{iv}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Prompts configurables */}
        {showPrompts && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, paddingTop: 16, borderTop: '0.5px solid #1e2130' }}>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>✦ Prompt analyse détaillée (par instrument)</div>
              <textarea value={analyzePrompt} onChange={e => setAnalyzePrompt(e.target.value)} rows={10}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#0f1117', color: '#ccc', fontSize: 11, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace' }} />
              <button onClick={() => setAnalyzePrompt(DEFAULT_ANALYZE_PROMPT)} style={{ marginTop: 4, padding: '3px 10px', borderRadius: 5, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 11 }}>↺ Réinitialiser</button>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>✦ Prompt scanner (recommandation multi-instruments)</div>
              <textarea value={scanPrompt} onChange={e => setScanPrompt(e.target.value)} rows={10}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#0f1117', color: '#ccc', fontSize: 11, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace' }} />
              <button onClick={() => setScanPrompt(DEFAULT_SCAN_PROMPT)} style={{ marginTop: 4, padding: '3px 10px', borderRadius: 5, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 11 }}>↺ Réinitialiser</button>
            </div>
          </div>
        )}
      </div>
{/* Accès rapide */}
<div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '14px 20px', marginBottom: 16 }}>
  <div style={{ fontSize: 12, color: '#888', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Accès rapide — Analyse détaillée</div>
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    {Object.entries(ALL_INSTRUMENTS).filter(([,v]) => v.topstep).map(([ticker, info]) => (
      <button key={ticker} onClick={() => openDetail(ticker)} style={{
        padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '0.5px solid #1e2130', background: '#0f1117',
        color: '#ccc', display: 'flex', alignItems: 'center', gap: 6,
        transition: 'border-color 0.2s'
      }}
        onMouseEnter={e => e.currentTarget.style.borderColor = '#378ADD'}
        onMouseLeave={e => e.currentTarget.style.borderColor = '#1e2130'}
      >
        <span>{info.emoji}</span>
        <span style={{ fontWeight: 500 }}>{ticker.replace('=F','')}</span>
        <span style={{ fontSize: 11, color: '#555' }}>{info.name}</span>
      </button>
    ))}
  </div>
</div>
      {/* Sélecteur instruments */}
      <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '14px 20px', marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Instruments — {selectedTickers.length} sélectionnés <span style={{ color: '#333', fontSize: 11 }}>(★ = TopStep disponible)</span>
        </div>
        {categories.map(cat => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#444', marginBottom: 6 }}>{cat}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(ALL_INSTRUMENTS).filter(([,v]) => v.category === cat).map(([ticker, info]) => (
                <button key={ticker} onClick={() => toggleTicker(ticker)} style={{
                  padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                  border: '0.5px solid', borderColor: selectedTickers.includes(ticker) ? '#378ADD' : '#1e2130',
                  background: selectedTickers.includes(ticker) ? '#0d1f35' : 'transparent',
                  color: selectedTickers.includes(ticker) ? '#378ADD' : '#555',
                  display: 'flex', alignItems: 'center', gap: 6
                }}>
                  <span>{info.emoji}</span>
                  <span style={{ fontWeight: 500 }}>{ticker.replace('=F','')}</span>
                  <span style={{ fontSize: 11, color: selectedTickers.includes(ticker) ? '#5a9ad4' : '#333' }}>{info.name}</span>
                  {info.topstep && <span style={{ fontSize: 10, color: '#E8A838' }}>★</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button onClick={scan} disabled={scanning || !selectedTickers.length} style={{
          marginTop: 8, padding: '10px 24px', borderRadius: 8, border: 'none',
          background: scanning || !selectedTickers.length ? '#1e2130' : '#378ADD',
          color: scanning || !selectedTickers.length ? '#555' : '#fff',
          cursor: scanning || !selectedTickers.length ? 'not-allowed' : 'pointer',
          fontSize: 14, fontWeight: 500
        }}>
          {scanning ? '⏳ Analyse en cours...' : `↗ Analyser ${selectedTickers.length} instrument${selectedTickers.length > 1 ? 's' : ''}`}
        </button>
      </div>

      {/* Statut session */}
      {currentHour && (
        <div style={{ background: currentHour.isExcluded?'#2b0d0d':'#0d2b1a', borderRadius: 8, padding: '8px 16px', marginBottom: 16, fontSize: 12, color: currentHour.isExcluded?'#D85A30':'#1D9E75', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{currentHour.isExcluded ? '🔴' : '🟢'}</span>
          <span>{currentHour.h}h{String(currentHour.m).padStart(2,'0')} (America/Montreal) — {currentHour.isExcluded ? 'HORS HEURES DE TRADING' : 'SESSION ACTIVE'}</span>
        </div>
      )}

      {/* Cartes résultats */}
      {scanResults && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px,1fr))', gap: 12, marginBottom: 16 }}>
            {Object.entries(scanResults).map(([ticker, r]) => {
              const info = ALL_INSTRUMENTS[ticker];
              const hasErr = !!r.error;
              const rsi = r.currentRSI;
              const col = hasErr ? '#555' : rsi > 70 ? '#D85A30' : rsi < 30 ? '#378ADD' : '#1D9E75';
              return (
                <div key={ticker} style={{ background: '#13151f', borderRadius: 10, border: `0.5px solid ${col}44`, padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 22 }}>{info.emoji}</span>
                    <div>
                      <div style={{ fontWeight: 600, color: '#fff', fontSize: 14 }}>{ticker.replace('=F','')}</div>
                      <div style={{ fontSize: 11, color: '#444' }}>{info.name}</div>
                    </div>
                    <div style={{ marginLeft: 'auto', width: 10, height: 10, borderRadius: '50%', background: col }} />
                  </div>
                  {hasErr ? (
                    <div style={{ fontSize: 12, color: '#D85A30' }}>❌ Erreur données</div>
                  ) : (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                        <div><div style={{ fontSize: 10, color: '#444' }}>PRIX</div><div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>{r.currentPrice?.toFixed(2)}</div></div>
                        <div><div style={{ fontSize: 10, color: '#444' }}>RSI</div><div style={{ fontSize: 15, fontWeight: 600, color: RSI_COLOR(rsi) }}>{rsi}</div></div>
                        <div><div style={{ fontSize: 10, color: '#444' }}>HL%</div><div style={{ fontSize: 13, color: '#ccc' }}>{r.summary?.avgHLPct}%</div></div>
                        <div><div style={{ fontSize: 10, color: '#444' }}>DOMINANCE</div><div style={{ fontSize: 12, color: '#ccc' }}>{r.summary?.dominance}</div></div>
                      </div>
                      <div style={{ fontSize: 11, color: RSI_COLOR(rsi), marginBottom: 10 }}>{RSI_LABEL(rsi)}</div>
                      <button onClick={() => openDetail(ticker)} style={{ width: '100%', padding: '7px', borderRadius: 6, border: `0.5px solid ${col}`, background: 'transparent', color: col, cursor: 'pointer', fontSize: 12, fontWeight: 500 }}>
                        Voir l'analyse détaillée →
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Recommandation Claude */}
          {recommendation && (
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '0.5px solid #1e2130', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>✦</span>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>Recommandation Claude — Meilleur instrument du moment</span>
              </div>
              <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.8, color: '#ccc', whiteSpace: 'pre-wrap' }}>
                {recommendation}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
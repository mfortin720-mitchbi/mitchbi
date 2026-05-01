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

const RSI_COLOR = (rsi) => {
  if (!rsi) return '#555';
  if (rsi > 70) return '#D85A30';
  if (rsi < 30) return '#378ADD';
  return '#1D9E75';
};

const RSI_LABEL = (rsi) => {
  if (!rsi) return '—';
  if (rsi > 70) return '🔴 Suracheté';
  if (rsi < 30) return '🔵 Survendu';
  return '🟢 Neutre';
};

// Simple Plotly loader
const usePlotly = () => {
  const [loaded, setLoaded] = useState(!!window.Plotly);
  useEffect(() => {
    if (window.Plotly) { setLoaded(true); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.26.0/plotly.min.js';
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
  }, []);
  return loaded;
};

// Candlestick Chart
const CandleChart = ({ data, ticker }) => {
  const ref = useRef(null);
  const plotlyLoaded = usePlotly();

  useEffect(() => {
    if (!plotlyLoaded || !ref.current || !data?.length) return;
    const last100 = data  //.slice(-100);
    window.Plotly.newPlot(ref.current, [{
      type: 'candlestick',
      x: last100.map(d => new Date(d.timestamp)),
      open: last100.map(d => d.open),
      high: last100.map(d => d.high),
      low: last100.map(d => d.low),
      close: last100.map(d => d.close),
      increasing: { line: { color: '#26a69a' } },
      decreasing: { line: { color: '#ef5350' } },
    }], {
      title: `${ticker} — Chandelles (5min)`,
      template: 'plotly_dark',
      xaxis: { rangeslider: { visible: false } },
      height: 300,
      margin: { t: 40, l: 50, r: 20, b: 40 }
    }, { responsive: true, displayModeBar: false });
  }, [plotlyLoaded, data]);

  return <div ref={ref} style={{ width: '100%' }} />;
};

// Tick Pressure Chart
const TickPressureChart = ({ dailyStats }) => {
  const ref = useRef(null);
  const plotlyLoaded = usePlotly();

  useEffect(() => {
    if (!plotlyLoaded || !ref.current || !dailyStats?.length) return;
    window.Plotly.newPlot(ref.current, [
      { type: 'bar', x: dailyStats.map(d => d.date), y: dailyStats.map(d => d.totalLong), name: 'Long', marker: { color: '#26a69a' } },
      { type: 'bar', x: dailyStats.map(d => d.date), y: dailyStats.map(d => d.totalShort), name: 'Short', marker: { color: '#ef5350' } },
      { type: 'scatter', x: dailyStats.map(d => d.date), y: dailyStats.map(d => d.netDelta), name: 'Net Delta', line: { color: 'white', width: 2, dash: 'dot' } },
    ], {
      title: 'Pression Long vs Short (Ticks)',
      template: 'plotly_dark', barmode: 'relative', height: 280,
      margin: { t: 40, l: 50, r: 20, b: 40 }
    }, { responsive: true, displayModeBar: false });
  }, [plotlyLoaded, dailyStats]);

  return <div ref={ref} style={{ width: '100%' }} />;
};

// Structure + Volatility Chart
const StructureChart = ({ dailyStats }) => {
  const ref = useRef(null);
  const plotlyLoaded = usePlotly();

  useEffect(() => {
    if (!plotlyLoaded || !ref.current || !dailyStats?.length) return;
    window.Plotly.newPlot(ref.current, [
      { type: 'scatter', x: dailyStats.map(d => d.date), y: dailyStats.map(d => d.high), name: 'High', line: { color: '#26a69a', width: 2 }, mode: 'lines+markers' },
      { type: 'scatter', x: dailyStats.map(d => d.date), y: dailyStats.map(d => d.low), name: 'Low', line: { color: '#ef5350', width: 2 }, mode: 'lines+markers' },
      { type: 'scatter', x: dailyStats.map(d => d.date), y: dailyStats.map(d => d.close), name: 'Close', line: { color: 'white', width: 1, dash: 'dot' }, mode: 'lines' },
    ], {
      title: 'Structure de Prix (H/L/Close)',
      template: 'plotly_dark', height: 280,
      margin: { t: 40, l: 50, r: 20, b: 40 }
    }, { responsive: true, displayModeBar: false });
  }, [plotlyLoaded, dailyStats]);

  return <div ref={ref} style={{ width: '100%' }} />;
};

// RSI Chart
const RSIChart = ({ data }) => {
  const ref = useRef(null);
  const plotlyLoaded = usePlotly();

  useEffect(() => {
    if (!plotlyLoaded || !ref.current || !data?.length) return;
    const last100 = data.slice(-100).filter(d => d.rsi !== null);
    window.Plotly.newPlot(ref.current, [
      {
        type: 'scatter', x: last100.map(d => new Date(d.timestamp)), y: last100.map(d => d.rsi),
        name: 'RSI', line: { color: '#9B59B6', width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(155,89,182,0.1)'
      },
    ], {
      title: 'RSI (9 périodes)',
      template: 'plotly_dark', height: 200,
      shapes: [
        { type: 'line', y0: 70, y1: 70, x0: 0, x1: 1, xref: 'paper', line: { color: '#ef5350', dash: 'dash', width: 1 } },
        { type: 'line', y0: 30, y1: 30, x0: 0, x1: 1, xref: 'paper', line: { color: '#26a69a', dash: 'dash', width: 1 } },
      ],
      yaxis: { range: [0, 100] },
      margin: { t: 40, l: 50, r: 20, b: 40 }
    }, { responsive: true, displayModeBar: false });
  }, [plotlyLoaded, data]);

  return <div ref={ref} style={{ width: '100%' }} />;
};

// Streak Dashboard Chart
const StreakChart = ({ streaks, criticalShorts }) => {
  const ref = useRef(null);
  const plotlyLoaded = usePlotly();

  useEffect(() => {
    if (!plotlyLoaded || !ref.current || !streaks?.length) return;

    const { makeSubplots } = window.Plotly;

    // Group by date
    const dates = [...new Set(streaks.map(s => s.date))];
    const longByDate = dates.map(d => Math.max(...streaks.filter(s => s.date === d && s.dir === 1).map(s => s.ticks), 0));
    const shortByDate = dates.map(d => Math.min(...streaks.filter(s => s.date === d && s.dir === -1).map(s => s.ticks), 0));
    const longLen = dates.map(d => Math.max(...streaks.filter(s => s.date === d && s.dir === 1).map(s => s.count), 0));
    const shortLen = dates.map(d => Math.max(...streaks.filter(s => s.date === d && s.dir === -1).map(s => s.count), 0));

    const longHours = streaks.filter(s => s.dir === 1 && s.count >= 3).map(s => s.hour);
    const shortHours = criticalShorts.map(s => parseInt(s.startTime.split(':')[0]));

    window.Plotly.newPlot(ref.current, [
      { type: 'bar', x: dates, y: longByDate, name: 'Long Max (ticks)', marker: { color: '#26a69a' }, xaxis: 'x', yaxis: 'y' },
      { type: 'bar', x: dates, y: shortByDate, name: 'Short Max (ticks)', marker: { color: '#ef5350' }, xaxis: 'x', yaxis: 'y' },
      { type: 'bar', x: dates, y: longLen, name: 'Durée Long', marker: { color: '#80cbc4' }, xaxis: 'x2', yaxis: 'y2' },
      { type: 'bar', x: dates, y: shortLen.map(v => -v), name: 'Durée Short', marker: { color: '#ffab91' }, xaxis: 'x2', yaxis: 'y2' },
      { type: 'histogram', x: longHours, name: 'Heures Long', marker: { color: '#26a69a' }, xaxis: 'x3', yaxis: 'y3', xbins: { start: 0, end: 24, size: 1 } },
      { type: 'histogram', x: shortHours, name: 'Heures Short Critiques', marker: { color: '#ef5350' }, xaxis: 'x4', yaxis: 'y4', xbins: { start: 0, end: 24, size: 1 } },
    ], {
      title: 'Dashboard Analytique Streaks',
      template: 'plotly_dark',
      height: 600,
      grid: { rows: 3, columns: 2, pattern: 'independent' },
      annotations: [
        { text: 'Puissance (ticks)', xref: 'paper', yref: 'paper', x: 0.2, y: 1.02, showarrow: false, font: { color: '#888', size: 11 } },
        { text: 'Endurance (bougies)', xref: 'paper', yref: 'paper', x: 0.8, y: 1.02, showarrow: false, font: { color: '#888', size: 11 } },
        { text: 'Fréquence Long/heure', xref: 'paper', yref: 'paper', x: 0.2, y: 0.62, showarrow: false, font: { color: '#888', size: 11 } },
        { text: 'Fréquence Short Critique/heure', xref: 'paper', yref: 'paper', x: 0.8, y: 0.62, showarrow: false, font: { color: '#888', size: 11 } },
      ],
      margin: { t: 60, l: 50, r: 20, b: 40 },
      barmode: 'relative',
      showlegend: false,
    }, { responsive: true, displayModeBar: false });
  }, [plotlyLoaded, streaks, criticalShorts]);

  return <div ref={ref} style={{ width: '100%' }} />;
};

// ─── COMPOSANT PRINCIPAL ─────────────────────────────────────────────────────
export default function Trader() {
  const [selectedTickers, setSelectedTickers] = useState(['MGC=F', 'MES=F', 'MNQ=F']);
  const [params, setParams] = useState({ rsiWindow: 9, slMax: 600, dca1: 200, dca2: 400, streakMin: 3 });
  const [period, setPeriod] = useState('10d');
  const [interval, setInterval] = useState('5m');
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState(null);
  const [recommendation, setRecommendation] = useState('');
  const [currentHour, setCurrentHour] = useState(null);
  const [selectedTicker, setSelectedTicker] = useState(null); // Vue détaillée
  const [loadingData, setLoadingData] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [detailData, setDetailData] = useState(null);
  const [claudeAnalysis, setClaudeAnalysis] = useState(null);

  const toggleTicker = (ticker) => {
    setSelectedTickers(prev =>
      prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker]
    );
  };

  const scan = async () => {
    if (selectedTickers.length === 0) return;
    setScanning(true); setScanResults(null); setRecommendation('');
    try {
      const res = await fetch(`${API}/api/trader/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: selectedTickers, period, interval, params })
      });
      const data = await res.json();
      if (data.success) {
        setScanResults(data.results);
        setRecommendation(data.recommendation);
        setCurrentHour(data.currentHour);
      }
    } catch (err) { console.error(err); }
    finally { setScanning(false); }
  };

  const openDetail = async (ticker) => {
    setSelectedTicker(ticker);
    setDetailData(null);
    setClaudeAnalysis(null);
    setLoadingData(true);
    try {
      const res = await fetch(`${API}/api/trader/data`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, period, interval, params })
      });
      const data = await res.json();
      if (data.success) setDetailData(data);
    } catch (err) { console.error(err); }
    finally { setLoadingData(false); }
  };

  const runClaudeAnalysis = async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`${API}/api/trader/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: selectedTicker, period, interval, params })
      });
      const data = await res.json();
      if (data.success) setClaudeAnalysis(data.claudeAnalysis);
    } catch (err) { console.error(err); }
    finally { setAnalyzing(false); }
  };

  const categories = [...new Set(Object.values(ALL_INSTRUMENTS).map(i => i.category))];

  // ── VUE DÉTAILLÉE ──────────────────────────────────────────────────────────
  if (selectedTicker) {
    const info = ALL_INSTRUMENTS[selectedTicker];
    return (
      <div>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <button onClick={() => setSelectedTicker(null)} style={{ padding: '6px 14px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 13 }}>
            ← Retour
          </button>
          <div style={{ fontSize: 20 }}>{info.emoji}</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>{info.name} ({selectedTicker})</div>
            <div style={{ fontSize: 12, color: '#444' }}>{info.category} · TopStep {info.topstep ? '✅' : '❌'}</div>
          </div>

          {/* Période / Interval */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {['5d', '10d', '30d'].map(p => (
              <button key={p} onClick={() => { setPeriod(p); }} style={{
                padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                border: '0.5px solid', borderColor: period === p ? '#378ADD' : '#1e2130',
                background: period === p ? '#0d1f35' : 'transparent',
                color: period === p ? '#378ADD' : '#555'
              }}>{p}</button>
            ))}
            {['1m', '5m', '15m'].map(iv => (
              <button key={iv} onClick={() => setInterval(iv)} style={{
                padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                border: '0.5px solid', borderColor: interval === iv ? '#1D9E75' : '#1e2130',
                background: interval === iv ? '#0d2b1a' : 'transparent',
                color: interval === iv ? '#1D9E75' : '#555'
              }}>{iv}</button>
            ))}
            <button onClick={() => openDetail(selectedTicker)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 12 }}>
              ↺ Actualiser
            </button>
          </div>
        </div>

        {loadingData ? (
          <div style={{ color: '#444', fontSize: 13, padding: 40, textAlign: 'center' }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>⏳</div>
            Téléchargement des données Yahoo Finance...
          </div>
        ) : detailData ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* KPIs */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
              {[
                { label: 'Prix actuel', value: detailData.analysis.currentPrice?.toFixed(2) },
                { label: 'RSI actuel', value: detailData.analysis.currentRSI, color: RSI_COLOR(detailData.analysis.currentRSI), sub: RSI_LABEL(detailData.analysis.currentRSI) },
                { label: 'HL% moyen', value: `${detailData.analysis.summary.avgHLPct}%` },
                { label: 'Max Short Streak', value: `${detailData.analysis.summary.maxShortStreak}t`, color: detailData.analysis.summary.maxShortStreak > 600 ? '#D85A30' : '#1D9E75' },
                { label: '% SL dépassés', value: `${detailData.analysis.slBreachPct}%`, color: parseFloat(detailData.analysis.slBreachPct) > 30 ? '#D85A30' : '#1D9E75' },
                { label: 'Dominance', value: detailData.analysis.summary.dominance },
              ].map(kpi => (
                <div key={kpi.label} style={{ background: '#13151f', borderRadius: 8, border: '0.5px solid #1e2130', padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, color: '#444', marginBottom: 4, textTransform: 'uppercase' }}>{kpi.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: kpi.color || '#fff' }}>{kpi.value}</div>
                  {kpi.sub && <div style={{ fontSize: 11, color: kpi.color || '#555', marginTop: 2 }}>{kpi.sub}</div>}
                </div>
              ))}
            </div>

            {/* Charts */}
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
              <CandleChart data={detailData.analysis.candleData} ticker={selectedTicker} />
            </div>
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
              <RSIChart data={detailData.analysis.candleData} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
                <TickPressureChart dailyStats={detailData.analysis.dailyStats} />
              </div>
              <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
                <StructureChart dailyStats={detailData.analysis.dailyStats} />
              </div>
            </div>
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16 }}>
              <StreakChart streaks={detailData.analysis.streaks} criticalShorts={detailData.analysis.criticalShorts} />
            </div>

            {/* Analyse Claude */}
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '0.5px solid #1e2130', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>✦</span>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>Analyse Claude — {info.name}</span>
                {!claudeAnalysis && !analyzing && (
                  <button onClick={runClaudeAnalysis} style={{
                    marginLeft: 'auto', padding: '6px 16px', borderRadius: 6, border: 'none',
                    background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500
                  }}>
                    ✦ Lancer l'analyse Claude
                  </button>
                )}
                {analyzing && (
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: '#444' }}>⏳ Analyse en cours...</span>
                )}
              </div>
              {!claudeAnalysis && !analyzing && (
                <div style={{ padding: '32px 20px', textAlign: 'center', color: '#444', fontSize: 13 }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>✦</div>
                  Clique sur "Lancer l'analyse Claude" pour obtenir les recommandations basées sur ta méthode DCA
                </div>
              )}
              {analyzing && (
                <div style={{ padding: '32px 20px', textAlign: 'center', color: '#444', fontSize: 13 }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
                  Claude analyse les vagues critiques et les patterns...
                </div>
              )}
              {claudeAnalysis && (
                <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.8, color: '#ccc', whiteSpace: 'pre-wrap' }}>
                  {claudeAnalysis}
                </div>
              )}
            </div>

            {/* Statut session */}
            <div style={{
              background: detailData.analysis.isCurrentlyExcluded ? '#2b0d0d' : '#0d2b1a',
              borderRadius: 8, border: '0.5px solid #1e2130', padding: '12px 16px',
              fontSize: 13, color: detailData.analysis.isCurrentlyExcluded ? '#D85A30' : '#1D9E75',
              display: 'flex', alignItems: 'center', gap: 8
            }}>
              <span style={{ fontSize: 20 }}>{detailData.analysis.isCurrentlyExcluded ? '🔴' : '🟢'}</span>
              <span style={{ fontWeight: 500 }}>
                {detailData.analysis.isCurrentlyExcluded ? 'HORS HEURES DE TRADING — Ne pas trader' : 'SESSION ACTIVE — Conditions vérifiées'}
              </span>
            </div>

          </div>
        ) : null}
      </div>
    );
  }

  // ── VUE PRINCIPALE (Market Scanner) ────────────────────────────────────────
  return (
    <div>
      {/* Paramètres DCA */}
      <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '14px 20px', marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Paramètres de la méthode</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { label: 'RSI Window', key: 'rsiWindow', min: 5, max: 21 },
            { label: 'SL Max (ticks)', key: 'slMax', min: 100, max: 1000 },
            { label: 'DCA 1 (ticks)', key: 'dca1', min: 50, max: 500 },
            { label: 'DCA 2 (ticks)', key: 'dca2', min: 100, max: 800 },
            { label: 'Streak Min', key: 'streakMin', min: 1, max: 10 },
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
              {['5d', '10d', '30d'].map(p => (
                <button key={p} onClick={() => setPeriod(p)} style={{
                  padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                  border: '0.5px solid', borderColor: period === p ? '#378ADD' : '#1e2130',
                  background: period === p ? '#0d1f35' : 'transparent',
                  color: period === p ? '#378ADD' : '#555'
                }}>{p}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Intervalle</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {['1m', '5m', '15m'].map(iv => (
                <button key={iv} onClick={() => setInterval(iv)} style={{
                  padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                  border: '0.5px solid', borderColor: interval === iv ? '#1D9E75' : '#1e2130',
                  background: interval === iv ? '#0d2b1a' : 'transparent',
                  color: interval === iv ? '#1D9E75' : '#555'
                }}>{iv}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Sélecteur d'instruments */}
      <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '14px 20px', marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Instruments — {selectedTickers.length} sélectionnés
          <span style={{ marginLeft: 8, fontSize: 11, color: '#333' }}>(TopStep uniquement ★)</span>
        </div>
        {categories.map(cat => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#444', marginBottom: 6 }}>{cat}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(ALL_INSTRUMENTS)
                .filter(([, v]) => v.category === cat)
                .map(([ticker, info]) => (
                  <button key={ticker} onClick={() => toggleTicker(ticker)} style={{
                    padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                    border: '0.5px solid',
                    borderColor: selectedTickers.includes(ticker) ? '#378ADD' : '#1e2130',
                    background: selectedTickers.includes(ticker) ? '#0d1f35' : 'transparent',
                    color: selectedTickers.includes(ticker) ? '#378ADD' : '#555',
                    display: 'flex', alignItems: 'center', gap: 6
                  }}>
                    <span>{info.emoji}</span>
                    <span>{ticker.replace('=F', '')}</span>
                    <span style={{ fontSize: 11, color: selectedTickers.includes(ticker) ? '#378ADD' : '#333' }}>{info.name}</span>
                    {info.topstep && <span style={{ fontSize: 10, color: '#E8A838' }}>★</span>}
                  </button>
                ))}
            </div>
          </div>
        ))}

        <button onClick={scan} disabled={scanning || selectedTickers.length === 0} style={{
          marginTop: 8, padding: '10px 24px', borderRadius: 8, border: 'none',
          background: scanning || selectedTickers.length === 0 ? '#1e2130' : '#378ADD',
          color: scanning || selectedTickers.length === 0 ? '#555' : '#fff',
          cursor: scanning || selectedTickers.length === 0 ? 'not-allowed' : 'pointer',
          fontSize: 14, fontWeight: 500
        }}>
          {scanning ? '⏳ Analyse en cours...' : `↗ Analyser ${selectedTickers.length} instrument${selectedTickers.length > 1 ? 's' : ''}`}
        </button>
      </div>

      {/* Statut session */}
      {currentHour && (
        <div style={{
          background: currentHour.isExcluded ? '#2b0d0d' : '#0d2b1a',
          borderRadius: 8, padding: '8px 16px', marginBottom: 16,
          fontSize: 12, color: currentHour.isExcluded ? '#D85A30' : '#1D9E75',
          display: 'flex', alignItems: 'center', gap: 8
        }}>
          <span>{currentHour.isExcluded ? '🔴' : '🟢'}</span>
          <span>
            {currentHour.hour}h{String(currentHour.minute).padStart(2,'0')} (America/Montreal) —
            {currentHour.isExcluded ? ' HORS HEURES DE TRADING' : ' SESSION ACTIVE'}
          </span>
        </div>
      )}

      {/* Cartes des résultats */}
      {scanResults && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
            {Object.entries(scanResults).map(([ticker, result]) => {
              const info = ALL_INSTRUMENTS[ticker];
              const hasError = !!result.error;
              const rsi = result.currentRSI;
              const status = hasError ? 'error' : rsi > 70 ? 'danger' : rsi < 30 ? 'neutral' : 'good';
              const statusColors = { good: '#1D9E75', neutral: '#378ADD', danger: '#D85A30', error: '#555' };

              return (
                <div key={ticker} style={{
                  background: '#13151f', borderRadius: 10,
                  border: `0.5px solid ${statusColors[status]}44`,
                  padding: 16, cursor: hasError ? 'default' : 'pointer',
                  transition: 'border-color 0.2s'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 22 }}>{info.emoji}</span>
                    <div>
                      <div style={{ fontWeight: 600, color: '#fff', fontSize: 14 }}>{ticker.replace('=F', '')}</div>
                      <div style={{ fontSize: 11, color: '#444' }}>{info.name}</div>
                    </div>
                    <div style={{ marginLeft: 'auto', width: 10, height: 10, borderRadius: '50%', background: statusColors[status] }} />
                  </div>

                  {hasError ? (
                    <div style={{ fontSize: 12, color: '#D85A30' }}>❌ Erreur données</div>
                  ) : (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                        <div>
                          <div style={{ fontSize: 10, color: '#444' }}>PRIX</div>
                          <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>{result.currentPrice?.toFixed(2)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: '#444' }}>RSI</div>
                          <div style={{ fontSize: 15, fontWeight: 600, color: RSI_COLOR(rsi) }}>{rsi}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: '#444' }}>HL%</div>
                          <div style={{ fontSize: 13, color: '#ccc' }}>{result.summary?.avgHLPct}%</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, color: '#444' }}>DOMINANCE</div>
                          <div style={{ fontSize: 12, color: '#ccc' }}>{result.summary?.dominance}</div>
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: RSI_COLOR(rsi), marginBottom: 10 }}>{RSI_LABEL(rsi)}</div>
                      <button onClick={() => openDetail(ticker)} style={{
                        width: '100%', padding: '7px', borderRadius: 6, border: `0.5px solid ${statusColors[status]}`,
                        background: 'transparent', color: statusColors[status], cursor: 'pointer', fontSize: 12, fontWeight: 500
                      }}>
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
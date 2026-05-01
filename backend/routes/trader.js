const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

const getAnthropic = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INSTRUMENTS = {
  'MGC=F':  { name: 'Micro Gold',       emoji: '🥇', tickSize: 0.10, category: 'Metals',  topstep: true },
  'GC=F':   { name: 'Gold',             emoji: '🏅', tickSize: 0.10, category: 'Metals',  topstep: true },
  'MES=F':  { name: 'Micro E-mini S&P', emoji: '📈', tickSize: 0.25, category: 'Equity',  topstep: true },
  'ES=F':   { name: 'E-mini S&P 500',   emoji: '📊', tickSize: 0.25, category: 'Equity',  topstep: true },
  'MNQ=F':  { name: 'Micro Nasdaq',     emoji: '💻', tickSize: 0.25, category: 'Equity',  topstep: true },
  'NQ=F':   { name: 'E-mini Nasdaq',    emoji: '🖥',  tickSize: 0.25, category: 'Equity',  topstep: true },
  'M2K=F':  { name: 'Micro Russell',    emoji: '📉', tickSize: 0.10, category: 'Equity',  topstep: true },
  'RTY=F':  { name: 'Russell 2000',     emoji: '🏦', tickSize: 0.10, category: 'Equity',  topstep: true },
  'MCL=F':  { name: 'Micro Crude Oil',  emoji: '🛢',  tickSize: 0.01, category: 'Energy',  topstep: true },
  'CL=F':   { name: 'Crude Oil',        emoji: '⛽', tickSize: 0.01, category: 'Energy',  topstep: true },
  '6E=F':   { name: 'Euro FX',          emoji: '💶', tickSize: 0.00005, category: 'FX',   topstep: false },
  'ZB=F':   { name: '30Y T-Bond',       emoji: '🏛',  tickSize: 0.03125, category: 'Rates', topstep: false },
};

// Heures exclues en minutes depuis minuit (America/Montreal)
const EXCLUDED_RANGES = [
  { start: 9*60+15,  end: 10*60+15 },
  { start: 18*60,    end: 18*60+30 },
  { start: 22*60,    end: 24*60    },
  { start: 0,        end: 5*60+45  },
];

const isExcluded = (h, m) => {
  const t = h * 60 + m;
  return EXCLUDED_RANGES.some(r => t >= r.start && t <= r.end);
};

// Fetch Yahoo Finance
const fetchYahoo = async (ticker, period, interval) => {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${period}&interval=${interval}&includePrePost=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error('No data');
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  return ts.map((t, i) => ({
    ts: t * 1000,
    open: q.open[i], high: q.high[i], low: q.low[i],
    close: q.close[i], volume: q.volume[i] || 0
  })).filter(d => d.close != null);
};

// RSI — calcul sur TOUTES les données, retourne valeur par index
const calcRSI = (closes, win = 9) => {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= win) return rsi;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= win; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) avgG += d; else avgL += Math.abs(d);
  }
  avgG /= win; avgL /= win;
  rsi[win] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = win+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgG = (avgG * (win-1) + Math.max(d,0)) / win;
    avgL = (avgL * (win-1) + Math.max(-d,0)) / win;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
};

// Convertir timestamp UTC → heure Montreal (UTC-4 EDT)
const toMontreal = (tsMs) => {
  const d = new Date(tsMs - 4 * 3600000); // UTC-4
  return {
    dateStr: d.toISOString().slice(0,10),
    h: d.getUTCHours(),
    m: d.getUTCMinutes(),
    localMs: tsMs - 4*3600000
  };
};

// Analyse complète d'un instrument
const analyze = (raw, ticker, params) => {
  const { rsiWindow=9, slMax=600, dca1=200, dca2=400, streakMin=3 } = params;
  const tick = INSTRUMENTS[ticker]?.tickSize || 0.10;

  // RSI sur TOUTES les closes (pas de slice)
  const closes = raw.map(d => d.close);
  const rsiArr = calcRSI(closes, rsiWindow);

  // Enrichir avec date/heure Montreal + RSI
  const data = raw.map((d, i) => {
    const { dateStr, h, m, localMs } = toMontreal(d.ts);
    return { ...d, localMs, dateStr, h, m, rsi: rsiArr[i] };
  });

  // Stats journalières — TOUS les jours, heures filtrées pour ticks
  const dayMap = {};
  data.forEach(d => {
    if (!dayMap[d.dateStr]) dayMap[d.dateStr] = {
      long: 0, short: 0, highs: [], lows: [], closes: [], rsis: [], vols: [], date: d.dateStr
    };
    const day = dayMap[d.dateStr];
    day.highs.push(d.high); day.lows.push(d.low);
    day.closes.push(d.close); day.vols.push(d.volume);
    if (d.rsi !== null) day.rsis.push(d.rsi);

    // Ticks seulement pendant heures de trading
    if (!isExcluded(d.h, d.m)) {
      const varTick = Math.round((d.close - (d.open || d.close)) / tick);
      if (varTick > 0) day.long += varTick;
      else day.short += Math.abs(varTick);
    }
  });

  const dailyStats = Object.values(dayMap).sort((a,b) => a.date.localeCompare(b.date)).map(day => {
    const high = Math.max(...day.highs);
    const low  = Math.min(...day.lows);
    const close = day.closes[day.closes.length-1];
    const netDelta = day.long - day.short;
    const hlDelta  = parseFloat((high - low).toFixed(2));
    const hlDeltaPct = parseFloat(((hlDelta / ((high+low)/2)) * 100).toFixed(2));
    const rsiVals = day.rsis.filter(r => r !== null);
    const rsiAvg = rsiVals.length ? parseFloat((rsiVals.reduce((a,b)=>a+b,0)/rsiVals.length).toFixed(1)) : null;
    const vol = day.vols.reduce((a,b)=>a+b,0);
    return {
      date: day.date, totalLong: day.long, totalShort: -day.short,
      netDelta, high, low, close, hlDelta, hlDeltaPct, rsiAvg, volume: vol,
      dominance: netDelta >= 0 ? 'Bull 🐂' : 'Bear 🐻'
    };
  });

  // Streak analysis — données filtrées trading uniquement
  const tradingData = data.filter(d => !isExcluded(d.h, d.m));
  // Variation tick par tick
  tradingData.forEach((d, i) => {
    if (i === 0) { d.varTick = 0; return; }
    d.varTick = Math.round((d.close - tradingData[i-1].close) / tick);
  });

  const streaks = [];
  let cur = null, prevDir = 0;
  tradingData.forEach(d => {
    const dir = d.varTick > 0 ? 1 : d.varTick < 0 ? -1 : 0;
    if (dir === 0) return;
    if (dir !== prevDir) {
      if (cur) streaks.push(cur);
      cur = { dir, date: d.dateStr, startTime: `${d.h}:${String(d.m).padStart(2,'0')}`, h: d.h, ticks: 0, count: 0, rsiStart: d.rsi, rsiEnd: d.rsi };
      prevDir = dir;
    }
    if (cur) { cur.ticks += d.varTick; cur.count++; cur.rsiEnd = d.rsi; }
  });
  if (cur) streaks.push(cur);

  // Stats par jour pour le dashboard streak 3x2
  const dates = [...new Set(streaks.map(s => s.date))].sort();
  const streakByDay = dates.map(date => {
    const ds = streaks.filter(s => s.date === date);
    const longS = ds.filter(s => s.dir === 1);
    const shortS = ds.filter(s => s.dir === -1);
    const maxLongTicks = longS.length ? Math.max(...longS.map(s => s.ticks)) : 0;
    const maxShortTicks = shortS.length ? Math.min(...shortS.map(s => s.ticks)) : 0;
    const maxLongLen = longS.length ? Math.max(...longS.map(s => s.count)) : 0;
    const maxShortLen = shortS.length ? Math.max(...shortS.map(s => s.count)) : 0;
    const totalVol = dailyStats.find(d => d.date === date)?.volume || 0;
    return {
      date,
      maxLongTicks, maxShortTicks,
      maxLongLen, maxShortLen,
      longContracts: parseFloat((maxLongTicks / 200).toFixed(2)),
      shortContracts: parseFloat((Math.abs(maxShortTicks) / 200).toFixed(2)),
      totalVolume: totalVol
    };
  });

  // Heures des vagues Long >= streakMin bougies
  const longHours = streaks.filter(s => s.dir === 1 && s.count >= streakMin).map(s => s.h);

  // Vagues Short critiques (>= slMax)
  const criticalShorts = streaks.filter(s => s.dir === -1 && Math.abs(s.ticks) >= slMax && !isExcluded(s.h, 0));
  const shortHours = criticalShorts.map(s => s.h);

  // Distribution des ticks critiques
  const shortDist = criticalShorts.map(s => Math.abs(s.ticks));

  // % SL breach
  const slBreach = criticalShorts.length > 0
    ? parseFloat(((criticalShorts.filter(s => Math.abs(s.ticks) > slMax).length / criticalShorts.length)*100).toFixed(1))
    : 0;

  const last = data[data.length-1];
  const lastDay = dailyStats[dailyStats.length-1];

  return {
    ticker, info: INSTRUMENTS[ticker],
    currentPrice: last?.close,
    currentRSI: last?.rsi !== null ? parseFloat((last.rsi||0).toFixed(1)) : null,
    isExcluded: isExcluded(new Date().getUTCHours() - 4 < 0 ? new Date().getUTCHours() + 20 : new Date().getUTCHours() - 4, new Date().getUTCMinutes()),
    candleData: data,          // TOUTES les données
    dailyStats,                // TOUS les jours
    streaks,
    streakByDay,               // Pour graphique 3x2
    criticalShorts,
    longHours,
    shortHours,
    shortDist,
    slBreach,
    lastDay,
    summary: {
      avgHLPct: dailyStats.length ? parseFloat((dailyStats.reduce((a,b)=>a+b.hlDeltaPct,0)/dailyStats.length).toFixed(2)) : 0,
      avgRSI: lastDay?.rsiAvg,
      dominance: lastDay?.dominance,
      netDelta: lastDay?.netDelta,
      maxShortStreak: criticalShorts.length ? Math.max(...criticalShorts.map(s=>Math.abs(s.ticks))) : 0
    }
  };
};

// GET /api/trader/instruments
router.get('/instruments', (req, res) => {
  res.json({ success: true, instruments: INSTRUMENTS });
});

// POST /api/trader/data — Données seulement (rapide)
router.post('/data', async (req, res) => {
  try {
    const { ticker, period='10d', interval='5m', params={} } = req.body;
    const raw = await fetchYahoo(ticker, period, interval);
    const analysis = analyze(raw, ticker, params);
    res.json({ success: true, analysis });
  } catch (err) {
    console.error('Data error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/trader/scan — Multi-instruments
router.post('/scan', async (req, res) => {
  try {
    const { tickers=['MGC=F','MES=F','MNQ=F'], period='10d', interval='5m', params={}, scanPrompt } = req.body;
    const results = {};
    for (const ticker of tickers) {
      try {
        const raw = await fetchYahoo(ticker, period, interval);
        results[ticker] = analyze(raw, ticker, params);
      } catch (err) {
        results[ticker] = { ticker, error: err.message, info: INSTRUMENTS[ticker] };
      }
    }

    const summaries = Object.entries(results)
      .filter(([,v]) => !v.error)
      .map(([ticker,v]) => `${INSTRUMENTS[ticker]?.name} (${ticker}): RSI=${v.currentRSI}, HL%=${v.summary.avgHLPct}%, Dominance=${v.summary.dominance}, Max Short=${v.summary.maxShortStreak}t, SL Breach=${v.slBreach}%`)
      .join('\n');

    const nowUTC = new Date();
    const estH = ((nowUTC.getUTCHours() - 4) + 24) % 24;
    const estM = nowUTC.getUTCMinutes();
    const nowExcluded = isExcluded(estH, estM);

    const defaultPrompt = `Tu es un expert en trading de futures. Voici les données de marché en temps réel.

Heure actuelle (America/Montreal): ${estH}h${String(estM).padStart(2,'0')}
Session active: ${nowExcluded ? '🔴 HORS TRADING' : '🟢 SESSION ACTIVE'}
Heures exclues: 9h15-10h15, 18h-18h30, 22h-5h45

Méthode DCA: 3 contrats, entrée à -${params.dca1||200}t et -${params.dca2||400}t, SL max ${params.slMax||600}t (TopStep 50K, perte max $2000)

Données:
${summaries}

1. 🏆 Meilleur instrument du moment pour ma méthode DCA et pourquoi
2. 🚦 Statut de chaque instrument (Favorable/Neutre/Dangereux)
3. ⚠️ Alertes importantes
4. 💡 Conseil pour la session actuelle

Sois direct, en français, max 300 mots.`;

    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-5', max_tokens: 800,
      messages: [{ role: 'user', content: scanPrompt ? `${scanPrompt}\n\nDonnées:\n${summaries}\n\nHeure: ${estH}h${String(estM).padStart(2,'0')} (${nowExcluded ? 'HORS TRADING' : 'SESSION ACTIVE'})` : defaultPrompt }]
    });

    res.json({ success: true, results, recommendation: msg.content[0].text, currentHour: { h: estH, m: estM, isExcluded: nowExcluded } });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/trader/analyze — Analyse Claude détaillée
router.post('/analyze', async (req, res) => {
  try {
    const { ticker, period='10d', interval='5m', params={}, analyzePrompt } = req.body;
    const raw = await fetchYahoo(ticker, period, interval);
    const analysis = analyze(raw, ticker, params);
    const { slMax=600, dca1=200, dca2=400 } = params;

    const critData = analysis.criticalShorts.slice(-40)
      .map(s => `Date:${s.date} Heure:${s.startTime} Ticks:${Math.abs(s.ticks)} RSI_debut:${s.rsiStart?.toFixed(1)} RSI_fin:${s.rsiEnd?.toFixed(1)}`)
      .join('\n');

    const defaultPrompt = `Rôle: Expert en probabilités ${INSTRUMENTS[ticker]?.name} (${ticker}). 1 tick = 1$
Méthode: Grille DCA 3 contrats (-${dca1}t, -${dca2}t). Danger = Short Streak > ${slMax}t.
License TopStep 50K Combine, perte maximale $2000.
Heures EXCLUES (America/Montreal): 9h15-10h15, 18h-18h30, 22h-5h45

Vagues de baisse critiques (>=${slMax} ticks) pendant heures de trading:
${critData || 'Aucune vague critique détectée'}

Stats actuelles:
- Prix: ${analysis.currentPrice}
- RSI actuel: ${analysis.currentRSI}
- HL% moyen: ${analysis.summary.avgHLPct}%
- Dominance: ${analysis.summary.dominance}
- Max Short Streak: ${analysis.summary.maxShortStreak} ticks
- % SL dépassés: ${analysis.slBreach}%

1. 📊 Analyse Horaire: À quelles heures les vagues > ${dca2}-${slMax} ticks se produisent-elles?
2. ⚠️ Risque SL: % qui dépasse ${slMax}t et état du RSI à ce moment
3. 🔍 Patterns: Y a-t-il un pattern dans les déclenchements?
4. 🎯 Verdict: Ma grille est-elle adaptée à cet instrument maintenant?
5. 📐 RSI optimal: Quel RSI de départ est sécuritaire pour mon DCA?
6. ❓ Questions de session: 3 questions clés avant de trader

En français, précis et actionnable.`;

    const finalPrompt = analyzePrompt
      ? `${analyzePrompt}\n\nDonnées instrument ${ticker}:\n- Prix: ${analysis.currentPrice}\n- RSI: ${analysis.currentRSI}\n- HL%: ${analysis.summary.avgHLPct}%\n- Max Short: ${analysis.summary.maxShortStreak}t\n- SL Breach: ${analysis.slBreach}%\n\nVagues critiques:\n${critData}`
      : defaultPrompt;

    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-5', max_tokens: 1200,
      messages: [{ role: 'user', content: finalPrompt }]
    });

    res.json({ success: true, analysis, claudeAnalysis: msg.content[0].text });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
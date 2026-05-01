const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

const getAnthropic = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Instruments disponibles
const INSTRUMENTS = {
  'MGC=F':  { name: 'Micro Gold',       emoji: '🥇', tickSize: 0.10, category: 'Metals' },
  'GC=F':   { name: 'Gold',             emoji: '🏅', tickSize: 0.10, category: 'Metals' },
  'MES=F':  { name: 'Micro E-mini S&P', emoji: '📈', tickSize: 0.25, category: 'Equity' },
  'ES=F':   { name: 'E-mini S&P 500',   emoji: '📊', tickSize: 0.25, category: 'Equity' },
  'MNQ=F':  { name: 'Micro Nasdaq',     emoji: '💻', tickSize: 0.25, category: 'Equity' },
  'NQ=F':   { name: 'E-mini Nasdaq',    emoji: '🖥',  tickSize: 0.25, category: 'Equity' },
  'M2K=F':  { name: 'Micro Russell',    emoji: '📉', tickSize: 0.10, category: 'Equity' },
  'RTY=F':  { name: 'Russell 2000',     emoji: '🏦', tickSize: 0.10, category: 'Equity' },
  'MCL=F':  { name: 'Micro Crude Oil',  emoji: '🛢',  tickSize: 0.01, category: 'Energy' },
  'CL=F':   { name: 'Crude Oil',        emoji: '⛽', tickSize: 0.01, category: 'Energy' },
  '6E=F':   { name: 'Euro FX',          emoji: '💶', tickSize: 0.00005, category: 'FX' },
  'ZB=F':   { name: '30Y T-Bond',       emoji: '🏛',  tickSize: 0.03125, category: 'Rates' },
};

// Heures exclues (America/Montreal)
const EST_EXCLUDED = [
  { start: 9*60+15,  end: 10*60+15 }, // 9h15-10h15
  { start: 18*60,    end: 18*60+30 }, // 18h-18h30
  { start: 22*60,    end: 24*60    }, // 22h-minuit
  { start: 0,        end: 5*60+45  }, // minuit-5h45
];

const isExcludedHour = (hour, minute) => {
  const total = hour * 60 + minute;
  return EST_EXCLUDED.some(e => total >= e.start && total <= e.end);
};

// Fetch Yahoo Finance data
const fetchYahooData = async (ticker, period = '10d', interval = '5m') => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period=${period}&interval=${interval}&includePrePost=true`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  if (!response.ok) throw new Error(`Yahoo Finance error: ${response.status}`);
  const json = await response.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error('No data returned');

  const timestamps = result.timestamp;
  const quotes = result.indicators.quote[0];

  return timestamps.map((ts, i) => ({
    timestamp: ts * 1000,
    open: quotes.open[i],
    high: quotes.high[i],
    low: quotes.low[i],
    close: quotes.close[i],
    volume: quotes.volume[i] || 0
  })).filter(d => d.close !== null && d.close !== undefined);
};

// Calculer RSI
const calcRSI = (closes, window = 9) => {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < window + 1) return rsi;

  let gains = 0, losses = 0;
  for (let i = 1; i <= window; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / window;
  let avgLoss = losses / window;
  rsi[window] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = window + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (window - 1) + gain) / window;
    avgLoss = (avgLoss * (window - 1) + loss) / window;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
};

// Analyser un instrument
const analyzeInstrument = (rawData, ticker, params) => {
  const { rsiWindow = 9, slMax = 600, dca1 = 200, dca2 = 400, streakMin = 3 } = params;
  const tickSize = INSTRUMENTS[ticker]?.tickSize || 0.10;

  // Convertir timestamps en dates Montreal (UTC-4/UTC-5)
  const data = rawData.map(d => {
    const date = new Date(d.timestamp);
    const estOffset = -4; // EDT (été)
    const localDate = new Date(date.getTime() + estOffset * 3600000);
    return {
      ...d,
      dateStr: localDate.toISOString().split('T')[0],
      hour: localDate.getHours(),
      minute: localDate.getMinutes(),
      localDate
    };
  });

  // RSI
  const closes = data.map(d => d.close);
  const rsiValues = calcRSI(closes, rsiWindow);
  data.forEach((d, i) => { d.rsi = rsiValues[i]; });

  // Tick variations
  data.forEach((d, i) => {
    if (i === 0) { d.varTicks = 0; return; }
    d.varTicks = Math.round((d.close - data[i-1].close) / tickSize);
  });

  // Filtrer heures de trading actives
  const tradingData = data.filter(d => !isExcludedHour(d.hour, d.minute));

  // Stats journalières
  const dailyMap = {};
  tradingData.forEach(d => {
    if (!dailyMap[d.dateStr]) dailyMap[d.dateStr] = { long: 0, short: 0, highs: [], lows: [], closes: [], rsis: [], volumes: [] };
    const day = dailyMap[d.dateStr];
    if (d.varTicks > 0) day.long += d.varTicks;
    else day.short += Math.abs(d.varTicks);
    day.highs.push(d.high);
    day.lows.push(d.low);
    day.closes.push(d.close);
    day.rsis.push(d.rsi);
    day.volumes.push(d.volume);
  });

  const dailyStats = Object.entries(dailyMap).map(([date, d]) => {
    const high = Math.max(...d.highs);
    const low = Math.min(...d.lows);
    const close = d.closes[d.closes.length - 1];
    const netDelta = d.long - d.short;
    const hlDelta = parseFloat((high - low).toFixed(2));
    const hlDeltaPct = parseFloat(((hlDelta / ((high + low) / 2)) * 100).toFixed(2));
    const rsiAvg = d.rsis.filter(r => r !== null).reduce((a, b) => a + b, 0) / d.rsis.filter(r => r !== null).length;
    const volume = d.volumes.reduce((a, b) => a + b, 0);
    return { date, totalLong: d.long, totalShort: -d.short, netDelta, high, low, close, hlDelta, hlDeltaPct, rsiAvg: parseFloat(rsiAvg?.toFixed(1)), volume, dominance: netDelta > 0 ? 'Bull 🐂' : 'Bear 🐻' };
  });

  // Streak analysis
  let streakId = 0;
  let prevDir = 0;
  const streaks = [];
  let currentStreak = null;

  tradingData.forEach(d => {
    const dir = d.varTicks > 0 ? 1 : d.varTicks < 0 ? -1 : 0;
    if (dir === 0) return;

    if (dir !== prevDir) {
      if (currentStreak) streaks.push(currentStreak);
      streakId++;
      currentStreak = { id: streakId, dir, date: d.dateStr, startTime: `${d.hour}:${String(d.minute).padStart(2,'0')}`, hour: d.hour, ticks: 0, count: 0, rsiStart: d.rsi, rsiEnd: d.rsi };
      prevDir = dir;
    }
    if (currentStreak) {
      currentStreak.ticks += d.varTicks;
      currentStreak.count++;
      currentStreak.rsiEnd = d.rsi;
    }
  });
  if (currentStreak) streaks.push(currentStreak);

  // Short streaks critiques
  const criticalShorts = streaks.filter(s =>
    s.dir === -1 &&
    Math.abs(s.ticks) >= slMax &&
    !isExcludedHour(s.hour, 0)
  ).slice(-40);

  // Stats actuelles (dernière bougie)
  const lastData = data[data.length - 1];
  const currentRSI = lastData?.rsi;
  const lastDay = dailyStats[dailyStats.length - 1];

  // % streaks > SL
  const dangerousStreaks = criticalShorts.filter(s => Math.abs(s.ticks) > slMax);
  const slBreachPct = criticalShorts.length > 0 ? ((dangerousStreaks.length / criticalShorts.length) * 100).toFixed(1) : 0;

  return {
    ticker,
    info: INSTRUMENTS[ticker],
    currentPrice: lastData?.close,
    currentRSI: currentRSI ? parseFloat(currentRSI.toFixed(1)) : null,
    lastDayStats: lastDay,
    dailyStats,
    candleData: data.slice(-200),
    streaks: streaks.slice(-100),
    criticalShorts: criticalShorts.slice(-40),
    slBreachPct,
    isCurrentlyExcluded: isExcludedHour(new Date().getHours(), new Date().getMinutes()),
    summary: {
      avgHLPct: dailyStats.length > 0 ? parseFloat((dailyStats.reduce((a, b) => a + b.hlDeltaPct, 0) / dailyStats.length).toFixed(2)) : 0,
      avgRSI: lastDay?.rsiAvg,
      dominance: lastDay?.dominance,
      netDelta: lastDay?.netDelta,
      maxShortStreak: criticalShorts.length > 0 ? Math.max(...criticalShorts.map(s => Math.abs(s.ticks))) : 0
    }
  };
};

// GET /api/trader/instruments
router.get('/instruments', (req, res) => {
  res.json({ success: true, instruments: INSTRUMENTS });
});

// POST /api/trader/scan — Scanner plusieurs instruments
router.post('/scan', async (req, res) => {
  try {
    const { tickers = ['MGC=F', 'MES=F', 'MNQ=F'], period = '10d', interval = '5m', params = {} } = req.body;

    const results = {};
    for (const ticker of tickers) {
      try {
        const rawData = await fetchYahooData(ticker, period, interval);
        results[ticker] = analyzeInstrument(rawData, ticker, params);
      } catch (err) {
        console.error(`Error fetching ${ticker}:`, err.message);
        results[ticker] = { ticker, error: err.message, info: INSTRUMENTS[ticker] };
      }
    }

    // Recommandation Claude
    const summaries = Object.entries(results)
      .filter(([, v]) => !v.error)
      .map(([ticker, v]) => `${INSTRUMENTS[ticker]?.name} (${ticker}): RSI=${v.currentRSI}, HL%=${v.summary.avgHLPct}%, Dominance=${v.summary.dominance}, Max Short Streak=${v.summary.maxShortStreak}t, SL Breach=${v.slBreachPct}%`)
      .join('\n');

    const now = new Date();
    const estHour = (now.getUTCHours() - 4 + 24) % 24;
    const estMin = now.getUTCMinutes();
    const isExcluded = isExcludedHour(estHour, estMin);

    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Tu es un expert en trading de futures. Voici les données de marché en temps réel pour les instruments analysés.

Heure actuelle (America/Montreal): ${estHour}h${String(estMin).padStart(2,'0')}
Session active: ${isExcluded ? '🔴 HORS TRADING (heure exclue)' : '🟢 SESSION ACTIVE'}

Heures exclues: 9h15-10h15, 18h-18h30, 22h-5h45

Méthode DCA: 3 contrats, entrée à -200t et -400t, SL max 600t (TopStep 50K, perte max $2000)

Données des instruments:
${summaries}

Donne une recommandation concise en français:
1. 🏆 Meilleur instrument du moment pour ma méthode DCA et pourquoi
2. 🚦 Statut de chaque instrument (Favorable/Neutre/Dangereux)
3. ⚠️ Alertes importantes
4. 💡 Conseil pour la session actuelle

Sois direct et précis. Maximum 300 mots.`
      }]
    });

    res.json({ success: true, results, recommendation: msg.content[0].text, currentHour: { hour: estHour, minute: estMin, isExcluded } });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/trader/analyze — Analyse détaillée d'un instrument
router.post('/analyze', async (req, res) => {
  try {
    const { ticker, period = '10d', interval = '5m', params = {} } = req.body;

    const rawData = await fetchYahooData(ticker, period, interval);
    const analysis = analyzeInstrument(rawData, ticker, params);

    // Préparer données pour Claude
    const criticalData = analysis.criticalShorts
      .map(s => `Date:${s.date} Heure:${s.startTime} Ticks:${Math.abs(s.ticks)} RSI_debut:${s.rsiStart?.toFixed(1)} RSI_fin:${s.rsiEnd?.toFixed(1)}`)
      .join('\n');

    const { slMax = 600, dca1 = 200, dca2 = 400 } = params;

    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Rôle: Expert en probabilités ${INSTRUMENTS[ticker]?.name} (${ticker}). 1 tick = 1$
Méthode: Grille DCA 3 contrats (-${dca1}t, -${dca2}t). Danger = Short Streak > ${slMax}t.
License TopStep 50K Combine, perte maximale $2000.

Heures EXCLUES (America/Montreal): 9h15-10h15, 18h-18h30, 22h-5h45

Vagues de baisse critiques (>${slMax} ticks) pendant heures de trading:
${criticalData || 'Aucune vague critique détectée'}

Stats actuelles:
- Prix: ${analysis.currentPrice}
- RSI actuel: ${analysis.currentRSI}
- HL% moyen: ${analysis.summary.avgHLPct}%
- Dominance: ${analysis.summary.dominance}
- Max Short Streak: ${analysis.summary.maxShortStreak} ticks
- % SL dépassés: ${analysis.slBreachPct}%

Mission:
1. 📊 Analyse Horaire: À quelles heures ces vagues > ${dca2}-${slMax} ticks se produisent-elles le plus?
2. ⚠️ Risque SL: % qui dépasse ${slMax}t et état du RSI à ce moment
3. 🔍 Patterns: Vois-tu un pattern dans les déclenchements?
4. 🎯 Verdict: Ma grille est-elle adaptée à cet instrument maintenant?
5. 📐 RSI optimal: Quel RSI de départ est sécuritaire pour mon DCA?
6. ❓ Questions de session: 3 questions clés avant de trader

Réponds en français, sois précis et actionnable.`
      }]
    });

    res.json({ success: true, analysis, claudeAnalysis: msg.content[0].text });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trader/data — Données seulement, sans Claude
router.post('/data', async (req, res) => {
  try {
    const { ticker, period = '10d', interval = '5m', params = {} } = req.body;
    const rawData = await fetchYahooData(ticker, period, interval);
    const analysis = analyzeInstrument(rawData, ticker, params);
    res.json({ success: true, analysis });
  } catch (err) {
    console.error('Data error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
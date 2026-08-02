// Shared Yahoo Finance helper — used by routes/trader.js (futures tickers, passed
// through as-is) and routes/tradingImperium.js (MT5 symbols, converted via
// mt5SymbolToYahoo).

async function fetchYahoo(ticker, period, interval) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${period}&interval=${interval}&includePrePost=true`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}: ${res.statusText}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error('Aucune donnée retournée par Yahoo Finance');
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  return ts.map((t, i) => ({
    ts: t * 1000,
    open: q.open[i], high: q.high[i],
    low: q.low[i], close: q.close[i],
    volume: q.volume[i] || 0
  })).filter(d => d.close != null && d.open != null);
}

// MT5 symbols (e.g. "USDCHF", "GBPUSD.raw", "XAUUSD") -> Yahoo Finance FX/metal
// cross ticker ("USDCHF=X", "GBPUSD=X", "XAUUSD=X"). Strips the broker suffix first.
function mt5SymbolToYahoo(symbol) {
  const clean = symbol.split('.')[0].toUpperCase();
  return `${clean}=X`;
}

module.exports = { fetchYahoo, mt5SymbolToYahoo };

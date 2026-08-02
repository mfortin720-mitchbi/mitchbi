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

// Metals don't have a Yahoo "=X" spot cross (XAUUSD=X / XAGUSD=X both 404) --
// use the COMEX futures ticker instead, which tracks spot closely enough for charting.
const METAL_OVERRIDES = { XAUUSD: 'GC=F', XAGUSD: 'SI=F' };

// MT5 symbols (e.g. "USDCHF", "GBPUSD.raw", "XAUUSD") -> Yahoo Finance ticker
// ("USDCHF=X", "GBPUSD=X", "GC=F"). Strips the broker suffix first.
function mt5SymbolToYahoo(symbol) {
  const clean = symbol.split('.')[0].toUpperCase();
  return METAL_OVERRIDES[clean] || `${clean}=X`;
}

module.exports = { fetchYahoo, mt5SymbolToYahoo };

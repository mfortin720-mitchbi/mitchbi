const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const router = express.Router();

// Fixed, trusted infra config (not secret) — the live MT5 monitoring pipeline
// on the ForexVPS writes here every 5 minutes. Credentials are server-side only.
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

const run = (query, params = {}) => getBigQuery().query({ query, params, location: LOCATION }).then(([rows]) => rows);

// GET /api/trading-imperium/accounts — latest state of all 6 accounts (top balance bar),
// joined with their current challenge phase/status for the phase badge.
//
// trading_days_count: each firm's real pass condition is target reached AND a minimum number of
// trading days elapsed since phase_start_date -- not target alone (confirmed on FundedNext
// 14114959, which crossed its Phase 1 target on trading day 4 but only actually advanced to
// Phase 2 on day 5, its real minimum). min_trading_days/trading_days_profitable_only come from
// config.py via challenge_phases (see trading_monitor.py). Most firms count a trading day as any
// day with >=1 closed position; The5ers requires the day to also be profitable (net_pnl on that
// day >= 0.5% of the phase's deposit) -- trading_days_profitable_only picks which count applies.
router.get('/accounts', async (req, res) => {
  try {
    const rows = await run(`
      WITH daily AS (
        SELECT login, DATE(closed_at) AS trade_day, SUM(net_pnl) AS daily_pnl
        FROM \`${PROJECT_ID}.${DATASET_ID}.trades_view\`
        WHERE is_closed = TRUE
        GROUP BY login, trade_day
      ),
      counts AS (
        SELECT
          d.login,
          COUNT(*) AS all_days,
          COUNTIF(d.daily_pnl >= 0.005 * c.deposit) AS profitable_days
        FROM daily d
        JOIN \`${PROJECT_ID}.${DATASET_ID}.latest_challenge_view\` c ON c.login = d.login
        WHERE d.trade_day >= c.phase_start_date
        GROUP BY d.login
      )
      SELECT a.*,
        c.challenge_phase, c.challenge_target, c.challenge_status,
        c.phase_start_date, c.phase_end_date, c.initial_login,
        c.min_trading_days, c.trading_days_profitable_only,
        IF(c.trading_days_profitable_only, counts.profitable_days, counts.all_days) AS trading_days_count
      FROM \`${PROJECT_ID}.${DATASET_ID}.latest_accounts_view\` a
      LEFT JOIN \`${PROJECT_ID}.${DATASET_ID}.latest_challenge_view\` c USING (account_id)
      LEFT JOIN counts ON counts.login = a.login
      ORDER BY a.license_firm, a.login
    `);
    res.json({ success: true, accounts: rows });
  } catch (err) {
    console.error('[trading-imperium] accounts error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/history?login=&firm=&symbol=&days= — daily balance evolution for charts
router.get('/history', async (req, res) => {
  try {
    const { login, firm, symbol, days } = req.query;
    const conditions = [];
    const params = {};

    if (login) { conditions.push('login = @login'); params.login = parseInt(login, 10); }
    if (firm) { conditions.push('license_firm = @firm'); params.firm = firm; }
    if (symbol) { conditions.push('algo_symbol = @symbol'); params.symbol = symbol; }
    if (days) { conditions.push('day >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)'); params.days = parseInt(days, 10); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await run(
      `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.daily_balance_history_view\` ${where} ORDER BY login, day`,
      params
    );
    res.json({ success: true, history: rows });
  } catch (err) {
    console.error('[trading-imperium] history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/trades?login=&symbol=&limit= — completed round-trip trades
router.get('/trades', async (req, res) => {
  try {
    const { login, symbol, limit } = req.query;
    const conditions = ['is_closed = TRUE'];
    const params = {};

    if (login) { conditions.push('login = @login'); params.login = parseInt(login, 10); }
    // STARTS_WITH not exact match: broker-suffixed symbols like "GBPUSD.raw" (Alpha Capital)
    // must still match the clean "GBPUSD" filter value derived from the algo filename.
    if (symbol) { conditions.push('STARTS_WITH(symbol, @symbol)'); params.symbol = symbol; }

    const rowLimit = Math.min(parseInt(limit, 10) || 200, 1000);
    const rows = await run(
      `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.trades_view\` WHERE ${conditions.join(' AND ')} ORDER BY closed_at DESC LIMIT ${rowLimit}`,
      params
    );
    res.json({ success: true, trades: rows });
  } catch (err) {
    console.error('[trading-imperium] trades error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/events?login= — resets, topups, breaches
router.get('/events', async (req, res) => {
  try {
    const { login } = req.query;
    const conditions = [];
    const params = {};

    if (login) { conditions.push('login = @login'); params.login = parseInt(login, 10); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await run(
      `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.account_events_view\` ${where} ORDER BY event_time DESC`,
      params
    );
    res.json({ success: true, events: rows });
  } catch (err) {
    console.error('[trading-imperium] events error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/chart?login=&period=&interval= — OHLC candles reconstructed from
// price_bars (1-minute bars pulled straight from that account's own MT5 broker feed, NOT a
// third-party source), bucketed to the requested interval server-side. Keyed on login rather
// than symbol because price_bars is per-account -- each broker's feed is its own price series,
// same as looking at a chart directly in that account's own MT5 terminal.
router.get('/chart', async (req, res) => {
  try {
    const { login, period = '10d', interval = '5m' } = req.query;
    if (!login) return res.status(400).json({ success: false, error: 'login requis' });

    const days = parseInt(period, 10) || 10;
    const bucketSeconds = interval === '1m' ? 60 : interval === '15m' ? 900 : 300;

    const rows = await run(`
      SELECT
        TIMESTAMP_SECONDS(DIV(UNIX_SECONDS(time), @bucketSeconds) * @bucketSeconds) AS bucket_time,
        ARRAY_AGG(open ORDER BY time ASC LIMIT 1)[OFFSET(0)] AS open,
        MAX(high) AS high,
        MIN(low) AS low,
        ARRAY_AGG(close ORDER BY time DESC LIMIT 1)[OFFSET(0)] AS close,
        SUM(tick_volume) AS volume
      FROM \`${PROJECT_ID}.${DATASET_ID}.price_bars\`
      WHERE login = @login AND time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      GROUP BY bucket_time
      ORDER BY bucket_time
    `, { login: parseInt(login, 10), days, bucketSeconds });

    const candles = rows.map(r => ({
      ts: new Date(r.bucket_time.value || r.bucket_time).getTime(),
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
    }));
    res.json({ success: true, candles });
  } catch (err) {
    console.error('[trading-imperium] chart error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

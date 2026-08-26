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

// GET /api/trading-imperium/ea-config — latest EA attach status + config dump per account,
// parsed by trading_monitor.py from the EA's own print() log (MQL5/Logs/*.log, not the terminal
// Journal) -- config_json is returned parsed so the frontend can read `.attached`, `.reason`,
// `.config` (flat "Section.Key" -> value strings) directly.
router.get('/ea-config', async (req, res) => {
  try {
    const rows = await run(`
      SELECT account_id, login, ea_version, change_reason, recorded_at, config_json
      FROM \`${PROJECT_ID}.${DATASET_ID}.latest_ea_config_view\`
      ORDER BY account_id
    `);
    const configs = rows.map(r => {
      let parsed = null;
      try { parsed = JSON.parse(r.config_json); } catch (e) { /* leave null on malformed JSON */ }
      return {
        account_id: r.account_id,
        login: r.login,
        ea_version: r.ea_version,
        recorded_at: r.recorded_at,
        attached: parsed?.attached ?? null,
        reason: parsed?.reason ?? null,
        at: parsed?.at ?? null,
        config: parsed?.config ?? null,
      };
    });
    res.json({ success: true, configs });
  } catch (err) {
    console.error('[trading-imperium] ea-config error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/signal-performance — real winrate vs the account's own breakeven
// threshold, per account, all closed trades. threshold = avg_loss / (avg_win + avg_loss) --
// derived from each account's ACTUAL average win/loss size, not the EA's nominal configured R:R
// (which is 1.8 for almost every account here despite very different real thresholds).
// bucket groups accounts by their current Strategy.Bias signal: "MACRO" or "SWEEP" anywhere in
// the signal name -> 'loss' bucket, everything else (MICRO-prefixed or bare pattern name) ->
// 'profit' bucket -- this classification is a judgment call (Michel's own reference example
// grouped them this way), not a documented rule from the EA itself. Confirmed live 2026-08-26
// against the EA's raw MQL5 log that "MACRO" does NOT correspond to a different chart timeframe
// (Bias timeframe reads H2 either way) -- the actual signal-detection logic behind the label
// isn't observable from here (compiled .ex5, no .mq5 source anywhere on the VPS).
router.get('/signal-performance', async (req, res) => {
  try {
    const configRows = await run(`
      SELECT account_id, config_json
      FROM \`${PROJECT_ID}.${DATASET_ID}.latest_ea_config_view\`
    `);
    const signalByAccount = {};
    for (const r of configRows) {
      try {
        const parsed = JSON.parse(r.config_json);
        signalByAccount[r.account_id] = parsed?.config?.['Strategy.Bias signal'] || null;
      } catch (e) { /* leave unset on malformed JSON */ }
    }

    // Jointe sur (account_id, login) -- pas juste account_id -- pour ne compter que les trades
    // de la phase EN COURS. Un compte qui a changé de login (ex. FundedNext 14178484, dont le
    // lineage a aussi tourné sous 14114959 puis 14169076) a pu tourner sous un tout autre
    // "Strategy.Bias signal" durant ses phases précédentes -- leur P&L n'a rien à voir avec la
    // config actuelle qu'on affiche ici, et les additionner gonfle le chiffre du signal courant.
    const stats = await run(`
      SELECT a.account_id, a.license_firm, a.login, a.algo_symbol,
             COUNT(*) AS trades,
             COUNTIF(t.net_pnl >= 0) AS wins,
             ROUND(SUM(t.net_pnl), 2) AS net_pnl,
             ROUND(AVG(IF(t.net_pnl >= 0, t.net_pnl, NULL)), 2) AS avg_win,
             ROUND(AVG(IF(t.net_pnl < 0, t.net_pnl, NULL)), 2) AS avg_loss
      FROM \`${PROJECT_ID}.${DATASET_ID}.trades_view\` t
      JOIN \`${PROJECT_ID}.${DATASET_ID}.latest_accounts_view\` a
        ON a.account_id = t.account_id AND a.login = t.login
      WHERE t.is_closed = TRUE
      GROUP BY a.account_id, a.license_firm, a.login, a.algo_symbol
    `);

    const results = stats.map(r => {
      const signal = signalByAccount[r.account_id] || '';
      const avgWin = r.avg_win || 0;
      const avgLoss = Math.abs(r.avg_loss || 0);
      const winrate = r.trades ? (r.wins / r.trades) * 100 : 0;
      const threshold = (avgWin + avgLoss) ? (avgLoss / (avgWin + avgLoss)) * 100 : null;
      const bucket = /MACRO|SWEEP/i.test(signal) ? 'loss' : 'profit';
      return {
        account_id: r.account_id, firm: r.license_firm, login: r.login, symbol: r.algo_symbol,
        signal, bucket, trades: r.trades, winrate, threshold, net_pnl: r.net_pnl,
      };
    });

    res.json({ success: true, accounts: results });
  } catch (err) {
    console.error('[trading-imperium] signal-performance error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/mfe-losers — every SL-closed loser with its MFE (max R reached
// before the SL hit), one row per trade, for the MFE Tracker tab. Returns raw per-trade rows
// (day/symbol/firm/variant/mfe_r) rather than pre-aggregated buckets so the frontend can group
// by any dimension (day, symbole, build, prop firm) instantly without a round-trip per view --
// the dataset is small (one row per losing trade, not per cycle).
router.get('/mfe-losers', async (req, res) => {
  try {
    const rows = await run(`
      SELECT m.account_id, m.login, m.symbol, m.closed_at, m.mfe_r, m.net_pnl, a.license_firm
      FROM \`${PROJECT_ID}.${DATASET_ID}.trade_mfe\` m
      LEFT JOIN \`${PROJECT_ID}.${DATASET_ID}.latest_accounts_view\` a USING (account_id)
      ORDER BY m.closed_at ASC
    `);
    const configRows = await run(`
      SELECT account_id, config_json FROM \`${PROJECT_ID}.${DATASET_ID}.latest_ea_config_view\`
    `);
    const variantByAccount = {};
    for (const c of configRows) {
      try {
        const parsed = JSON.parse(c.config_json);
        variantByAccount[c.account_id] = parsed?.config?.variant || null;
      } catch (e) { /* leave unset on malformed JSON */ }
    }

    const trades = rows.map(r => ({
      account_id: r.account_id, login: r.login, symbol: r.symbol,
      firm: r.license_firm, variant: variantByAccount[r.account_id] || null,
      closed_at: r.closed_at, mfe_r: r.mfe_r, net_pnl: r.net_pnl,
    }));
    res.json({ success: true, trades });
  } catch (err) {
    console.error('[trading-imperium] mfe-losers error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/rr-optimal — combines trade_mfe (losers) and trade_mfe_win (winners)
// into a single backtest: for each candidate R:R from 0.5 to 4.0, what would total $ across every
// analyzable trade have been if the EA's TP had been set to that R instead of its real ~1.8?
// Per-trade outcome curve as a function of a candidate R (see trading-monitor's
// rr_optimization.py for the full reasoning -- this mirrors it exactly, now sourced live from
// trade_mfe/trade_mfe_win instead of an ad-hoc script):
//   Losers:  R <= mfe_r                              -> win at +R
//            R >  mfe_r                               -> loss at -1R (same as what really happened)
//   Winners: R <= r_at_close, or R <= mfe_r_extended  -> win at +R
//            R >  mfe_r_extended, stopped_by_sl        -> loss at -1R
//            R >  mfe_r_extended, not stopped_by_sl    -> marked to market at final_mark_r
// Each trade's own $/R (net_pnl / r_at_close for winners, abs(net_pnl) for losers) converts the R
// outcome to real dollars, since lot size/instrument differ per account/trade.
const RR_CANDIDATES = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.25, 3.5, 3.75, 4.0];

router.get('/rr-optimal', async (req, res) => {
  try {
    const losers = await run(`
      SELECT mfe_r, net_pnl FROM \`${PROJECT_ID}.${DATASET_ID}.trade_mfe\`
    `);
    const winners = await run(`
      SELECT r_at_close, mfe_r_extended, stopped_by_sl, final_mark_r, net_pnl
      FROM \`${PROJECT_ID}.${DATASET_ID}.trade_mfe_win\`
    `);

    const loserOutcomeR = (mfeR, r) => (r <= mfeR ? r : -1);
    const winnerOutcomeR = (w, r) => {
      if (r <= w.r_at_close || r <= w.mfe_r_extended) return r;
      return w.stopped_by_sl ? -1 : w.final_mark_r;
    };

    const actualTotal = losers.reduce((s, l) => s + (l.net_pnl || 0), 0)
      + winners.reduce((s, w) => s + (w.net_pnl || 0), 0);

    const sweep = RR_CANDIDATES.map(r => {
      let totalDollars = 0, wins = 0;
      for (const l of losers) {
        const outcome = loserOutcomeR(l.mfe_r, r);
        totalDollars += outcome * Math.abs(l.net_pnl || 0);
        if (outcome > 0) wins++;
      }
      for (const w of winners) {
        const outcome = winnerOutcomeR(w, r);
        const dollarsPerR = (w.net_pnl || 0) / w.r_at_close;
        totalDollars += outcome * dollarsPerR;
        if (outcome > 0) wins++;
      }
      const n = losers.length + winners.length;
      return { r, total_dollars: totalDollars, winrate: n ? (wins / n) * 100 : 0, n };
    });

    const best = sweep.reduce((a, b) => (b.total_dollars > a.total_dollars ? b : a), sweep[0]);

    const avg = arr => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
    const median = arr => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const loserMfes = losers.map(l => l.mfe_r).filter(v => v != null);
    const winnerLeftOnTable = winners.map(w => Math.max(0, w.mfe_r_extended - w.r_at_close));

    res.json({
      success: true,
      actual_total: actualTotal,
      sweep,
      best,
      losers: {
        count: losers.length,
        avg_mfe: avg(loserMfes),
        median_mfe: median(loserMfes),
        at_best_r: loserMfes.filter(v => v >= best.r).length,
      },
      winners: {
        count: winners.length,
        avg_left_on_table: avg(winnerLeftOnTable),
        median_left_on_table: median(winnerLeftOnTable),
        beyond_tp: winnerLeftOnTable.filter(v => v > 0.1).length,
      },
    });
  } catch (err) {
    console.error('[trading-imperium] rr-optimal error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/tp-scenarios?start=&end= — "what if I'd taken profit at +1R/+1.5R/+2R..."
// analysis over losing trades closed in [start, end]. Method (validated earlier against real data,
// see RR_ANALYSIS.md in the trading-monitor repo): only trades closed by SL (close_reason='SL') can
// be analyzed -- the SL price is recovered from the exit deal's own comment ("[sl X.XXXXX]", written
// by the broker at close time), which is the only place that price is preserved after the fact.
// Trades closed manually (CLIENT/EXPERT) have no recorded SL and are excluded (reported as
// excluded_losers, not silently dropped). For each analyzable losing trade, walk its M1 price_bars
// chronologically and check whether a hypothetical TP at each R-multiple would have been hit before
// the real SL -- same-bar ties count as SL hit (conservative: intra-bar order isn't knowable from
// OHLC alone).
const TP_SCENARIO_R_MULTIPLES = [1.0, 1.2, 1.5, 2.0, 2.5, 3.0];

router.get('/tp-scenarios', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start et end (dates) requis' });

    const [totals] = await run(`
      SELECT
        COUNT(*) AS total_trades,
        COUNTIF(net_pnl >= 0) AS total_winners,
        COUNTIF(net_pnl < 0) AS total_losers,
        COUNTIF(net_pnl < 0 AND close_reason = 'SL') AS analyzable_losers
      FROM \`${PROJECT_ID}.${DATASET_ID}.trades_view\`
      WHERE is_closed = TRUE AND closed_at BETWEEN TIMESTAMP(@start) AND TIMESTAMP(@end)
    `, { start, end });

    const slTrades = await run(`
      SELECT
        t.account_id, t.login, t.position_id, t.symbol, t.direction,
        t.entry_price, t.exit_price, t.opened_at, t.closed_at, t.net_pnl,
        CAST(REGEXP_EXTRACT(d.comment, r'\\[sl ([0-9.]+)\\]') AS FLOAT64) AS sl_price
      FROM \`${PROJECT_ID}.${DATASET_ID}.trades_view\` t
      JOIN \`${PROJECT_ID}.${DATASET_ID}.trade_deals\` d
        ON d.position_id = t.position_id AND d.login = t.login AND d.entry_name != 'IN'
      WHERE t.is_closed = TRUE AND t.net_pnl < 0 AND t.close_reason = 'SL'
        AND t.closed_at BETWEEN TIMESTAMP(@start) AND TIMESTAMP(@end)
    `, { start, end });

    const usableTrades = slTrades.filter(t => t.sl_price != null);

    // One price_bars query per distinct (account_id, symbol), covering the full span needed for
    // every trade on that pair -- instead of one query per trade (which for ~80 trades would be
    // ~80 round-trips just to re-fetch overlapping bar ranges on the same handful of symbols).
    const pairs = {};
    for (const t of usableTrades) {
      const key = `${t.account_id}|${t.symbol}`;
      if (!pairs[key]) pairs[key] = { account_id: t.account_id, symbol: t.symbol, min: t.opened_at, max: t.closed_at };
      else {
        if (t.opened_at.value < pairs[key].min.value) pairs[key].min = t.opened_at;
        if (t.closed_at.value > pairs[key].max.value) pairs[key].max = t.closed_at;
      }
    }

    const barsByPair = {};
    for (const key of Object.keys(pairs)) {
      const { account_id, symbol, min, max } = pairs[key];
      const bars = await run(`
        SELECT time, high, low
        FROM \`${PROJECT_ID}.${DATASET_ID}.price_bars\`
        WHERE account_id = @account_id AND symbol = @symbol AND time BETWEEN TIMESTAMP(@min) AND TIMESTAMP(@max)
        ORDER BY time ASC
      `, { account_id, symbol, min: min.value || min, max: max.value || max });
      barsByPair[key] = bars.map(b => ({ t: (b.time.value || b.time), high: b.high, low: b.low }));
    }

    // Per trade: R = |entry - sl|. For each requested multiple, walk that trade's own bar window
    // (opened_at..closed_at) chronologically -- first of {TP, SL} touched wins, same-bar = SL wins.
    const recoveredByR = Object.fromEntries(TP_SCENARIO_R_MULTIPLES.map(r => [r, 0]));
    for (const t of usableTrades) {
      const key = `${t.account_id}|${t.symbol}`;
      const bars = (barsByPair[key] || []).filter(b => b.t >= (t.opened_at.value || t.opened_at) && b.t <= (t.closed_at.value || t.closed_at));
      const risk = Math.abs(t.entry_price - t.sl_price);
      if (!risk) continue;
      const isBuy = t.direction === 'BUY';
      for (const r of TP_SCENARIO_R_MULTIPLES) {
        const tp = isBuy ? t.entry_price + risk * r : t.entry_price - risk * r;
        let recovered = false;
        for (const bar of bars) {
          const tpHit = isBuy ? bar.high >= tp : bar.low <= tp;
          const slHit = isBuy ? bar.low <= t.sl_price : bar.high >= t.sl_price;
          if (tpHit && !slHit) { recovered = true; break; }
          if (slHit) break;
        }
        if (recovered) recoveredByR[r] += 1;
      }
    }

    const totalTrades = Number(totals.total_trades);
    const totalWinners = Number(totals.total_winners);
    const scenarios = TP_SCENARIO_R_MULTIPLES.map(r => {
      const recovered = recoveredByR[r];
      const newWinners = totalWinners + recovered;
      const newWinrate = totalTrades ? (newWinners / totalTrades) * 100 : null;
      const breakeven = (100 / (1 + r));
      return {
        r_multiple: r,
        recovered_count: recovered,
        recovered_pct: usableTrades.length ? (recovered / usableTrades.length) * 100 : null,
        new_total_winners: newWinners,
        new_winrate: newWinrate,
        breakeven_winrate: breakeven,
        above_breakeven: newWinrate != null ? newWinrate > breakeven : null,
      };
    });

    res.json({
      success: true,
      totals: {
        total_trades: totalTrades,
        total_winners: totalWinners,
        total_losers: Number(totals.total_losers),
        analyzable_losers: usableTrades.length,
        excluded_losers: Number(totals.total_losers) - usableTrades.length,
        current_winrate: totalTrades ? (totalWinners / totalTrades) * 100 : null,
      },
      scenarios,
    });
  } catch (err) {
    console.error('[trading-imperium] tp-scenarios error:', err.message);
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

// GET /api/trading-imperium/phase-history — one row per PAST (superseded) login/phase per
// account, i.e. every challenge_phases login that is no longer the current one for its
// account_id. Balance/balance_max/drawdown come from accounts_snapshot_v2 (that old login's
// last-ever snapshot / peak balance while it was active) since challenge_phases itself doesn't
// carry live balance data. challenge_status on the historical row is often stale ("ongoing" --
// the old login's last row rarely gets flipped to "completed" before the switch to the new
// login happens) so the frontend derives a display status instead of trusting it literally: any
// non-terminal ("ongoing") historical row implicitly means the phase was passed (a newer login
// exists for the same account_id), only "breached"/"funded" are shown as their literal status.
router.get('/phase-history', async (req, res) => {
  try {
    const rows = await run(`
      WITH ranked_phases AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY recorded_at DESC) AS rn
        FROM \`${PROJECT_ID}.${DATASET_ID}.challenge_phases\`
      ),
      current_logins AS (
        SELECT account_id, login FROM ranked_phases WHERE rn = 1
      ),
      phase_per_login AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id, login ORDER BY recorded_at DESC) AS rn2
        FROM \`${PROJECT_ID}.${DATASET_ID}.challenge_phases\`
      ),
      past_phases AS (
        SELECT p.account_id, p.login, p.initial_login, p.firm, p.challenge_phase, p.challenge_target,
               p.deposit, p.challenge_status, p.phase_start_date, p.phase_end_date, p.recorded_at
        FROM phase_per_login p
        JOIN current_logins c ON c.account_id = p.account_id
        WHERE p.rn2 = 1 AND p.login != c.login
      ),
      snap_ranked AS (
        SELECT account_id, login, balance, drawdown_pct, timestamp,
               ROW_NUMBER() OVER (PARTITION BY account_id, login ORDER BY timestamp DESC) AS rn3
        FROM \`${PROJECT_ID}.${DATASET_ID}.accounts_snapshot_v2\`
      ),
      last_snap AS (
        SELECT account_id, login, balance AS last_balance, drawdown_pct AS last_drawdown, timestamp AS last_seen
        FROM snap_ranked WHERE rn3 = 1
      ),
      max_balance AS (
        SELECT account_id, login, MAX(balance) AS max_balance
        FROM \`${PROJECT_ID}.${DATASET_ID}.accounts_snapshot_v2\`
        GROUP BY account_id, login
      )
      SELECT pp.account_id, pp.login, pp.initial_login, pp.firm, pp.challenge_phase, pp.challenge_target,
        pp.deposit, pp.challenge_status, pp.phase_start_date, pp.phase_end_date, pp.recorded_at,
        ls.last_balance, ls.last_drawdown, ls.last_seen, mb.max_balance
      FROM past_phases pp
      LEFT JOIN last_snap ls ON ls.account_id = pp.account_id AND ls.login = pp.login
      LEFT JOIN max_balance mb ON mb.account_id = pp.account_id AND mb.login = pp.login
      ORDER BY pp.recorded_at DESC
    `);
    res.json({ success: true, phases: rows });
  } catch (err) {
    console.error('[trading-imperium] phase-history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/trading-imperium/trades?login=&symbol=&from=&to=&limit= — completed round-trip trades
router.get('/trades', async (req, res) => {
  try {
    const { login, symbol, from, to, limit } = req.query;
    const conditions = ['t.is_closed = TRUE'];
    const params = {};

    if (login) { conditions.push('t.login = @login'); params.login = parseInt(login, 10); }
    // STARTS_WITH not exact match: broker-suffixed symbols like "GBPUSD.raw" (Alpha Capital)
    // must still match the clean "GBPUSD" filter value derived from the algo filename.
    if (symbol) { conditions.push('STARTS_WITH(t.symbol, @symbol)'); params.symbol = symbol; }
    // from/to are date (or date+time) strings from the frontend's date inputs -- cast in SQL
    // rather than relying on the BigQuery client's JS-type inference, which would treat a bare
    // string param as STRING and fail the TIMESTAMP comparison.
    if (from) { conditions.push('t.closed_at >= TIMESTAMP(@from)'); params.from = from; }
    if (to) { conditions.push('t.closed_at <= TIMESTAMP(@to)'); params.to = to; }

    const rowLimit = Math.min(parseInt(limit, 10) || 200, 1000);
    // mfe_r (from trade_mfe, computed by trading_monitor.py's sync_trade_mfe()) is only ever
    // non-null for a losing trade closed at its own SL -- a manual/EA close or a winner has no
    // row there, LEFT JOIN keeps those trades in the result with mfe_r = null.
    const rows = await run(
      `SELECT t.*, m.mfe_r, m.peak_count AS mfe_peak_count
       FROM \`${PROJECT_ID}.${DATASET_ID}.trades_view\` t
       LEFT JOIN \`${PROJECT_ID}.${DATASET_ID}.trade_mfe\` m
         ON t.account_id = m.account_id AND t.position_id = m.position_id
       WHERE ${conditions.join(' AND ')} ORDER BY t.closed_at DESC LIMIT ${rowLimit}`,
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

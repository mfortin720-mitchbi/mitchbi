import { useState, useEffect, useRef, useMemo } from 'react';

const API = import.meta.env.VITE_API_URL;

const GREEN = '#1D9E75';
const RED = '#D85A30';
const BLUE = '#378ADD';
const GOLD = '#E8A838';

const FIRM_COLORS = { 'Hola Prime': '#378ADD', 'FundedNext': '#E8A838', 'Alpha Capital': '#1D9E75' };
const firmColor = f => FIRM_COLORS[f] || '#9B59B6';

const fmtMoney = v => v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
const fmtDateTime = v => v ? new Date(v).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' }) : '—';

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

const PlotDiv = ({ traces, layout, deps }) => {
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

const Card = ({ children, style }) => (
  <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16, ...style }}>
    {children}
  </div>
);

const AccountStatus = (acc) => {
  if (!acc.terminal_connected) return { label: '🔴 Déconnecté', color: RED };
  if (!acc.trade_allowed) return { label: '🟠 Trading désactivé', color: GOLD };
  return { label: '🟢 Actif', color: GREEN };
};

export default function TradingImperium() {
  const [accounts, setAccounts] = useState([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [events, setEvents] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');

  const [filterFirm, setFilterFirm] = useState('all');
  const [filterAccount, setFilterAccount] = useState('all');

  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const [trades, setTrades] = useState([]);
  const [loadingTrades, setLoadingTrades] = useState(false);

  const loadAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const res = await fetch(`${API}/api/trading-imperium/accounts`);
      const d = await res.json();
      if (d.success) setAccounts(d.accounts);
    } catch (e) { console.error(e); }
    finally { setLoadingAccounts(false); }
  };

  const loadEvents = async () => {
    try {
      const res = await fetch(`${API}/api/trading-imperium/events`);
      const d = await res.json();
      if (d.success) setEvents(d.events);
    } catch (e) { console.error(e); }
  };

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const params = new URLSearchParams();
      if (filterFirm !== 'all') params.set('firm', filterFirm);
      if (filterAccount !== 'all') params.set('accountId', filterAccount);
      const res = await fetch(`${API}/api/trading-imperium/history?${params}`);
      const d = await res.json();
      if (d.success) setHistory(d.history);
    } catch (e) { console.error(e); }
    finally { setLoadingHistory(false); }
  };

  const loadTrades = async () => {
    setLoadingTrades(true);
    try {
      const params = new URLSearchParams();
      if (filterAccount !== 'all') params.set('accountId', filterAccount);
      const res = await fetch(`${API}/api/trading-imperium/trades?${params}`);
      const d = await res.json();
      if (d.success) setTrades(d.trades);
    } catch (e) { console.error(e); }
    finally { setLoadingTrades(false); }
  };

  useEffect(() => { loadAccounts(); loadEvents(); }, []);
  useEffect(() => { if (activeTab === 'overview') loadHistory(); }, [activeTab, filterFirm, filterAccount]);
  useEffect(() => { if (activeTab === 'trades') loadTrades(); }, [activeTab, filterAccount]);

  const firms = useMemo(() => [...new Set(accounts.map(a => a.license_firm))], [accounts]);

  const totals = useMemo(() => {
    const balance = accounts.reduce((s, a) => s + (a.balance || 0), 0);
    const equity = accounts.reduce((s, a) => s + (a.equity || 0), 0);
    const deposit = accounts.reduce((s, a) => s + (a.deposit || 0), 0);
    const pnl = equity - deposit;
    return { balance, equity, deposit, pnl, pnlPct: deposit ? (pnl / deposit) * 100 : 0 };
  }, [accounts]);

  // ── Graphique évolution (Overview) ────────────────────────────────────────
  const historyByAccount = useMemo(() => {
    const map = {};
    for (const row of history) {
      if (!map[row.account_id]) map[row.account_id] = [];
      map[row.account_id].push(row);
    }
    return map;
  }, [history]);

  const resetEvents = useMemo(
    () => events.filter(e => e.event_type === 'reset' && (filterAccount === 'all' || e.account_id === filterAccount)),
    [events, filterAccount]
  );

  return (
    <div>
      {/* ── Bandeau balance — toujours visible ─────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 10, marginBottom: 16 }}>
        {[
          { label: 'Balance totale', value: fmtMoney(totals.balance) },
          { label: 'Equity totale', value: fmtMoney(totals.equity) },
          { label: 'Deposit total', value: fmtMoney(totals.deposit) },
          { label: 'P&L global', value: fmtMoney(totals.pnl), color: totals.pnl >= 0 ? GREEN : RED },
          { label: 'P&L %', value: fmtPct(totals.pnlPct), color: totals.pnlPct >= 0 ? GREEN : RED },
          { label: 'Comptes actifs', value: `${accounts.filter(a => a.terminal_connected).length}/${accounts.length || 6}` },
        ].map(k => (
          <Card key={k.label} style={{ padding: '10px 14px' }}>
            <div style={{ fontSize: 10, color: '#444', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: k.color || '#fff' }}>{k.value}</div>
          </Card>
        ))}
      </div>

      {loadingAccounts && <div style={{ color: '#444', fontSize: 13, padding: 20, textAlign: 'center' }}>⏳ Chargement des comptes...</div>}

      {!loadingAccounts && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px,1fr))', gap: 12, marginBottom: 20 }}>
          {accounts.map(acc => {
            const status = AccountStatus(acc);
            return (
              <Card key={acc.account_id} style={{ borderColor: `${firmColor(acc.license_firm)}33` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: firmColor(acc.license_firm) }} />
                  <div>
                    <div style={{ fontWeight: 600, color: '#fff', fontSize: 13 }}>{acc.license_firm} — {acc.login}</div>
                    <div style={{ fontSize: 11, color: '#555' }}>{acc.algo_symbol || acc.symbols_trading || '—'}</div>
                  </div>
                  <div style={{ marginLeft: 'auto', fontSize: 11, color: status.color }}>{status.label}</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div><div style={{ fontSize: 10, color: '#444' }}>BALANCE</div><div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>{fmtMoney(acc.balance)}</div></div>
                  <div><div style={{ fontSize: 10, color: '#444' }}>EQUITY</div><div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>{fmtMoney(acc.equity)}</div></div>
                  <div><div style={{ fontSize: 10, color: '#444' }}>P&amp;L</div><div style={{ fontSize: 13, color: acc.pnl >= 0 ? GREEN : RED }}>{fmtMoney(acc.pnl)} ({fmtPct(acc.pnl_pct)})</div></div>
                  <div><div style={{ fontSize: 10, color: '#444' }}>DRAWDOWN</div><div style={{ fontSize: 13, color: acc.drawdown_pct > 0 ? RED : '#ccc' }}>{fmtPct(acc.drawdown_pct)}</div></div>
                </div>
                <div style={{ fontSize: 10, color: '#333' }}>{acc.open_positions_count} position(s) · maj {fmtDateTime(acc.last_updated)}</div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Sous-onglets ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {[
          { id: 'overview', label: 'Vue d’ensemble' },
          { id: 'trades', label: 'Trades' },
          { id: 'events', label: 'Événements' },
        ].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: '7px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
            border: '0.5px solid', borderColor: activeTab === t.id ? BLUE : '#1e2130',
            background: activeTab === t.id ? '#0d1f35' : 'transparent',
            color: activeTab === t.id ? BLUE : '#555', fontWeight: 500
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Filtres (Overview + Trades) ────────────────────────────────── */}
      {(activeTab === 'overview' || activeTab === 'trades') && (
        <Card style={{ padding: '10px 16px', marginBottom: 16, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {activeTab === 'overview' && (
            <div>
              <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Firme</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {['all', ...firms].map(f => (
                  <button key={f} onClick={() => setFilterFirm(f)} style={{
                    padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                    border: '0.5px solid', borderColor: filterFirm === f ? BLUE : '#1e2130',
                    background: filterFirm === f ? '#0d1f35' : 'transparent',
                    color: filterFirm === f ? BLUE : '#555'
                  }}>{f === 'all' ? 'Toutes' : f}</button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Compte</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {['all', ...accounts.map(a => a.account_id)].map(id => (
                <button key={id} onClick={() => setFilterAccount(id)} style={{
                  padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
                  border: '0.5px solid', borderColor: filterAccount === id ? BLUE : '#1e2130',
                  background: filterAccount === id ? '#0d1f35' : 'transparent',
                  color: filterAccount === id ? BLUE : '#555'
                }}>{id === 'all' ? 'Tous' : id}</button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* ── Vue d'ensemble : graphique évolution ───────────────────────── */}
      {activeTab === 'overview' && (
        <Card>
          {loadingHistory && <div style={{ color: '#444', fontSize: 13, padding: 40, textAlign: 'center' }}>⏳ Chargement de l'historique...</div>}
          {!loadingHistory && history.length === 0 && (
            <div style={{ color: '#444', fontSize: 13, padding: 40, textAlign: 'center' }}>Pas encore assez de données — l'historique s'accumule au fil des jours.</div>
          )}
          {!loadingHistory && history.length > 0 && (
            <PlotDiv
              traces={Object.entries(historyByAccount).map(([accountId, rows]) => ({
                type: 'scatter', mode: 'lines+markers',
                x: rows.map(r => r.day.value || r.day),
                y: rows.map(r => r.balance),
                name: accountId,
                line: { width: 2 }
              }))}
              layout={{
                title: 'Évolution de la balance par compte',
                height: 420,
                xaxis: { title: 'Date' },
                yaxis: { title: 'Balance (USD)' },
                shapes: resetEvents.map(e => ({
                  type: 'line', xref: 'x', yref: 'paper',
                  x0: e.event_time.value || e.event_time, x1: e.event_time.value || e.event_time,
                  y0: 0, y1: 1,
                  line: { color: GOLD, dash: 'dash', width: 1 }
                })),
                annotations: resetEvents.map(e => ({
                  x: e.event_time.value || e.event_time, y: 1, yref: 'paper',
                  text: 'Reset', showarrow: false, font: { color: GOLD, size: 10 }
                }))
              }}
              deps={[history.length, resetEvents.length]}
            />
          )}
        </Card>
      )}

      {/* ── Trades ──────────────────────────────────────────────────────── */}
      {activeTab === 'trades' && (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {loadingTrades && <div style={{ color: '#444', fontSize: 13, padding: 40, textAlign: 'center' }}>⏳ Chargement des trades...</div>}
          {!loadingTrades && trades.length === 0 && (
            <div style={{ color: '#444', fontSize: 13, padding: 40, textAlign: 'center' }}>Aucun trade complété pour ce filtre.</div>
          )}
          {!loadingTrades && trades.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '0.5px solid #1e2130', color: '#555', textAlign: 'left' }}>
                    {['Compte', 'Symbole', 'Sens', 'Ouvert', 'Fermé', 'Entrée', 'Sortie', 'P&L net', 'Raison'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid #1a1d27' }}>
                      <td style={{ padding: '8px 12px', color: '#ccc' }}>{t.account_id}</td>
                      <td style={{ padding: '8px 12px', color: '#ccc' }}>{t.symbol}</td>
                      <td style={{ padding: '8px 12px', color: t.direction === 'BUY' ? GREEN : RED }}>{t.direction}</td>
                      <td style={{ padding: '8px 12px', color: '#555' }}>{fmtDateTime(t.opened_at?.value || t.opened_at)}</td>
                      <td style={{ padding: '8px 12px', color: '#555' }}>{fmtDateTime(t.closed_at?.value || t.closed_at)}</td>
                      <td style={{ padding: '8px 12px', color: '#ccc' }}>{t.entry_price}</td>
                      <td style={{ padding: '8px 12px', color: '#ccc' }}>{t.exit_price}</td>
                      <td style={{ padding: '8px 12px', fontWeight: 600, color: t.net_pnl >= 0 ? GREEN : RED }}>{fmtMoney(t.net_pnl)}</td>
                      <td style={{ padding: '8px 12px', color: '#555' }}>{t.close_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ── Événements ──────────────────────────────────────────────────── */}
      {activeTab === 'events' && (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {events.length === 0 && (
            <div style={{ color: '#444', fontSize: 13, padding: 40, textAlign: 'center' }}>Aucun événement.</div>
          )}
          {events.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '0.5px solid #1e2130', color: '#555', textAlign: 'left' }}>
                    {['Compte', 'Date', 'Type', 'Montant', 'Commentaire'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', fontWeight: 500, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid #1a1d27' }}>
                      <td style={{ padding: '8px 12px', color: '#ccc' }}>{e.account_id}</td>
                      <td style={{ padding: '8px 12px', color: '#555' }}>{fmtDateTime(e.event_time?.value || e.event_time)}</td>
                      <td style={{ padding: '8px 12px', color: e.event_type === 'reset' ? GOLD : '#ccc' }}>{e.event_type}</td>
                      <td style={{ padding: '8px 12px', color: e.amount >= 0 ? GREEN : RED }}>{fmtMoney(e.amount)}</td>
                      <td style={{ padding: '8px 12px', color: '#555' }}>{e.comment}</td>
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

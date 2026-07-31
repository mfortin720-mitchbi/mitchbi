import { useState, useEffect, useRef, useMemo } from 'react';

const API = import.meta.env.VITE_API_URL;

const GREEN = '#1D9E75';
const RED = '#D85A30';
const BLUE = '#378ADD';
const GOLD = '#E8A838';
const MUTED = '#8b93a5'; // labels/sous-titres — plus lisible que le gris foncé d'origine

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
      if (filterLogin !== 'all') params.set('login', filterLogin);
      if (filterSymbol !== 'all') params.set('symbol', filterSymbol);
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
      if (filterLogin !== 'all') params.set('login', filterLogin);
      if (filterSymbol !== 'all') params.set('symbol', filterSymbol);
      const res = await fetch(`${API}/api/trading-imperium/trades?${params}`);
      const d = await res.json();
      if (d.success) setTrades(d.trades);
    } catch (e) { console.error(e); }
    finally { setLoadingTrades(false); }
  };

  useEffect(() => { loadAccounts(); loadEvents(); }, []);
  useEffect(() => { if (activeTab === 'overview') loadHistory(); }, [activeTab, filterFirm, filterLogin, filterSymbol]);
  useEffect(() => { if (activeTab === 'trades') loadTrades(); }, [activeTab, filterLogin, filterSymbol]);

  const firms = useMemo(() => [...new Set(accounts.map(a => a.license_firm))], [accounts]);
  const symbols = useMemo(() => [...new Set(accounts.map(a => a.algo_symbol).filter(Boolean))].sort(), [accounts]);

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

  // Clique sur une case compte → filtre le graphique du bas sur ce login et affiche la Vue d'ensemble
  const selectAccount = login => {
    setFilterLogin(prev => (prev === login ? 'all' : login));
    onTabChange?.('overview');
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                  <div><div style={{ fontSize: 10, color: MUTED }}>BALANCE</div><div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{fmtMoney(acc.balance)}</div></div>
                  <div><div style={{ fontSize: 10, color: MUTED }}>EQUITY</div><div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{fmtMoney(acc.equity)}</div></div>
                  <div><div style={{ fontSize: 10, color: MUTED }}>P&amp;L</div><div style={{ fontSize: 12, color: acc.pnl >= 0 ? GREEN : RED }}>{fmtMoney(acc.pnl)} ({fmtPct(acc.pnl_pct)})</div></div>
                  <div><div style={{ fontSize: 10, color: MUTED }}>DRAWDOWN</div><div style={{ fontSize: 12, color: acc.drawdown_pct > 0 ? RED : '#ccc' }}>{fmtPct(acc.drawdown_pct)}</div></div>
                </div>
                <div style={{ fontSize: 10, color: MUTED }}>{acc.open_positions_count} position(s) · maj {fmtDateTime(acc.last_updated)}</div>
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
                <button key={s} onClick={() => setFilterSymbol(s)} style={{
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
                  x0: e.event_time.value || e.event_time, x1: e.event_time.value || e.event_time,
                  y0: 0, y1: 1,
                  line: { color: GOLD, dash: 'dash', width: 1 }
                })),
                annotations: resetEvents.map(e => ({
                  x: e.event_time.value || e.event_time, y: 1, yref: 'paper',
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
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {loadingTrades && <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>⏳ Chargement des trades...</div>}
          {!loadingTrades && trades.length === 0 && (
            <div style={{ color: MUTED, fontSize: 13, padding: 40, textAlign: 'center' }}>Aucun trade complété pour ce filtre.</div>
          )}
          {!loadingTrades && trades.length > 0 && (
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
        </Card>
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

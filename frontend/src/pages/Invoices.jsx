import { useState, useEffect, useCallback } from 'react';

const CATEGORIES = ['Trading', 'AI & Tech', 'Cloud & Infra', 'Souscriptions', 'E-commerce', 'Business', 'Autre'];

const CATEGORY_COLORS = {
  'Trading': '#378ADD',
  'AI & Tech': '#9B59B6',
  'Cloud & Infra': '#1D9E75',
  'Souscriptions': '#E8A838',
  'E-commerce': '#D85A30',
  'Business': '#2ECC71',
  'Autre': '#555'
};

const StatusBadge = ({ status }) => {
  const config = {
    pending: { bg: '#1a1a2b', text: '#378ADD', label: '⏳ À valider' },
    verified: { bg: '#0d2b1a', text: '#1D9E75', label: '✅ Vérifié' },
    corrected: { bg: '#2b1a0d', text: '#E8A838', label: '✏️ Corrigé' },
  };
  const c = config[status] || config.pending;
  return <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: c.bg, color: c.text }}>{c.label}</span>;
};

export default function Invoices({ session }) {
  const [invoices, setInvoices] = useState([]);
  const [stats, setStats] = useState(null);
  const [gmailStatus, setGmailStatus] = useState({ connected: false });
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState({ category: '', verified: '' });
  const [editingId, setEditingId] = useState(null);
  const [editCategory, setEditCategory] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [scanResult, setScanResult] = useState(null);
  const [settings, setSettings] = useState({ scan_interval_hours: 4 });
  const [activeTab, setActiveTab] = useState('invoices');

  const API = import.meta.env.VITE_API_URL;

  const loadGmailStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/auth/google/status`);
      const data = await res.json();
      setGmailStatus(data);
      if (data.settings) setSettings(data.settings);
    } catch (err) { console.error(err); }
  }, [API]);

  const loadInvoices = useCallback(async (cat = filter.category, ver = filter.verified) => {
    try {
      const params = new URLSearchParams();
      if (cat) params.append('category', cat);
      if (ver) params.append('verified', ver);
      const res = await fetch(`${API}/api/invoices?${params}`);
      const data = await res.json();
      if (data.success) setInvoices(data.invoices);
    } catch (err) { console.error(err); }
  }, [API, filter]);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/invoices/stats`);
      const data = await res.json();
      if (data.success) setStats(data);
    } catch (err) { console.error(err); }
  }, [API]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadInvoices(), loadStats(), loadGmailStatus()]);
    setLoading(false);
  }, [loadInvoices, loadStats, loadGmailStatus]);

  // Initial load + check OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailParam = params.get('gmail');
    if (gmailParam) {
      window.history.replaceState({}, '', window.location.pathname);
      if (gmailParam === 'connected') {
        setTimeout(() => loadAll(), 1000);
      }
    }
    loadAll();
  }, []);

  // Reload when filter changes
  useEffect(() => {
    if (!loading) loadInvoices(filter.category, filter.verified);
  }, [filter]);

  const connectGmail = async () => {
    try {
      const res = await fetch(`${API}/api/auth/google`);
      const data = await res.json();
      window.location.href = data.url;
    } catch (err) { console.error(err); }
  };

  const scan = async () => {
    setScanning(true); setScanResult(null);
    try {
      const res = await fetch(`${API}/api/invoices/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      setScanResult(data);
      if (data.success) await loadAll();
    } catch (err) { setScanResult({ success: false, error: err.message }); }
    finally { setScanning(false); }
  };

  const verify = async (id) => {
    await fetch(`${API}/api/invoices/${id}/verify`, { method: 'PATCH' });
    setInvoices(prev => prev.map(inv => inv.id === id ? { ...inv, category_verified: 'verified' } : inv));
  };

  const saveEdit = async (id) => {
    await fetch(`${API}/api/invoices/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: editCategory, notes: editNotes })
    });
    setInvoices(prev => prev.map(inv => inv.id === id ? { ...inv, category: editCategory, notes: editNotes, category_verified: 'corrected' } : inv));
    setEditingId(null);
  };

  const exportCSV = () => window.open(`${API}/api/invoices/export/csv`, '_blank');

  const pendingCount = invoices.filter(i => i.category_verified === 'pending').length;

  return (
    <div>
      {/* Header tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { id: 'invoices', label: '📋 Factures' },
          { id: 'stats', label: '📊 Stats' },
          { id: 'settings', label: '⚙️ Paramètres' }
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            padding: '7px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
            border: '0.5px solid', borderColor: activeTab === tab.id ? '#378ADD' : '#1e2130',
            background: activeTab === tab.id ? '#0d1f35' : 'transparent',
            color: activeTab === tab.id ? '#378ADD' : '#555'
          }}>
            {tab.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {pendingCount > 0 && (
            <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, background: '#1a1a2b', color: '#378ADD' }}>
              {pendingCount} à valider
            </span>
          )}
          <button onClick={exportCSV} style={{ padding: '7px 14px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 12 }}>
            ↓ Export CSV
          </button>
          {gmailStatus.connected && (
            <button onClick={scan} disabled={scanning} style={{
              padding: '7px 16px', borderRadius: 6, border: 'none',
              cursor: scanning ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500,
              background: scanning ? '#1e2130' : '#378ADD', color: scanning ? '#555' : '#fff'
            }}>
              {scanning ? 'Scan en cours...' : '↺ Scanner Gmail'}
            </button>
          )}
        </div>
      </div>

      {/* Gmail connection banner */}
      {!gmailStatus.connected && (
        <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '20px 24px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 500, color: '#fff', marginBottom: 4 }}>📧 Connecte ton Gmail</div>
            <div style={{ fontSize: 13, color: '#555' }}>Autorise MitchBI à scanner tes emails pour trouver les factures PDF</div>
          </div>
          <button onClick={connectGmail} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
            Connecter Gmail →
          </button>
        </div>
      )}

      {/* Gmail connected banner */}
      {gmailStatus.connected && (
        <div style={{ background: '#0d2b1a', borderRadius: 8, border: '0.5px solid #1e2130', padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          <span style={{ color: '#1D9E75' }}>✅ Gmail connecté</span>
          <span style={{ color: '#444' }}>{gmailStatus.email}</span>
          {settings?.last_scan_at && (
            <span style={{ color: '#444' }}>Dernier scan : {new Date(settings.last_scan_at).toLocaleString('fr-CA')}</span>
          )}
          {settings?.next_scan_at && (
            <span style={{ color: '#444', marginLeft: 'auto' }}>Prochain : {new Date(settings.next_scan_at).toLocaleString('fr-CA')}</span>
          )}
        </div>
      )}

      {/* Scan result */}
      {scanResult && (
        <div style={{ padding: '12px 16px', borderRadius: 8, marginBottom: 16, background: scanResult.success ? '#0d2b1a' : '#2b0d0d', color: scanResult.success ? '#1D9E75' : '#D85A30', fontSize: 13 }}>
          {scanResult.success
            ? `✅ Scan terminé — ${scanResult.processed} nouvelles factures, ${scanResult.skipped} ignorées sur ${scanResult.total} emails`
            : `❌ ${scanResult.error}`}
        </div>
      )}

      {/* INVOICES TAB */}
      {activeTab === 'invoices' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <select value={filter.category} onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}
              style={{ padding: '6px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#13151f', color: filter.category ? '#fff' : '#555', fontSize: 13 }}>
              <option value="">Toutes les catégories</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filter.verified} onChange={e => setFilter(f => ({ ...f, verified: e.target.value }))}
              style={{ padding: '6px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#13151f', color: filter.verified ? '#fff' : '#555', fontSize: 13 }}>
              <option value="">Tous les statuts</option>
              <option value="pending">À valider</option>
              <option value="verified">Vérifiés</option>
              <option value="corrected">Corrigés</option>
            </select>
          </div>

          {loading ? (
            <div style={{ color: '#444', fontSize: 13, padding: 20 }}>Chargement...</div>
          ) : invoices.length === 0 ? (
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 48, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✉️</div>
              <div style={{ color: '#555', marginBottom: 8 }}>Aucune facture trouvée</div>
              <div style={{ fontSize: 12, color: '#333' }}>Connecte Gmail et lance un scan pour commencer</div>
            </div>
          ) : (
            <div style={{ border: '0.5px solid #1e2130', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#13151f' }}>
                    {['Date', 'Expéditeur', 'Sujet', 'Montant', 'Catégorie', 'Statut', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 500, fontSize: 12, color: '#555', borderBottom: '0.5px solid #1e2130' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <tr key={inv.id} style={{ borderBottom: '0.5px solid #1e2130' }}>
                      <td style={{ padding: '10px 14px', color: '#888', whiteSpace: 'nowrap' }}>
                        {inv.received_at ? new Date(inv.received_at).toLocaleDateString('fr-CA') : '—'}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ color: '#fff' }}>{inv.sender_name || inv.sender_email}</div>
                        <div style={{ fontSize: 11, color: '#444' }}>{inv.sender_email}</div>
                      </td>
                      <td style={{ padding: '10px 14px', color: '#888', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {inv.subject}
                      </td>
                      <td style={{ padding: '10px 14px', color: '#fff', whiteSpace: 'nowrap', fontWeight: 500 }}>
                        {inv.amount ? `${inv.amount} ${inv.currency}` : '—'}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {editingId === inv.id ? (
                          <select value={editCategory} onChange={e => setEditCategory(e.target.value)}
                            style={{ padding: '4px 8px', borderRadius: 4, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 12 }}>
                            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        ) : (
                          <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: `${CATEGORY_COLORS[inv.category]}22`, color: CATEGORY_COLORS[inv.category] || '#555' }}>
                            {inv.category}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <StatusBadge status={inv.category_verified} />
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {editingId === inv.id ? (
                            <>
                              <button onClick={() => saveEdit(inv.id)} style={{ padding: '3px 10px', borderRadius: 4, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 11 }}>Sauver</button>
                              <button onClick={() => setEditingId(null)} style={{ padding: '3px 10px', borderRadius: 4, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 11 }}>Annuler</button>
                            </>
                          ) : (
                            <>
                              {inv.category_verified === 'pending' && (
                                <button onClick={() => verify(inv.id)} style={{ padding: '3px 10px', borderRadius: 4, border: 'none', background: '#0d2b1a', color: '#1D9E75', cursor: 'pointer', fontSize: 11 }}>✅ Valider</button>
                              )}
                              <button onClick={() => { setEditingId(inv.id); setEditCategory(inv.category); setEditNotes(inv.notes || ''); }}
                                style={{ padding: '3px 10px', borderRadius: 4, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 11 }}>✏️ Éditer</button>
                              {inv.drive_file_url && (
                                <a href={inv.drive_file_url} target="_blank" rel="noreferrer"
                                  style={{ padding: '3px 10px', borderRadius: 4, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 11, textDecoration: 'none' }}>📄 PDF</a>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* STATS TAB */}
      {activeTab === 'stats' && (
        <div>
          {stats ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Total factures', value: stats.count, color: '#fff' },
                  { label: 'Total dépenses', value: `$${(stats.total || 0).toFixed(2)}`, color: '#fff' },
                  { label: 'À valider', value: stats.pending, color: '#E8A838' },
                ].map(kpi => (
                  <div key={kpi.label} style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '14px 18px' }}>
                    <div style={{ fontSize: 11, color: '#444', marginBottom: 6, textTransform: 'uppercase' }}>{kpi.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 600, color: kpi.color }}>{kpi.value}</div>
                  </div>
                ))}
              </div>
              <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '0.5px solid #1e2130', fontSize: 14, fontWeight: 500, color: '#fff' }}>Par catégorie</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#0f1117' }}>
                      {['Catégorie', 'Factures', 'Total', '% du total'].map(h => (
                        <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontWeight: 500, fontSize: 12, color: '#555', borderBottom: '0.5px solid #1e2130' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stats.byCategory || {}).sort((a, b) => b[1].total - a[1].total).map(([cat, d]) => (
                      <tr key={cat} style={{ borderBottom: '0.5px solid #1e2130' }}>
                        <td style={{ padding: '10px 16px' }}>
                          <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: `${CATEGORY_COLORS[cat]}22`, color: CATEGORY_COLORS[cat] || '#555' }}>{cat}</span>
                        </td>
                        <td style={{ padding: '10px 16px', color: '#ccc' }}>{d.count}</td>
                        <td style={{ padding: '10px 16px', color: '#fff', fontWeight: 500 }}>${d.total.toFixed(2)}</td>
                        <td style={{ padding: '10px 16px', color: '#555' }}>{stats.total ? ((d.total / stats.total) * 100).toFixed(1) : 0}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : <div style={{ color: '#444', fontSize: 13 }}>Aucune donnée disponible</div>}
        </div>
      )}

      {/* SETTINGS TAB */}
      {activeTab === 'settings' && (
        <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 24, maxWidth: 500 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 20 }}>Paramètres Invoice Manager</div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 8 }}>Fréquence de scan automatique</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[1, 2, 4, 8, 12, 24].map(h => (
                <button key={h} onClick={() => setSettings(s => ({ ...s, scan_interval_hours: h }))} style={{
                  padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                  border: '0.5px solid', borderColor: settings.scan_interval_hours === h ? '#378ADD' : '#1e2130',
                  background: settings.scan_interval_hours === h ? '#0d1f35' : 'transparent',
                  color: settings.scan_interval_hours === h ? '#378ADD' : '#555'
                }}>
                  {h}h
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 8 }}>Scanner depuis le</label>
            <input type="date" defaultValue="2025-01-01"
              style={{ padding: '8px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 13 }} />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 8 }}>Compte Gmail</label>
            {gmailStatus.connected ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: '#1D9E75', fontSize: 13 }}>✅ {gmailStatus.email}</span>
                <button onClick={connectGmail} style={{ padding: '4px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 12 }}>
                  Reconnecter
                </button>
              </div>
            ) : (
              <button onClick={connectGmail} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Connecter Gmail
              </button>
            )}
          </div>

          <div style={{ padding: '12px 16px', borderRadius: 8, background: '#0f1117', border: '0.5px solid #1e2130', fontSize: 12, color: '#444' }}>
            <div style={{ marginBottom: 4 }}>📁 Google Drive : <span style={{ color: '#555' }}>MitchBI - Factures/</span></div>
            <div>🕐 Prochain scan : <span style={{ color: '#555' }}>{settings?.next_scan_at ? new Date(settings.next_scan_at).toLocaleString('fr-CA') : 'Non planifié'}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
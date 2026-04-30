import { useState, useEffect, useCallback } from 'react';

const STATUS_CONFIG = {
  pending_review: { bg: '#1a1a2b', text: '#378ADD', label: '⏳ À valider' },
  classified:     { bg: '#0d2b1a', text: '#1D9E75', label: '✅ Classifié' },
  not_invoice:    { bg: '#2b2b0d', text: '#888',    label: '🚫 Pas une facture' },
  rejected:       { bg: '#2b0d0d', text: '#D85A30', label: '🗑 Supprimé' },
};

const StatusBadge = ({ status }) => {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.pending_review;
  return <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: c.bg, color: c.text, whiteSpace: 'nowrap' }}>{c.label}</span>;
};

const ConfidenceBadge = ({ score }) => {
  const color = score >= 80 ? '#1D9E75' : score >= 50 ? '#E8A838' : '#D85A30';
  return <span style={{ fontSize: 11, color, marginLeft: 4 }}>{score}%</span>;
};

export default function Invoices({ session }) {
  const [drafts, setDrafts] = useState([]);
  const [stats, setStats] = useState(null);
  const [categories, setCategories] = useState([]);
  const [gmailStatus, setGmailStatus] = useState({ connected: false });
  const [settings, setSettings] = useState({ scan_interval_hours: 4 });
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [activeTab, setActiveTab] = useState('drafts');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [showScanOptions, setShowScanOptions] = useState(false);
  const [scanDates, setScanDates] = useState({ from: '', to: '' });
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});
  const [classifying, setClassifying] = useState(null);
  // New category modal
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCat, setNewCat] = useState({ name: '', color: '#378ADD', icon: '📄', keywords: '' });

  const API = import.meta.env.VITE_API_URL;

  const loadCategories = useCallback(async () => {
    const res = await fetch(`${API}/api/invoices/categories`);
    const data = await res.json();
    if (data.success) setCategories(data.categories);
  }, [API]);

  const loadDrafts = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterStatus) params.append('status', filterStatus);
    if (filterCategory) params.append('category', filterCategory);
    const res = await fetch(`${API}/api/invoices/drafts?${params}&limit=500`);
    const data = await res.json();
    if (data.success) setDrafts(data.drafts);
  }, [API, filterStatus, filterCategory]);

  const loadStats = useCallback(async () => {
    const res = await fetch(`${API}/api/invoices/stats`);
    const data = await res.json();
    if (data.success) setStats(data);
  }, [API]);

  const loadGmailStatus = useCallback(async () => {
    const res = await fetch(`${API}/api/auth/google/status`);
    const data = await res.json();
    setGmailStatus(data);
    if (data.settings) setSettings(data.settings);
  }, [API]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadDrafts(), loadStats(), loadGmailStatus(), loadCategories()]);
    setLoading(false);
  }, [loadDrafts, loadStats, loadGmailStatus, loadCategories]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail') === 'connected') {
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(loadAll, 1000);
    }
    loadAll();
  }, []);

  useEffect(() => { if (!loading) loadDrafts(); }, [filterStatus, filterCategory]);

  const connectGmail = async () => {
    const res = await fetch(`${API}/api/auth/google`);
    const data = await res.json();
    window.location.href = data.url;
  };

  const scan = async (dateFrom, dateTo) => {
    setScanning(true); setScanResult(null); setShowScanOptions(false);
    try {
      const res = await fetch(`${API}/api/invoices/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo })
      });
      const data = await res.json();
      setScanResult(data);
      if (data.success) await loadAll();
    } catch (err) { setScanResult({ success: false, error: err.message }); }
    finally { setScanning(false); }
  };

  const scanIncremental = () => {
    const from = settings?.last_scan_at?.split('T')[0] || '2025-01-01';
    scan(from, null);
  };

  const updateDraft = async (id, updates) => {
    await fetch(`${API}/api/invoices/drafts/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
    setEditingId(null);
  };

  const classifyDraft = async (id) => {
    setClassifying(id);
    try {
      const res = await fetch(`${API}/api/invoices/drafts/${id}/classify`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setDrafts(prev => prev.map(d => d.id === id ? data.draft : d));
        await loadStats();
      }
    } catch (err) { console.error(err); }
    finally { setClassifying(null); }
  };

  const deleteDraft = async (id) => {
    if (!confirm('Supprimer cette entrée ?')) return;
    await fetch(`${API}/api/invoices/drafts/${id}`, { method: 'DELETE' });
    setDrafts(prev => prev.filter(d => d.id !== id));
    await loadStats();
  };

  const markNotInvoice = async (id) => {
    await updateDraft(id, { status: 'not_invoice', final_category: 'Pas une facture' });
  };

  const createCategory = async () => {
    const keywords = newCat.keywords.split(',').map(k => k.trim()).filter(Boolean);
    const res = await fetch(`${API}/api/invoices/categories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newCat, keywords })
    });
    const data = await res.json();
    if (data.success) {
      await loadCategories();
      setShowNewCat(false);
      setNewCat({ name: '', color: '#378ADD', icon: '📄', keywords: '' });
    }
  };

  const exportCSV = () => window.open(`${API}/api/invoices/export/csv`, '_blank');

  const getCatColor = (name) => categories.find(c => c.name === name)?.color || '#555';

  const pendingCount = drafts.filter(d => d.status === 'pending_review').length;

  return (
    <div>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          { id: 'drafts', label: `📋 Factures${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
          { id: 'stats', label: '📊 Stats' },
          { id: 'categories', label: '🏷 Catégories' },
          { id: 'settings', label: '⚙️ Paramètres' },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            padding: '7px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
            border: '0.5px solid', borderColor: activeTab === tab.id ? '#378ADD' : '#1e2130',
            background: activeTab === tab.id ? '#0d1f35' : 'transparent',
            color: activeTab === tab.id ? '#378ADD' : '#555'
          }}>{tab.label}</button>
        ))}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={exportCSV} style={{ padding: '7px 14px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 12 }}>
            ↓ Export CSV
          </button>
          {gmailStatus.connected && (
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex' }}>
                <button onClick={scanIncremental} disabled={scanning} style={{
                  padding: '7px 14px', borderRadius: '6px 0 0 6px', border: 'none',
                  cursor: scanning ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500,
                  background: scanning ? '#1e2130' : '#378ADD', color: scanning ? '#555' : '#fff'
                }}>
                  {scanning ? '⏳ Scan...' : '↺ Scanner'}
                </button>
                <button onClick={() => setShowScanOptions(!showScanOptions)} disabled={scanning} style={{
                  padding: '7px 10px', borderRadius: '0 6px 6px 0', border: 'none', borderLeft: '1px solid #2a5a8c',
                  cursor: 'pointer', fontSize: 12, background: '#2a6aad', color: '#fff'
                }}>▾</button>
              </div>

              {showScanOptions && (
                <div style={{
                  position: 'absolute', right: 0, top: '110%', zIndex: 200,
                  background: '#13151f', border: '0.5px solid #1e2130', borderRadius: 8,
                  padding: 16, width: 280, boxShadow: '0 8px 30px rgba(0,0,0,0.6)'
                }}>
                  <div style={{ fontSize: 13, color: '#fff', fontWeight: 500, marginBottom: 12 }}>Options de scan</div>
                  <button onClick={scanIncremental} style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6, border: '0.5px solid #1e2130',
                    background: '#0d1f35', color: '#378ADD', cursor: 'pointer', fontSize: 13, textAlign: 'left', marginBottom: 10
                  }}>
                    ↺ Scan incrémental
                    <div style={{ fontSize: 11, color: '#444', marginTop: 2 }}>
                      Depuis : {settings?.last_scan_at ? new Date(settings.last_scan_at).toLocaleDateString('fr-CA') : '2025-01-01'}
                    </div>
                  </button>
                  <div style={{ borderTop: '0.5px solid #1e2130', paddingTop: 10 }}>
                    <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Période personnalisée</div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: '#555', marginBottom: 3 }}>Du</div>
                        <input type="date" value={scanDates.from} onChange={e => setScanDates(d => ({ ...d, from: e.target.value }))}
                          style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 12, boxSizing: 'border-box' }} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: '#555', marginBottom: 3 }}>Au</div>
                        <input type="date" value={scanDates.to} onChange={e => setScanDates(d => ({ ...d, to: e.target.value }))}
                          style={{ width: '100%', padding: '5px 8px', borderRadius: 5, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 12, boxSizing: 'border-box' }} />
                      </div>
                    </div>
                    <button onClick={() => { scan(scanDates.from, scanDates.to || null); }} disabled={!scanDates.from} style={{
                      width: '100%', padding: '7px', borderRadius: 5, border: 'none',
                      background: scanDates.from ? '#378ADD' : '#1e2130',
                      color: scanDates.from ? '#fff' : '#555',
                      cursor: scanDates.from ? 'pointer' : 'not-allowed', fontSize: 13
                    }}>Scanner cette période</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Gmail banner */}
      {!gmailStatus.connected && (
        <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '20px 24px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 500, color: '#fff', marginBottom: 4 }}>📧 Connecte ton Gmail</div>
            <div style={{ fontSize: 13, color: '#555' }}>Autorise MitchBI à scanner tes emails pour trouver les factures</div>
          </div>
          <button onClick={connectGmail} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
            Connecter Gmail →
          </button>
        </div>
      )}

      {gmailStatus.connected && (
        <div style={{ background: '#0d2b1a', borderRadius: 8, padding: '8px 16px', marginBottom: 16, display: 'flex', gap: 16, fontSize: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: '#1D9E75' }}>✅ {gmailStatus.email}</span>
          {settings?.last_scan_at && <span style={{ color: '#444' }}>Dernier scan : {new Date(settings.last_scan_at).toLocaleString('fr-CA')}</span>}
          {settings?.next_scan_at && <span style={{ color: '#444', marginLeft: 'auto' }}>Prochain : {new Date(settings.next_scan_at).toLocaleString('fr-CA')}</span>}
        </div>
      )}

      {scanResult && (
        <div style={{ padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13, background: scanResult.success ? '#0d2b1a' : '#2b0d0d', color: scanResult.success ? '#1D9E75' : '#D85A30' }}>
          {scanResult.success
            ? `✅ Scan terminé — ${scanResult.processed} nouveaux emails, ${scanResult.skipped} déjà vus, ${scanResult.errors} erreurs`
            : `❌ ${scanResult.error}`}
        </div>
      )}

      {/* DRAFTS TAB */}
      {activeTab === 'drafts' && (
        <div>
          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#13151f', color: filterStatus ? '#fff' : '#555', fontSize: 12 }}>
              <option value="">Tous les statuts</option>
              <option value="pending_review">À valider</option>
              <option value="classified">Classifiés</option>
              <option value="not_invoice">Pas une facture</option>
            </select>
            <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#13151f', color: filterCategory ? '#fff' : '#555', fontSize: 12 }}>
              <option value="">Toutes les catégories</option>
              {categories.map(c => <option key={c.id} value={c.name}>{c.icon} {c.name}</option>)}
            </select>
            <span style={{ fontSize: 12, color: '#444', marginLeft: 'auto' }}>{drafts.length} entrée{drafts.length !== 1 ? 's' : ''}</span>
          </div>

          {loading ? (
            <div style={{ color: '#444', fontSize: 13, padding: 20 }}>Chargement...</div>
          ) : drafts.length === 0 ? (
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 48, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✉️</div>
              <div style={{ color: '#555' }}>Aucune facture trouvée</div>
              <div style={{ fontSize: 12, color: '#333', marginTop: 4 }}>Lance un scan pour commencer</div>
            </div>
          ) : (
            <div style={{ border: '0.5px solid #1e2130', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#13151f' }}>
                    {['Date', 'Expéditeur', 'Sujet', 'Type', 'Catégorie suggérée', 'Montant', 'Statut', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontWeight: 500, fontSize: 11, color: '#555', borderBottom: '0.5px solid #1e2130', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {drafts.map(draft => (
                    <tr key={draft.id} style={{ borderBottom: '0.5px solid #1e2130', background: draft.status === 'not_invoice' ? '#111' : 'transparent' }}>
                      <td style={{ padding: '9px 12px', color: '#888', whiteSpace: 'nowrap' }}>
                        {draft.received_at ? new Date(draft.received_at).toLocaleDateString('fr-CA') : '—'}
                      </td>
                      <td style={{ padding: '9px 12px', maxWidth: 150 }}>
                        <div style={{ color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{draft.suggested_vendor_name || draft.sender_name}</div>
                        <div style={{ fontSize: 10, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{draft.sender_email}</div>
                      </td>
                      <td style={{ padding: '9px 12px', maxWidth: 160 }}>
                        <div style={{ color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{draft.subject}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                          {draft.gmail_url && (
                            <a href={draft.gmail_url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: '#378ADD', textDecoration: 'none' }}>📧 Email</a>
                          )}
                          {draft.drive_file_url && (
                            <a href={draft.drive_file_url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: '#1D9E75', textDecoration: 'none' }}>📄 PDF</a>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#1a1d27', color: '#555' }}>
                          {draft.has_pdf ? '📎 PDF' : '📧 Email'}
                        </span>
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        {editingId === draft.id ? (
                          <select value={editData.final_category} onChange={e => setEditData(d => ({ ...d, final_category: e.target.value }))}
                            style={{ padding: '3px 6px', borderRadius: 4, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 11 }}>
                            {categories.map(c => <option key={c.id} value={c.name}>{c.icon} {c.name}</option>)}
                          </select>
                        ) : (
                          <div>
                            <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 3, background: `${getCatColor(draft.final_category)}22`, color: getCatColor(draft.final_category) }}>
                              {draft.final_category}
                            </span>
                            <ConfidenceBadge score={draft.confidence_score} />
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        {editingId === draft.id ? (
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input type="number" value={editData.final_amount || ''} onChange={e => setEditData(d => ({ ...d, final_amount: e.target.value }))}
                              placeholder="0.00" style={{ width: 70, padding: '3px 6px', borderRadius: 4, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 11 }} />
                            <select value={editData.final_currency} onChange={e => setEditData(d => ({ ...d, final_currency: e.target.value }))}
                              style={{ padding: '3px 4px', borderRadius: 4, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 11 }}>
                              {['USD', 'CAD', 'EUR'].map(c => <option key={c}>{c}</option>)}
                            </select>
                          </div>
                        ) : (
                          <span style={{ color: '#fff', fontWeight: 500 }}>
                            {draft.final_amount ? `${draft.final_amount} ${draft.final_currency}` : <span style={{ color: '#444' }}>—</span>}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        <StatusBadge status={draft.status} />
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {editingId === draft.id ? (
                            <>
                              <button onClick={() => updateDraft(draft.id, editData)} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 11 }}>💾</button>
                              <button onClick={() => setEditingId(null)} style={{ padding: '3px 8px', borderRadius: 4, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 11 }}>✕</button>
                            </>
                          ) : (
                            <>
                              {draft.status === 'pending_review' && (
                                <>
                                  <button onClick={() => classifyDraft(draft.id)} disabled={classifying === draft.id} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#0d2b1a', color: '#1D9E75', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}>
                                    {classifying === draft.id ? '...' : '✅ Classifier'}
                                  </button>
                                  <button onClick={() => markNotInvoice(draft.id)} style={{ padding: '3px 8px', borderRadius: 4, border: '0.5px solid #1e2130', background: 'transparent', color: '#888', cursor: 'pointer', fontSize: 11 }}>🚫</button>
                                </>
                              )}
                              <button onClick={() => { setEditingId(draft.id); setEditData({ final_category: draft.final_category, final_amount: draft.final_amount, final_currency: draft.final_currency || 'USD' }); }}
                                style={{ padding: '3px 8px', borderRadius: 4, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 11 }}>✏️</button>
                              <button onClick={() => deleteDraft(draft.id)} style={{ padding: '3px 8px', borderRadius: 4, border: '0.5px solid #2b0d0d', background: 'transparent', color: '#D85A30', cursor: 'pointer', fontSize: 11 }}>🗑</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        </div>
          )}
        </div>
      )}

      {/* STATS TAB */}
      {activeTab === 'stats' && stats && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
            {[
              { label: 'Total scannés', value: stats.count },
              { label: 'À valider', value: stats.byStatus?.pending_review || 0, color: '#378ADD' },
              { label: 'Classifiés', value: stats.byStatus?.classified || 0, color: '#1D9E75' },
              { label: 'Pas une facture', value: stats.byStatus?.not_invoice || 0, color: '#888' },
              { label: 'Total dépenses', value: `$${(stats.total || 0).toFixed(2)}` },
            ].map(kpi => (
              <div key={kpi.label} style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: '14px 18px' }}>
                <div style={{ fontSize: 11, color: '#444', marginBottom: 6, textTransform: 'uppercase' }}>{kpi.label}</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: kpi.color || '#fff' }}>{kpi.value}</div>
              </div>
            ))}
          </div>
          {Object.keys(stats.byCategory || {}).length > 0 && (
            <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '0.5px solid #1e2130', fontSize: 14, fontWeight: 500, color: '#fff' }}>Par catégorie (classifiés)</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#0f1117' }}>
                    {['Catégorie', 'Factures', 'Total', '% du total'].map(h => (
                      <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontWeight: 500, fontSize: 12, color: '#555', borderBottom: '0.5px solid #1e2130' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(stats.byCategory).sort((a, b) => b[1].total - a[1].total).map(([cat, d]) => (
                    <tr key={cat} style={{ borderBottom: '0.5px solid #1e2130' }}>
                      <td style={{ padding: '10px 16px' }}>
                        <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: `${getCatColor(cat)}22`, color: getCatColor(cat) }}>{cat}</span>
                      </td>
                      <td style={{ padding: '10px 16px', color: '#ccc' }}>{d.count}</td>
                      <td style={{ padding: '10px 16px', color: '#fff', fontWeight: 500 }}>${d.total.toFixed(2)}</td>
                      <td style={{ padding: '10px 16px', color: '#555' }}>{stats.total ? ((d.total / stats.total) * 100).toFixed(1) : 0}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* CATEGORIES TAB */}
      {activeTab === 'categories' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: '#555' }}>Gérer les catégories de classification</div>
            <button onClick={() => setShowNewCat(true)} style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 13 }}>
              + Nouvelle catégorie
            </button>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {categories.map(cat => (
              <div key={cat.id} style={{ background: '#13151f', borderRadius: 8, border: '0.5px solid #1e2130', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 20 }}>{cat.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 500, color: cat.color || '#fff' }}>{cat.name}</span>
                    <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: `${cat.color}22`, color: cat.color }}>{cat.color}</span>
                  </div>
                  {cat.keywords?.length > 0 && (
                    <div style={{ fontSize: 11, color: '#444', marginTop: 3 }}>
                      Mots-clés : {cat.keywords.join(', ')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* New category modal */}
          {showNewCat && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
              <div style={{ background: '#13151f', borderRadius: 12, border: '0.5px solid #1e2130', padding: 28, width: '100%', maxWidth: 460 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 20 }}>Nouvelle catégorie</div>
                {[
                  { label: 'Nom *', key: 'name', placeholder: 'ex: Impôts & Taxes' },
                  { label: 'Icône', key: 'icon', placeholder: '📄' },
                  { label: 'Couleur (hex)', key: 'color', placeholder: '#378ADD' },
                  { label: 'Mots-clés (séparés par virgule)', key: 'keywords', placeholder: 'revenu québec, impot, taxe' },
                ].map(field => (
                  <div key={field.key} style={{ marginBottom: 14 }}>
                    <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 5 }}>{field.label}</label>
                    <input value={newCat[field.key]} onChange={e => setNewCat(n => ({ ...n, [field.key]: e.target.value }))}
                      placeholder={field.placeholder}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
                  <button onClick={() => setShowNewCat(false)} style={{ padding: '8px 18px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 13 }}>Annuler</button>
                  <button onClick={createCategory} disabled={!newCat.name} style={{ padding: '8px 18px', borderRadius: 6, border: 'none', background: newCat.name ? '#378ADD' : '#1e2130', color: newCat.name ? '#fff' : '#555', cursor: newCat.name ? 'pointer' : 'not-allowed', fontSize: 13 }}>Créer</button>
                </div>
              </div>
            </div>
          )}
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
                }}>{h}h</button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 8 }}>Compte Gmail</label>
            {gmailStatus.connected ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: '#1D9E75', fontSize: 13 }}>✅ {gmailStatus.email}</span>
                <button onClick={connectGmail} style={{ padding: '4px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 12 }}>Reconnecter</button>
              </div>
            ) : (
              <button onClick={connectGmail} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 13 }}>Connecter Gmail</button>
            )}
          </div>
          <div style={{ padding: '12px 16px', borderRadius: 8, background: '#0f1117', border: '0.5px solid #1e2130', fontSize: 12, color: '#444' }}>
            <div style={{ marginBottom: 4 }}>📁 Drive : <span style={{ color: '#555' }}>MitchBI - Factures/</span></div>
            <div style={{ marginBottom: 4 }}>🕐 Dernier scan : <span style={{ color: '#555' }}>{settings?.last_scan_at ? new Date(settings.last_scan_at).toLocaleString('fr-CA') : 'Jamais'}</span></div>
            <div>⏭ Prochain : <span style={{ color: '#555' }}>{settings?.next_scan_at ? new Date(settings.next_scan_at).toLocaleString('fr-CA') : 'Non planifié'}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
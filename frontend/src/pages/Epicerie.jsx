import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../services/api';

const BLUE = '#378ADD';
const GREEN = '#1D9E75';
const RED = '#D85A30';
const GOLD = '#E8A838';
const MUTED = '#8b93a5';

const card = { background: '#1a1d27', borderRadius: 12, border: '0.5px solid #1e2130', padding: 20 };
const label = { fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 };
const input = {
  background: '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6, color: '#fff',
  padding: '7px 10px', fontSize: 13, outline: 'none',
};
const btn = (bg) => ({
  background: bg, border: 'none', borderRadius: 6, color: '#fff', padding: '7px 14px',
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
});
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '0.5px solid #1e2130' };
const td = { padding: '8px 10px', fontSize: 13, color: '#ddd', borderBottom: '0.5px solid #1e2130' };

const TABS = [
  { id: 'config', label: 'Config' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'orders', label: 'Commandes' },
  { id: 'next-order', label: 'Prochaine commande' },
];

export default function Epicerie({ activeTab = 'dashboard', onTabChange }) {
  return (
    <div>
      {/* Onglets -- redondants avec la sidebar mais utiles si on arrive ici sans passer par elle */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '0.5px solid #1e2130' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTabChange?.(t.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 16px', fontSize: 13,
              color: activeTab === t.id ? '#fff' : MUTED,
              borderBottom: activeTab === t.id ? `2px solid ${BLUE}` : '2px solid transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'config' && <ConfigTab />}
      {activeTab === 'dashboard' && <DashboardTab />}
      {activeTab === 'orders' && <OrdersTab />}
      {activeTab === 'next-order' && <NextOrderTab />}
    </div>
  );
}

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

function ConfigTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [thresholdInput, setThresholdInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [tokenExpiresInput, setTokenExpiresInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [newRule, setNewRule] = useState({ article_number: '', blacklisted: true, notes: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/epicerie/config');
      const json = await res.json();
      if (json.success) {
        setData(json);
        const threshold = json.config.find((c) => c.key === 'list_frequency_threshold');
        setThresholdInput(threshold ? String(Math.round(parseFloat(threshold.value) * 100)) : '15');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveThreshold = async () => {
    setSaving(true);
    try {
      const value = (parseFloat(thresholdInput) / 100).toString();
      await apiFetch('/api/epicerie/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'list_frequency_threshold', value }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const saveHousehold = async (patch) => {
    setSaving(true);
    try {
      const current = data?.household || {};
      await apiFetch('/api/epicerie/household-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eliane_present_week: current.eliane_present_week || false,
          julie_present_week: current.julie_present_week || false,
          next_pattern_date: current.next_pattern_date || null,
          ...patch,
        }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const saveToken = async () => {
    if (!tokenInput.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim(), expires_at: tokenExpiresInput || null }),
      });
      setTokenInput('');
      setTokenExpiresInput('');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const toggleBlacklist = async (rule) => {
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article_number: rule.article_number, blacklisted: !rule.blacklisted, preferred_qty: rule.preferred_qty, notes: rule.notes }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const addRule = async () => {
    if (!newRule.article_number.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newRule),
      });
      setNewRule({ article_number: '', blacklisted: true, notes: '' });
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ color: MUTED, fontSize: 13 }}>Chargement...</div>;

  const household = data?.household || {};
  const token = data?.token || { present: false };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      {/* Seuil de generation */}
      <div style={card}>
        <div style={label}>Seuil de fréquence — liste hebdomadaire</div>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>
          Un produit entre automatiquement dans la liste s'il apparaît dans au moins ce % des commandes passées.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input style={{ ...input, width: 70 }} type="number" min="1" max="100" value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)} />
          <span style={{ color: MUTED, fontSize: 13 }}>%</span>
          <button style={btn(BLUE)} onClick={saveThreshold} disabled={saving}>Sauvegarder</button>
        </div>
      </div>

      {/* Presence Eliane/Julie */}
      <div style={card}>
        <div style={label}>Présence cette semaine</div>
        <div style={{ display: 'flex', gap: 24, marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ddd', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!household.eliane_present_week}
              onChange={(e) => saveHousehold({ eliane_present_week: e.target.checked })} />
            Éliane présente
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ddd', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!household.julie_present_week}
              onChange={(e) => saveHousehold({ julie_present_week: e.target.checked })} />
            Julie présente
          </label>
        </div>
      </div>

      {/* Token Maxi */}
      <div style={card}>
        <div style={label}>Token Maxi (session)</div>
        {token.present ? (
          <p style={{ fontSize: 12, margin: '0 0 12px' }}>
            <span style={{ color: token.expired ? RED : GREEN }}>{token.expired ? '⚠ Expiré' : '✓ Valide'}</span>
            <span style={{ color: MUTED }}> — capturé {token.captured_at ? new Date(token.captured_at).toLocaleString('fr-CA') : '—'}
              {token.expires_at ? `, expire ${new Date(token.expires_at).toLocaleString('fr-CA')}` : ''}</span>
          </p>
        ) : (
          <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>Aucun token enregistré.</p>
        )}
        <p style={{ fontSize: 11, color: MUTED, margin: '0 0 8px' }}>
          F12 → Application → Cookies → maxi.ca → copier la valeur de <code>AccessToken</code>
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea style={{ ...input, minHeight: 60, fontFamily: 'monospace', fontSize: 11 }}
            placeholder="Coller le token ici"
            value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={input} type="datetime-local" value={tokenExpiresInput}
              onChange={(e) => setTokenExpiresInput(e.target.value)} />
            <button style={btn(BLUE)} onClick={saveToken} disabled={saving || !tokenInput.trim()}>Sauvegarder le token</button>
          </div>
        </div>
      </div>

      {/* Blacklist / regles produit */}
      <div style={card}>
        <div style={label}>Règles produit (blacklist)</div>
        {(data?.rules || []).length === 0 && <p style={{ fontSize: 12, color: MUTED }}>Aucune règle configurée.</p>}
        {(data?.rules || []).map((r) => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '0.5px solid #1e2130' }}>
            <div>
              <div style={{ fontSize: 13, color: '#ddd' }}>{r.article_number}</div>
              {r.notes && <div style={{ fontSize: 11, color: MUTED }}>{r.notes}</div>}
            </div>
            <button style={btn(r.blacklisted ? RED : '#333')} onClick={() => toggleBlacklist(r)} disabled={saving}>
              {r.blacklisted ? 'Blacklisté' : 'Autorisé'}
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input style={{ ...input, flex: 1 }} placeholder="Numéro d'article (ex: 20026703001)"
            value={newRule.article_number} onChange={(e) => setNewRule({ ...newRule, article_number: e.target.value })} />
          <input style={{ ...input, flex: 1 }} placeholder="Note (optionnel)"
            value={newRule.notes} onChange={(e) => setNewRule({ ...newRule, notes: e.target.value })} />
          <button style={btn(BLUE)} onClick={addRule} disabled={saving || !newRule.article_number.trim()}>+ Blacklister</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------

function DashboardTab() {
  const [rows, setRows] = useState([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await apiFetch('/api/epicerie/dashboard/top-products?limit=50');
        const json = await res.json();
        if (json.success) { setRows(json.products); setTotalOrders(json.total_orders); }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ color: MUTED, fontSize: 13 }}>Chargement...</div>;

  return (
    <div style={card}>
      <div style={label}>Top 50 produits — basé sur {totalOrders} commandes</div>
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Produit</th>
              <th style={th}>Marque</th>
              <th style={th}>Commandes</th>
              <th style={th}>Fréquence</th>
              <th style={th}>Qté moyenne</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.article_number}>
                <td style={{ ...td, color: MUTED }}>{i + 1}</td>
                <td style={td}>{r.product_name}{r.is_weighted && <span style={{ color: MUTED }}> (au poids)</span>}</td>
                <td style={{ ...td, color: MUTED }}>{r.brand || '—'}</td>
                <td style={td}>{r.orders}</td>
                <td style={{ ...td, color: r.frequency_pct >= 30 ? GREEN : r.frequency_pct >= 15 ? GOLD : MUTED }}>{r.frequency_pct}%</td>
                <td style={td}>{r.avg_qty ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// LISTE DES COMMANDES
// ---------------------------------------------------------------------

function OrdersTab() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await apiFetch('/api/epicerie/orders?limit=100');
        const json = await res.json();
        if (json.success) setOrders(json.orders);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ color: MUTED, fontSize: 13 }}>Chargement...</div>;

  return (
    <div style={card}>
      <div style={label}>{orders.length} commandes</div>
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Date</th>
              <th style={th}>Magasin</th>
              <th style={th}>Type</th>
              <th style={th}>Items</th>
              <th style={th}>Total</th>
              <th style={th}>Points</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td style={td}>{new Date(o.order_date).toLocaleDateString('fr-CA')}</td>
                <td style={{ ...td, color: MUTED }}>{o.store_name || '—'}</td>
                <td style={td}>
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 4,
                    background: o.order_type === 'online' ? '#1a1a2b' : '#1a1d27',
                    color: o.order_type === 'online' ? BLUE : MUTED,
                  }}>
                    {o.order_type}
                  </span>
                </td>
                <td style={td}>{o.total_items ?? '—'}</td>
                <td style={td}>{o.total_price != null ? `${Number(o.total_price).toFixed(2)}$` : '—'}</td>
                <td style={{ ...td, color: MUTED }}>{o.points_earned ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// PROCHAINE COMMANDE (editable)
// ---------------------------------------------------------------------

function NextOrderTab() {
  const [weekOf, setWeekOf] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newItem, setNewItem] = useState({ article_number: '', product_name: '', quantity: 1 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/epicerie/next-order');
      const json = await res.json();
      if (json.success) { setWeekOf(json.week_of); setItems(json.items); }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateQty = async (id, quantity) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, quantity } : it)));
    await apiFetch(`/api/epicerie/next-order/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    });
  };

  const removeItem = async (id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    await apiFetch(`/api/epicerie/next-order/${id}`, { method: 'DELETE' });
  };

  const addItem = async () => {
    if (!newItem.article_number.trim() || !weekOf) return;
    await apiFetch('/api/epicerie/next-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_of: weekOf, ...newItem }),
    });
    setNewItem({ article_number: '', product_name: '', quantity: 1 });
    await load();
  };

  if (loading) return <div style={{ color: MUTED, fontSize: 13 }}>Chargement...</div>;

  if (!weekOf) {
    return <div style={card}><p style={{ fontSize: 13, color: MUTED }}>Aucune liste générée pour l'instant.</p></div>;
  }

  return (
    <div style={card}>
      <div style={label}>Semaine du {new Date(weekOf).toLocaleDateString('fr-CA')} — {items.length} items</div>
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Produit</th>
              <th style={th}>Quantité</th>
              <th style={th}>Statut</th>
              <th style={th}>Lien</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td style={td}>{it.product_name}</td>
                <td style={td}>
                  <input type="number" min="1" style={{ ...input, width: 60 }} value={it.quantity}
                    onChange={(e) => updateQty(it.id, parseInt(e.target.value, 10) || 1)} />
                </td>
                <td style={{ ...td, color: it.status === 'added' ? GREEN : it.status === 'skipped' ? RED : MUTED }}>{it.status}</td>
                <td style={td}>
                  {it.product_url && <a href={it.product_url} target="_blank" rel="noreferrer" style={{ color: BLUE, fontSize: 12 }}>Voir</a>}
                </td>
                <td style={td}>
                  <button style={btn('#333')} onClick={() => removeItem(it.id)}>Retirer</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input style={{ ...input, width: 160 }} placeholder="N° article" value={newItem.article_number}
          onChange={(e) => setNewItem({ ...newItem, article_number: e.target.value })} />
        <input style={{ ...input, flex: 1 }} placeholder="Nom du produit" value={newItem.product_name}
          onChange={(e) => setNewItem({ ...newItem, product_name: e.target.value })} />
        <input type="number" min="1" style={{ ...input, width: 70 }} value={newItem.quantity}
          onChange={(e) => setNewItem({ ...newItem, quantity: parseInt(e.target.value, 10) || 1 })} />
        <button style={btn(BLUE)} onClick={addItem} disabled={!newItem.article_number.trim()}>+ Ajouter</button>
      </div>
    </div>
  );
}

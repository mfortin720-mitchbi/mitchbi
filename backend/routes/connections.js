import { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';

const CONNECTION_TYPES = [
  { id: 'bigquery', label: 'BigQuery', icon: '◈', color: '#4285F4' },
  { id: 'snowflake', label: 'Snowflake', icon: '❄', color: '#29B5E8' },
  { id: 'shopify', label: 'Shopify', icon: '🛍', color: '#96BF48' },
  { id: 'ga4', label: 'GA4', icon: '📊', color: '#F9AB00' },
  { id: 'google_ads', label: 'Google Ads', icon: '📢', color: '#4285F4' },
];

const StatusBadge = ({ status }) => {
  const colors = {
    active: { bg: '#0d2b1a', text: '#1D9E75' },
    error: { bg: '#2b0d0d', text: '#D85A30' },
  };
  const c = colors[status] || colors.active;
  return <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: c.bg, color: c.text }}>{status}</span>;
};

export default function Connections({ session }) {
  const [connections, setConnections] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedType, setSelectedType] = useState('bigquery');
  const [form, setForm] = useState({ name: '', projectId: '', credentials: '', location: 'northamerica-northeast1' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [loadingConns, setLoadingConns] = useState(true);

  useEffect(() => { loadConnections(); }, []);

  const loadConnections = async () => {
    setLoadingConns(true);
    const { data } = await supabase.from('connections').select('*').order('created_at', { ascending: false });
    const conns = (data || []).map(c => {
      let projectId = '';
      try { projectId = JSON.parse(c.credentials_encrypted).project_id || ''; } catch {}
      return { id: c.id, name: c.name, type: c.type, projectId, credentials: c.credentials_encrypted, location: c.location, status: c.status, addedAt: new Date(c.created_at).toLocaleDateString('fr-CA') };
    });
    setConnections(conns);
    setLoadingConns(false);
  };

  const testConnection = async () => {
    if (!form.credentials || !form.projectId) { setTestResult({ success: false, error: 'Remplis tous les champs requis.' }); return; }
    setTesting(true); setTestResult(null);
    try {
      let creds;
      try { creds = JSON.parse(form.credentials); } catch { setTestResult({ success: false, error: 'JSON invalide.' }); setTesting(false); return; }

      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/connections/bigquery/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: creds, projectId: form.projectId })
      });
      const data = await res.json();
      setTestResult(data);

      if (data.success) {
        const { data: saved } = await supabase.from('connections').insert({
          name: form.name || `BigQuery — ${form.projectId}`,
          type: selectedType,
          credentials_encrypted: form.credentials,
          location: form.location,
          status: 'active',
          user_id: session?.user?.id
        }).select().single();

        const newConn = { id: saved?.id || Date.now(), name: form.name || `BigQuery — ${form.projectId}`, type: selectedType, projectId: form.projectId, credentials: form.credentials, location: form.location, status: 'active', addedAt: new Date().toLocaleDateString('fr-CA') };
        setConnections([...connections, newConn]);
        setShowAdd(false);
        setForm({ name: '', projectId: '', credentials: '', location: 'northamerica-northeast1' });
      }
    } catch (err) { setTestResult({ success: false, error: err.message }); }
    finally { setTesting(false); }
  };

  const deleteConnection = async (id) => {
    await supabase.from('connections').delete().eq('id', id);
    setConnections(connections.filter(c => c.id !== id));
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 14, color: '#555' }}>Connecte tes sources de données — BigQuery, Snowflake, Shopify et plus.</div>
        <button onClick={() => setShowAdd(true)} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#378ADD', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
          + Ajouter une connexion
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        {CONNECTION_TYPES.map(t => (
          <div key={t.id} style={{ padding: '8px 16px', borderRadius: 8, border: '0.5px solid #1e2130', background: '#13151f', display: 'flex', alignItems: 'center', gap: 8, color: '#555', fontSize: 13 }}>
            <span>{t.icon}</span><span>{t.label}</span>
            <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#1e2130', color: '#333' }}>{connections.filter(c => c.type === t.id).length}</span>
          </div>
        ))}
      </div>

      {loadingConns && <div style={{ color: '#444', fontSize: 13, padding: 20 }}>Chargement...</div>}

      {!loadingConns && connections.length === 0 && !showAdd && (
        <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 48, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
          <d
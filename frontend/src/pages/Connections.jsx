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
    testing: { bg: '#1a1a2b', text: '#378ADD' },
  };
  const c = colors[status] || colors.active;
  return (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: c.bg, color: c.text }}>
      {status}
    </span>
  );
};

export default function Connections({ session }) {
  const [connections, setConnections] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedType, setSelectedType] = useState('bigquery');
  const [form, setForm] = useState({ name: '', projectId: '', credentials: '' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [loadingConns, setLoadingConns] = useState(true);

  // Charger les connexions depuis Supabase au démarrage
  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    setLoadingConns(true);
    try {
      const { data, error } = await supabase
        .from('connections')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Reconstruire les connexions avec les credentials
      const conns = (data || []).map(c => {
        let projectId = '';
        let datasets = [];
        try {
          const creds = JSON.parse(c.credentials_encrypted);
          projectId = creds.project_id || '';
        } catch {}
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          projectId,
          credentials: c.credentials_encrypted,
          status: c.status,
          datasets,
          addedAt: new Date(c.created_at).toLocaleDateString('fr-CA')
        };
      });
      setConnections(conns);
    } catch (err) {
      console.error('Load connections error:', err);
    } finally {
      setLoadingConns(false);
    }
  };

  const testConnection = async () => {
    if (!form.credentials || !form.projectId) {
      setTestResult({ success: false, error: 'Remplis tous les champs requis.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      let creds;
      try {
        creds = JSON.parse(form.credentials);
      } catch {
        setTestResult({ success: false, error: 'Le JSON du service account est invalide.' });
        setTesting(false);
        return;
      }

      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/connections/bigquery/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: creds, projectId: form.projectId })
      });
      const data = await res.json();
      setTestResult(data);

      if (data.success) {
        // Sauvegarder dans Supabase
        const { data: saved, error } = await supabase
          .from('connections')
          .insert({
            name: form.name || `BigQuery — ${form.projectId}`,
            type: selectedType,
            credentials_encrypted: form.credentials,
            status: 'active',
            user_id: session?.user?.id
          })
          .select()
          .single();

        if (error) console.error('Save error:', error);

        const newConn = {
          id: saved?.id || Date.now(),
          name: form.name || `BigQuery — ${form.projectId}`,
          type: selectedType,
          projectId: form.projectId,
          credentials: form.credentials,
          status: 'active',
          datasets: data.datasets,
          addedAt: new Date().toLocaleDateString('fr-CA')
        };
        setConnections([...connections, newConn]);
        setShowAdd(false);
        setForm({ name: '', projectId: '', credentials: '' });
      }
    } catch (err) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const deleteConnection = async (id) => {
    await supabase.from('connections').delete().eq('id', id);
    setConnections(connections.filter(c => c.id !== id));
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 14, color: '#555' }}>
          Connecte tes sources de données — BigQuery, Snowflake, Shopify et plus.
        </div>
        <button onClick={() => setShowAdd(true)} style={{
          padding: '8px 18px', borderRadius: 8, border: 'none',
          background: '#378ADD', color: '#fff', cursor: 'pointer',
          fontSize: 13, fontWeight: 500
        }}>
          + Ajouter une connexion
        </button>
      </div>

      {/* Connection type counters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        {CONNECTION_TYPES.map(t => (
          <div key={t.id} style={{
            padding: '8px 16px', borderRadius: 8,
            border: '0.5px solid #1e2130', background: '#13151f',
            display: 'flex', alignItems: 'center', gap: 8,
            color: '#555', fontSize: 13
          }}>
            <span>{t.icon}</span>
            <span>{t.label}</span>
            <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#1e2130', color: '#333' }}>
              {connections.filter(c => c.type === t.id).length}
            </span>
          </div>
        ))}
      </div>

      {/* Loading */}
      {loadingConns && (
        <div style={{ color: '#444', fontSize: 13, padding: 20 }}>Chargement des connexions...</div>
      )}

      {/* Empty state */}
      {!loadingConns && connections.length === 0 && !showAdd && (
        <div style={{
          background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130',
          padding: 48, textAlign: 'center', color: '#333', fontSize: 14
        }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
          <div style={{ marginBottom: 8, color: '#555' }}>Aucune connexion configurée</div>
          <div style={{ fontSize: 12 }}>Clique "Ajouter une connexion" pour commencer</div>
        </div>
      )}

      {/* Connections list */}
      {connections.map(conn => (
        <div key={conn.id} style={{
          background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130',
          padding: '16px 20px', marginBottom: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 8,
              background: '#1a1d27', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: 18
            }}>
              {CONNECTION_TYPES.find(t => t.id === conn.type)?.icon}
            </div>
            <div>
              <div style={{ fontWeight: 500, color: '#fff', marginBottom: 4 }}>{conn.name}</div>
              <div style={{ fontSize: 12, color: '#444' }}>
                {conn.projectId} · Ajouté le {conn.addedAt}
              </div>
              {conn.datasets?.length > 0 && (
                <div style={{ fontSize: 11, color: '#333', marginTop: 2 }}>
                  Datasets : {conn.datasets.slice(0, 3).join(', ')}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <StatusBadge status={conn.status} />
            <button onClick={() => deleteConnection(conn.id)} style={{
              padding: '5px 12px', borderRadius: 6,
              border: '0.5px solid #2b0d0d', background: 'transparent',
              color: '#D85A30', cursor: 'pointer', fontSize: 12
            }}>
              Supprimer
            </button>
          </div>
        </div>
      ))}

      {/* Add connection modal */}
      {showAdd && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{
            background: '#13151f', borderRadius: 12, border: '0.5px solid #1e2130',
            padding: 32, width: '100%', maxWidth: 560
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 20 }}>
              Ajouter une connexion
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
              {CONNECTION_TYPES.map(t => (
                <button key={t.id} onClick={() => setSelectedType(t.id)} style={{
                  padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
                  border: '0.5px solid',
                  borderColor: selectedType === t.id ? t.color : '#1e2130',
                  background: selectedType === t.id ? `${t.color}22` : 'transparent',
                  color: selectedType === t.id ? t.color : '#555', fontSize: 13
                }}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            {selectedType === 'bigquery' && (
              <div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>Nom de la connexion</label>
                  <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                    placeholder="ex: BigQuery — Royal Distributing"
                    style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>Project ID GCP *</label>
                  <input value={form.projectId} onChange={e => setForm({ ...form, projectId: e.target.value })}
                    placeholder="ex: my-project-123456"
                    style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 14, boxSizing: 'border-box' }} />
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 6 }}>Service Account JSON *</label>
                  <textarea value={form.credentials} onChange={e => setForm({ ...form, credentials: e.target.value })}
                    placeholder='Colle le contenu de ton fichier .json ici...'
                    rows={6}
                    style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 12, boxSizing: 'border-box', fontFamily: 'monospace', resize: 'vertical' }} />
                </div>
              </div>
            )}

            {selectedType !== 'bigquery' && (
              <div style={{ padding: 24, background: '#0f1117', borderRadius: 8, border: '0.5px solid #1e2130', textAlign: 'center', color: '#444', fontSize: 13, marginBottom: 20 }}>
                Connexion {CONNECTION_TYPES.find(t => t.id === selectedType)?.label} — disponible prochainement 🚀
              </div>
            )}

            {testResult && (
              <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 16, background: testResult.success ? '#0d2b1a' : '#2b0d0d', color: testResult.success ? '#1D9E75' : '#D85A30', fontSize: 13 }}>
                {testResult.success ? testResult.message : `❌ ${testResult.error}`}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAdd(false); setTestResult(null); }} style={{ padding: '10px 20px', borderRadius: 8, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 13 }}>
                Annuler
              </button>
              {selectedType === 'bigquery' && (
                <button onClick={testConnection} disabled={testing} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: testing ? '#1e2130' : '#378ADD', color: testing ? '#555' : '#fff', cursor: testing ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 500 }}>
                  {testing ? 'Test en cours...' : 'Tester & Connecter'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
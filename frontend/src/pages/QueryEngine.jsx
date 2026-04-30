
import { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';

export default function QueryEngine() {
  const [connections, setConnections] = useState([]);
  const [selectedConn, setSelectedConn] = useState(null);
  const [datasets, setDatasets] = useState([]);
  const [expandedDataset, setExpandedDataset] = useState(null);
  const [tables, setTables] = useState({});
  const [selectedTable, setSelectedTable] = useState(null);
  const [schema, setSchema] = useState([]);
  const [loadingDatasets, setLoadingDatasets] = useState(false);
  const [loadingTables, setLoadingTables] = useState(null);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [showSQL, setShowSQL] = useState(false);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('connections').select('*').eq('type', 'bigquery').eq('status', 'active');
      if (data?.length > 0) { setConnections(data); setSelectedConn(data[0]); }
    };
    load();
  }, []);

  useEffect(() => { if (selectedConn) loadDatasets(); }, [selectedConn]);

  const getCreds = () => {
    try { return JSON.parse(selectedConn.credentials_encrypted); } catch { return null; }
  };

  const apiPost = async (endpoint, body) => {
    const res = await fetch(`${import.meta.env.VITE_API_URL}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json();
  };

  const loadDatasets = async () => {
    setLoadingDatasets(true);
    setDatasets([]); setTables({}); setSelectedTable(null); setSchema([]);
    const creds = getCreds();
    const data = await apiPost('/api/connections/bigquery/datasets', { credentials: creds, projectId: creds.project_id });
    if (data.success) setDatasets(data.datasets);
    setLoadingDatasets(false);
  };

  const loadTables = async (datasetId) => {
    if (expandedDataset === datasetId) { setExpandedDataset(null); return; }
    setExpandedDataset(datasetId);
    if (tables[datasetId]) return;
    setLoadingTables(datasetId);
    const creds = getCreds();
    const data = await apiPost('/api/connections/bigquery/tables', { credentials: creds, projectId: creds.project_id, datasetId });
    if (data.success) setTables(prev => ({ ...prev, [datasetId]: data.tables }));
    setLoadingTables(null);
  };

  const loadSchema = async (datasetId, tableId) => {
    setSelectedTable({ datasetId, tableId });
    setSchema([]); setLoadingSchema(true); setResult(null); setError('');
    const creds = getCreds();
    const data = await apiPost('/api/connections/bigquery/schema', { credentials: creds, projectId: creds.project_id, datasetId, tableId });
    if (data.success) setSchema(data.schema);
    setLoadingSchema(false);
  };

  const runQuery = async () => {
    if (!question.trim() || !selectedTable) return;
    setLoading(true); setResult(null); setError('');
    const creds = getCreds();
    const data = await apiPost('/api/query/nl', {
      question, credentials: creds, projectId: creds.project_id,
      datasetId: selectedTable.datasetId, tableId: selectedTable.tableId,
      schema, location: selectedConn.location || 'northamerica-northeast1'
    });
    if (data.success) setResult(data); else setError(data.error);
    setLoading(false);
  };

  const columns = result?.rows?.length > 0 ? Object.keys(result.rows[0]) : [];

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 108px)' }}>

      {/* LEFT — Explorer */}
      <div style={{ width: 240, flexShrink: 0, background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Connection selector */}
        <div style={{ padding: '12px 14px', borderBottom: '0.5px solid #1e2130' }}>
          <div style={{ fontSize: 11, color: '#444', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Connexion</div>
          <select value={selectedConn?.id || ''} onChange={e => setSelectedConn(connections.find(c => c.id === e.target.value))}
            style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 12 }}>
            {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {selectedConn && (
            <div style={{ fontSize: 11, color: '#444', marginTop: 4 }}>
              📍 {selectedConn.location || 'northamerica-northeast1'}
            </div>
          )}
        </div>

        {/* Tree */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          <div style={{ padding: '4px 14px 8px', fontSize: 11, color: '#444', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Datasets & Tables</div>

          {loadingDatasets && <div style={{ padding: '8px 14px', fontSize: 12, color: '#444' }}>Chargement...</div>}

          {datasets.map(ds => (
            <div key={ds.id}>
              <div onClick={() => loadTables(ds.id)} style={{
                padding: '6px 14px', cursor: 'pointer', fontSize: 13,
                color: expandedDataset === ds.id ? '#fff' : '#666',
                background: expandedDataset === ds.id ? '#1a1d27' : 'transparent',
                display: 'flex', alignItems: 'center', gap: 6
              }}>
                <span style={{ fontSize: 10 }}>{expandedDataset === ds.id ? '▼' : '▶'}</span>
                <span>◈</span>
                <span>{ds.id}</span>
                {loadingTables === ds.id && <span style={{ fontSize: 10, color: '#444', marginLeft: 'auto' }}>...</span>}
              </div>

              {expandedDataset === ds.id && tables[ds.id] && tables[ds.id].map(t => (
                <div key={t.id} onClick={() => loadSchema(ds.id, t.id)} style={{
                  padding: '5px 14px 5px 32px', cursor: 'pointer', fontSize: 12,
                  color: selectedTable?.tableId === t.id ? '#378ADD' : '#555',
                  background: selectedTable?.tableId === t.id ? '#0d1f35' : 'transparent',
                  borderLeft: selectedTable?.tableId === t.id ? '2px solid #378ADD' : '2px solid transparent',
                  display: 'flex', alignItems: 'center', gap: 6
                }}>
                  <span style={{ fontSize: 10 }}>📋</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.id}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT — Query + Results */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>

        {/* Schema */}
        {selectedTable && (
          <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', flexShrink: 0 }}>
            <div style={{ padding: '10px 16px', borderBottom: '0.5px solid #1e2130', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#fff', fontWeight: 500 }}>
                {selectedTable.datasetId}.<span style={{ color: '#378ADD' }}>{selectedTable.tableId}</span>
              </span>
              {loadingSchema && <span style={{ fontSize: 12, color: '#444' }}>Chargement...</span>}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#444' }}>{schema.length} colonnes</span>
            </div>
            {schema.length > 0 && (
              <div style={{ padding: '8px 16px', display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 100, overflowY: 'auto' }}>
                {schema.map(f => (
                  <span key={f.name} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 4,
                    background: '#0f1117', border: '0.5px solid #1e2130',
                    color: f.type === 'STRING' ? '#1D9E75' : f.type === 'INTEGER' || f.type === 'FLOAT64' ? '#378ADD' : '#E8A838'
                  }}>
                    {f.name} <span style={{ opacity: 0.5 }}>{f.type}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Input */}
        <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', padding: 16, flexShrink: 0 }}>
          {!selectedTable ? (
            <div style={{ color: '#444', fontSize: 13, textAlign: 'center', padding: '8px 0' }}>← Sélectionne une table pour commencer</div>
          ) : (
            <div style={{ display: 'flex', gap: 10 }}>
              <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === 'Enter' && runQuery()}
                placeholder={`Question sur ${selectedTable.tableId}...`}
                style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '0.5px solid #1e2130', background: '#0f1117', color: '#fff', fontSize: 14 }} />
              <button onClick={runQuery} disabled={loading || !question.trim()} style={{
                padding: '10px 20px', borderRadius: 8, border: 'none',
                background: loading || !question.trim() ? '#1e2130' : '#378ADD',
                color: loading || !question.trim() ? '#555' : '#fff',
                cursor: loading || !question.trim() ? 'not-allowed' : 'pointer',
                fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap'
              }}>
                {loading ? 'Génération...' : 'Exécuter ↗'}
              </button>
            </div>
          )}
        </div>

        {/* Error */}
        {error && <div style={{ padding: '12px 16px', borderRadius: 8, background: '#2b0d0d', color: '#D85A30', fontSize: 13, flexShrink: 0 }}>❌ {error}</div>}

        {/* Results */}
        {result && (
          <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', overflow: 'hidden', flex: 1 }}>
            <div style={{ padding: '10px 16px', borderBottom: '0.5px solid #1e2130', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13, color: '#fff' }}>✅ {result.count} résultat(s)</div>
              <button onClick={() => setShowSQL(!showSQL)} style={{ padding: '4px 12px', borderRadius: 6, border: '0.5px solid #1e2130', background: 'transparent', color: '#555', cursor: 'pointer', fontSize: 12 }}>
                {showSQL ? 'Cacher SQL' : 'Voir SQL'}
              </button>
            </div>
            {showSQL && (
              <div style={{ padding: '12px 16px', borderBottom: '0.5px solid #1e2130', background: '#0f1117' }}>
                <pre style={{ margin: 0, fontSize: 12, color: '#378ADD', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{result.sql}</pre>
              </div>
            )}
            <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 300 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#0f1117', position: 'sticky', top: 0 }}>
                    {columns.map(col => (
                      <th key={col} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 500, fontSize: 12, color: '#555', borderBottom: '0.5px solid #1e2130', whiteSpace: 'nowrap' }}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid #1e2130' }}>
                      {columns.map(col => (
                        <td key={col} style={{ padding: '8px 14px', color: '#ccc', whiteSpace: 'nowrap' }}>{String(row[col] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
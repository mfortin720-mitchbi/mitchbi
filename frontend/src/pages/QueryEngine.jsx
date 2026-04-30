
import { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';

const SAMPLE_QUESTIONS = [
  'Montre-moi les 10 pages les plus visitées ce mois-ci',
  'Quel est le nombre de sessions par source de trafic ?',
  'Quels sont les événements les plus fréquents ?',
  'Montre-moi les utilisateurs actifs par jour cette semaine',
];

export default function QueryEngine() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [showSQL, setShowSQL] = useState(false);
  const [connections, setConnections] = useState([]);
  const [selectedConn, setSelectedConn] = useState(null);
  const [dataset, setDataset] = useState('ga4');

  useEffect(() => {
    const loadConnections = async () => {
      const { data } = await supabase
        .from('connections')
        .select('*')
        .eq('type', 'bigquery')
        .eq('status', 'active');

      if (data && data.length > 0) {
        setConnections(data);
        setSelectedConn(data[0]);
      }
    };
    loadConnections();
  }, []);

  const runQuery = async (q) => {
    const finalQuestion = q || question;
    if (!finalQuestion.trim()) return;
    if (!selectedConn) {
      setError('Aucune connexion BigQuery trouvée. Va dans Connections pour en ajouter une.');
      return;
    }

    setLoading(true);
    setResult(null);
    setError('');

    try {
      let creds;
      try {
        creds = JSON.parse(selectedConn.credentials_encrypted);
      } catch {
        setError('Credentials invalides — reconfigure ta connexion BigQuery.');
        setLoading(false);
        return;
      }

      console.log('Using project:', creds.project_id);
      console.log('Dataset:', dataset);

      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/query/nl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: finalQuestion,
          projectId: creds.project_id,
          dataset,
          credentials: creds
        })
      });
      const data = await res.json();
      if (data.success) {
        setResult(data);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const columns = result?.rows?.length > 0 ? Object.keys(result.rows[0]) : [];

  return (
    <div>
      {/* Connection + dataset selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {connections.length > 0 ? (
          <select
            value={selectedConn?.id || ''}
            onChange={e => setSelectedConn(connections.find(c => c.id === e.target.value))}
            style={{
              padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
              border: '0.5px solid #1e2130', background: '#13151f',
              color: '#fff', fontSize: 13
            }}
          >
            {connections.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: 12, color: '#D85A30' }}>
            ⚠ Aucune connexion BigQuery — va dans Connections
          </span>
        )}

        {['ga4', 'ga4hector', 'gads_app'].map(ds => (
          <button key={ds} onClick={() => setDataset(ds)} style={{
            padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
            border: '0.5px solid',
            borderColor: dataset === ds ? '#378ADD' : '#1e2130',
            background: dataset === ds ? '#0d1f35' : 'transparent',
            color: dataset === ds ? '#378ADD' : '#555',
            fontSize: 13
          }}>
            {ds}
          </button>
        ))}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#333' }}>
          {selectedConn ? `● ${selectedConn.name} · BigQuery` : ''}
        </span>
      </div>

      {/* Query input */}
      <div style={{
        background: '#13151f', borderRadius: 10,
        border: '0.5px solid #1e2130', padding: 20, marginBottom: 16
      }}>
        <div style={{ fontSize: 12, color: '#555', marginBottom: 10 }}>
          Pose ta question en français — MitchBI génère et exécute le SQL automatiquement
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runQuery()}
            placeholder='ex: "Montre-moi les sessions par source ce mois-ci dans ga4_channel_alldims"'
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 8,
              border: '0.5px solid #1e2130', background: '#0f1117',
              color: '#fff', fontSize: 14
            }}
          />
          <button onClick={() => runQuery()} disabled={loading || !selectedConn} style={{
            padding: '10px 20px', borderRadius: 8, border: 'none',
            background: loading || !selectedConn ? '#1e2130' : '#378ADD',
            color: loading || !selectedConn ? '#555' : '#fff',
            cursor: loading || !selectedConn ? 'not-allowed' : 'pointer',
            fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap'
          }}>
            {loading ? 'Génération...' : 'Exécuter ↗'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {SAMPLE_QUESTIONS.map((q, i) => (
            <button key={i} onClick={() => { setQuestion(q); runQuery(q); }} style={{
              padding: '4px 12px', borderRadius: 20,
              border: '0.5px solid #1e2130', background: 'transparent',
              color: '#444', fontSize: 12, cursor: 'pointer'
            }}>
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '12px 16px', borderRadius: 8, marginBottom: 16,
          background: '#2b0d0d', color: '#D85A30', fontSize: 13
        }}>
          ❌ {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div style={{ background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130', overflow: 'hidden' }}>
          <div style={{
            padding: '12px 20px', borderBottom: '0.5px solid #1e2130',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between'
          }}>
            <div style={{ fontSize: 13, color: '#fff' }}>
              ✅ {result.count} résultat(s) · <span style={{ color: '#378ADD' }}>{dataset}</span>
            </div>
            <button onClick={() => setShowSQL(!showSQL)} style={{
              padding: '4px 12px', borderRadius: 6,
              border: '0.5px solid #1e2130', background: 'transparent',
              color: '#555', cursor: 'pointer', fontSize: 12
            }}>
              {showSQL ? 'Cacher SQL' : 'Voir SQL'}
            </button>
          </div>

          {showSQL && (
            <div style={{ padding: '12px 20px', borderBottom: '0.5px solid #1e2130', background: '#0f1117' }}>
              <pre style={{ margin: 0, fontSize: 12, color: '#378ADD', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                {result.sql}
              </pre>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#0f1117' }}>
                  {columns.map(col => (
                    <th key={col} style={{
                      padding: '10px 16px', textAlign: 'left',
                      fontWeight: 500, fontSize: 12, color: '#555',
                      borderBottom: '0.5px solid #1e2130', whiteSpace: 'nowrap'
                    }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} style={{ borderBottom: '0.5px solid #1e2130' }}>
                    {columns.map(col => (
                      <td key={col} style={{ padding: '10px 16px', color: '#ccc', whiteSpace: 'nowrap' }}>
                        {String(row[col] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
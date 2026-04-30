import { useState } from 'react';

const SAMPLE_QUESTIONS = [
  'Montre-moi les 10 pages les plus visitées ce mois-ci',
  'Quel est le nombre de sessions par source de trafic ?',
  'Quels sont les événements les plus fréquents ?',
  'Montre-moi les utilisateurs actifs par jour cette semaine',
];

export default function QueryEngine() {
  const [question, setQuestion] = useState('');
  const [dataset, setDataset] = useState('ga4');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [showSQL, setShowSQL] = useState(false);

  // Credentials BigQuery — à remplacer par le vrai système de connexions
  const credentials = null; // sera passé depuis Connections
  const projectId = 'royaldistributing'; // à dynamiser

  const runQuery = async (q) => {
    const finalQuestion = q || question;
    if (!finalQuestion.trim()) return;
    setLoading(true);
    setResult(null);
    setError('');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/query/nl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: finalQuestion,
          projectId,
          dataset,
          credentials // null pour l'instant — à connecter
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
      {/* Source selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
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
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#333', alignSelf: 'center' }}>
          ● royaldistributing · BigQuery
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
            placeholder='ex: "Montre-moi les sessions par source ce mois-ci"'
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 8,
              border: '0.5px solid #1e2130', background: '#0f1117',
              color: '#fff', fontSize: 14
            }}
          />
          <button onClick={() => runQuery()} disabled={loading} style={{
            padding: '10px 20px', borderRadius: 8, border: 'none',
            background: loading ? '#1e2130' : '#378ADD',
            color: loading ? '#555' : '#fff',
            cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap'
          }}>
            {loading ? 'Génération...' : 'Exécuter ↗'}
          </button>
        </div>

        {/* Sample questions */}
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
          {/* Result header */}
          <div style={{
            padding: '12px 20px', borderBottom: '0.5px solid #1e2130',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between'
          }}>
            <div style={{ fontSize: 13, color: '#fff' }}>
              ✅ {result.count} résultat(s) · dataset: <span style={{ color: '#378ADD' }}>{dataset}</span>
            </div>
            <button onClick={() => setShowSQL(!showSQL)} style={{
              padding: '4px 12px', borderRadius: 6,
              border: '0.5px solid #1e2130', background: 'transparent',
              color: '#555', cursor: 'pointer', fontSize: 12
            }}>
              {showSQL ? 'Cacher SQL' : 'Voir SQL'}
            </button>
          </div>

          {/* SQL display */}
          {showSQL && (
            <div style={{
              padding: '12px 20px', borderBottom: '0.5px solid #1e2130',
              background: '#0f1117'
            }}>
              <pre style={{
                margin: 0, fontSize: 12, color: '#378ADD',
                fontFamily: 'monospace', whiteSpace: 'pre-wrap'
              }}>
                {result.sql}
              </pre>
            </div>
          )}

          {/* Data table */}
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
                      <td key={col} style={{
                        padding: '10px 16px', color: '#ccc',
                        whiteSpace: 'nowrap'
                      }}>
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
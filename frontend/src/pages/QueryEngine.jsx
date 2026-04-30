import { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';

const SAMPLE_QUESTIONS = [
  'Montre-moi les 10 pages les plus visitées ce mois-ci',
  'Quel est le nombre de sessions par source de trafic en utilisant ga4_channel_alldims ?',
  'Quels sont les événements les plus fréquents ?',
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
            placeholder='ex: "Montre-moi les sessions par
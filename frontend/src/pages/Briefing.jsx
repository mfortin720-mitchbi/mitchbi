import { useState, useEffect } from 'react';

const KPI = ({ label, value, delta, color }) => (
  <div style={{
    background: '#13151f', borderRadius: 10, padding: '14px 18px',
    border: '0.5px solid #1e2130', minWidth: 0
  }}>
    <div style={{ fontSize: 11, color: '#444', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 600, color: '#fff' }}>{value}</div>
    {delta && <div style={{ fontSize: 12, color: color || '#1D9E75', marginTop: 3 }}>{delta}</div>}
  </div>
);

const formatLine = (line, i) => {
  if (line.startsWith('# '))
    return <h2 key={i} style={{ color: '#fff', fontSize: 16, marginBottom: 8 }}>{line.replace(/^# /, '')}</h2>;
  if (line.startsWith('## ') || line.startsWith('### '))
    return <h3 key={i} style={{ color: '#378ADD', fontSize: 14, margin: '16px 0 6px' }}>{line.replace(/^#{2,3} /, '')}</h3>;
  if (line.startsWith('- ') || line.startsWith('• '))
    return <p key={i} style={{ margin: '4px 0', paddingLeft: 12, borderLeft: '2px solid #1e2130' }}>{line.replace(/^[-•] /, '').replace(/\*\*/g, '')}</p>;
  if (line.match(/^\d+\. /))
    return <p key={i} style={{ margin: '4px 0', paddingLeft: 12, borderLeft: '2px solid #378ADD' }}>{line.replace(/\*\*/g, '')}</p>;
  if (line === '---')
    return <hr key={i} style={{ border: 'none', borderTop: '0.5px solid #1e2130', margin: '12px 0' }} />;
  if (line.trim() === '')
    return <br key={i} />;
  return <p key={i} style={{ margin: '4px 0' }}>{line.replace(/\*\*/g, '')}</p>;
};

export default function Briefing({ session }) {
  const [brief, setBrief] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBriefing = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('http://localhost:3001/api/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: session?.user?.email })
      });
      const data = await res.json();
      setBrief(data.briefing);
    } catch (err) {
      setBrief('❌ Erreur de connexion au backend. Assure-toi que le serveur tourne sur le port 3001.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { fetchBriefing(); }, []);

  return (
    <div>
      {/* KPI Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12, marginBottom: 24
      }}>
        <KPI label="S&P 500" value="5,472" delta="▲ +0.8%" />
        <KPI label="BTC" value="$67,200" delta="▲ +2.1%" />
        <KPI label="Factures en attente" value="7" delta="3 dues aujourd'hui" color="#E8A838" />
        <KPI label="Campagnes actives" value="12" delta="2 sous-performantes" color="#D85A30" />
        <KPI label="Sessions GA4" value="24.5K" delta="▲ +16.6%" />
      </div>

      {/* Briefing Card */}
      <div style={{
        background: '#13151f', borderRadius: 10,
        border: '0.5px solid #1e2130', overflow: 'hidden'
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px', borderBottom: '0.5px solid #1e2130',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between'
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>
              ☀ Briefing AI du jour
            </div>
            <div style={{ fontSize: 11, color: '#444', marginTop: 2 }}>
              Généré par Claude · {new Date().toLocaleDateString('fr-CA')}
            </div>
          </div>
          <button onClick={fetchBriefing} disabled={refreshing} style={{
            padding: '6px 14px', borderRadius: 6,
            border: '0.5px solid #2a2d3a', background: 'transparent',
            color: refreshing ? '#333' : '#555', cursor: refreshing ? 'not-allowed' : 'pointer',
            fontSize: 12
          }}>
            {refreshing ? 'Génération...' : '↺ Rafraîchir'}
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '20px 24px' }}>
          {loading ? (
            <div style={{ color: '#444', fontSize: 14, lineHeight: 2 }}>
              <div style={{ marginBottom: 8 }}>✦ Analyse des marchés...</div>
              <div style={{ marginBottom: 8 }}>✦ Récupération des insights marketing...</div>
              <div>✦ Préparation de ton briefing personnalisé...</div>
            </div>
          ) : (
            <div style={{ fontSize: 14, lineHeight: 1.8, color: '#ccc' }}>
              {brief.split('\n').map((line, i) => formatLine(line, i))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
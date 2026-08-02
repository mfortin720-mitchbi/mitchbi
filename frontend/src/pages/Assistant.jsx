import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '../services/api';

const BLUE = '#378ADD';
const MUTED = '#8b93a5';

// Styled overrides so react-markdown output (tables, code, lists...) matches the app's dark theme.
const MARKDOWN_COMPONENTS = {
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead style={{ borderBottom: '1px solid #2a2d3a' }}>{children}</thead>,
  th: ({ children }) => (
    <th style={{ textAlign: 'left', padding: '6px 12px', color: MUTED, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</th>
  ),
  td: ({ children }) => <td style={{ padding: '6px 12px', borderTop: '0.5px solid #1e2130', color: '#ddd' }}>{children}</td>,
  tr: ({ children }) => <tr>{children}</tr>,
  h1: ({ children }) => <div style={{ color: BLUE, fontWeight: 700, fontSize: 16, margin: '12px 0 6px' }}>{children}</div>,
  h2: ({ children }) => <div style={{ color: BLUE, fontWeight: 600, fontSize: 15, margin: '10px 0 4px' }}>{children}</div>,
  h3: ({ children }) => <div style={{ color: BLUE, fontWeight: 600, fontSize: 14, margin: '10px 0 4px' }}>{children}</div>,
  p: ({ children }) => <p style={{ margin: '4px 0' }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: 20 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: 20 }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
  code: ({ inline, children }) => inline
    ? <code style={{ background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 4, padding: '1px 5px', fontSize: 12.5, color: BLUE }}>{children}</code>
    : <code>{children}</code>,
  pre: ({ children }) => (
    <pre style={{ background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 8, padding: 12, overflowX: 'auto', fontSize: 12.5, margin: '8px 0' }}>{children}</pre>
  ),
  a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: BLUE }}>{children}</a>,
  hr: () => <hr style={{ border: 'none', borderTop: '0.5px solid #1e2130', margin: '10px 0' }} />,
  strong: ({ children }) => <strong style={{ color: '#fff' }}>{children}</strong>,
};

export default function Assistant({ session }) {
  const [msgs, setMsgs] = useState([{
    role: 'assistant',
    content: `Bonjour ${session?.user?.email?.split('@')[0]} 👋\n\nJe suis NexusIQ, ton assistant AI personnel. Je connais tes rôles — data scientist, stratège digital, directeur BI, trader et gestionnaire de factures.\n\nComment puis-je t'aider aujourd'hui ?`
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: 'user', content: input };
    const newMsgs = [...msgs, userMsg];
    setMsgs(newMsgs);
    setInput('');
    setLoading(true);

    try {
      const res = await apiFetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMsgs,
          email: session?.user?.email
        })
      });
      const data = await res.json();
      setMsgs([...newMsgs, { role: 'assistant', content: data.response }]);
    } catch (err) {
      setMsgs([...newMsgs, { role: 'assistant', content: '❌ Erreur de connexion au backend.' }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const suggestions = [
    'Analyse mon portfolio de campagnes Google Ads',
    'Génère une requête SQL pour mes ventes Shopify',
    'Quelles sont les tendances crypto cette semaine ?',
    'Aide-moi à structurer un rapport BI pour mon équipe',
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 108px)' }}>
      {/* Messages */}
      <div style={{
        flex: 1, overflowY: 'auto', marginBottom: 16,
        display: 'flex', flexDirection: 'column', gap: 12
      }}>
        {msgs.map((m, i) => (
          <div key={i} style={{
            display: 'flex',
            justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start'
          }}>
            {m.role === 'assistant' && (
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: '#378ADD', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                fontSize: 12, color: '#fff', flexShrink: 0,
                marginRight: 10, marginTop: 4
              }}>✦</div>
            )}
            <div style={{
              maxWidth: '75%',
              padding: '10px 16px',
              borderRadius: m.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
              background: m.role === 'user' ? '#1a3a5c' : '#13151f',
              border: '0.5px solid',
              borderColor: m.role === 'user' ? '#2a5a8c' : '#1e2130',
              color: '#ccc', fontSize: 14, lineHeight: 1.6
            }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {m.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: '#378ADD', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 12, color: '#fff'
            }}>✦</div>
            <div style={{ color: '#444', fontSize: 13 }}>NexusIQ réfléchit...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Suggestions */}
      {msgs.length === 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {suggestions.map((s, i) => (
            <button key={i} onClick={() => setInput(s)} style={{
              padding: '6px 12px', borderRadius: 20,
              border: '0.5px solid #1e2130', background: '#13151f',
              color: '#555', fontSize: 12, cursor: 'pointer'
            }}>
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'flex-end',
        background: '#13151f', borderRadius: 12,
        border: '0.5px solid #1e2130', padding: '10px 14px'
      }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Pose une question à NexusIQ... (Entrée pour envoyer)"
          rows={1}
          style={{
            flex: 1, background: 'transparent', border: 'none',
            color: '#fff', fontSize: 14, resize: 'none',
            outline: 'none', fontFamily: 'system-ui, sans-serif',
            lineHeight: 1.5
          }}
        />
        <button onClick={send} disabled={loading || !input.trim()} style={{
          padding: '8px 16px', borderRadius: 8,
          border: 'none', background: input.trim() ? '#378ADD' : '#1e2130',
          color: input.trim() ? '#fff' : '#444',
          cursor: input.trim() ? 'pointer' : 'not-allowed',
          fontSize: 13, fontWeight: 500, flexShrink: 0
        }}>
          Envoyer ↗
        </button>
      </div>
    </div>
  );
}
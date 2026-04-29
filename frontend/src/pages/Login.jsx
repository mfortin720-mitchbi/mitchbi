import { useState } from 'react';
import { supabase } from '../services/supabase';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('login'); // 'login' or 'signup'

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setError('✅ Compte créé ! Vérifie ton email pour confirmer.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f1117',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <div style={{
        width: '100%',
        maxWidth: 400,
        padding: '40px',
        background: '#1a1d27',
        borderRadius: 12,
        border: '0.5px solid #2a2d3a'
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px' }}>
            Mitch<span style={{ color: '#378ADD' }}>BI</span>
          </div>
          <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
            AI Command Center
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', marginBottom: 24, borderRadius: 8, overflow: 'hidden', border: '0.5px solid #2a2d3a' }}>
          {['login', 'signup'].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              flex: 1, padding: '10px', border: 'none', cursor: 'pointer',
              background: mode === m ? '#378ADD' : 'transparent',
              color: mode === m ? '#fff' : '#666',
              fontSize: 13, fontWeight: 500, transition: 'all 0.2s'
            }}>
              {m === 'login' ? 'Connexion' : 'Créer un compte'}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 6 }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="ton@email.com"
              required
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                border: '0.5px solid #2a2d3a', background: '#0f1117',
                color: '#fff', fontSize: 14, boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#888', marginBottom: 6 }}>
              Mot de passe
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                border: '0.5px solid #2a2d3a', background: '#0f1117',
                color: '#fff', fontSize: 14, boxSizing: 'border-box'
              }}
            />
          </div>

          {error && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 16,
              background: error.startsWith('✅') ? '#1a2e1a' : '#2e1a1a',
              color: error.startsWith('✅') ? '#4caf50' : '#f44336',
              fontSize: 13
            }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={{
            width: '100%', padding: '12px', borderRadius: 8,
            border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
            background: '#378ADD', color: '#fff',
            fontSize: 14, fontWeight: 600,
            opacity: loading ? 0.7 : 1
          }}>
            {loading ? 'Chargement...' : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#444' }}>
          MitchBI v1.0 — Secure & Private
        </div>
      </div>
    </div>
  );
}
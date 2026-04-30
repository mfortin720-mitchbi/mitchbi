import { useState, useEffect } from 'react';
import { supabase } from './services/supabase';
import Login from './pages/Login';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import Briefing from './pages/Briefing';
import Assistant from './pages/Assistant';
import Connections from './pages/Connections';

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState('briefing');
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#0f1117',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#555',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14
      }}>
        Chargement MitchBI...
      </div>
    );
  }

  if (!session) {
    return <Login />;
  }

  const renderModule = () => {
    switch (active) {
      case 'briefing':
        return <Briefing session={session} />;
      case 'assistant': 
        return <Assistant session={session} />;
      case 'connections': 
        return <Connections />;
      default:
        return (
          <div style={{
            background: '#1a1d27',
            borderRadius: 12,
            border: '0.5px solid #1e2130',
            padding: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 400,
            color: '#444',
            fontSize: 14
          }}>
            Module "{active}" — en construction 🚀
          </div>
        );
    }
  };

  return (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      background: '#0f1117',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <Sidebar
        active={active}
        onNavigate={setActive}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Topbar active={active} session={session} />
        <div style={{ flex: 1, padding: 24, overflowY: 'auto', color: '#fff' }}>
          {renderModule()}
        </div>
      </div>
    </div>
  );
}
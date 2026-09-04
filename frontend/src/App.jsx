import { useState, useEffect } from 'react';
import { supabase } from './services/supabase';
import Login from './pages/Login';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import Briefing from './pages/Briefing';
import Assistant from './pages/Assistant';
import Connections from './pages/Connections';
import QueryEngine from './pages/QueryEngine';
import Trader from './pages/Trader';
import TradingImperium from './pages/TradingImperium';
import Epicerie from './pages/Epicerie';
import Readme from './pages/Readme';

const TI_TAB_BY_ID = {
  'trading-imperium': 'overview',
  'trading-imperium-trades': 'trades',
  'trading-imperium-events': 'events',
  'trading-imperium-config': 'config',
  'trading-imperium-analyse': 'analyse',
  'trading-imperium-architecture': 'architecture',
};
const TI_ID_BY_TAB = {
  overview: 'trading-imperium', trades: 'trading-imperium-trades',
  events: 'trading-imperium-events', config: 'trading-imperium-config',
  analyse: 'trading-imperium-analyse', architecture: 'trading-imperium-architecture',
};

const EP_TAB_BY_ID = {
  'epicerie-config': 'config',
  'epicerie-dashboard': 'dashboard',
  'epicerie-orders': 'orders',
  'epicerie-next-order': 'next-order',
  'epicerie-flyer': 'flyer',
  'epicerie-search': 'search',
  'epicerie-agent-log': 'agent-log',
  'epicerie-readme': 'readme',
};
const EP_ID_BY_TAB = {
  config: 'epicerie-config',
  dashboard: 'epicerie-dashboard',
  orders: 'epicerie-orders',
  'next-order': 'epicerie-next-order',
  flyer: 'epicerie-flyer',
  search: 'epicerie-search',
  'agent-log': 'epicerie-agent-log',
  readme: 'epicerie-readme',
};

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState('trading-imperium');
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
        return <Connections session={session} />;
      case 'query':
        return <QueryEngine />;

      case 'trader': return <Trader />;

      case 'readme': return <Readme />;

      case 'trading-imperium':
      case 'trading-imperium-trades':
      case 'trading-imperium-events':
      case 'trading-imperium-config':
      case 'trading-imperium-analyse':
      case 'trading-imperium-architecture':
        return (
          <TradingImperium
            activeTab={TI_TAB_BY_ID[active]}
            onTabChange={tab => setActive(TI_ID_BY_TAB[tab])}
          />
        );

      case 'epicerie-config':
      case 'epicerie-dashboard':
      case 'epicerie-orders':
      case 'epicerie-next-order':
      case 'epicerie-flyer':
      case 'epicerie-search':
      case 'epicerie-agent-log':
      case 'epicerie-readme':
        return (
          <Epicerie
            activeTab={EP_TAB_BY_ID[active]}
            onTabChange={tab => setActive(EP_ID_BY_TAB[tab])}
          />
        );

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

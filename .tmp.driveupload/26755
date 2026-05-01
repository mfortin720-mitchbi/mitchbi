import { supabase } from '../services/supabase';

const MODULE_TITLES = {
  briefing:    { title: 'Morning Briefing',  subtitle: 'Ton résumé AI du jour' },
  analytics:   { title: 'Analytics Hub',     subtitle: 'Google Ads · GA4 · Shopify' },
  trader:      { title: 'Trader Desk',       subtitle: 'Portfolio & marchés en temps réel' },
  query:       { title: 'NL Query Engine',   subtitle: 'BigQuery · Snowflake' },
  scripts:     { title: 'Script Studio',     subtitle: 'Python · SQL · JavaScript' },
  invoices:    { title: 'Invoice Manager',   subtitle: 'Gestion des factures' },
  scraper:     { title: 'Content Scraper',   subtitle: 'Scraping & génération de contenu AI' },
  assistant:   { title: 'AI Assistant',      subtitle: 'Ton conseiller NexusIQ' },
  connections: { title: 'Connections',       subtitle: 'Gérer tes sources de données' },
  users:       { title: 'Users & Access',    subtitle: 'RBAC · Permissions · Audit' },
  settings:    { title: 'Settings',          subtitle: 'Configuration de MitchBI' },
};

export default function Topbar({ active, session }) {
  const mod = MODULE_TITLES[active] || MODULE_TITLES.briefing;
  const email = session?.user?.email || '';
  const initials = email.slice(0, 2).toUpperCase();
  const today = new Date().toLocaleDateString('fr-CA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  return (
    <div style={{
      height: 60,
      background: '#0f1117',
      borderBottom: '0.5px solid #1e2130',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 24px',
      flexShrink: 0
    }}>
      {/* Left — module title */}
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>{mod.title}</div>
        <div style={{ fontSize: 11, color: '#444', marginTop: 1 }}>{today} · {mod.subtitle}</div>
      </div>

      {/* Right — user + logout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 12, color: '#555' }}>{email}</div>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: '#378ADD', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, color: '#fff'
        }}>
          {initials}
        </div>
        <button onClick={() => supabase.auth.signOut()} style={{
          padding: '5px 12px', borderRadius: 6,
          border: '0.5px solid #2a2d3a', background: 'transparent',
          color: '#555', cursor: 'pointer', fontSize: 12
        }}>
          Logout
        </button>
      </div>
    </div>
  );
}
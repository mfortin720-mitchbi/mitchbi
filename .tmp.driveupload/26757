import { useState } from 'react';

const MENU_ITEMS = [
  { id: 'briefing',   icon: '☀',  label: 'Morning Briefing' },
  { id: 'analytics',  icon: '◈',  label: 'Analytics Hub' },
  { id: 'trader',     icon: '▲',  label: 'Trader Desk' },
  { id: 'query',      icon: '⬡',  label: 'NL Query Engine' },
  { id: 'scripts',    icon: '⟨⟩', label: 'Script Studio' },
  { id: 'invoices',   icon: '✉',  label: 'Invoice Manager' },
  { id: 'scraper',    icon: '◎',  label: 'Content Scraper' },
  { id: 'assistant',  icon: '✦',  label: 'AI Assistant' },
];

const BOTTOM_ITEMS = [
  { id: 'connections', icon: '⚡', label: 'Connections' },
  { id: 'users',       icon: '👥', label: 'Users & Access' },
  { id: 'settings',    icon: '⚙',  label: 'Settings' },
];

export default function Sidebar({ active, onNavigate, collapsed, onToggle }) {
  return (
    <div style={{
      width: collapsed ? 52 : 220,
      minHeight: '100vh',
      background: '#13151f',
      borderRight: '0.5px solid #1e2130',
      display: 'flex',
      flexDirection: 'column',
      transition: 'width 0.2s ease',
      flexShrink: 0,
      position: 'relative'
    }}>
      {/* Logo */}
      <div style={{
        padding: collapsed ? '18px 14px' : '18px 20px',
        borderBottom: '0.5px solid #1e2130',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        {!collapsed && (
          <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px' }}>
            Mitch<span style={{ color: '#378ADD' }}>BI</span>
          </div>
        )}
        <button onClick={onToggle} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#555', fontSize: 14, padding: 0,
          marginLeft: collapsed ? 'auto' : 0
        }}>
          {collapsed ? '▶' : '◀'}
        </button>
      </div>

      {/* Main nav */}
      <nav style={{ flex: 1, padding: '8px 0' }}>
        {!collapsed && (
          <div style={{ padding: '8px 20px 4px', fontSize: 10, color: '#444', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Modules
          </div>
        )}
        {MENU_ITEMS.map(item => (
          <button key={item.id} onClick={() => onNavigate(item.id)} style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: collapsed ? '10px 16px' : '9px 20px',
            background: active === item.id ? '#1a1d2e' : 'transparent',
            border: 'none',
            borderLeft: active === item.id ? '2px solid #378ADD' : '2px solid transparent',
            cursor: 'pointer',
            color: active === item.id ? '#fff' : '#555',
            fontSize: 13,
            textAlign: 'left',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
            overflow: 'hidden'
          }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>

      {/* Bottom nav */}
      <div style={{ borderTop: '0.5px solid #1e2130', padding: '8px 0' }}>
        {BOTTOM_ITEMS.map(item => (
          <button key={item.id} onClick={() => onNavigate(item.id)} style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: collapsed ? '9px 16px' : '9px 20px',
            background: active === item.id ? '#1a1d2e' : 'transparent',
            border: 'none',
            borderLeft: active === item.id ? '2px solid #378ADD' : '2px solid transparent',
            cursor: 'pointer',
            color: active === item.id ? '#fff' : '#444',
            fontSize: 13,
            textAlign: 'left',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
            overflow: 'hidden'
          }}>
            <span style={{ fontSize: 15, flexShrink: 0 }}>{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </div>

      {/* Version */}
      {!collapsed && (
        <div style={{ padding: '10px 20px', fontSize: 10, color: '#333', borderTop: '0.5px solid #1e2130' }}>
          MitchBI v1.0 — AI Command Center
        </div>
      )}
    </div>
  );
}
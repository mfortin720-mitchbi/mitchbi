// Autres modules (briefing/analytics/query/scripts/scraper/assistant/connections/users/settings)
// temporairement retirés de la nav — seuls Trader Desk et Trading Imperium sont utilisés pour l'instant.
// Le code des pages reste en place, prêt à être réactivé.
const MENU_ITEMS = [
  { id: 'trader',     icon: '▲',  label: 'Trader Desk' },
  {
    id: 'trading-imperium', icon: '♛', label: 'Trading Imperium',
    subItems: [
      { id: 'trading-imperium', label: 'Vue d’ensemble' },
      { id: 'trading-imperium-trades', label: 'Trades' },
      { id: 'trading-imperium-events', label: 'Événements' },
    ]
  },
];

const BOTTOM_ITEMS = [
  { id: 'readme', icon: '📖', label: 'README' },
];

const NavButton = ({ item, active, onNavigate, collapsed, indent }) => (
  <button onClick={() => onNavigate(item.id)} style={{
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: collapsed ? '9px 16px' : `9px 20px 9px ${indent ? 36 : 20}px`,
    background: active ? '#1a1d2e' : 'transparent',
    border: 'none',
    borderLeft: active ? '2px solid #378ADD' : '2px solid transparent',
    cursor: 'pointer',
    color: active ? '#fff' : (indent ? '#666' : '#555'),
    fontSize: indent ? 12 : 13,
    textAlign: 'left',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
    overflow: 'hidden'
  }}>
    {item.icon && <span style={{ fontSize: 15, flexShrink: 0 }}>{item.icon}</span>}
    {!collapsed && <span>{item.label}</span>}
  </button>
);

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
        {MENU_ITEMS.map(item => {
          const isActiveGroup = item.subItems ? item.subItems.some(s => s.id === active) : active === item.id;
          return (
            <div key={item.id}>
              <NavButton item={item} active={isActiveGroup && !item.subItems} onNavigate={onNavigate} collapsed={collapsed} />
              {item.subItems && isActiveGroup && !collapsed && item.subItems.map(sub => (
                <NavButton key={sub.id} item={sub} active={active === sub.id} onNavigate={onNavigate} collapsed={collapsed} indent />
              ))}
            </div>
          );
        })}
      </nav>

      {/* Bottom nav */}
      {BOTTOM_ITEMS.length > 0 && (
        <div style={{ borderTop: '0.5px solid #1e2130', padding: '8px 0' }}>
          {BOTTOM_ITEMS.map(item => (
            <NavButton key={item.id} item={item} active={active === item.id} onNavigate={onNavigate} collapsed={collapsed} />
          ))}
        </div>
      )}

      {/* Version */}
      {!collapsed && (
        <div style={{ padding: '10px 20px', fontSize: 10, color: '#333', borderTop: '0.5px solid #1e2130' }}>
          MitchBI v1.0 — AI Command Center
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '../services/api';

const BLUE = '#378ADD';
const GREEN = '#1D9E75';
const RED = '#D85A30';
const GOLD = '#E8A838';
const MUTED = '#8b93a5';

const card = { background: '#1a1d27', borderRadius: 12, border: '0.5px solid #1e2130', padding: 20 };
const label = { fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 };
const input = {
  background: '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6, color: '#fff',
  padding: '7px 10px', fontSize: 13, outline: 'none',
};
const btn = (bg) => ({
  background: bg, border: 'none', borderRadius: 6, color: '#fff', padding: '7px 14px',
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
});
const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '0.5px solid #1e2130' };
const thCompact = { ...th, padding: '5px 8px', textAlign: 'left' };
const tdCompact = { padding: '5px 8px', fontSize: 11, color: '#ddd', borderBottom: '0.5px solid #1e2130', textAlign: 'left' };

const RULE_BADGE = {
  blacklisted: { label: 'Blacklisté', bg: '#2b0d0d', color: '#D85A30' },
  whitelisted: { label: 'Whitelisté', bg: '#0d2b1a', color: '#1D9E75' },
};

// next_grocery_config -- cycle de planification ponctuel consomme par la
// skill externe maxi-reco-items (voir grocery_agent_log). Budget et
// presence Julie/Eliane sont derives en lecture (grocery_config +
// grocery_household_config), jamais saisis ici -- source unique ailleurs.
const NEXT_CONFIG_DEFAULTS = {
  target_date_or_week: '', dinner_count: '', additional_people_count: 0, max_prep_time: '',
  meal_types: [], temporary_preferences: '', temporary_exclusions: '',
  recurring_whitelist_policy: 'probably_needed', substitution_policy: '', notes: '',
};
// Michel controle: draft, ready, changes_requested, approved, cancelled.
// maxi-reco-items controle: recommendation_in_progress, recommendation_ready,
// queue_updated, completed, error. Un changement de statut ne declenche
// jamais d'execution automatique.
const NEXT_CONFIG_STATUS_LABELS = {
  draft: 'Brouillon',
  ready: 'Prêt pour maxi-reco-items',
  recommendation_in_progress: 'Recommandation en cours (agent)',
  recommendation_ready: 'Recommandation prête à réviser',
  changes_requested: 'Ajustements demandés',
  approved: 'Approuvé',
  queue_updated: 'Queue mise à jour (agent)',
  completed: 'Complété',
  cancelled: 'Annulé',
  error: 'Erreur',
};
const RECURRING_POLICY_LABELS = {
  all: 'Tous les récurrents/whitelist',
  probably_needed: 'Probablement nécessaires seulement',
  none: 'Aucun ajout automatique',
};
const MAX_PREP_TIME_LABELS = {
  under_20: 'Moins de 20 minutes',
  '20_to_40': '20 à 40 minutes',
  up_to_60: "Jusqu'à 60 minutes",
  no_preference: 'Sans préférence',
};
const SUBSTITUTION_POLICY_LABELS = {
  none: 'Aucune substitution',
  comparable_brand: 'Marque comparable',
  comparable_brand_and_format: 'Marque et format comparables',
  ask_each_time: 'Demander avant chaque remplacement',
};
const MEAL_TYPE_LABELS = {
  best_specials: 'Meilleurs spéciaux, sans préférence',
  meat: 'Viande',
  fish_seafood: 'Poisson et fruits de mer',
  vegetarian: 'Végétarien',
  ready_to_cook: 'Repas préparés ou prêts à cuire',
};
const fieldLabel = { fontSize: 11, color: MUTED, display: 'block', marginBottom: 4 };
// Toutes les commandes en ligne passent par Clémenceau (confirmé en pratique) --
// le stock_status du circulaire n'est pertinent que pour le magasin selectionne ici.
const STORE_LABELS = {
  '8923': 'Beauport Clémenceau',
  '8981': 'Charlesbourg Louis-XIV',
};
function RuleBadge({ blacklisted, whitelisted }) {
  if (blacklisted) return <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: RULE_BADGE.blacklisted.bg, color: RULE_BADGE.blacklisted.color }}>Blacklisté</span>;
  if (whitelisted) return <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: RULE_BADGE.whitelisted.bg, color: RULE_BADGE.whitelisted.color }}>Whitelisté</span>;
  return null;
}

// Boutons blacklist/whitelist reutilises dans Dashboard et Prochaine commande --
// onRule reçoit ('blacklisted'|'whitelisted') et fait le POST /product-rules
function RuleActions({ blacklisted, whitelisted, onRule, disabled }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <button
        title="Blacklister"
        onClick={() => onRule(blacklisted ? null : 'blacklisted')}
        disabled={disabled}
        style={{ ...btn(blacklisted ? RED : '#333'), padding: '3px 8px', fontSize: 11 }}
      >
        🚫
      </button>
      <button
        title="Whitelister"
        onClick={() => onRule(whitelisted ? null : 'whitelisted')}
        disabled={disabled}
        style={{ ...btn(whitelisted ? GREEN : '#333'), padding: '3px 8px', fontSize: 11 }}
      >
        ⭐
      </button>
    </div>
  );
}
const td = { padding: '8px 10px', fontSize: 13, color: '#ddd', borderBottom: '0.5px solid #1e2130' };

// Bookmarklet -- doit être glissé dans la barre de favoris et cliqué
// DEPUIS maxi.ca (même origine requise pour lire le cookie AccessToken).
// Une page mitchbi.com ne peut pas l'exécuter dans un onglet maxi.ca ouvert
// depuis ici -- restriction cross-origin du navigateur, pas contournable.
const BOOKMARKLET = `javascript:(function(){const name="AccessToken=";const decodedCookie=decodeURIComponent(document.cookie);const ca=decodedCookie.split(';');let token="";for(let i=0;i<ca.length;i++){let c=ca[i].trim();if(c.indexOf(name)===0){token=c.substring(name.length,c.length);break;}}if(token){navigator.clipboard.writeText(token).then(()=>{alert("✅ AccessToken copié dans le presse-papier !");}).catch(()=>{prompt("Voici votre AccessToken :",token);});}else{alert("❌ Cookie 'AccessToken' introuvable dans document.cookie.");}})();`;

const TABS = [
  { id: 'config', label: 'Config' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'orders', label: 'Commandes' },
  { id: 'next-order', label: 'Prochaine commande' },
  { id: 'flyer', label: 'Circulaire' },
  { id: 'search', label: 'Recherche' },
  { id: 'agent-log', label: 'Journal des agents' },
  { id: 'readme', label: 'README' },
];

// Reprend le theme sombre de l'app pour le rendu Markdown des messages du
// journal des agents (meme pattern que Assistant.jsx).
const LOG_MARKDOWN_COMPONENTS = {
  p: ({ children }) => <p style={{ margin: '4px 0' }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: 20 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: 20 }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
  code: ({ inline, children }) => inline
    ? <code style={{ background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 4, padding: '1px 5px', fontSize: 11.5, color: BLUE }}>{children}</code>
    : <code>{children}</code>,
  pre: ({ children }) => <pre style={{ background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 8, padding: 10, overflowX: 'auto', fontSize: 11.5, margin: '6px 0' }}>{children}</pre>,
  a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: BLUE }}>{children}</a>,
  hr: () => <hr style={{ border: 'none', borderTop: '0.5px solid #1e2130', margin: '8px 0' }} />,
  strong: ({ children }) => <strong style={{ color: '#fff' }}>{children}</strong>,
  h1: ({ children }) => <div style={{ color: BLUE, fontWeight: 700, fontSize: 14, margin: '8px 0 4px' }}>{children}</div>,
  h2: ({ children }) => <div style={{ color: BLUE, fontWeight: 600, fontSize: 13, margin: '8px 0 4px' }}>{children}</div>,
  h3: ({ children }) => <div style={{ color: BLUE, fontWeight: 600, fontSize: 13, margin: '6px 0 4px' }}>{children}</div>,
};

export default function Epicerie({ activeTab = 'dashboard', onTabChange }) {
  return (
    <div>
      <style>{`
        .ep-thumb { transition: transform 0.15s ease; cursor: zoom-in; position: relative; }
        .ep-thumb:hover { transform: scale(1.8); z-index: 30; }
      `}</style>
      {/* Onglets -- redondants avec la sidebar mais utiles si on arrive ici sans passer par elle */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '0.5px solid #1e2130' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTabChange?.(t.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 16px', fontSize: 13,
              color: activeTab === t.id ? '#fff' : MUTED,
              borderBottom: activeTab === t.id ? `2px solid ${BLUE}` : '2px solid transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'config' && <ConfigTab />}
      {activeTab === 'dashboard' && <DashboardTab />}
      {activeTab === 'orders' && <OrdersTab />}
      {activeTab === 'next-order' && <NextOrderTab />}
      {activeTab === 'flyer' && <FlyerTab />}
      {activeTab === 'search' && <SearchTab />}
      {activeTab === 'agent-log' && <AgentLogTab />}
      {activeTab === 'readme' && <EpicerieReadmeTab />}
    </div>
  );
}

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

function ConfigTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [thresholdInput, setThresholdInput] = useState('');
  const [priceCompareInput, setPriceCompareInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [tokenExpiresInput, setTokenExpiresInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [genMessage, setGenMessage] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [flyerMessage, setFlyerMessage] = useState('');
  const [refreshingFlyer, setRefreshingFlyer] = useState(false);
  const [budgetInputs, setBudgetInputs] = useState({ tier_1_min: '40', tier_1_max: '100', tier_2_min: '100', tier_2_max: '160', tier_3_min: '160', tier_3_max: '220' });
  const [selectedTier, setSelectedTier] = useState('1');
  const [showTierSettings, setShowTierSettings] = useState(false);
  const [newBlacklistRule, setNewBlacklistRule] = useState({ article_number: '', notes: '' });
  const bookmarkletRef = useRef(null);
  const [nextConfig, setNextConfig] = useState(null);
  const [nextConfigForm, setNextConfigForm] = useState(NEXT_CONFIG_DEFAULTS);
  const [savingNextConfig, setSavingNextConfig] = useState(false);

  const loadNextConfig = useCallback(async () => {
    const res = await apiFetch('/api/epicerie/next-config');
    const json = await res.json();
    if (json.success) {
      setNextConfig(json.config);
      if (json.config) {
        setNextConfigForm({
          target_date_or_week: json.config.target_date_or_week || '',
          dinner_count: json.config.dinner_count ?? '',
          additional_people_count: json.config.additional_people_count ?? 0,
          max_prep_time: json.config.max_prep_time || '',
          meal_types: json.config.meal_types || [],
          temporary_preferences: json.config.temporary_preferences || '',
          temporary_exclusions: json.config.temporary_exclusions || '',
          recurring_whitelist_policy: json.config.recurring_whitelist_policy || 'probably_needed',
          substitution_policy: json.config.substitution_policy || '',
          notes: json.config.notes || '',
        });
      }
    }
  }, []);

  useEffect(() => { loadNextConfig(); }, [loadNextConfig]);

  const toggleMealType = (key) => {
    setNextConfigForm((prev) => ({
      ...prev,
      meal_types: prev.meal_types.includes(key) ? prev.meal_types.filter((m) => m !== key) : [...prev.meal_types, key],
    }));
  };

  const saveNextConfig = async (statusOverride) => {
    setSavingNextConfig(true);
    try {
      const payload = {
        ...nextConfigForm,
        dinner_count: nextConfigForm.dinner_count !== '' ? parseInt(nextConfigForm.dinner_count, 10) : null,
        additional_people_count: parseInt(nextConfigForm.additional_people_count, 10) || 0,
        max_prep_time: nextConfigForm.max_prep_time || null,
        target_date_or_week: nextConfigForm.target_date_or_week || null,
      };
      if (statusOverride) payload.status = statusOverride;
      const url = nextConfig ? `/api/epicerie/next-config/${nextConfig.id}` : '/api/epicerie/next-config';
      const method = nextConfig ? 'PUT' : 'POST';
      const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (json.success) setNextConfig(json.config);
    } finally {
      setSavingNextConfig(false);
    }
  };

  const startNewPlanning = () => {
    setNextConfig(null);
    setNextConfigForm(NEXT_CONFIG_DEFAULTS);
  };

  // React sanitise/bloque tout href="javascript:..." passe en prop JSX (protection
  // anti-XSS) -- le lien "bookmarklet" deviendrait un no-op qui throw. Seul un
  // setAttribute impératif sur le noeud DOM réel contourne cette protection.
  useEffect(() => {
    if (bookmarkletRef.current) bookmarkletRef.current.setAttribute('href', BOOKMARKLET);
  }, []);
  const [newWhitelistRule, setNewWhitelistRule] = useState({ article_number: '', notes: '', category: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/epicerie/config');
      const json = await res.json();
      if (json.success) {
        setData(json);
        const threshold = json.config.find((c) => c.key === 'list_frequency_threshold');
        setThresholdInput(threshold ? String(Math.round(parseFloat(threshold.value) * 100)) : '15');
        const priceCompare = json.config.find((c) => c.key === 'price_compare_duration_months');
        setPriceCompareInput(priceCompare ? priceCompare.value : '6');
        const get = (key, fallback) => json.config.find((c) => c.key === key)?.value ?? fallback;
        setBudgetInputs({
          tier_1_min: get('grocery_budget_tier_1_min', '40'),
          tier_1_max: get('grocery_budget_tier_1_max', '100'),
          tier_2_min: get('grocery_budget_tier_2_min', '100'),
          tier_2_max: get('grocery_budget_tier_2_max', '160'),
          tier_3_min: get('grocery_budget_tier_3_min', '160'),
          tier_3_max: get('grocery_budget_tier_3_max', '220'),
        });
        setSelectedTier(get('grocery_budget_tier_selected', '1'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveThreshold = async () => {
    setSaving(true);
    setGenMessage('');
    try {
      const value = (parseFloat(thresholdInput) / 100).toString();
      await apiFetch('/api/epicerie/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'list_frequency_threshold', value }),
      });
      // le seuil affecte directement quels produits qualifient -- on
      // recalcule la prochaine commande tout de suite plutôt que de la
      // laisser désynchronisée jusqu'au prochain cron
      const res = await apiFetch('/api/epicerie/generate-list', { method: 'POST' });
      const json = await res.json();
      if (json.success) setGenMessage(`Liste recalculée : ${json.count} produits pour le ${json.week_of}.`);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const savePriceCompare = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'price_compare_duration_months', value: priceCompareInput }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const saveBudgetTiers = async () => {
    setSaving(true);
    try {
      await Promise.all(
        Object.entries(budgetInputs).map(([suffix, value]) =>
          apiFetch('/api/epicerie/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: `grocery_budget_${suffix}`, value }),
          })
        )
      );
      await load();
    } finally {
      setSaving(false);
    }
  };

  const selectBudgetTier = async (tier) => {
    setSelectedTier(tier);
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'grocery_budget_tier_selected', value: tier }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const selectStore = async (storeId) => {
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'maxi_store_id', value: storeId }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const saveHousehold = async (patch) => {
    setSaving(true);
    try {
      const current = data?.household || {};
      await apiFetch('/api/epicerie/household-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eliane_present_week: current.eliane_present_week || false,
          julie_present_week: current.julie_present_week || false,
          next_pattern_date: current.next_pattern_date || null,
          ...patch,
        }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const saveToken = async () => {
    if (!tokenInput.trim()) return;
    setSaving(true);
    setSyncMessage('Synchronisation des commandes en cours...');
    try {
      const res = await apiFetch('/api/epicerie/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim(), expires_at: tokenExpiresInput || null }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setSyncMessage(`Erreur: ${json.error || res.status}`);
        return;
      }
      setSyncMessage(json.sync?.success ? json.sync.message : `Erreur de synchronisation: ${json.sync?.error || 'inconnue'}`);
      setTokenInput('');
      setTokenExpiresInput('');
      await load();
    } catch (err) {
      setSyncMessage(`Erreur: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setSyncMessage('Synchronisation des commandes en cours...');
    try {
      const res = await apiFetch('/api/epicerie/sync-orders', { method: 'POST' });
      const json = await res.json();
      setSyncMessage(json.success ? json.message : `Erreur: ${json.error || res.status}`);
    } catch (err) {
      setSyncMessage(`Erreur: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const refreshFlyer = async () => {
    setRefreshingFlyer(true);
    setFlyerMessage('Récupération du circulaire en cours (~15-20s)...');
    try {
      const res = await apiFetch('/api/epicerie/refresh-flyer', { method: 'POST' });
      const json = await res.json();
      setFlyerMessage(json.success ? json.message : `Erreur: ${json.error || res.status}`);
      await load();
    } catch (err) {
      setFlyerMessage(`Erreur: ${err.message}`);
    } finally {
      setRefreshingFlyer(false);
    }
  };

  const deleteRule = async (id) => {
    setSaving(true);
    try {
      await apiFetch(`/api/epicerie/product-rules/${id}`, { method: 'DELETE' });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const addBlacklistRule = async () => {
    if (!newBlacklistRule.article_number.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newBlacklistRule, blacklisted: true, whitelisted: false }),
      });
      setNewBlacklistRule({ article_number: '', notes: '' });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const addWhitelistRule = async () => {
    if (!newWhitelistRule.article_number.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newWhitelistRule, blacklisted: false, whitelisted: true }),
      });
      setNewWhitelistRule({ article_number: '', notes: '', category: '' });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const updateRuleCategory = async (rule, category) => {
    setSaving(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_number: rule.article_number,
          blacklisted: rule.blacklisted,
          whitelisted: rule.whitelisted,
          category,
        }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ color: MUTED, fontSize: 13 }}>Chargement...</div>;

  const household = data?.household || {};
  const token = data?.token || { present: false };
  const flyerLastSynced = data?.config.find((c) => c.key === 'flyer_last_synced_at')?.value;
  const flyerStoreId = data?.config.find((c) => c.key === 'maxi_store_id')?.value || '8981';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      {/* Paliers de budget -- pour le prochain panier */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={label}>Palier de budget — prochain panier</div>
          <button style={{ ...btn('#333'), padding: '4px 10px', fontSize: 11 }} onClick={() => setShowTierSettings((v) => !v)}>
            {showTierSettings ? 'Fermer' : '⚙ Modifier les paliers'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>
          Sélectionne le palier qui définit combien de produits l'algo de génération doit viser pour la prochaine commande.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: showTierSettings ? 16 : 0 }}>
          {['1', '2', '3'].map((tier) => (
            <button key={tier} onClick={() => selectBudgetTier(tier)} disabled={saving}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                border: selectedTier === tier ? `1px solid ${BLUE}` : '0.5px solid #2a2e3f',
                background: selectedTier === tier ? '#1a1a2b' : '#0f1117',
              }}>
              <div style={{ fontSize: 13, color: selectedTier === tier ? '#fff' : '#ddd', fontWeight: 600 }}>Palier {tier}</div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{budgetInputs[`tier_${tier}_min`]}$ à {budgetInputs[`tier_${tier}_max`]}$</div>
            </button>
          ))}
        </div>
        {showTierSettings && (
          <div style={{ borderTop: '0.5px solid #2a2e3f', paddingTop: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {['1', '2', '3'].map((tier) => (
                <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#ddd' }}>
                  <span style={{ width: 60 }}>Palier {tier}</span>
                  <input style={{ ...input, width: 70 }} type="number" min="0" value={budgetInputs[`tier_${tier}_min`]}
                    onChange={(e) => setBudgetInputs({ ...budgetInputs, [`tier_${tier}_min`]: e.target.value })} />
                  <span style={{ color: MUTED }}>$ à</span>
                  <input style={{ ...input, width: 70 }} type="number" min="0" value={budgetInputs[`tier_${tier}_max`]}
                    onChange={(e) => setBudgetInputs({ ...budgetInputs, [`tier_${tier}_max`]: e.target.value })} />
                  <span style={{ color: MUTED }}>$</span>
                </div>
              ))}
            </div>
            <button style={btn(BLUE)} onClick={saveBudgetTiers} disabled={saving}>Sauvegarder les paliers</button>
          </div>
        )}
      </div>

      {/* next_grocery_config -- cycle de planification ponctuel pour maxi-reco-items */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={label}>Planification prochain repas</div>
          {nextConfig && (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: '#1a1a2b', color: BLUE }}>
              {NEXT_CONFIG_STATUS_LABELS[nextConfig.status] || nextConfig.status}
            </span>
          )}
        </div>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>
          Config ponctuelle consommée par l'agent externe maxi-reco-items.
        </p>

        {nextConfig && (
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12, padding: '8px 12px', background: '#0f1117', borderRadius: 6, fontSize: 12 }}>
            <span style={{ color: '#ddd' }}>
              Palier {nextConfig.budget_tier_selected} ({nextConfig.budget_min}$-{nextConfig.budget_max}$)
            </span>
            <span style={{ color: '#ddd' }}>
              {nextConfig.people_count} portion(s) — Julie {nextConfig.julie_present ? '✓' : '✗'}, Éliane {nextConfig.eliane_present ? '✓' : '✗'}
            </span>
            <a href="#presence-semaine" style={{ color: BLUE, fontSize: 11 }}
              onClick={(ev) => { ev.preventDefault(); document.getElementById('presence-semaine')?.scrollIntoView({ behavior: 'smooth' }); }}>
              Ajuster la présence →
            </a>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={fieldLabel}>Date/semaine visée</label>
            <input type="date" style={{ ...input, width: '100%' }} value={nextConfigForm.target_date_or_week}
              onChange={(e) => setNextConfigForm({ ...nextConfigForm, target_date_or_week: e.target.value })} />
          </div>
          <div>
            <label style={fieldLabel}>Nombre de soupers (0-7)</label>
            <input type="number" min="0" max="7" style={{ ...input, width: '100%' }} value={nextConfigForm.dinner_count}
              onChange={(e) => setNextConfigForm({ ...nextConfigForm, dinner_count: e.target.value })} />
          </div>
          <div>
            <label style={fieldLabel}>+ personnes additionnelles (0-5)</label>
            <input type="number" min="0" max="5" style={{ ...input, width: '100%' }} value={nextConfigForm.additional_people_count}
              onChange={(e) => setNextConfigForm({ ...nextConfigForm, additional_people_count: e.target.value })} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={fieldLabel}>Temps de préparation</label>
            <select style={{ ...input, width: '100%' }} value={nextConfigForm.max_prep_time}
              onChange={(e) => setNextConfigForm({ ...nextConfigForm, max_prep_time: e.target.value })}>
              <option value="">—</option>
              {Object.keys(MAX_PREP_TIME_LABELS).map((k) => <option key={k} value={k}>{MAX_PREP_TIME_LABELS[k]}</option>)}
            </select>
          </div>
          <div>
            <label style={fieldLabel}>Politique récurrents/whitelist</label>
            <select style={{ ...input, width: '100%' }} value={nextConfigForm.recurring_whitelist_policy}
              onChange={(e) => setNextConfigForm({ ...nextConfigForm, recurring_whitelist_policy: e.target.value })}>
              {Object.keys(RECURRING_POLICY_LABELS).map((k) => <option key={k} value={k}>{RECURRING_POLICY_LABELS[k]}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={fieldLabel}>Types de repas (choix multiples)</label>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {Object.keys(MEAL_TYPE_LABELS).map((k) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ddd', cursor: 'pointer' }}>
                <input type="checkbox" checked={nextConfigForm.meal_types.includes(k)} onChange={() => toggleMealType(k)} />
                {MEAL_TYPE_LABELS[k]}
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={fieldLabel}>Politique de substitution</label>
          <select style={{ ...input, width: '100%' }} value={nextConfigForm.substitution_policy}
            onChange={(e) => setNextConfigForm({ ...nextConfigForm, substitution_policy: e.target.value })}>
            <option value="">—</option>
            {Object.keys(SUBSTITUTION_POLICY_LABELS).map((k) => <option key={k} value={k}>{SUBSTITUTION_POLICY_LABELS[k]}</option>)}
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={fieldLabel}>Préférences ponctuelles</label>
            <input style={{ ...input, width: '100%' }} value={nextConfigForm.temporary_preferences}
              onChange={(e) => setNextConfigForm({ ...nextConfigForm, temporary_preferences: e.target.value })} />
          </div>
          <div>
            <label style={fieldLabel}>Exclusions ponctuelles</label>
            <input style={{ ...input, width: '100%' }} value={nextConfigForm.temporary_exclusions}
              onChange={(e) => setNextConfigForm({ ...nextConfigForm, temporary_exclusions: e.target.value })} />
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={fieldLabel}>Notes</label>
          <input style={{ ...input, width: '100%' }} value={nextConfigForm.notes}
            onChange={(e) => setNextConfigForm({ ...nextConfigForm, notes: e.target.value })} />
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {(!nextConfig || ['draft', 'ready'].includes(nextConfig.status)) && (
            <>
              <button style={btn(BLUE)} onClick={() => saveNextConfig()} disabled={savingNextConfig}>Enregistrer le brouillon</button>
              <button style={btn(GREEN)} onClick={() => saveNextConfig('ready')} disabled={savingNextConfig}>Prêt pour maxi-reco-items</button>
            </>
          )}
          {nextConfig && nextConfig.status === 'recommendation_ready' && (
            <>
              <button style={btn('#333')} onClick={() => saveNextConfig('changes_requested')} disabled={savingNextConfig}>Demander des ajustements</button>
              <button style={btn(GREEN)} onClick={() => saveNextConfig('approved')} disabled={savingNextConfig}>Approuver</button>
            </>
          )}
          {nextConfig && !['completed', 'cancelled'].includes(nextConfig.status) && (
            <button style={{ ...btn(RED), opacity: 0.85 }} onClick={() => saveNextConfig('cancelled')} disabled={savingNextConfig}>Annuler</button>
          )}
          {nextConfig && ['completed', 'cancelled'].includes(nextConfig.status) && (
            <button style={btn(BLUE)} onClick={startNewPlanning} disabled={savingNextConfig}>Nouvelle planification</button>
          )}
        </div>
      </div>

      {/* Presence Eliane/Julie */}
      <div id="presence-semaine" style={card}>
        <div style={label}>Présence cette semaine</div>
        <div style={{ display: 'flex', gap: 24, marginTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ddd', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!household.eliane_present_week}
              onChange={(e) => saveHousehold({ eliane_present_week: e.target.checked })} />
            Éliane présente
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ddd', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!household.julie_present_week}
              onChange={(e) => saveHousehold({ julie_present_week: e.target.checked })} />
            Julie présente
          </label>
        </div>
      </div>

      {/* Blacklist */}
      <div style={card}>
        <div style={label}>Blacklist — jamais dans la liste</div>
        {(data?.rules || []).filter((r) => r.blacklisted).length === 0 && (
          <p style={{ fontSize: 12, color: MUTED }}>Aucun produit blacklisté.</p>
        )}
        {(data?.rules || []).filter((r) => r.blacklisted).map((r) => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '0.5px solid #1e2130', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
              {r.image_url && <img className="ep-thumb" src={r.image_url} alt="" style={{ width: 40, height: 40, objectFit: 'contain', borderRadius: 4, background: '#fff' }} />}
              <div>
                <div style={{ fontSize: 13, color: '#ddd', textTransform: 'lowercase' }}>{r.product_name || r.article_number}</div>
                <div style={{ fontSize: 11, color: MUTED, fontFamily: 'monospace' }}>{r.article_number}</div>
                {r.notes && <div style={{ fontSize: 11, color: MUTED }}>{r.notes}</div>}
              </div>
            </div>
            <button style={btn('#333')} onClick={() => deleteRule(r.id)} disabled={saving}>Retirer</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input style={{ ...input, flex: 1 }} placeholder="Numéro d'article (ex: 20026703001)"
            value={newBlacklistRule.article_number} onChange={(e) => setNewBlacklistRule({ ...newBlacklistRule, article_number: e.target.value })} />
          <input style={{ ...input, flex: 1 }} placeholder="Note (optionnel)"
            value={newBlacklistRule.notes} onChange={(e) => setNewBlacklistRule({ ...newBlacklistRule, notes: e.target.value })} />
          <button style={btn(RED)} onClick={addBlacklistRule} disabled={saving || !newBlacklistRule.article_number.trim()}>+ Blacklister</button>
        </div>
      </div>

      {/* Whitelist */}
      <div style={card}>
        <div style={label}>Whitelist — toujours dans la liste, même sous le seuil</div>
        {(data?.rules || []).filter((r) => r.whitelisted).length === 0 && (
          <p style={{ fontSize: 12, color: MUTED }}>Aucun produit whitelisté.</p>
        )}
        {(data?.rules || []).filter((r) => r.whitelisted).map((r) => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '0.5px solid #1e2130', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
              {r.image_url && <img className="ep-thumb" src={r.image_url} alt="" style={{ width: 40, height: 40, objectFit: 'contain', borderRadius: 4, background: '#fff' }} />}
              <div>
                <div style={{ fontSize: 13, color: '#ddd', textTransform: 'lowercase' }}>{r.product_name || r.article_number}</div>
                <div style={{ fontSize: 11, color: MUTED, fontFamily: 'monospace' }}>{r.article_number}</div>
                {r.notes && <div style={{ fontSize: 11, color: MUTED }}>{r.notes}</div>}
              </div>
            </div>
            <select style={{ ...input, padding: '3px 6px', fontSize: 11, width: 160 }} value={r.category || ''}
              onChange={(e) => updateRuleCategory(r, e.target.value || null)} disabled={saving}>
              <option value="">Non classifié</option>
              {PERSON_OPTIONS.map((p) => <option key={p} value={p}>{PERSON_LABELS[p]}</option>)}
            </select>
            <button style={btn('#333')} onClick={() => deleteRule(r.id)} disabled={saving}>Retirer</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input style={{ ...input, flex: 1 }} placeholder="Numéro d'article (ex: 20026703001)"
            value={newWhitelistRule.article_number} onChange={(e) => setNewWhitelistRule({ ...newWhitelistRule, article_number: e.target.value })} />
          <input style={{ ...input, flex: 1 }} placeholder="Note (optionnel)"
            value={newWhitelistRule.notes} onChange={(e) => setNewWhitelistRule({ ...newWhitelistRule, notes: e.target.value })} />
          <select style={{ ...input, width: 160 }} value={newWhitelistRule.category}
            onChange={(e) => setNewWhitelistRule({ ...newWhitelistRule, category: e.target.value })}>
            <option value="">Non classifié</option>
            {PERSON_OPTIONS.map((p) => <option key={p} value={p}>{PERSON_LABELS[p]}</option>)}
          </select>
          <button style={btn(GREEN)} onClick={addWhitelistRule} disabled={saving || !newWhitelistRule.article_number.trim()}>+ Whitelister</button>
        </div>
      </div>

      {/* Seuil de generation */}
      <div style={card}>
        <div style={label}>Seuil de fréquence — liste hebdomadaire</div>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>
          Un produit entre automatiquement dans la liste s'il apparaît dans au moins ce % des commandes passées.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input style={{ ...input, width: 70 }} type="number" min="1" max="100" value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)} />
          <span style={{ color: MUTED, fontSize: 13 }}>%</span>
          <button style={btn(BLUE)} onClick={saveThreshold} disabled={saving}>Sauvegarder</button>
        </div>
        {genMessage && <p style={{ fontSize: 11, color: GREEN, margin: '8px 0 0' }}>{genMessage}</p>}
      </div>

      {/* Duree de comparaison des prix */}
      <div style={card}>
        <div style={label}>Durée de comparaison des prix</div>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>
          Nombre de mois utilisés pour calculer le "prix moyen payé" affiché dans Prochaine commande.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input style={{ ...input, width: 70 }} type="number" min="1" max="36" value={priceCompareInput}
            onChange={(e) => setPriceCompareInput(e.target.value)} />
          <span style={{ color: MUTED, fontSize: 13 }}>mois</span>
          <button style={btn(BLUE)} onClick={savePriceCompare} disabled={saving}>Sauvegarder</button>
        </div>
      </div>

      {/* Token Maxi */}
      <div style={card}>
        <div style={label}>Token Maxi (session)</div>
        {token.present ? (
          <p style={{ fontSize: 12, margin: '0 0 12px' }}>
            <span style={{ color: token.expired ? RED : GREEN }}>{token.expired ? '⚠ Expiré' : '✓ Valide'}</span>
            <span style={{ color: MUTED }}> — capturé {token.captured_at ? new Date(token.captured_at).toLocaleString('fr-CA') : '—'}
              {token.expires_at ? `, expire ${new Date(token.expires_at).toLocaleString('fr-CA')}` : ''}</span>
          </p>
        ) : (
          <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>Aucun token enregistré.</p>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '0 0 12px' }}>
          <button style={btn(BLUE)} onClick={() => window.open('https://www.maxi.ca/fr', '_blank')}>
            1. Ouvrir Maxi.ca
          </button>
          <a ref={bookmarkletRef} href="#" onClick={(e) => e.preventDefault()}
            style={{ ...btn('#333'), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', cursor: 'grab' }}
            title="Glisser ce bouton dans ta barre de favoris">
            2. 📋 Copier AccessToken (glisser dans les favoris)
          </a>
        </div>
        <p style={{ fontSize: 11, color: MUTED, margin: '0 0 12px' }}>
          Glisse le bouton "2." dans ta barre de favoris <strong>une seule fois</strong>. Ensuite : connecte-toi sur Maxi.ca,
          clique ce favori (le token est copié automatiquement), reviens ici et colle-le. Un navigateur ne permet pas à
          mitchbi.com d'exécuter un script directement sur maxi.ca — d'où le favori.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea style={{ ...input, minHeight: 60, fontFamily: 'monospace', fontSize: 11 }}
            placeholder="Coller le token ici"
            value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={input} type="datetime-local" value={tokenExpiresInput}
              onChange={(e) => setTokenExpiresInput(e.target.value)} />
            <button style={btn(BLUE)} onClick={saveToken} disabled={saving || !tokenInput.trim()}>Sauvegarder le token</button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <button style={btn('#333')} onClick={syncNow} disabled={syncing || saving}>
              {syncing ? 'Synchronisation...' : '↻ Synchroniser les commandes maintenant'}
            </button>
          </div>
          {syncMessage && (
            <p style={{ fontSize: 12, color: syncMessage.startsWith('Erreur') ? RED : GREEN, margin: '4px 0 0' }}>{syncMessage}</p>
          )}
        </div>
      </div>

      {/* Circulaire (API native Maxi) */}
      <div style={card}>
        <div style={label}>Circulaire — API native Maxi</div>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>
          Récupère les spéciaux en cours pour le magasin {STORE_LABELS[flyerStoreId] || flyerStoreId} directement depuis l'API Maxi/PC Express
          (ne nécessite pas de token). Dernière mise à jour : {flyerLastSynced ? new Date(flyerLastSynced).toLocaleString('fr-CA') : 'jamais'}.
        </p>
        <button style={btn(BLUE)} onClick={refreshFlyer} disabled={refreshingFlyer}>
          {refreshingFlyer ? 'Récupération...' : '↻ Rafraîchir le circulaire maintenant'}
        </button>
        {flyerMessage && (
          <p style={{ fontSize: 12, color: flyerMessage.startsWith('Erreur') ? RED : GREEN, margin: '8px 0 0' }}>{flyerMessage}</p>
        )}
      </div>

      {/* Magasin -- toutes les commandes en ligne passent par Clemenceau en pratique,
          important pour la fiabilite du stock_status affiche dans Circulaire */}
      <div style={card}>
        <div style={label}>Magasin</div>
        <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px' }}>
          Détermine le circulaire et le statut de stock affichés. Toutes les commandes en ligne passent par Clémenceau en pratique — le stock de Louis-XIV n'est pas nécessairement représentatif.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          {Object.keys(STORE_LABELS).map((storeId) => (
            <button key={storeId} onClick={() => selectStore(storeId)} disabled={saving}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                border: flyerStoreId === storeId ? `1px solid ${BLUE}` : '0.5px solid #2a2e3f',
                background: flyerStoreId === storeId ? '#1a1a2b' : '#0f1117',
              }}>
              <div style={{ fontSize: 13, color: flyerStoreId === storeId ? '#fff' : '#ddd', fontWeight: 600 }}>{STORE_LABELS[storeId]}</div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 2, fontFamily: 'monospace' }}>{storeId}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------

const DATE_RANGES = [
  { id: 'L30D', label: '30j' },
  { id: 'L90D', label: '90j' },
  { id: 'L120D', label: '120j' },
  { id: 'L6M', label: '6 mois' },
  { id: 'L1Y', label: '1 an' },
  { id: 'L2Y', label: '2 ans' },
  { id: 'ALL', label: 'Tout' },
];

function DashboardTab() {
  const [rows, setRows] = useState([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [range, setRange] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/epicerie/dashboard/top-products?limit=50&range=${range}`);
      const json = await res.json();
      if (json.success) { setRows(json.products); setTotalOrders(json.total_orders); }
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // flag: 'blacklisted' | 'whitelisted' | null (null = retirer les deux)
  const applyRule = async (article_number, flag) => {
    setApplying(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_number,
          blacklisted: flag === 'blacklisted',
          whitelisted: flag === 'whitelisted',
        }),
      });
      await load();
    } finally {
      setApplying(false);
    }
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={label}>Top 50 produits — basé sur {totalOrders} commandes</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {DATE_RANGES.map((r) => (
            <button key={r.id} onClick={() => setRange(r.id)}
              style={{
                background: range === r.id ? BLUE : '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6,
                color: range === r.id ? '#fff' : MUTED, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
              }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>Chargement...</div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thCompact}></th>
                <th style={thCompact}>#</th>
                <th style={thCompact}>Produit</th>
                <th style={thCompact}>N° article</th>
                <th style={thCompact}>Marque</th>
                <th style={thCompact}>Commandes</th>
                <th style={thCompact}>Fréquence</th>
                <th style={thCompact}>Qté moyenne</th>
                <th style={thCompact}>Prix moyen</th>
                <th style={thCompact}>Statut</th>
                <th style={thCompact}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.article_number}>
                  <td style={tdCompact}>
                    {r.image_url && <img className="ep-thumb" src={r.image_url} alt="" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 4, background: '#fff' }} />}
                  </td>
                  <td style={{ ...tdCompact, color: MUTED }}>{i + 1}</td>
                  <td style={tdCompact}>{r.product_name}{r.is_weighted && <span style={{ color: MUTED }}> (au poids)</span>}</td>
                  <td style={{ ...tdCompact, color: MUTED, fontFamily: 'monospace' }}>{r.article_number}</td>
                  <td style={{ ...tdCompact, color: MUTED }}>{r.brand || '—'}</td>
                  <td style={tdCompact}>{r.orders}</td>
                  <td style={{ ...tdCompact, color: r.frequency_pct >= 30 ? GREEN : r.frequency_pct >= 15 ? GOLD : MUTED }}>{r.frequency_pct}%</td>
                  <td style={tdCompact}>
                    {r.is_weighted
                      ? (r.avg_weight != null ? `~${r.avg_weight} kg` : '—')
                      : (r.avg_qty ?? '—')}
                  </td>
                  <td style={tdCompact}>{r.avg_price != null ? `${Number(r.avg_price).toFixed(2)}$` : '—'}</td>
                  <td style={tdCompact}><RuleBadge blacklisted={r.blacklisted} whitelisted={r.whitelisted} /></td>
                  <td style={tdCompact}>
                    <RuleActions blacklisted={r.blacklisted} whitelisted={r.whitelisted} disabled={applying}
                      onRule={(flag) => applyRule(r.article_number, flag)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// LISTE DES COMMANDES
// ---------------------------------------------------------------------

function OrderDetailRows({ orderId }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addedIds, setAddedIds] = useState(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/epicerie/orders/${orderId}`);
      const json = await res.json();
      if (json.success) setDetail(json);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  const applyRule = async (article_number, flag) => {
    setBusy(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_number,
          blacklisted: flag === 'blacklisted',
          whitelisted: flag === 'whitelisted',
        }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const addToCart = async (l) => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/epicerie/next-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_number: l.article_number,
          product_name: l.grocery_products?.product_name || l.article_number,
          product_url: l.grocery_products?.product_url || null,
          quantity: l.weight != null ? l.weight : (l.quantity || 1),
          added_reason: 'previous',
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(`Erreur ajout au panier: ${json.error || res.status}`);
        return;
      }
      setAddedIds((prev) => new Set(prev).add(l.id));
    } catch (err) {
      alert(`Erreur ajout au panier: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <tr><td colSpan={9} style={{ ...tdCompact, color: MUTED }}>Chargement des produits...</td></tr>;
  }
  if (!detail?.lines?.length) {
    return <tr><td colSpan={9} style={{ ...tdCompact, color: MUTED }}>Aucun produit trouvé.</td></tr>;
  }

  return (
    <>
      {detail.lines.map((l) => (
        <tr key={l.id} style={{ background: '#14161f' }}>
          <td style={tdCompact}>
            {l.grocery_products?.image_url && (
              <img className="ep-thumb" src={l.grocery_products.image_url} alt="" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 4, background: '#fff' }} />
            )}
          </td>
          <td style={{ ...tdCompact, paddingLeft: 24 }}>
            {l.grocery_products?.product_name || l.article_number}
            {l.grocery_products?.brand && <span style={{ color: MUTED }}> — {l.grocery_products.brand}</span>}
          </td>
          <td style={tdCompact}>{l.weight != null ? `${l.weight} kg` : l.quantity}</td>
          <td style={tdCompact}>{l.unit_price != null ? `${Number(l.unit_price).toFixed(2)}$` : '—'}</td>
          <td style={{ ...tdCompact, color: MUTED }}>
            {l.avg_price_paid != null ? `${Number(l.avg_price_paid).toFixed(2)}$ (${detail.price_compare_duration_months}mo)` : '—'}
          </td>
          <td style={tdCompact}>{l.total_price != null ? `${Number(l.total_price).toFixed(2)}$` : '—'}</td>
          <td style={tdCompact}><RuleBadge blacklisted={l.blacklisted} whitelisted={l.whitelisted} /></td>
          <td style={tdCompact}>
            <RuleActions blacklisted={l.blacklisted} whitelisted={l.whitelisted} disabled={busy}
              onRule={(flag) => applyRule(l.article_number, flag)} />
          </td>
          <td style={tdCompact}>
            <button style={{ ...btn(addedIds.has(l.id) ? GREEN : '#333'), padding: '4px 10px', fontSize: 11 }}
              onClick={() => addToCart(l)} disabled={busy || addedIds.has(l.id)}>
              {addedIds.has(l.id) ? '✓ Ajouté' : '+ Panier'}
            </button>
          </td>
        </tr>
      ))}
    </>
  );
}

function OrdersTab() {
  const [orders, setOrders] = useState([]);
  const [comparisons, setComparisons] = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshingPending, setRefreshingPending] = useState(false);
  const [openOrderId, setOpenOrderId] = useState(null);
  const [openPendingId, setOpenPendingId] = useState(null);
  const [openComparisonId, setOpenComparisonId] = useState(null);

  const loadPendingOrders = useCallback(async () => {
    setRefreshingPending(true);
    try {
      const res = await apiFetch('/api/epicerie/pending-orders');
      const json = await res.json();
      if (json.success) setPendingOrders(json.orders);
    } finally {
      setRefreshingPending(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [ordersRes, comparisonsRes, pendingRes] = await Promise.all([
          apiFetch('/api/epicerie/orders?limit=100'),
          apiFetch('/api/epicerie/order-comparisons?limit=10'),
          apiFetch('/api/epicerie/pending-orders'),
        ]);
        const ordersJson = await ordersRes.json();
        if (ordersJson.success) setOrders(ordersJson.orders);
        const comparisonsJson = await comparisonsRes.json();
        if (comparisonsJson.success) setComparisons(comparisonsJson.comparisons);
        const pendingJson = await pendingRes.json();
        if (pendingJson.success) setPendingOrders(pendingJson.orders);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ color: MUTED, fontSize: 13 }}>Chargement...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {pendingOrders.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={label}>Commande(s) en cours (pas encore dans l'historique) — clique une ligne pour voir les produits</div>
            <button style={{ ...btn('#333'), padding: '4px 10px', fontSize: 11 }} onClick={loadPendingOrders} disabled={refreshingPending}>
              {refreshingPending ? 'Rafraîchissement...' : '↻ Rafraîchir'}
            </button>
          </div>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thCompact}>Commande</th>
                  <th style={thCompact}>Passée le</th>
                  <th style={thCompact}>Statut</th>
                  <th style={thCompact}>Cutoff (ajout possible avant)</th>
                  <th style={thCompact}>Ramassage/livraison</th>
                  <th style={thCompact}>Magasin</th>
                  <th style={thCompact}>Items</th>
                  <th style={thCompact}>Total</th>
                </tr>
              </thead>
              <tbody>
                {pendingOrders.map((o) => {
                  const cutoffPassed = o.cutoff_date && new Date(o.cutoff_date) < new Date();
                  return (
                    <Fragment key={o.id}>
                      <tr onClick={() => setOpenPendingId(openPendingId === o.id ? null : o.id)} style={{ cursor: 'pointer' }}>
                        <td style={{ ...tdCompact, color: MUTED, fontFamily: 'monospace' }}>{openPendingId === o.id ? '▾ ' : '▸ '}#{o.order_number}</td>
                        <td style={tdCompact}>{new Date(o.created).toLocaleString('fr-CA')}</td>
                        <td style={{ ...tdCompact, color: GOLD }}>{o.delivery_status_label}</td>
                        <td style={{ ...tdCompact, color: o.cutoff_date ? (cutoffPassed ? RED : GREEN) : MUTED }}>
                          {o.cutoff_date ? `${new Date(o.cutoff_date).toLocaleString('fr-CA')}${cutoffPassed ? ' (passé)' : ''}` : '—'}
                        </td>
                        <td style={{ ...tdCompact, color: MUTED }}>{o.pickup_start_date ? new Date(o.pickup_start_date).toLocaleString('fr-CA') : '—'}</td>
                        <td style={{ ...tdCompact, color: MUTED }}>{o.store_name || '—'}</td>
                        <td style={tdCompact}>{o.total_items ?? '—'}</td>
                        <td style={tdCompact}>{o.total_price != null ? `${Number(o.total_price).toFixed(2)}$` : '—'}</td>
                      </tr>
                      {openPendingId === o.id && (o.items || []).map((it) => (
                        <tr key={it.article_number} style={{ background: '#14161f' }}>
                          <td style={tdCompact}>
                            {it.image_url && <img className="ep-thumb" src={it.image_url} alt="" style={{ width: 40, height: 40, objectFit: 'contain', borderRadius: 4, background: '#fff' }} />}
                          </td>
                          <td colSpan={2} style={{ ...tdCompact, textTransform: 'lowercase' }}>{it.product_name}</td>
                          <td style={{ ...tdCompact, color: MUTED }}>{it.brand?.toLowerCase() || '—'}</td>
                          <td style={{ ...tdCompact, color: MUTED }}>x{it.quantity}</td>
                          <td colSpan={3} style={tdCompact}>{it.total_price != null ? `${Number(it.total_price).toFixed(2)}$` : '—'}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {comparisons.length > 0 && (
        <div style={card}>
          <div style={label}>Derniers comparatifs (panier planifié vs commande réelle) — clique une ligne pour le détail</div>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thCompact}>Comparé le</th>
                  <th style={thCompact}>Commande</th>
                  <th style={thCompact}>Semaine</th>
                  <th style={thCompact}>Retrouvés</th>
                  <th style={thCompact}>Manquants</th>
                  <th style={thCompact}>Extras</th>
                  <th style={thCompact}>Déclenché par</th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((c) => (
                  <Fragment key={c.id}>
                    <tr onClick={() => setOpenComparisonId(openComparisonId === c.id ? null : c.id)} style={{ cursor: 'pointer' }}>
                      <td style={tdCompact}>{openComparisonId === c.id ? '▾ ' : '▸ '}{new Date(c.compared_at).toLocaleString('fr-CA')}</td>
                      <td style={{ ...tdCompact, color: MUTED, fontFamily: 'monospace' }}>#{c.order_number}</td>
                      <td style={{ ...tdCompact, color: MUTED }}>{new Date(c.week_of).toLocaleDateString('fr-CA')}</td>
                      <td style={tdCompact}>{c.matched_count}/{c.planned_count}</td>
                      <td style={{ ...tdCompact, color: c.missing_items?.length ? GOLD : MUTED }}>{c.missing_items?.length || 0}</td>
                      <td style={{ ...tdCompact, color: c.extra_items?.length ? BLUE : MUTED }}>{c.extra_items?.length || 0}</td>
                      <td style={{ ...tdCompact, color: MUTED }}>{c.triggered_by || '—'}</td>
                    </tr>
                    {openComparisonId === c.id && (
                      <tr>
                        <td colSpan={7} style={{ ...tdCompact, background: '#14161f', padding: 12 }}>
                          {(c.matched_items || []).length > 0 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 11, color: GREEN, marginBottom: 4 }}>✓ Retrouvés dans la commande ({c.matched_items.length})</div>
                              {c.matched_items.map((m) => (
                                <div key={m.article_number} style={{ fontSize: 12, color: '#ddd', padding: '2px 0' }}>
                                  {m.product_name || m.article_number} — planifié x{m.planned_quantity}, commandé x{m.quantity}
                                </div>
                              ))}
                            </div>
                          )}
                          {(c.missing_items || []).length > 0 && (
                            <div style={{ marginBottom: 10 }}>
                              <div style={{ fontSize: 11, color: GOLD, marginBottom: 4 }}>⚠️ Planifiés mais absents de la commande ({c.missing_items.length})</div>
                              {c.missing_items.map((m) => (
                                <div key={m.article_number} style={{ fontSize: 12, color: '#ddd', padding: '2px 0' }}>{m.product_name || m.article_number}</div>
                              ))}
                            </div>
                          )}
                          {(c.extra_items || []).length > 0 && (
                            <div>
                              <div style={{ fontSize: 11, color: BLUE, marginBottom: 4 }}>➕ Achetés mais pas planifiés ({c.extra_items.length})</div>
                              {c.extra_items.map((m) => (
                                <div key={m.article_number} style={{ fontSize: 12, color: '#ddd', padding: '2px 0' }}>
                                  {m.product_name || m.article_number} — x{m.quantity}{m.total_price != null ? `, ${Number(m.total_price).toFixed(2)}$` : ''}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div style={card}>
      <div style={label}>{orders.length} commandes — clique une ligne pour voir les produits</div>
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Date</th>
              <th style={th}>Magasin</th>
              <th style={th}>Type</th>
              <th style={th}>Items</th>
              <th style={th}>Total</th>
              <th style={th}>Points</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <Fragment key={o.id}>
                <tr onClick={() => setOpenOrderId(openOrderId === o.id ? null : o.id)} style={{ cursor: 'pointer' }}>
                  <td style={td}>{openOrderId === o.id ? '▾ ' : '▸ '}{new Date(o.order_date).toLocaleDateString('fr-CA')}</td>
                  <td style={{ ...td, color: MUTED }}>{o.store_name || '—'}</td>
                  <td style={td}>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 4,
                      background: o.order_type === 'online' ? '#1a1a2b' : '#1a1d27',
                      color: o.order_type === 'online' ? BLUE : MUTED,
                    }}>
                      {o.order_type}
                    </span>
                  </td>
                  <td style={td}>{o.total_items ?? '—'}</td>
                  <td style={td}>{o.total_price != null ? `${Number(o.total_price).toFixed(2)}$` : '—'}</td>
                  <td style={{ ...td, color: MUTED }}>{o.points_earned ?? '—'}</td>
                </tr>
                {openOrderId === o.id && (
                  <>
                    <tr style={{ background: '#14161f' }}>
                      <th style={thCompact}></th>
                      <th style={thCompact}>Produit</th>
                      <th style={thCompact}>Qté</th>
                      <th style={thCompact}>Prix payé</th>
                      <th style={thCompact}>Prix moyen</th>
                      <th style={thCompact}>Total ligne</th>
                      <th style={thCompact}>Statut</th>
                      <th style={thCompact}></th>
                      <th style={thCompact}></th>
                    </tr>
                    <OrderDetailRows orderId={o.id} />
                  </>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// JOURNAL DES AGENTS -- canal asynchrone avec un agent externe (ex: agent
// navigateur qui remplit le vrai panier Maxi), voir grocery_agent_log
// ---------------------------------------------------------------------

const LOG_TYPE_COLOR = { info: BLUE, warning: GOLD, error: RED, done: GREEN };

function AgentLogTab() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/epicerie/agent-log?limit=50');
      const json = await res.json();
      if (json.success) setEntries(json.entries);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const markRead = async (id) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, read_at: new Date().toISOString() } : e)));
    await apiFetch(`/api/epicerie/agent-log/${id}`, { method: 'PUT' });
  };

  const q = search.trim().toLowerCase();
  // Recherche par No d'article -- le payload est jsonb libre (pas de schema
  // garanti), donc on cherche la sous-chaine dans le message ET le payload
  // serialise plutot que de supposer un champ article_number precis.
  const visibleEntries = entries.filter((e) => {
    if (!q) return true;
    return (e.message || '').toLowerCase().includes(q) || JSON.stringify(e.payload || {}).toLowerCase().includes(q);
  });
  const unreadCount = entries.filter((e) => !e.read_at).length;

  if (loading) return <div style={{ color: MUTED, fontSize: 13 }}>Chargement...</div>;

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={label}>
          {visibleEntries.length}/{entries.length} entrées{unreadCount > 0 ? ` — ${unreadCount} non lue(s)` : ''}
        </div>
        <input style={{ ...input, width: 240, padding: '4px 10px', fontSize: 12 }} placeholder="Rechercher (No d'article, texte...)"
          value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {entries.length === 0 ? (
        <p style={{ fontSize: 13, color: MUTED, marginTop: 12 }}>Aucun message pour l'instant.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {visibleEntries.map((e) => {
            const color = LOG_TYPE_COLOR[e.message_type] || MUTED;
            const isOpen = expandedId === e.id;
            return (
              <div key={e.id} style={{
                padding: '8px 12px', borderRadius: 8, background: e.read_at ? 'transparent' : '#14161f',
                border: `0.5px solid ${e.read_at ? '#1e2130' : color}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}
                  onClick={() => setExpandedId(isOpen ? null : e.id)}>
                  <div>
                    <span style={{ fontSize: 10, color, textTransform: 'uppercase', marginRight: 8 }}>{e.message_type}</span>
                    <span style={{ fontSize: 10, color: MUTED, fontFamily: 'monospace', marginRight: 8 }}>{e.agent_name}</span>
                    <span style={{ fontSize: 10, color: MUTED }}>{new Date(e.created_at).toLocaleString('fr-CA')}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {!e.read_at && (
                      <button style={{ ...btn('#333'), padding: '2px 8px', fontSize: 10 }}
                        onClick={(ev) => { ev.stopPropagation(); markRead(e.id); }}>
                        Marquer lu
                      </button>
                    )}
                    <span style={{ fontSize: 10, color: MUTED }}>{isOpen ? '▾' : '▸'}</span>
                  </div>
                </div>
                {!isOpen && e.message && (
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.message.replace(/[#*_`\n]/g, ' ').trim().slice(0, 160)}
                  </div>
                )}
                {isOpen && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#ddd', borderTop: '0.5px solid #1e2130', paddingTop: 8 }}>
                    {e.message ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={LOG_MARKDOWN_COMPONENTS}>
                        {e.message}
                      </ReactMarkdown>
                    ) : <span style={{ color: MUTED }}>—</span>}
                    {e.payload && Object.keys(e.payload).length > 0 && (
                      <pre style={{ background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 6, padding: 10, marginTop: 8, fontSize: 11, overflowX: 'auto', color: MUTED }}>
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// PROCHAINE COMMANDE (editable)
// ---------------------------------------------------------------------

const REASON_LABELS = {
  frequency: 'Fréquence',
  whitelist: 'Whitelist',
  telegram: 'Telegram',
  flyer_proposal: 'Proposé (circulaire)',
  michel_request: 'Demande Michel',
  eliane: 'Éliane',
  julie: 'Julie',
  previous: 'Commande précédente',
  maxi_reco_items: 'Recommandation (agent)',
  michel_telegram_search: 'Michel (Telegram /search)',
  julie_telegram_search: 'Julie (Telegram /search)',
  other: 'Autre',
};
const REASON_OPTIONS = Object.keys(REASON_LABELS);

// Classification "pour qui" d'un produit whitelisté -- alimente le futur
// moteur de suggestions (croiser avec eliane_present_week/julie_present_week
// dans grocery_household_config).
const PERSON_LABELS = {
  eliane: 'Éliane',
  julie: 'Julie',
  both: 'Éliane + Julie',
  household: 'Ménage (général)',
};
const PERSON_OPTIONS = Object.keys(PERSON_LABELS);

function NextOrderTab() {
  const [weekOf, setWeekOf] = useState(null);
  const [items, setItems] = useState([]);
  const [priceCompareDuration, setPriceCompareDuration] = useState(6);
  const [loading, setLoading] = useState(true);
  const [newItem, setNewItem] = useState({ article_number: '', product_name: '', quantity: 1 });
  const [resetReason, setResetReason] = useState('ALL');
  const [resetting, setResetting] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [compareMessage, setCompareMessage] = useState('');
  const [addingRecurring, setAddingRecurring] = useState(false);
  const [addRecurringMessage, setAddRecurringMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/epicerie/next-order');
      const json = await res.json();
      if (json.success) {
        setWeekOf(json.week_of);
        setItems(json.items);
        if (json.price_compare_duration_months) setPriceCompareDuration(json.price_compare_duration_months);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateReason = async (id, added_reason) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, added_reason } : it)));
    await apiFetch(`/api/epicerie/next-order/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ added_reason }),
    });
  };

  const updateQty = async (id, quantity) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, quantity } : it)));
    await apiFetch(`/api/epicerie/next-order/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    });
  };

  const removeItem = async (id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    await apiFetch(`/api/epicerie/next-order/${id}`, { method: 'DELETE' });
  };

  // flag: 'blacklisted' | 'whitelisted' | null (null = retirer les deux)
  const applyRule = async (article_number, flag) => {
    await apiFetch('/api/epicerie/product-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        article_number,
        blacklisted: flag === 'blacklisted',
        whitelisted: flag === 'whitelisted',
      }),
    });
    await load();
  };

  const addItem = async () => {
    if (!newItem.article_number.trim() || !weekOf) return;
    await apiFetch('/api/epicerie/next-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week_of: weekOf, ...newItem, added_reason: 'michel_request' }),
    });
    setNewItem({ article_number: '', product_name: '', quantity: 1 });
    await load();
  };

  const resetCart = async () => {
    if (!weekOf) return;
    const what = resetReason === 'ALL' ? 'TOUT le panier' : `les items "${REASON_LABELS[resetReason]}"`;
    if (!window.confirm(`Supprimer ${what} de la semaine du ${new Date(weekOf).toLocaleDateString('fr-CA')} ?`)) return;
    setResetting(true);
    try {
      const qs = new URLSearchParams({ week_of: weekOf, reason: resetReason });
      await apiFetch(`/api/epicerie/next-order?${qs}`, { method: 'DELETE' });
      await load();
    } finally {
      setResetting(false);
    }
  };

  // A utiliser une fois la commande reellement passee sur maxi.ca -- compare
  // le panier planifie a la derniere commande synchronisee, puis vide le
  // panier. Meme flux que la commande /reset envoyee par Telegram.
  const compareAndReset = async () => {
    if (!weekOf) return;
    if (!window.confirm('Comparer le panier à la dernière commande Maxi et vider le panier ?')) return;
    setComparing(true);
    setCompareMessage('');
    try {
      const res = await apiFetch('/api/epicerie/reset-and-compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggered_by: 'web' }),
      });
      const json = await res.json();
      if (!json.success) {
        setCompareMessage(`Erreur: ${json.error}`);
        return;
      }
      const parts = [`Commande #${json.order_number} — ${json.matched_count}/${json.planned_count} items planifiés retrouvés.`];
      if (json.missing.length) parts.push(`Manquants: ${json.missing.map((m) => m.product_name).join(', ')}`);
      if (json.extra.length) parts.push(`${json.extra.length} item(s) acheté(s) hors plan.`);
      setCompareMessage(parts.join(' '));
      await load();
    } catch (err) {
      setCompareMessage(`Erreur: ${err.message}`);
    } finally {
      setComparing(false);
    }
  };

  // Ajoute les produits recurrents (frequence >= seuil) et whitelistes au
  // panier actif (ou en amorce un si aucun n'existe) -- ne supprime jamais
  // rien, preserve les ajouts manuels et ceux d'un autre agent.
  const addRecurringWhitelist = async () => {
    setAddingRecurring(true);
    setAddRecurringMessage('');
    try {
      const res = await apiFetch('/api/epicerie/add-recurring-whitelist', { method: 'POST' });
      const json = await res.json();
      if (!json.success) {
        setAddRecurringMessage(`Erreur: ${json.error}`);
        return;
      }
      const parts = [`${json.added_count} produit(s) ajouté(s)`];
      if (json.already_present_count) parts.push(`${json.already_present_count} déjà présent(s), ignoré(s)`);
      setAddRecurringMessage(parts.join(', ') + '.');
      await load();
    } catch (err) {
      setAddRecurringMessage(`Erreur: ${err.message}`);
    } finally {
      setAddingRecurring(false);
    }
  };

  if (loading) return <div style={{ color: MUTED, fontSize: 13 }}>Chargement...</div>;

  if (!weekOf) {
    return (
      <div style={card}>
        <p style={{ fontSize: 13, color: MUTED, marginBottom: 12 }}>Aucune liste générée pour l'instant.</p>
        <button style={btn(BLUE)} onClick={addRecurringWhitelist} disabled={addingRecurring}>
          {addingRecurring ? 'Ajout...' : '+ Ajouter les produits récurrents et whitelistés'}
        </button>
        {addRecurringMessage && (
          <p style={{ fontSize: 12, color: addRecurringMessage.startsWith('Erreur') ? RED : GREEN, margin: '8px 0 0' }}>{addRecurringMessage}</p>
        )}
      </div>
    );
  }

  // Prix payé si connu, sinon moyenne recente -- meilleure estimation disponible,
  // pas le prix courant en magasin (pas d'integration temps reel hors circulaire).
  const cartTotals = items.reduce((acc, it) => {
    const qty = Number(it.quantity) || 0;
    acc.qty += qty;
    const unitPrice = it.last_price_paid ?? it.avg_price_paid;
    if (unitPrice != null) acc.price += unitPrice * qty;
    else acc.missingPrice += 1;
    return acc;
  }, { qty: 0, price: 0, missingPrice: 0 });

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={label}>Semaine du {new Date(weekOf).toLocaleDateString('fr-CA')} — {items.length} items</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button style={{ ...btn(BLUE), padding: '4px 10px', fontSize: 11 }} onClick={addRecurringWhitelist} disabled={addingRecurring}
            title="Ajoute les produits récurrents (fréquence) et whitelistés manquants, sans rien supprimer">
            {addingRecurring ? 'Ajout...' : '+ Récurrents/whitelist'}
          </button>
          <select style={{ ...input, padding: '4px 8px', fontSize: 11, width: 170 }} value={resetReason} onChange={(e) => setResetReason(e.target.value)}>
            <option value="ALL">Tous les items</option>
            {REASON_OPTIONS.map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
          </select>
          <button style={{ ...btn(RED), padding: '4px 10px', fontSize: 11 }} onClick={resetCart} disabled={resetting || !items.length}>
            {resetting ? 'Suppression...' : '↺ Reset'}
          </button>
          <button style={{ ...btn(GREEN), padding: '4px 10px', fontSize: 11 }} onClick={compareAndReset} disabled={comparing || !items.length}
            title="Une fois la commande passée sur maxi.ca : compare le panier à la dernière commande synchronisée, puis vide le panier">
            {comparing ? 'Comparaison...' : '📦 Commande passée'}
          </button>
        </div>
      </div>
      {addRecurringMessage && (
        <p style={{ fontSize: 12, color: addRecurringMessage.startsWith('Erreur') ? RED : GREEN, margin: '8px 0 0' }}>{addRecurringMessage}</p>
      )}
      {compareMessage && (
        <p style={{ fontSize: 12, color: compareMessage.startsWith('Erreur') ? RED : MUTED, margin: '8px 0 0' }}>{compareMessage}</p>
      )}
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thCompact}></th>
              <th style={thCompact}>Produit</th>
              <th style={thCompact}>N° article</th>
              <th style={thCompact}>Quantité</th>
              <th style={thCompact}>Prix payé</th>
              <th style={thCompact}>Moy. {priceCompareDuration}mo</th>
              <th style={thCompact}>Ajouté par</th>
              <th style={thCompact}>Statut</th>
              <th style={thCompact}>Lien</th>
              <th style={thCompact}></th>
              <th style={thCompact}></th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ background: '#0f1117' }}>
              <td style={tdCompact}></td>
              <td style={{ ...tdCompact, fontWeight: 700 }}>Total ({items.length} items)</td>
              <td style={tdCompact}></td>
              <td style={{ ...tdCompact, fontWeight: 700 }}>{Math.round(cartTotals.qty * 100) / 100}</td>
              <td style={{ ...tdCompact, fontWeight: 700, color: GREEN }}>
                {cartTotals.price.toFixed(2)}$
                {cartTotals.missingPrice > 0 && <span style={{ color: MUTED, fontWeight: 400 }}> (*{cartTotals.missingPrice} sans prix connu)</span>}
              </td>
              <td style={tdCompact}></td>
              <td style={tdCompact}></td>
              <td style={tdCompact}></td>
              <td style={tdCompact}></td>
              <td style={tdCompact}></td>
              <td style={tdCompact}></td>
            </tr>
            {items.map((it) => (
              <tr key={it.id}>
                <td style={tdCompact}>
                  {it.image_url && <img className="ep-thumb" src={it.image_url} alt="" style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 4, background: '#fff' }} />}
                </td>
                <td style={tdCompact}>{it.product_name}</td>
                <td style={{ ...tdCompact, color: MUTED, fontFamily: 'monospace', fontSize: 11 }}>{it.article_number}</td>
                <td style={tdCompact}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {it.is_weighted ? (
                      <input type="number" min="0.1" step="0.1" style={{ ...input, width: 55, padding: '4px 8px' }} value={it.quantity}
                        onChange={(e) => updateQty(it.id, parseFloat(e.target.value) || 0.1)} />
                    ) : (
                      <input type="number" min="1" style={{ ...input, width: 55, padding: '4px 8px' }} value={it.quantity}
                        onChange={(e) => updateQty(it.id, parseInt(e.target.value, 10) || 1)} />
                    )}
                    {it.is_weighted && <span style={{ color: MUTED, fontSize: 11 }}>kg (approx.)</span>}
                  </div>
                </td>
                <td style={tdCompact}>{it.last_price_paid != null ? `${Number(it.last_price_paid).toFixed(2)}$` : '—'}</td>
                <td style={{ ...tdCompact, color: MUTED }}>{it.avg_price_paid != null ? `${Number(it.avg_price_paid).toFixed(2)}$` : '—'}</td>
                <td style={tdCompact}>
                  <select style={{ ...input, padding: '3px 6px', fontSize: 11, color: MUTED }} value={it.added_reason || 'other'}
                    onChange={(e) => updateReason(it.id, e.target.value)}>
                    {REASON_OPTIONS.map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
                  </select>
                </td>
                <td style={{ ...tdCompact, color: it.status === 'added' ? GREEN : it.status === 'skipped' ? RED : MUTED }}>{it.status}</td>
                <td style={tdCompact}>
                  {it.product_url && <a href={it.product_url} target="_blank" rel="noreferrer" style={{ color: BLUE, fontSize: 12 }}>Voir</a>}
                </td>
                <td style={tdCompact}>
                  <RuleActions blacklisted={it.blacklisted} whitelisted={it.whitelisted}
                    onRule={(flag) => applyRule(it.article_number, flag)} />
                </td>
                <td style={tdCompact}>
                  <button style={{ ...btn('#333'), padding: '4px 10px' }} onClick={() => removeItem(it.id)}>Retirer</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <input style={{ ...input, width: 160 }} placeholder="N° article" value={newItem.article_number}
          onChange={(e) => setNewItem({ ...newItem, article_number: e.target.value })} />
        <input style={{ ...input, flex: 1 }} placeholder="Nom du produit" value={newItem.product_name}
          onChange={(e) => setNewItem({ ...newItem, product_name: e.target.value })} />
        <input type="number" min="1" style={{ ...input, width: 70 }} value={newItem.quantity}
          onChange={(e) => setNewItem({ ...newItem, quantity: parseInt(e.target.value, 10) || 1 })} />
        <button style={btn(BLUE)} onClick={addItem} disabled={!newItem.article_number.trim()}>+ Ajouter</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// CIRCULAIRE (style dashboard: table plate + filtre, pas de detail imbrique)
// ---------------------------------------------------------------------

// Colonnes optionnelles du tableau Circulaire -- masquables via le menu
// "Colonnes" pour reduire la largeur totale (avec ~1800 items et 16 colonnes,
// le bouton Panier finit hors-ecran et force un scroll horizontal).
const FLYER_COLUMNS = [
  { key: 'article_number', label: 'N° article' },
  { key: 'brand', label: 'Marque' },
  { key: 'original_price', label: 'Régulier' },
  { key: 'member_price', label: 'Prix membre' },
  { key: 'unit_price', label: 'Prix unitaire' },
  { key: 'type', label: 'Type' },
  { key: 'stock', label: 'Stock' },
  { key: 'discount', label: '% Rabais' },
  { key: 'purchases', label: 'Achats' },
  { key: 'valid_to', label: "Valide jusqu'au" },
  { key: 'status', label: 'Statut' },
];
const FLYER_PAGE_SIZE = 100;
const STOCK_LABELS = { OK: { text: 'En stock', color: 'inherit' }, LOW: { text: 'Stock bas', color: '#e8b339' }, OUT: { text: 'Épuisé', color: '#e8546a' } };

function FlyerTab() {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [purchasedOnly, setPurchasedOnly] = useState(false);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [memberOnly, setMemberOnly] = useState(false);
  const [badgeFilter, setBadgeFilter] = useState('');
  const [priceCompareDuration, setPriceCompareDuration] = useState(6);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [addedArticles, setAddedArticles] = useState(new Set());
  const [sortBy, setSortBy] = useState(null); // null | 'purchases' | 'discount'
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [showColMenu, setShowColMenu] = useState(false);
  const [hiddenCols, setHiddenCols] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ep_flyer_hidden_cols') || '[]')); }
    catch { return new Set(); }
  });

  useEffect(() => {
    localStorage.setItem('ep_flyer_hidden_cols', JSON.stringify([...hiddenCols]));
  }, [hiddenCols]);
  const colVisible = (key) => !hiddenCols.has(key);
  const toggleCol = (key) => setHiddenCols((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/epicerie/flyer');
      const json = await res.json();
      if (json.success) {
        setItems(json.items);
        if (json.price_compare_duration_months) setPriceCompareDuration(json.price_compare_duration_months);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, purchasedOnly, inStockOnly, memberOnly, badgeFilter, sortBy, sortDir]);

  const addToCart = async (it) => {
    setApplying(true);
    try {
      const res = await apiFetch('/api/epicerie/next-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_number: it.article_number,
          product_name: it.name,
          product_url: it.product_url || null,
          image_url: it.image_url || null,
          brand: it.brand || null,
          quantity: 1,
          added_reason: 'flyer_proposal',
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(`Erreur ajout au panier: ${json.error || res.status}`);
        return;
      }
      setAddedArticles((prev) => new Set(prev).add(it.article_number));
    } catch (err) {
      alert(`Erreur ajout au panier: ${err.message}`);
    } finally {
      setApplying(false);
    }
  };

  const applyRule = async (article_number, flag) => {
    setApplying(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_number,
          blacklisted: flag === 'blacklisted',
          whitelisted: flag === 'whitelisted',
        }),
      });
      await load();
    } finally {
      setApplying(false);
    }
  };

  const toggleSort = (field) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(field);
      setSortDir('desc');
    }
  };

  // % de rabais = (regulier - special) / regulier -- null si pas de prix regulier connu
  const getDiscountPct = (it) => {
    const price = parseFloat(it.price_text);
    if (!it.original_price || isNaN(price) || it.original_price <= 0) return null;
    return Math.round(((it.original_price - price) / it.original_price) * 1000) / 10;
  };

  const badgeLabels = useMemo(() => {
    const set = new Set();
    for (const it of items) if (it.badge_label) set.add(it.badge_label);
    return [...set].sort();
  }, [items]);

  const q = search.trim().toLowerCase();
  const visibleItems = items.filter((it) => {
    if (purchasedOnly && !it.previously_purchased) return false;
    if (inStockOnly && it.stock_status === 'OUT') return false;
    if (memberOnly && it.member_price == null) return false;
    if (badgeFilter && it.badge_label !== badgeFilter) return false;
    if (!q) return true;
    return [it.name, it.brand, it.article_number]
      .filter(Boolean)
      .some((f) => String(f).toLowerCase().includes(q));
  });

  const sortedItems = sortBy
    ? [...visibleItems].sort((a, b) => {
        const va = sortBy === 'purchases' ? (a.recent_purchases || 0) : (getDiscountPct(a) ?? -Infinity);
        const vb = sortBy === 'purchases' ? (b.recent_purchases || 0) : (getDiscountPct(b) ?? -Infinity);
        return sortDir === 'desc' ? vb - va : va - vb;
      })
    : visibleItems;

  const pageCount = Math.max(1, Math.ceil(sortedItems.length / FLYER_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedItems = sortedItems.slice((currentPage - 1) * FLYER_PAGE_SIZE, currentPage * FLYER_PAGE_SIZE);

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={label}>{visibleItems.length}/{items.length} spéciaux — magasin Maxi (API native)</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...input, width: 220, padding: '4px 10px', fontSize: 12 }} placeholder="Rechercher (produit, marque, N° article)"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={() => setPurchasedOnly((v) => !v)}
            style={{
              background: purchasedOnly ? GREEN : '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6,
              color: purchasedOnly ? '#fff' : MUTED, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            }}>
            Déjà acheté
          </button>
          <button onClick={() => setInStockOnly((v) => !v)}
            style={{
              background: inStockOnly ? GREEN : '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6,
              color: inStockOnly ? '#fff' : MUTED, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            }}>
            En stock
          </button>
          <button onClick={() => setMemberOnly((v) => !v)}
            style={{
              background: memberOnly ? GREEN : '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6,
              color: memberOnly ? '#fff' : MUTED, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            }}>
            Prix membre
          </button>
          <button onClick={() => setBadgeFilter('')}
            style={{
              background: badgeFilter === '' ? BLUE : '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6,
              color: badgeFilter === '' ? '#fff' : MUTED, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
            }}>
            Tous types
          </button>
          {badgeLabels.map((b) => (
            <button key={b} onClick={() => setBadgeFilter(b)}
              style={{
                background: badgeFilter === b ? BLUE : '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6,
                color: badgeFilter === b ? '#fff' : MUTED, padding: '4px 10px', fontSize: 11, cursor: 'pointer', textTransform: 'lowercase',
              }}>
              {b}
            </button>
          ))}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowColMenu((v) => !v)}
              style={{ background: '#0f1117', border: '0.5px solid #2a2e3f', borderRadius: 6, color: MUTED, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>
              Colonnes ▾
            </button>
            {showColMenu && (
              <div style={{
                position: 'absolute', top: '110%', right: 0, background: '#1a1d27', border: '0.5px solid #2a2e3f',
                borderRadius: 8, padding: 10, zIndex: 50, minWidth: 170, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              }}>
                {FLYER_COLUMNS.map((c) => (
                  <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ddd', padding: '3px 0', cursor: 'pointer' }}>
                    <input type="checkbox" checked={colVisible(c.key)} onChange={() => toggleCol(c.key)} />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {loading ? (
        <div style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>Chargement...</div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thCompact}></th>
                <th style={thCompact}>Produit</th>
                {colVisible('article_number') && <th style={thCompact}>N° article</th>}
                {colVisible('brand') && <th style={thCompact}>Marque</th>}
                <th style={thCompact}>Prix</th>
                {colVisible('original_price') && <th style={thCompact}>Régulier</th>}
                {colVisible('member_price') && <th style={thCompact}>Prix membre</th>}
                {colVisible('unit_price') && <th style={thCompact}>Prix unitaire</th>}
                {colVisible('type') && <th style={thCompact}>Type</th>}
                {colVisible('stock') && <th style={thCompact}>Stock</th>}
                {colVisible('discount') && (
                  <th style={{ ...thCompact, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('discount')} title="Trier par % de rabais">
                    % Rabais {sortBy === 'discount' ? (sortDir === 'desc' ? '▾' : '▴') : ''}
                  </th>
                )}
                {colVisible('purchases') && (
                  <th style={{ ...thCompact, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('purchases')} title="Trier par fréquence d'achats">
                    Achats ({priceCompareDuration}mo) {sortBy === 'purchases' ? (sortDir === 'desc' ? '▾' : '▴') : ''}
                  </th>
                )}
                {colVisible('valid_to') && <th style={thCompact}>Valide jusqu'au</th>}
                {colVisible('status') && <th style={thCompact}>Statut</th>}
                <th style={thCompact}></th>
                <th style={thCompact}></th>
              </tr>
            </thead>
            <tbody>
              {pagedItems.map((it) => (
                <tr key={it.id}>
                  <td style={tdCompact}>
                    {it.image_url && <img className="ep-thumb" src={it.image_url} alt="" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 4, background: '#fff' }} />}
                  </td>
                  <td style={{ ...tdCompact, textTransform: 'lowercase' }}>
                    {it.previously_purchased && <span title="Déjà acheté" style={{ color: GREEN }}>● </span>}
                    {it.name}
                  </td>
                  {colVisible('article_number') && <td style={{ ...tdCompact, color: MUTED, fontFamily: 'monospace' }}>{it.article_number || '—'}</td>}
                  {colVisible('brand') && <td style={{ ...tdCompact, color: MUTED, textTransform: 'lowercase' }}>{it.brand || '—'}</td>}
                  <td style={{ ...tdCompact, color: GREEN, fontWeight: 600 }}>{it.price_text || '—'}</td>
                  {colVisible('original_price') && (
                    <td style={{ ...tdCompact, color: MUTED, textDecoration: it.original_price ? 'line-through' : 'none' }}>
                      {it.original_price != null ? `${Number(it.original_price).toFixed(2)}$` : '—'}
                    </td>
                  )}
                  {colVisible('member_price') && <td style={{ ...tdCompact, color: GOLD }}>{it.member_price != null ? `${Number(it.member_price).toFixed(2)}$` : '—'}</td>}
                  {colVisible('unit_price') && <td style={{ ...tdCompact, color: MUTED, fontSize: 10 }}>{it.unit_price_text || '—'}</td>}
                  {colVisible('type') && <td style={{ ...tdCompact, color: MUTED, textTransform: 'lowercase' }}>{it.badge_label || '—'}</td>}
                  {colVisible('stock') && (
                    <td style={{ ...tdCompact, color: STOCK_LABELS[it.stock_status]?.color || MUTED }}>
                      {STOCK_LABELS[it.stock_status]?.text || '—'}
                    </td>
                  )}
                  {colVisible('discount') && <td style={{ ...tdCompact, color: GOLD }}>{getDiscountPct(it) != null ? `-${getDiscountPct(it)}%` : '—'}</td>}
                  {colVisible('purchases') && <td style={{ ...tdCompact, color: it.recent_purchases ? undefined : MUTED }}>{it.recent_purchases || 0}x</td>}
                  {colVisible('valid_to') && <td style={{ ...tdCompact, color: MUTED }}>{it.valid_to ? new Date(it.valid_to).toLocaleDateString('fr-CA') : '—'}</td>}
                  {colVisible('status') && <td style={tdCompact}><RuleBadge blacklisted={it.blacklisted} whitelisted={it.whitelisted} /></td>}
                  <td style={tdCompact}>
                    {it.article_number && (
                      <RuleActions blacklisted={it.blacklisted} whitelisted={it.whitelisted} disabled={applying}
                        onRule={(flag) => applyRule(it.article_number, flag)} />
                    )}
                  </td>
                  <td style={tdCompact}>
                    {it.article_number && (
                      <button style={{ ...btn(addedArticles.has(it.article_number) ? GREEN : BLUE), padding: '4px 10px', fontSize: 11 }}
                        onClick={() => addToCart(it)} disabled={applying || addedArticles.has(it.article_number)}>
                        {addedArticles.has(it.article_number) ? '✓ Ajouté' : '+ Panier'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pageCount > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 12 }}>
              <button style={{ ...btn('#333'), padding: '4px 10px', fontSize: 11 }} onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
                ← Précédent
              </button>
              <span style={{ fontSize: 12, color: MUTED }}>Page {currentPage}/{pageCount} ({sortedItems.length} items)</span>
              <button style={{ ...btn('#333'), padding: '4px 10px', fontSize: 11 }} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={currentPage >= pageCount}>
                Suivant →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// RECHERCHE DE PRODUITS (historique complet + circulaire)
// ---------------------------------------------------------------------

function SearchTab() {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [priceCompareDuration, setPriceCompareDuration] = useState(6);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addedIds, setAddedIds] = useState(new Set());
  const [sortDir, setSortDir] = useState(null); // null | 'asc' | 'desc'

  // debounce -- pas d'appel a chaque frappe
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setItems([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/epicerie/search?q=${encodeURIComponent(q)}`);
        const json = await res.json();
        if (json.success) {
          setItems(json.items);
          if (json.price_compare_duration_months) setPriceCompareDuration(json.price_compare_duration_months);
        }
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const applyRule = async (article_number, flag) => {
    setBusy(true);
    try {
      await apiFetch('/api/epicerie/product-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_number,
          blacklisted: flag === 'blacklisted',
          whitelisted: flag === 'whitelisted',
        }),
      });
      setItems((prev) => prev.map((it) => it.article_number === article_number
        ? { ...it, blacklisted: flag === 'blacklisted', whitelisted: flag === 'whitelisted' }
        : it));
    } finally {
      setBusy(false);
    }
  };

  const addToCart = async (it) => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/epicerie/next-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_number: it.article_number,
          product_name: it.product_name,
          product_url: it.product_url,
          quantity: 1,
          added_reason: 'michel_request',
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(`Erreur ajout au panier: ${json.error || res.status}`);
        return;
      }
      setAddedIds((prev) => new Set(prev).add(it.article_number));
    } catch (err) {
      alert(`Erreur ajout au panier: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleSort = () => {
    setSortDir((d) => (d === 'desc' ? 'asc' : d === 'asc' ? null : 'desc'));
  };

  const sortedItems = sortDir
    ? [...items].sort((a, b) => (sortDir === 'desc' ? b.recent_purchases - a.recent_purchases : a.recent_purchases - b.recent_purchases))
    : items;

  return (
    <div style={card}>
      <div style={label}>Recherche dans l'historique d'achat et le circulaire actuel</div>
      <input style={{ ...input, width: '100%', marginTop: 8 }} placeholder="Chercher un produit ou une marque (ex: fromage, saumon...)"
        value={query} onChange={(e) => setQuery(e.target.value)} />

      {loading && <div style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>Recherche...</div>}
      {!loading && query.trim().length >= 2 && items.length === 0 && (
        <div style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>Aucun résultat.</div>
      )}

      {items.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thCompact}></th>
                <th style={thCompact}>Produit</th>
                <th style={thCompact}>N° article</th>
                <th style={thCompact}>Marque</th>
                <th style={{ ...thCompact, cursor: 'pointer', userSelect: 'none' }} onClick={toggleSort} title="Trier par achats">
                  Achats ({priceCompareDuration}mo) {sortDir === 'desc' ? '▾' : sortDir === 'asc' ? '▴' : ''}
                </th>
                <th style={thCompact}>Prix moyen ({priceCompareDuration}mo)</th>
                <th style={thCompact}>Circulaire</th>
                <th style={thCompact}>Statut</th>
                <th style={thCompact}></th>
                <th style={thCompact}></th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((it) => (
                <tr key={it.article_number}>
                  <td style={tdCompact}>
                    {it.image_url && <img className="ep-thumb" src={it.image_url} alt="" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 4, background: '#fff' }} />}
                  </td>
                  <td style={tdCompact}>
                    {it.product_name}{it.is_weighted && <span style={{ color: MUTED }}> (au poids)</span>}
                  </td>
                  <td style={{ ...tdCompact, color: MUTED, fontFamily: 'monospace', fontSize: 11 }}>{it.article_number}</td>
                  <td style={{ ...tdCompact, color: MUTED }}>{it.brand || '—'}</td>
                  <td style={tdCompact}>
                    {it.recent_purchases}x{it.recent_qty ? ` (${it.recent_qty}${it.is_weighted ? 'kg' : 'u'})` : ''}
                  </td>
                  <td style={tdCompact}>{it.avg_price_paid != null ? `${Number(it.avg_price_paid).toFixed(2)}$` : '—'}</td>
                  <td style={{ ...tdCompact, color: it.on_flyer ? GREEN : MUTED }}>{it.on_flyer ? (it.flyer_price_text || 'Oui') : '—'}</td>
                  <td style={tdCompact}><RuleBadge blacklisted={it.blacklisted} whitelisted={it.whitelisted} /></td>
                  <td style={tdCompact}>
                    <RuleActions blacklisted={it.blacklisted} whitelisted={it.whitelisted} disabled={busy}
                      onRule={(flag) => applyRule(it.article_number, flag)} />
                  </td>
                  <td style={tdCompact}>
                    <button style={{ ...btn(addedIds.has(it.article_number) ? GREEN : BLUE), padding: '4px 10px', fontSize: 11 }}
                      onClick={() => addToCart(it)} disabled={busy || addedIds.has(it.article_number)}>
                      {addedIds.has(it.article_number) ? '✓ Ajouté' : '+ Panier'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// README
// ---------------------------------------------------------------------

const ReadmeSection = ({ title, children }) => (
  <div style={{ ...card, marginBottom: 16 }}>
    <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', marginBottom: 12 }}>{title}</div>
    <div style={{ fontSize: 13, color: '#c7cdd9', lineHeight: 1.6 }}>{children}</div>
  </div>
);
const RCode = ({ children }) => (
  <code style={{ background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 4, padding: '1px 6px', fontSize: 12, color: BLUE, fontFamily: 'monospace' }}>{children}</code>
);
const RCmdRow = ({ cmd, desc }) => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', margin: '4px 0' }}>
    <RCode>{cmd}</RCode>
    <span style={{ color: MUTED, fontSize: 12 }}>{desc}</span>
  </div>
);
const RTabRow = ({ name, desc }) => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', margin: '4px 0' }}>
    <span style={{ color: '#fff', fontSize: 13, minWidth: 150 }}>{name}</span>
    <span style={{ color: MUTED, fontSize: 12 }}>{desc}</span>
  </div>
);

function EpicerieReadmeTab() {
  return (
    <div style={{ maxWidth: 820 }}>
      <ReadmeSection title="🛒 Comment ça marche">
        <p>
          Le module lit et écrit les données Maxi via l'API native PC Express (pas de navigation automatisée —
          bloquée par Akamai). Le <RCode>Circulaire</RCode> ne nécessite aucun token ; tout ce qui touche à
          l'historique, aux commandes en cours ou au panier réel nécessite le <b>token Maxi</b> (session, expire
          après ~1h).
        </p>
        <p style={{ marginTop: 8 }}>
          Le panier en préparation (<RCode>Prochaine commande</RCode>) peut être piloté par un{' '}
          <b>cycle de planification</b> (voir plus bas) ou géré manuellement — les deux fonctionnent, un seul
          cycle peut être actif à la fois.
        </p>
      </ReadmeSection>

      <ReadmeSection title="📑 Les onglets">
        <RTabRow name="Config" desc="seuils, palier de budget, planification, présence, token Maxi, circulaire, blacklist/whitelist, magasin" />
        <RTabRow name="Dashboard" desc="produits les plus achetés, par plage de dates" />
        <RTabRow name="Commandes" desc="historique livré + commandes en cours chez Maxi + comparatifs panier/commande" />
        <RTabRow name="Prochaine commande" desc="le panier en préparation — total, ajout manuel, reset, comparer à une vraie commande" />
        <RTabRow name="Circulaire" desc="spéciaux en cours pour le magasin sélectionné (Config)" />
        <RTabRow name="Recherche" desc="chercher un produit dans l'historique + le circulaire" />
        <RTabRow name="Journal des agents" desc="messages échangés avec l'agent externe de recommandation" />
      </ReadmeSection>

      <ReadmeSection title="🔑 Token Maxi">
        <p>
          Dans <RCode>Config</RCode> : ouvrir Maxi.ca, se connecter, cliquer le favori "Copier AccessToken"
          (glissé une seule fois dans la barre de favoris), coller le token dans Config <i>ou</i> l'envoyer par
          Telegram avec <RCode>/token</RCode>. Expire après ~1h — <RCode>/status_token</RCode> le confirme.
        </p>
      </ReadmeSection>

      <ReadmeSection title="⌨️ Commandes Telegram">
        <p>Envoyées au bot par toi ou Julie, réponse immédiate :</p>
        <div style={{ margin: '10px 0' }}>
          <RCmdRow cmd="/status_token" desc="état du token Maxi" />
          <RCmdRow cmd="/token <valeur>" desc="colle un nouveau token" />
          <RCmdRow cmd="/commande" desc="compare le panier à la commande passée sur Maxi, puis vide le panier" />
          <RCmdRow cmd="/status_commande" desc="commandes en cours chez Maxi (pas encore livrées)" />
          <RCmdRow cmd="/list" desc="cette liste" />
        </div>
        <p style={{ color: MUTED, fontSize: 12 }}>
          À utiliser après avoir réellement passé la commande sur maxi.ca : <RCode>/commande</RCode> attend
          quelques minutes si la commande n'est pas encore visible côté serveur plutôt que de comparer à une
          commande périmée.
        </p>
      </ReadmeSection>

      <ReadmeSection title="🔄 Cycle de planification (Config → Planification prochain repas)">
        <p>
          Statut : <RCode>draft</RCode> → <RCode>ready</RCode> → <RCode>recommendation_in_progress</RCode> →{' '}
          <RCode>recommendation_ready</RCode> → <RCode>approved</RCode> → <RCode>queue_updated</RCode> →{' '}
          <RCode>completed</RCode> (branches : <RCode>changes_requested</RCode>, <RCode>cancelled</RCode>,{' '}
          <RCode>error</RCode>).
        </p>
        <p style={{ marginTop: 8 }}>
          Tu contrôles draft/ready/changes_requested/approved/cancelled ; l'agent externe contrôle le reste.
          Un seul cycle actif à la fois — en démarrer un nouveau clôture automatiquement l'ancien. Le budget et
          la présence Julie/Éliane ne se ressaisissent pas ici : lus directement depuis Config et "Présence
          cette semaine".
        </p>
      </ReadmeSection>

      <ReadmeSection title="⚡ Pièges connus">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Toutes les commandes en ligne passent par Maxi Beauport Clémenceau en pratique — le magasin
            sélectionné dans Config détermine le stock affiché dans Circulaire, choisis Clémenceau pour un
            stock représentatif.</li>
          <li>Le token expire vite (~1h) : si <RCode>/commande</RCode> ou une sync échoue, c'est souvent ça —{' '}
            <RCode>/status_token</RCode> confirme.</li>
          <li>Une commande fraîchement passée peut prendre quelques minutes avant d'apparaître côté Maxi —{' '}
            <RCode>/commande</RCode> ne touche jamais au panier tant qu'elle n'est pas trouvée.</li>
        </ul>
      </ReadmeSection>
    </div>
  );
}

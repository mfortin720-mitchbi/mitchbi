const BLUE = '#378ADD';
const GREEN = '#1D9E75';
const RED = '#D85A30';
const GOLD = '#E8A838';
const MUTED = '#8b93a5';

const Section = ({ title, children }) => (
  <div style={{
    background: '#13151f', borderRadius: 10, border: '0.5px solid #1e2130',
    padding: 20, marginBottom: 16
  }}>
    <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', marginBottom: 12 }}>{title}</div>
    <div style={{ fontSize: 13, color: '#c7cdd9', lineHeight: 1.6 }}>{children}</div>
  </div>
);

const Code = ({ children }) => (
  <code style={{
    background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 4,
    padding: '1px 6px', fontSize: 12, color: BLUE, fontFamily: 'monospace'
  }}>{children}</code>
);

const CmdRow = ({ cmd, desc }) => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', margin: '4px 0' }}>
    <Code>{cmd}</Code>
    <span style={{ color: MUTED, fontSize: 12 }}>{desc}</span>
  </div>
);

const AccountRow = ({ firm, login, color }) => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '3px 0', fontSize: 12 }}>
    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
    <span style={{ color: '#fff' }}>{firm}</span>
    <span style={{ color: MUTED }}>— {login}</span>
  </div>
);

export default function Readme() {
  return (
    <div style={{ maxWidth: 820 }}>
      <Section title="🏗️ Comment ça marche">
        <p>
          Un script Python (<Code>trading_monitor.py</Code>) tourne toutes les 5 minutes sur le ForexVPS
          (tâche planifiée Windows) et lit l'état réel de chaque compte MT5 via l'API officielle{' '}
          <Code>MetaTrader5</Code> — balance, equity, positions ouvertes, deals fermés. Tout est envoyé
          dans BigQuery (<Code>royaldistributing.trading</Code>), et cette page (mitchbi.com) affiche ces
          données via un backend Express sur Railway. Le pipeline est en lecture seule sur MT5 : il n'envoie
          jamais d'ordre, il ne fait qu'observer.
        </p>
      </Section>

      <Section title="📊 Comptes suivis">
        <AccountRow firm="Hola Prime — 112119" login="hola_1 · 50K" color={BLUE} />
        <AccountRow firm="Hola Prime — 112109" login="hola_2 · 50K" color={BLUE} />
        <AccountRow firm="Hola Prime — 124582" login="hola_3 · 25K" color={BLUE} />
        <AccountRow firm="FundedNext — 14114959" login="fundednext · 50K" color={GOLD} />
        <AccountRow firm="Alpha Capital — 2779521" login="alpha_1 · 50K" color={GREEN} />
        <AccountRow firm="Alpha Capital — 2779506" login="alpha_2 · 50K" color={GREEN} />
        <p style={{ marginTop: 10 }}>
          Chaque compte a un <Code>account_id</Code> stable (ex. <Code>hola_3</Code>) qui ne change jamais —
          c'est la clé de traçabilité. Le <Code>login</Code> (le vrai numéro de compte MT5), lui, change à
          chaque nouvelle phase de challenge. Le tout premier login d'un compte est conservé pour toujours
          dans <Code>initial_login</Code>, même après plusieurs changements de phase.
        </p>
      </Section>

      <Section title="🔔 Notifications automatiques (Telegram)">
        <p>Envoyées sans aucune action de votre part, dès que le pipeline détecte l'événement :</p>
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          <li>🟢 Nouveau trade ouvert (symbole, sens, volume, SL/TP)</li>
          <li>🟢/🔴 Trade fermé (P&amp;L net, raison de fermeture)</li>
          <li>📋 Suivi de challenge initié (première fois qu'un compte est vu)</li>
          <li>🚀 Nouvelle phase démarrée (le login a changé dans <Code>config.py</Code>)</li>
          <li>🎉 Challenge complété / ❌ Breach / 🔄 Statut mis à jour</li>
        </ul>
      </Section>

      <Section title="⌨️ Commandes Telegram (vous → le bot)">
        <p>
          Envoyez une commande directement au bot pour changer le statut d'un compte sans passer par le VPS.
          Le bot répond immédiatement avec une confirmation.
        </p>
        <div style={{ margin: '10px 0' }}>
          <CmdRow cmd="/completed <login>" desc="marque le challenge comme réussi" />
          <CmdRow cmd="/breached <login>" desc="marque le challenge comme échoué" />
          <CmdRow cmd="/funded <login>" desc="marque le compte comme financé" />
          <CmdRow cmd="/ongoing <login>" desc="remet le compte en cours (annule un statut précédent)" />
        </div>
        <p>
          <Code>&lt;login&gt;</Code> peut être le numéro MT5 (ex. <Code>124582</Code>) ou l'<Code>account_id</Code>{' '}
          (ex. <Code>hola_3</Code>). La commande est prise en compte au prochain cycle (max 5 min), log dans
          l'historique <Code>challenge_phases</Code> et déclenche la notification appropriée.
        </p>
        <p style={{
          background: '#0f1117', border: '0.5px solid #1e2130', borderRadius: 6,
          padding: '8px 12px', marginTop: 8, color: MUTED, fontSize: 12
        }}>
          ⚠️ La commande reste active jusqu'à ce que vous éditiez vous-même le statut dans{' '}
          <Code>config.py</Code> pour ce compte — à ce moment-là, l'édition du fichier l'emporte
          automatiquement et l'ancienne commande Telegram est ignorée. Seuls les messages envoyés depuis
          votre propre conversation avec le bot sont acceptés.
        </p>
      </Section>

      <Section title="🛠️ Éditer une license (config.py)">
        <p>
          Toute la configuration des 6 comptes vit dans <Code>C:\TradingMonitor\config.py</Code> sur le VPS,
          dans la liste <Code>MT5_ACCOUNTS</Code>. Champs à ajuster au fil d'un challenge :
        </p>
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          <li><Code>challenge_phase</Code> — texte libre affiché comme badge (ex. "2-Step Prime (Phase 1)")</li>
          <li><Code>challenge_target</Code> — solde/équité à atteindre pour la phase</li>
          <li><Code>challenge_status</Code> — <Code>ongoing</Code> / <Code>completed</Code> / <Code>breached</Code> / <Code>funded</Code></li>
          <li><Code>phase_start_date</Code> / <Code>phase_end_date</Code></li>
          <li><Code>login</Code> — à changer quand la phase suivante donne un nouveau numéro de compte MT5 (le terminal doit aussi être re-loggé avec les nouveaux identifiants)</li>
        </ul>
        <p>
          Aucun redémarrage nécessaire : la tâche planifiée relance <Code>trading_monitor.py</Code> à zéro
          toutes les 5 minutes, donc le fichier modifié est pris en compte au cycle suivant. Le script compare
          l'état précédent (<Code>state\challenge_state.json</Code>) à la nouvelle config, log le changement
          dans BigQuery et envoie la notification Telegram correspondante — automatiquement.
        </p>
      </Section>

      <Section title="⚡ Pièges connus">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Symboles avec suffixe broker (ex. <Code>GBPUSD.raw</Code> chez Alpha Capital) : partout dans
            l'app, le regroupement par symbole ignore tout ce qui suit le premier point, pour bien agréger
            avec le <Code>GBPUSD</Code> propre des autres firmes.
          </li>
          <li>
            L'historique de balance quotidien est reconstruit à partir des deals (pas d'un simple snapshot),
            et partitionné par <Code>account_id</Code> + <Code>login</Code> ensemble : un changement de login
            (nouvelle phase) démarre sa propre courbe au lieu de prolonger celle de la phase précédente.
          </li>
        </ul>
      </Section>
    </div>
  );
}

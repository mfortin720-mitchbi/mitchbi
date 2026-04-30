const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/query/nl — Natural Language to SQL + Execute
router.post('/nl', async (req, res) => {
  try {
    const { question, credentials, projectId, dataset } = req.body;

    console.log('Query request received:', { question, projectId, dataset, hasCredentials: !!credentials });

    if (!credentials) {
      return res.status(400).json({ success: false, error: 'Credentials manquants — configure ta connexion BigQuery.' });
    }

    // Parser les credentials si string
    let parsedCreds;
    try {
      parsedCreds = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Credentials JSON invalide.' });
    }

    const pid = projectId || parsedCreds.project_id;
    console.log('Using project:', pid);

    // Étape 1 — Générer le SQL avec Claude
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Tu es un expert BigQuery SQL. Convertis cette question en une requête BigQuery SQL valide.

Project ID: ${pid}
Dataset: ${dataset || 'ga4'}
Question: "${question}"

Règles:
- Syntaxe BigQuery standard
- Préfixe les tables avec \`${pid}.${dataset || 'ga4'}.\`
- LIMIT 100 maximum
- Réponds UNIQUEMENT avec le SQL, sans backticks ni markdown

SQL:`
      }]
    });

    let sql = message.content[0].text.trim()
      .replace(/```sql/gi, '')
      .replace(/```/g, '')
      .trim();

    console.log('Generated SQL:', sql);

    // Étape 2 — Exécuter sur BigQuery
    const bigquery = new BigQuery({
      credentials: parsedCreds,
      projectId: pid
    });

    const [rows] = await bigquery.query({ query: sql, location: 'US' });
    console.log('Query success, rows:', rows.length);

    res.json({ success: true, sql, rows, count: rows.length });

  } catch (err) {
    console.error('Query error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/query/sql — Exécuter un SQL directement
router.post('/sql', async (req, res) => {
  try {
    const { sql, credentials, projectId } = req.body;

    let parsedCreds = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    const pid = projectId || parsedCreds.project_id;

    const bigquery = new BigQuery({ credentials: parsedCreds, projectId: pid });
    const [rows] = await bigquery.query({ query: sql, location: 'US' });

    res.json({ success: true, rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
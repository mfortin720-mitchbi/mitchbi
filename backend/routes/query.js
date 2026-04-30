const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/query/nl — Natural Language to SQL + Execute
router.post('/nl', async (req, res) => {
  try {
    const { question, credentials, projectId, dataset } = req.body;

    // Étape 1 — Générer le SQL avec Claude
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Tu es un expert BigQuery SQL. Convertis cette question en une requête BigQuery SQL valide.

Project ID: ${projectId}
Dataset disponible: ${dataset || 'ga4'}
Question: "${question}"

Règles importantes:
- Utilise la syntaxe BigQuery standard
- Préfixe les tables avec \`${projectId}.${dataset || 'ga4'}.\`
- Limite toujours les résultats à 100 lignes maximum avec LIMIT 100
- Réponds UNIQUEMENT avec la requête SQL, sans explication, sans backticks, sans markdown

SQL:`
      }]
    });

    const sql = message.content[0].text.trim()
      .replace(/```sql/gi, '')
      .replace(/```/g, '')
      .trim();

    // Étape 2 — Exécuter la requête sur BigQuery
    const bigquery = new BigQuery({
      credentials: typeof credentials === 'string' ? JSON.parse(credentials) : credentials,
      projectId
    });

    const [rows] = await bigquery.query({ query: sql, location: 'US' });

    res.json({
      success: true,
      sql,
      rows,
      count: rows.length
    });

  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/query/sql — Exécuter un SQL directement
router.post('/sql', async (req, res) => {
  try {
    const { sql, credentials, projectId } = req.body;

    const bigquery = new BigQuery({
      credentials: typeof credentials === 'string' ? JSON.parse(credentials) : credentials,
      projectId
    });

    const [rows] = await bigquery.query({ query: sql, location: 'US' });
    res.json({ success: true, rows, count: rows.length });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const initBigQuery = (credentials, projectId) => {
  const creds = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
  return new BigQuery({ credentials: creds, projectId: projectId || creds.project_id });
};

// POST /api/query/nl
router.post('/nl', async (req, res) => {
  try {
    const { question, credentials, projectId, datasetId, tableId, schema, location } = req.body;

    if (!credentials) return res.status(400).json({ success: false, error: 'Credentials manquants.' });

    const creds = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
    const pid = projectId || creds.project_id;
    const loc = location || 'northamerica-northeast1';

    let schemaContext = '';
    if (schema?.length > 0) {
      schemaContext = `\nSchéma de \`${pid}.${datasetId}.${tableId}\`:\n${schema.map(f => `  - ${f.name} (${f.type})`).join('\n')}`;
    }

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Tu es un expert BigQuery SQL. Convertis cette question en SQL BigQuery valide.

Project: ${pid} | Dataset: ${datasetId} | Table: ${tableId} | Région: ${loc}
${schemaContext}

Question: "${question}"

Règles:
- Utilise EXACTEMENT les noms de colonnes du schéma
- Table complète: \`${pid}.${datasetId}.${tableId}\`
- LIMIT 100 max
- Pour GA4: event_timestamp est en microsecondes → TIMESTAMP_MICROS()
- Réponds UNIQUEMENT avec le SQL brut, sans backticks ni markdown

SQL:`
      }]
    });

    let sql = message.content[0].text.trim().replace(/```sql/gi, '').replace(/```/g, '').trim();
    console.log('SQL généré:', sql);

    const bigquery = initBigQuery(creds, pid);
    const [rows] = await bigquery.query({ query: sql, location: loc });

    res.json({ success: true, sql, rows, count: rows.length });
  } catch (err) {
    console.error('Query error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/query/sql
router.post('/sql', async (req, res) => {
  try {
    const { sql, credentials, projectId, location } = req.body;
    const bigquery = initBigQuery(credentials, projectId);
    const [rows] = await bigquery.query({ query: sql, location: location || 'northamerica-northeast1' });
    res.json({ success: true, rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
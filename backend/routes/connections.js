const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');
const router = express.Router();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'mitchbi_secret_key_32chars_long!';
const ALGORITHM = 'aes-256-cbc';

// Chiffrer les credentials
const encrypt = (text) => {
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
};

// Déchiffrer les credentials
const decrypt = (text) => {
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32));
  const [ivHex, encrypted] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

// POST /api/connections/bigquery/test — Tester une connexion BigQuery
router.post('/bigquery/test', async (req, res) => {
  try {
    const { credentials, projectId } = req.body;

    const bigquery = new BigQuery({
      credentials: typeof credentials === 'string' ? JSON.parse(credentials) : credentials,
      projectId
    });

    // Test simple — liste les datasets
    const [datasets] = await bigquery.getDatasets();
    res.json({
      success: true,
      message: `✅ Connexion réussie ! ${datasets.length} dataset(s) trouvé(s).`,
      datasets: datasets.map(d => d.id)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/connections/bigquery/query — Exécuter une requête BigQuery
router.post('/bigquery/query', async (req, res) => {
  try {
    const { credentials, projectId, query } = req.body;

    const bigquery = new BigQuery({
      credentials: typeof credentials === 'string' ? JSON.parse(credentials) : credentials,
      projectId
    });

    const [rows] = await bigquery.query({ query, location: 'US' });
    res.json({ success: true, rows, count: rows.length });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/connections/encrypt — Chiffrer les credentials pour stockage
router.post('/encrypt', (req, res) => {
  try {
    const { data } = req.body;
    const encrypted = encrypt(typeof data === 'string' ? data : JSON.stringify(data));
    res.json({ encrypted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
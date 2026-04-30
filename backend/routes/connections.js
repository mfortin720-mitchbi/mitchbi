const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const router = express.Router();

const initBigQuery = (credentials, projectId) => {
  const creds = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
  return new BigQuery({ credentials: creds, projectId: projectId || creds.project_id });
};

// POST /api/connections/bigquery/test
router.post('/bigquery/test', async (req, res) => {
  try {
    const { credentials, projectId } = req.body;
    const bigquery = initBigQuery(credentials, projectId);
    const [datasets] = await bigquery.getDatasets();
    res.json({ success: true, message: `✅ Connexion réussie ! ${datasets.length} dataset(s) trouvé(s).`, datasets: datasets.map(d => d.id) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/connections/bigquery/datasets
router.post('/bigquery/datasets', async (req, res) => {
  try {
    const { credentials, projectId } = req.body;
    const bigquery = initBigQuery(credentials, projectId);
    const [datasets] = await bigquery.getDatasets();
    res.json({ success: true, datasets: datasets.map(d => ({ id: d.id, projectId: d.bigQuery.projectId })) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/connections/bigquery/tables
router.post('/bigquery/tables', async (req, res) => {
  try {
    const { credentials, projectId, datasetId } = req.body;
    const bigquery = initBigQuery(credentials, projectId);
    const [tables] = await bigquery.dataset(datasetId).getTables();
    res.json({ success: true, tables: tables.map(t => ({ id: t.id, type: t.metadata?.type || 'TABLE' })) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/connections/bigquery/schema
router.post('/bigquery/schema', async (req, res) => {
  try {
    const { credentials, projectId, datasetId, tableId } = req.body;
    const bigquery = initBigQuery(credentials, projectId);
    const [metadata] = await bigquery.dataset(datasetId).table(tableId).getMetadata();
    const fields = metadata.schema?.fields || [];
    res.json({
      success: true,
      schema: fields.map(f => ({ name: f.name, type: f.type, mode: f.mode || 'NULLABLE', description: f.description || '' })),
      fullTableName: `${projectId || metadata.tableReference.projectId}.${datasetId}.${tableId}`
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
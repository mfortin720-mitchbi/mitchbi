const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const pdf = require('pdf-parse');
const router = express.Router();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = ['Trading', 'AI & Tech', 'Cloud & Infra', 'Souscriptions', 'E-commerce', 'Business', 'Autre'];

const CATEGORY_KEYWORDS = {
  'Trading': ['tradingview', 'topstep', 'ftmo', 'forex', 'trading', 'ninjatrader', 'thinkorswim', 'interactive brokers', 'tastytrade'],
  'AI & Tech': ['anthropic', 'openai', 'claude', 'chatgpt', 'cursor', 'github', 'notion', 'figma', 'linear','gemini'],
  'Cloud & Infra': ['google cloud', 'gcp', 'aws', 'amazon web services', 'railway', 'vercel', 'supabase', 'cloudflare', 'digitalocean'],
  'Souscriptions': ['netflix', 'spotify', 'amazon prime', 'disney', 'apple', 'microsoft 365', 'adobe', 'dropbox','bell'],
  'E-commerce': ['amazon', 'shopify', 'etsy', 'ebay', 'walmart'],
  'Business': ['shopify plus', 'mailchimp', 'hubspot', 'salesforce', 'zoom', 'slack', 'asana'],
};

const getOAuthClient = (tokens) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
};

const getTokens = async () => {
  const { data } = await supabase.from('invoice_settings').select('*').single();
  if (!data?.google_access_token) throw new Error('Gmail non connecté');
  return {
    access_token: data.google_access_token,
    refresh_token: data.google_refresh_token,
    expiry_date: data.google_token_expiry
  };
};

// Classifier avec keywords d'abord, puis Claude si nécessaire
const classifyInvoice = async (text, senderEmail, subject) => {
  const combined = `${text} ${senderEmail} ${subject}`.toLowerCase();

  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => combined.includes(k))) return cat;
  }

  // Claude pour les cas ambigus
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Classifie cette facture dans UNE des catégories suivantes: ${CATEGORIES.join(', ')}

Expéditeur: ${senderEmail}
Sujet: ${subject}
Texte (extrait): ${text.substring(0, 500)}

Réponds UNIQUEMENT avec le nom exact de la catégorie, rien d'autre.`
      }]
    });
    const cat = msg.content[0].text.trim();
    return CATEGORIES.includes(cat) ? cat : 'Autre';
  } catch { return 'Autre'; }
};

// Extraire les infos de la facture avec Claude
const extractInvoiceData = async (text, senderEmail, subject) => {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Extrais les informations de cette facture. Réponds UNIQUEMENT en JSON valide, sans markdown.

Expéditeur: ${senderEmail}
Sujet: ${subject}
Texte: ${text.substring(0, 1000)}

Format JSON requis:
{
  "amount": 0.00,
  "currency": "USD",
  "invoice_date": "YYYY-MM-DD",
  "invoice_number": "",
  "sender_name": ""
}`
      }]
    });

    const clean = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch { return { amount: null, currency: 'USD', invoice_date: null, invoice_number: null, sender_name: senderEmail }; }
};

// Créer dossier Drive si inexistant
const getOrCreateDriveFolder = async (drive, name, parentId = null) => {
  const query = parentId
    ? `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const { data } = await drive.files.list({ q: query, fields: 'files(id, name)' });

  if (data.files.length > 0) return data.files[0].id;

  const { data: folder } = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] },
    fields: 'id'
  });
  return folder.id;
};

// POST /api/invoices/scan — Scanner Gmail
router.post('/scan', async (req, res) => {
  try {
    const tokens = await getTokens();
    const auth = getOAuthClient(tokens);
    const gmail = google.gmail({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    // Paramètres de scan
    const { data: settings } = await supabase.from('invoice_settings').select('*').single();
    const scanFrom = settings?.scan_from_date || '2025-01-01';

    console.log(`Scanning Gmail from ${scanFrom}...`);

    // Chercher emails avec PDF
    const afterDate = Math.floor(new Date(scanFrom).getTime() / 1000);
    const { data: listData } = await gmail.users.messages.list({
      userId: 'me',
      q: `has:attachment filename:pdf after:${afterDate}`,
      maxResults: 100
    });

    const messages = listData.messages || [];
    console.log(`Found ${messages.length} emails with PDF`);

    // Créer structure Drive
    const rootFolderId = await getOrCreateDriveFolder(drive, settings?.drive_root_folder_name || 'MitchBI - Factures');

    // Sauvegarder root folder ID
    await supabase.from('invoice_settings').update({ drive_root_folder_id: rootFolderId }).eq('id', settings.id);

    let processed = 0;
    let skipped = 0;
    const results = [];

    for (const msg of messages) {
      try {
        // Vérifier si déjà traité
        const { data: existing } = await supabase.from('invoices').select('id').eq('gmail_message_id', msg.id).single();
        if (existing) { skipped++; continue; }

        // Récupérer le message complet
        const { data: fullMsg } = await gmail.users.messages.get({ userId: 'me', id: msg.id });

        const headers = fullMsg.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        // Parser l'expéditeur
        const senderMatch = from.match(/^(.*?)\s*<(.+?)>$/) || [null, from, from];
        const senderName = senderMatch[1]?.trim() || from;
        const senderEmail = senderMatch[2]?.trim() || from;
        const receivedAt = new Date(date).toISOString();

        // Trouver les PDFs
        const parts = fullMsg.payload.parts || [];
        const pdfParts = parts.filter(p => p.mimeType === 'application/pdf' || p.filename?.endsWith('.pdf'));

        if (pdfParts.length === 0) { skipped++; continue; }

        for (const part of pdfParts) {
          // Télécharger le PDF
          const { data: attachment } = await gmail.users.messages.attachments.get({
            userId: 'me', messageId: msg.id, id: part.body.attachmentId
          });

          const pdfBuffer = Buffer.from(attachment.data, 'base64');
          let pdfText = '';
          try {
            const pdfData = await pdf(pdfBuffer);
            pdfText = pdfData.text;
          } catch { pdfText = ''; }

          // Classifier et extraire
          const category = await classifyInvoice(pdfText, senderEmail, subject);
          const extracted = await extractInvoiceData(pdfText, senderEmail, subject);

          // Créer dossier catégorie dans Drive
          const categoryFolderId = await getOrCreateDriveFolder(drive, category, rootFolderId);

          // Upload PDF vers Drive
          const fileName = `${senderName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date(receivedAt).toISOString().split('T')[0]}.pdf`;
          const { data: driveFile } = await drive.files.create({
            requestBody: { name: fileName, parents: [categoryFolderId] },
            media: { mimeType: 'application/pdf', body: require('stream').Readable.from(pdfBuffer) },
            fields: 'id, webViewLink'
          });

          // Sauvegarder dans Supabase
          const { data: invoice } = await supabase.from('invoices').insert({
            gmail_message_id: msg.id,
            received_at: receivedAt,
            sender_email: senderEmail,
            sender_name: senderName,
            subject,
            amount: extracted.amount,
            currency: extracted.currency || 'USD',
            invoice_date: extracted.invoice_date,
            invoice_number: extracted.invoice_number,
            category,
            category_verified: 'pending',
            drive_file_id: driveFile.id,
            drive_file_url: driveFile.webViewLink,
            drive_folder_id: categoryFolderId,
            pdf_filename: fileName,
            raw_text: pdfText.substring(0, 2000)
          }).select().single();

          results.push({ id: invoice?.data?.id, sender: senderName, category, amount: extracted.amount });
          processed++;
        }
      } catch (err) {
        console.error(`Error processing message ${msg.id}:`, err.message);
        skipped++;
      }
    }

    // Mettre à jour last_scan_at
    const nextScan = new Date(Date.now() + (settings?.scan_interval_hours || 4) * 3600000).toISOString();
    await supabase.from('invoice_settings').update({ last_scan_at: new Date().toISOString(), next_scan_at: nextScan }).eq('id', settings.id);

    res.json({ success: true, processed, skipped, total: messages.length, results });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices — Récupérer toutes les factures
router.get('/', async (req, res) => {
  try {
    const { category, verified, limit = 100 } = req.query;
    let query = supabase.from('invoices').select('*').order('received_at', { ascending: false }).limit(limit);
    if (category) query = query.eq('category', category);
    if (verified) query = query.eq('category_verified', verified);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, invoices: data, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/invoices/:id — Mettre à jour catégorie
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { category, notes } = req.body;
    const { data, error } = await supabase.from('invoices').update({
      category,
      notes,
      category_verified: 'corrected',
      updated_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, invoice: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/invoices/:id/verify — Vérifier la classification
router.patch('/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('invoices').update({
      category_verified: 'verified',
      updated_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, invoice: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices/export/csv — Export CSV
router.get('/export/csv', async (req, res) => {
  try {
    const { data } = await supabase.from('invoices').select('*').order('received_at', { ascending: false });
    const headers = ['Date réception', 'Expéditeur', 'Email', 'Sujet', 'Montant', 'Devise', 'Date facture', 'N° facture', 'Catégorie', 'Vérifié', 'Drive URL', 'Notes'];
    const rows = data.map(inv => [
      inv.received_at ? new Date(inv.received_at).toLocaleDateString('fr-CA') : '',
      inv.sender_name || '',
      inv.sender_email || '',
      inv.subject || '',
      inv.amount || '',
      inv.currency || '',
      inv.invoice_date || '',
      inv.invoice_number || '',
      inv.category || '',
      inv.category_verified || '',
      inv.drive_file_url || '',
      inv.notes || ''
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="mitchbi-factures.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices/stats — Statistiques
router.get('/stats', async (req, res) => {
  try {
    const { data } = await supabase.from('invoices').select('category, amount, currency, category_verified');
    const byCategory = {};
    let total = 0;
    let pending = 0;
    data.forEach(inv => {
      if (!byCategory[inv.category]) byCategory[inv.category] = { count: 0, total: 0 };
      byCategory[inv.category].count++;
      byCategory[inv.category].total += parseFloat(inv.amount || 0);
      total += parseFloat(inv.amount || 0);
      if (inv.category_verified === 'pending') pending++;
    });
    res.json({ success: true, byCategory, total, pending, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
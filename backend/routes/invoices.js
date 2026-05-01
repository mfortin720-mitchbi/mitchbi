const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const pdf = require('pdf-parse');
const router = express.Router();

const getSupabase = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const getAnthropic = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const getOAuthClient = (tokens) => {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
};

const getTokens = async () => {
  const { data } = await getSupabase().from('invoice_settings').select('*').single();
  if (!data?.google_access_token) throw new Error('Gmail non connecté');
  return {
    access_token: data.google_access_token,
    refresh_token: data.google_refresh_token,
    expiry_date: data.google_token_expiry
  };
};

// Charger catégories + corrections pour le prompt Claude
const buildClaudeContext = async () => {
  const { data: cats } = await getSupabase().from('invoice_categories').select('*').eq('is_active', true).order('sort_order');
  const { data: corrections } = await getSupabase().from('classification_corrections').select('*').limit(20).order('created_at', { ascending: false });
  return { cats: cats || [], corrections: corrections || [] };
};

// Classifier avec Claude
const classifyWithClaude = async (text, senderEmail, senderName, subject, cats, corrections) => {
  const categoryList = cats.map(c => `- ${c.name}: ${c.keywords?.join(', ') || 'général'}`).join('\n');
  const correctionExamples = corrections.length > 0
    ? `\nCorrections passées (apprends de ces erreurs):\n${corrections.map(c => `- "${c.sender_name || c.sender_email}" → ${c.correct_category} (pas ${c.suggested_category})`).join('\n')}`
    : '';

  const prompt = `Tu es un expert en classification de factures. Analyse ce document et réponds UNIQUEMENT en JSON valide.

Catégories disponibles:
${categoryList}
${correctionExamples}

Expéditeur: ${senderName} <${senderEmail}>
Sujet: ${subject}
Contenu (extrait): ${text.substring(0, 1500)}

Réponds en JSON:
{
  "is_invoice": true/false,
  "category": "nom exact de la catégorie",
  "confidence": 0-100,
  "amount": 0.00 ou null,
  "currency": "USD/CAD/EUR",
  "invoice_date": "YYYY-MM-DD" ou null,
  "invoice_number": "string" ou null,
  "vendor_name": "string",
  "reasoning": "explication courte"
}`;

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });
    const clean = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('Claude classification error:', err.message);
    return { is_invoice: true, category: 'Autre', confidence: 0, amount: null, currency: 'USD', vendor_name: senderName };
  }
};

// Créer dossier Drive si inexistant
const getOrCreateFolder = async (drive, name, parentId = null) => {
  const q = parentId
    ? `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)' });
  if (data.files.length > 0) return data.files[0].id;
  const { data: f } = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] },
    fields: 'id'
  });
  return f.id;
};

// Vérifier si fichier déjà dans Drive (anti-doublon)
const fileExistsInDrive = async (drive, fileName, folderId) => {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)' });
  return data.files.length > 0 ? data.files[0].id : null;
};

// Extraire texte du corps HTML d'un email
const extractTextFromEmail = (payload) => {
  let text = '';
  const extractParts = (part) => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      text += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n';
    } else if (part.mimeType === 'text/html' && part.body?.data && !text) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
      text += html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n';
    }
    if (part.parts) part.parts.forEach(extractParts);
  };
  if (payload.body?.data) {
    text += Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) payload.parts.forEach(extractParts);
  return text.trim();
};

// POST /api/invoices/scan
router.post('/scan', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.body;
    const tokens = await getTokens();
    const auth = getOAuthClient(tokens);
    const gmail = google.gmail({ version: 'v1', auth });

    const { data: settings } = await getSupabase().from('invoice_settings').select('*').single();
    const scanFrom = dateFrom || settings?.scan_from_date || '2025-01-01';
    const scanTo = dateTo || null;

    const afterDate = Math.floor(new Date(scanFrom).getTime() / 1000);
    const beforeDate = scanTo ? Math.floor(new Date(scanTo).getTime() / 1000) : null;

    // Chercher emails avec PDF ET emails potentiellement factures sans PDF
    const queries = [
      `in:inbox has:attachment filename:pdf after:${afterDate}${beforeDate ? ` before:${beforeDate}` : ''}`,
      `in:inbox (invoice OR facture OR receipt OR "order confirmation" OR billing OR payment) after:${afterDate}${beforeDate ? ` before:${beforeDate}` : ''}`
    ];

    const { cats, corrections } = await buildClaudeContext();

    let allMessageIds = new Set();
    for (const q of queries) {
      const { data } = await gmail.users.messages.list({ userId: 'me', q, maxResults: 200 });
      (data.messages || []).forEach(m => allMessageIds.add(m.id));
    }

    console.log(`Found ${allMessageIds.size} unique emails to process`);

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const messageId of allMessageIds) {
      try {
        // Vérifier si déjà dans la DB
        const { data: existing } = await getSupabase()
          .from('invoice_drafts')
          .select('id')
          .eq('gmail_message_id', messageId)
          .single();
        if (existing) { skipped++; continue; }

        const { data: fullMsg } = await gmail.users.messages.get({ userId: 'me', id: messageId });
        const headers = fullMsg.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        const senderMatch = from.match(/^(.*?)\s*<(.+?)>$/) || [null, from, from];
        const senderName = (senderMatch[1]?.trim() || from).replace(/"/g, '');
        const senderEmail = senderMatch[2]?.trim() || from;
        const receivedAt = new Date(date).toISOString();
        const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${messageId}`;

        // Trouver les PDFs
        const parts = fullMsg.payload.parts || [];
        const pdfParts = parts.filter(p =>
          p.mimeType === 'application/pdf' ||
          p.filename?.toLowerCase().endsWith('.pdf') ||
          (p.mimeType === 'application/octet-stream' && p.filename?.toLowerCase().endsWith('.pdf'))
        );

        let rawText = '';
        let hasPdf = false;
        let isEmbedded = false;
        let type = 'embedded_email';
        let pdfBuffer = null;

        if (pdfParts.length > 0) {
          // Email avec PDF
          hasPdf = true;
          type = 'pdf_attachment';
          const part = pdfParts[0];
          try {
            const { data: attachment } = await gmail.users.messages.attachments.get({
              userId: 'me', messageId, id: part.body.attachmentId
            });
            pdfBuffer = Buffer.from(attachment.data, 'base64');
            const pdfData = await pdf(pdfBuffer);
            rawText = pdfData.text;
          } catch { rawText = ''; }
        } else {
          // Email sans PDF — extraire le texte du body
          isEmbedded = true;
          rawText = extractTextFromEmail(fullMsg.payload);
        }

        // Claude analyse
        const analysis = await classifyWithClaude(rawText, senderEmail, senderName, subject, cats, corrections);

        // Sauvegarder dans invoice_drafts
        const draftData = {
          gmail_message_id: messageId,
          type,
          received_at: receivedAt,
          sender_email: senderEmail,
          sender_name: senderName,
          subject,
          gmail_url: gmailUrl,
          suggested_category: analysis.is_invoice === false ? 'Pas une facture' : (analysis.category || 'Autre'),
          suggested_amount: analysis.amount,
          suggested_currency: analysis.currency || 'USD',
          suggested_invoice_number: analysis.invoice_number,
          suggested_invoice_date: analysis.invoice_date,
          suggested_vendor_name: analysis.vendor_name,
          confidence_score: analysis.confidence || 0,
          final_category: analysis.is_invoice === false ? 'Pas une facture' : (analysis.category || 'Autre'),
          final_amount: analysis.amount,
          final_currency: analysis.currency || 'USD',
          has_pdf: hasPdf,
          is_embedded: isEmbedded,
          status: 'pending_review',
          raw_text: rawText.substring(0, 3000)
        };

        await getSupabase().from('invoice_drafts').insert(draftData);
        processed++;

      } catch (err) {
        console.error(`Error processing ${messageId}:`, err.message);
        errors++;
      }
    }

    // Mettre à jour last_scan_at
    const nextScan = new Date(Date.now() + (settings?.scan_interval_hours || 4) * 3600000).toISOString();
    if (settings) {
      await getSupabase().from('invoice_settings').update({
        last_scan_at: new Date().toISOString(),
        next_scan_at: nextScan
      }).eq('id', settings.id);
    }

    res.json({ success: true, processed, skipped, errors, total: allMessageIds.size });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices/drafts — Récupérer les brouillons
router.get('/drafts', async (req, res) => {
  try {
    const { status, category, limit = 200, offset = 0 } = req.query;
    let query = getSupabase()
      .from('invoice_drafts')
      .select('*')
      .order('received_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (status) query = query.eq('status', status);
    if (category) query = query.eq('final_category', category);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ success: true, drafts: data, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices/stats
router.get('/stats', async (req, res) => {
  try {
    const { data } = await getSupabase().from('invoice_drafts').select('status, final_category, final_amount, final_currency');
    const byStatus = { pending_review: 0, classified: 0, not_invoice: 0, rejected: 0 };
    const byCategory = {};
    let total = 0;
    (data || []).forEach(d => {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
      if (d.status === 'classified') {
        if (!byCategory[d.final_category]) byCategory[d.final_category] = { count: 0, total: 0 };
        byCategory[d.final_category].count++;
        byCategory[d.final_category].total += parseFloat(d.final_amount || 0);
        total += parseFloat(d.final_amount || 0);
      }
    });
    res.json({ success: true, byStatus, byCategory, total, count: (data || []).length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/invoices/drafts/:id — Mettre à jour un brouillon
router.patch('/drafts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { final_category, final_amount, final_currency, final_invoice_number, final_invoice_date, notes, status } = req.body;
    const { data, error } = await getSupabase()
      .from('invoice_drafts')
      .update({ final_category, final_amount, final_currency, final_invoice_number, final_invoice_date, notes, status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    // Sauvegarder correction si catégorie changée
    if (data.suggested_category !== final_category) {
      await getSupabase().from('classification_corrections').insert({
        sender_email: data.sender_email,
        sender_name: data.sender_name,
        subject_pattern: data.subject,
        suggested_category: data.suggested_category,
        correct_category: final_category
      });
    }

    res.json({ success: true, draft: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/invoices/drafts/:id/classify — Classifier + uploader dans Drive
router.post('/drafts/:id/classify', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: draft } = await getSupabase().from('invoice_drafts').select('*').eq('id', id).single();
    if (!draft) return res.status(404).json({ success: false, error: 'Brouillon introuvable' });
    if (draft.status === 'classified') return res.json({ success: true, message: 'Déjà classifié', draft });

    const tokens = await getTokens();
    const auth = getOAuthClient(tokens);
    const gmail = google.gmail({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    const { data: settings } = await getSupabase().from('invoice_settings').select('*').single();
    const rootFolderId = settings?.drive_root_folder_id || await getOrCreateFolder(drive, settings?.drive_root_folder_name || 'MitchBI - Factures');

    // Créer dossier catégorie
    const categoryFolderId = await getOrCreateFolder(drive, draft.final_category || 'Autre', rootFolderId);

    // Nom du fichier
    const vendorClean = (draft.suggested_vendor_name || draft.sender_name || 'Unknown')
  .replace(/[^a-zA-Z0-9\s]/g, '')
  .trim()
  .replace(/\s+/g, '_')
  .substring(0, 30);
    const dateStr = draft.received_at ? new Date(draft.received_at).toISOString().split('T')[0] : 'unknown';
    const amountStr = draft.final_amount ? `_${draft.final_amount}${draft.final_currency || 'USD'}` : '';
    const invoiceNum = draft.final_invoice_number ? `_${draft.final_invoice_number.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 20)}` : '';
    const fileName = `${vendorClean}_${dateStr}${amountStr}${invoiceNum}.pdf`;

    // Anti-doublon Drive
    const existingFileId = await fileExistsInDrive(drive, fileName, categoryFolderId);
    let driveFileId, driveFileUrl;

    if (existingFileId) {
      driveFileId = existingFileId;
      const { data: f } = await drive.files.get({ fileId: existingFileId, fields: 'webViewLink' });
      driveFileUrl = f.webViewLink;
    } else if (draft.has_pdf) {
      // Télécharger le PDF depuis Gmail
      const { data: fullMsg } = await gmail.users.messages.get({ userId: 'me', id: draft.gmail_message_id });
      const parts = fullMsg.payload.parts || [];
      const pdfPart = parts.find(p => p.mimeType === 'application/pdf' || p.filename?.toLowerCase().endsWith('.pdf'));

      if (pdfPart) {
        const { data: attachment } = await gmail.users.messages.attachments.get({
          userId: 'me', messageId: draft.gmail_message_id, id: pdfPart.body.attachmentId
        });
        const pdfBuffer = Buffer.from(attachment.data, 'base64');
        const { data: driveFile } = await drive.files.create({
          requestBody: { name: fileName, parents: [categoryFolderId] },
          media: { mimeType: 'application/pdf', body: require('stream').Readable.from(pdfBuffer) },
          fields: 'id, webViewLink'
        });
        driveFileId = driveFile.id;
        driveFileUrl = driveFile.webViewLink;
      }
    }

    // Mettre à jour le brouillon
    const { data: updated } = await getSupabase()
      .from('invoice_drafts')
      .update({
        status: 'classified',
        drive_file_id: driveFileId,
        drive_file_url: driveFileUrl,
        drive_folder_id: categoryFolderId,
        pdf_filename: fileName,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    res.json({ success: true, draft: updated });
  } catch (err) {
    console.error('Classify error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/invoices/drafts/:id — Supprimer
router.delete('/drafts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: draft } = await getSupabase().from('invoice_drafts').select('drive_file_id').eq('id', id).single();

    // Supprimer de Drive si existe
    if (draft?.drive_file_id) {
      try {
        const tokens = await getTokens();
        const auth = getOAuthClient(tokens);
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.delete({ fileId: draft.drive_file_id });
      } catch (err) { console.log('Drive delete error (non-fatal):', err.message); }
    }

    await getSupabase().from('invoice_drafts').delete().eq('id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices/categories — Récupérer les catégories
router.get('/categories', async (req, res) => {
  try {
    const { data } = await getSupabase().from('invoice_categories').select('*').eq('is_active', true).order('sort_order');
    res.json({ success: true, categories: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/invoices/categories — Créer une catégorie
router.post('/categories', async (req, res) => {
  try {
    const { name, color, icon, keywords, description } = req.body;
    const { data, error } = await getSupabase().from('invoice_categories').insert({ name, color, icon, keywords, description }).select().single();
    if (error) throw error;
    res.json({ success: true, category: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/invoices/categories/:id — Modifier une catégorie
router.patch('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, icon, keywords, description, is_active } = req.body;
    const { data, error } = await getSupabase().from('invoice_categories').update({ name, color, icon, keywords, description, is_active }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, category: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices/export/csv
router.get('/export/csv', async (req, res) => {
  try {
    const { data } = await getSupabase().from('invoice_drafts').select('*').eq('status', 'classified').order('received_at', { ascending: false });
    const headers = ['Date réception', 'Expéditeur', 'Email', 'Sujet', 'Montant', 'Devise', 'Date facture', 'N° facture', 'Catégorie', 'Drive URL', 'Gmail URL', 'Notes'];
    const rows = (data || []).map(d => [
      d.received_at ? new Date(d.received_at).toLocaleDateString('fr-CA') : '',
      d.suggested_vendor_name || d.sender_name || '',
      d.sender_email || '',
      d.subject || '',
      d.final_amount || '',
      d.final_currency || '',
      d.final_invoice_date || '',
      d.final_invoice_number || '',
      d.final_category || '',
      d.drive_file_url || '',
      d.gmail_url || '',
      d.notes || ''
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mitchbi-factures.csv"');
    res.send('\uFEFF' + csv); // BOM pour Excel/Google Sheets
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
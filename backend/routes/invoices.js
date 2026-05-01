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

// Charger règles de scan + catégories + corrections
const loadContext = async () => {
  const [rulesRes, catsRes, correctionsRes] = await Promise.all([
    getSupabase().from('invoice_scan_rules').select('*').single(),
    getSupabase().from('invoice_categories').select('*').eq('is_active', true).order('sort_order'),
    getSupabase().from('classification_corrections').select('*').limit(30).order('created_at', { ascending: false })
  ]);
  return {
    rules: rulesRes.data,
    cats: catsRes.data || [],
    corrections: correctionsRes.data || []
  };
};

// Construire les queries Gmail dynamiquement
const buildGmailQueries = (rules, afterDate, beforeDate) => {
  const dateFilter = `after:${afterDate}${beforeDate ? ` before:${beforeDate}` : ''}`;
  const excludeFilter = `-in:spam -in:trash`;
  const queries = new Set();

  // 1. Query par expéditeurs connus (manuel + auto-appris)
  const allSenders = [...(rules.known_senders || []), ...(rules.auto_senders || [])];
  if (allSenders.length > 0) {
    // Grouper par batch de 10 pour éviter les queries trop longues
    for (let i = 0; i < allSenders.length; i += 10) {
      const batch = allSenders.slice(i, i + 10);
      const senderFilter = batch.map(s => `from:${s}`).join(' OR ');
      queries.add(`${excludeFilter} (${senderFilter}) ${dateFilter}`);
    }
  }

  // 2. Query par mots-clés sujet + PDF
  const keywords = rules.subject_keywords || [];
  if (keywords.length > 0) {
    const kwFilter = keywords.map(k => `subject:"${k}"`).join(' OR ');
    queries.add(`${excludeFilter} has:attachment filename:pdf (${kwFilter}) ${dateFilter}`);
    queries.add(`${excludeFilter} (${kwFilter}) ${dateFilter}`);
  }

  // 3. Query générale PDF
  queries.add(`${excludeFilter} has:attachment filename:pdf ${dateFilter}`);

  return [...queries];
};

// Pré-filtrage Claude — est-ce une facture ?
const isLikelyInvoice = async (subject, senderEmail, bodyPreview, rules) => {
  // Expéditeurs connus → toujours traiter
  const allSenders = [...(rules.known_senders || []), ...(rules.auto_senders || [])];
  if (allSenders.some(s => senderEmail.toLowerCase().includes(s.toLowerCase()))) {
    return { likely: true, confidence: 95, reason: 'Expéditeur connu' };
  }

  // Mots-clés exclusion → ignorer
  const excludeKw = rules.exclude_keywords || [];
  const combined = `${subject} ${bodyPreview}`.toLowerCase();
  if (excludeKw.some(k => combined.includes(k.toLowerCase()))) {
    return { likely: false, confidence: 90, reason: 'Mot-clé exclusion trouvé' };
  }

  // Mots-clés inclusion → probablement une facture
  const includeKw = rules.subject_keywords || [];
  if (includeKw.some(k => subject.toLowerCase().includes(k.toLowerCase()))) {
    return { likely: true, confidence: 80, reason: 'Mot-clé sujet trouvé' };
  }

  // Claude décide pour les cas ambigus
  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `${rules.claude_instructions || 'Tu es un expert en détection de factures.'}

Expéditeur: ${senderEmail}
Sujet: ${subject}
Aperçu: ${bodyPreview.substring(0, 300)}

Réponds UNIQUEMENT en JSON: {"is_invoice": true/false, "confidence": 0-100, "reason": "courte explication"}`
      }]
    });
    const clean = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    return { likely: result.is_invoice, confidence: result.confidence, reason: result.reason };
  } catch {
    return { likely: false, confidence: 0, reason: 'Erreur analyse' };
  }
};

// Classification complète Claude
const classifyInvoice = async (text, senderEmail, senderName, subject, cats, corrections, rules) => {
  const categoryList = cats.map(c => `- ${c.name}: ${c.keywords?.join(', ') || ''}`).join('\n');
  const correctionExamples = corrections.length > 0
    ? `\nCorrections passées — apprends de ces erreurs:\n${corrections.map(c => `  - "${c.sender_name || c.sender_email}" classifié comme "${c.correct_category}" (pas "${c.suggested_category}")`).join('\n')}`
    : '';

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `${rules?.claude_instructions || 'Tu es un expert en classification de factures.'}

Catégories disponibles:
${categoryList}
${correctionExamples}

Expéditeur: ${senderName} <${senderEmail}>
Sujet: ${subject}
Contenu: ${text.substring(0, 2000)}

Réponds UNIQUEMENT en JSON valide:
{
  "is_invoice": true/false,
  "category": "nom exact",
  "confidence": 0-100,
  "amount": 0.00,
  "currency": "USD/CAD/EUR",
  "invoice_date": "YYYY-MM-DD",
  "invoice_number": "string ou null",
  "vendor_name": "string",
  "reasoning": "explication courte"
}`
      }]
    });
    const clean = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    return { is_invoice: true, category: 'Autre', confidence: 0, amount: null, currency: 'USD', vendor_name: senderName };
  }
};

// Créer dossier Drive
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

const fileExistsInDrive = async (drive, fileName, folderId) => {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)' });
  return data.files.length > 0 ? data.files[0].id : null;
};

const extractTextFromEmail = (payload) => {
  let text = '';
  const extract = (part) => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      text += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n';
    } else if (part.mimeType === 'text/html' && part.body?.data && !text) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
      text += html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n';
    }
    if (part.parts) part.parts.forEach(extract);
  };
  if (payload.body?.data) text += Buffer.from(payload.body.data, 'base64').toString('utf-8');
  if (payload.parts) payload.parts.forEach(extract);
  return text.trim();
};

// POST /api/invoices/scan
router.post('/scan', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.body;
    const tokens = await getTokens();
    const auth = getOAuthClient(tokens);
    const gmail = google.gmail({ version: 'v1', auth });

    const { rules, cats, corrections } = await loadContext();
    const { data: settings } = await getSupabase().from('invoice_settings').select('*').single();

    const scanFrom = dateFrom || settings?.last_scan_at?.split('T')[0] || settings?.scan_from_date || '2025-01-01';
    const scanTo = dateTo || null;
    const afterDate = Math.floor(new Date(scanFrom).getTime() / 1000);
    const beforeDate = scanTo ? Math.floor(new Date(scanTo).getTime() / 1000) : null;

    // Construire queries dynamiques
    const queries = buildGmailQueries(rules, afterDate, beforeDate);
    console.log(`Running ${queries.length} Gmail queries...`);

    // Collecter tous les message IDs uniques
    const allMessageIds = new Set();
    for (const q of queries) {
      try {
        const { data } = await gmail.users.messages.list({ userId: 'me', q, maxResults: 500 });
        (data.messages || []).forEach(m => allMessageIds.add(m.id));
      } catch (err) { console.error('Query error:', err.message); }
    }

    console.log(`Found ${allMessageIds.size} unique emails`);

    let processed = 0, skipped = 0, filtered = 0, errors = 0;

    for (const messageId of allMessageIds) {
      try {
        // Anti-doublon
        const { data: existing } = await getSupabase().from('invoice_drafts').select('id').eq('gmail_message_id', messageId).single();
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

        // Extraire texte pour pré-filtrage
        const bodyPreview = extractTextFromEmail(fullMsg.payload).substring(0, 500);

        // Pré-filtrage Claude
        const preFilter = await isLikelyInvoice(subject, senderEmail, bodyPreview, rules);
        if (!preFilter.likely && preFilter.confidence > 80) {
          filtered++;
          continue;
        }

        // Trouver PDFs
        const parts = fullMsg.payload.parts || [];
        const pdfParts = parts.filter(p =>
          p.mimeType === 'application/pdf' ||
          p.filename?.toLowerCase().endsWith('.pdf') ||
          (p.mimeType === 'application/octet-stream' && p.filename?.toLowerCase().endsWith('.pdf'))
        );

        let rawText = '';
        let hasPdf = false;
        let type = 'embedded_email';

        if (pdfParts.length > 0) {
          hasPdf = true;
          type = 'pdf_attachment';
          try {
            const { data: attachment } = await gmail.users.messages.attachments.get({
              userId: 'me', messageId, id: pdfParts[0].body.attachmentId
            });
            const pdfBuffer = Buffer.from(attachment.data, 'base64');
            const pdfData = await pdf(pdfBuffer);
            rawText = pdfData.text;
          } catch { rawText = bodyPreview; }
        } else {
          rawText = extractTextFromEmail(fullMsg.payload);
        }

        // Classification complète
        const analysis = await classifyInvoice(rawText, senderEmail, senderName, subject, cats, corrections, rules);

        // Sauvegarder
        await getSupabase().from('invoice_drafts').insert({
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
          is_embedded: !hasPdf,
          status: 'pending_review',
          raw_text: rawText.substring(0, 3000)
        });

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

    res.json({ success: true, processed, skipped, filtered, errors, total: allMessageIds.size });
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices/drafts
router.get('/drafts', async (req, res) => {
  try {
    const { status, category, limit = 500, offset = 0 } = req.query;
    let query = getSupabase().from('invoice_drafts').select('*').order('received_at', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (status) query = query.eq('status', status);
    if (category) query = query.eq('final_category', category);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, drafts: data, count: data.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
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
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// PATCH /api/invoices/drafts/:id
router.patch('/drafts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const { data: current } = await getSupabase().from('invoice_drafts').select('*').eq('id', id).single();

    const { data, error } = await getSupabase().from('invoice_drafts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (error) throw error;

    // Sauvegarder correction si catégorie changée
    if (current && updates.final_category && current.suggested_category !== updates.final_category) {
      await getSupabase().from('classification_corrections').insert({
        sender_email: current.sender_email,
        sender_name: current.sender_name,
        subject_pattern: current.subject,
        suggested_category: current.suggested_category,
        correct_category: updates.final_category
      });

      // Ajouter à auto_senders si c'est une facture validée
      if (updates.final_category !== 'Pas une facture' && current.sender_email) {
        const { data: rules } = await getSupabase().from('invoice_scan_rules').select('*').single();
        const autoSenders = rules?.auto_senders || [];
        if (!autoSenders.includes(current.sender_email)) {
          await getSupabase().from('invoice_scan_rules').update({
            auto_senders: [...autoSenders, current.sender_email]
          }).eq('id', rules.id);
        }
      }
    }

    res.json({ success: true, draft: data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/invoices/drafts/:id/classify
router.post('/drafts/:id/classify', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: draft } = await getSupabase().from('invoice_drafts').select('*').eq('id', id).single();
    if (!draft) return res.status(404).json({ success: false, error: 'Introuvable' });
    if (draft.status === 'classified') return res.json({ success: true, message: 'Déjà classifié', draft });

    const tokens = await getTokens();
    const auth = getOAuthClient(tokens);
    const gmail = google.gmail({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    const { data: settings } = await getSupabase().from('invoice_settings').select('*').single();
    let rootFolderId = settings?.drive_root_folder_id;
    if (!rootFolderId) {
      rootFolderId = await getOrCreateFolder(drive, settings?.drive_root_folder_name || 'MitchBI - Factures');
      await getSupabase().from('invoice_settings').update({ drive_root_folder_id: rootFolderId }).eq('id', settings.id);
    }

    const categoryFolderId = await getOrCreateFolder(drive, draft.final_category || 'Autre', rootFolderId);

    // Nom du fichier intelligent
    const vendorClean = (draft.suggested_vendor_name || draft.sender_name || 'Unknown')
      .replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_').substring(0, 30);
    const dateStr = draft.received_at ? new Date(draft.received_at).toISOString().split('T')[0] : 'unknown';
    const amountStr = draft.final_amount ? `_${draft.final_amount}${draft.final_currency || 'USD'}` : '';
    const invoiceNum = draft.final_invoice_number ? `_${draft.final_invoice_number.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 20)}` : '';
    const fileName = `${vendorClean}_${dateStr}${amountStr}${invoiceNum}.pdf`;

    // Anti-doublon Drive
    const existingFileId = await fileExistsInDrive(drive, fileName, categoryFolderId);
    let driveFileId = existingFileId;
    let driveFileUrl = null;

    if (existingFileId) {
      const { data: f } = await drive.files.get({ fileId: existingFileId, fields: 'webViewLink' });
      driveFileUrl = f.webViewLink;
    } else if (draft.has_pdf) {
      try {
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
      } catch (err) { console.error('Drive upload error:', err.message); }
    }

    // Ajouter expéditeur aux auto_senders
    if (draft.sender_email) {
      const { data: rules } = await getSupabase().from('invoice_scan_rules').select('*').single();
      const autoSenders = rules?.auto_senders || [];
      const knownSenders = rules?.known_senders || [];
      if (!autoSenders.includes(draft.sender_email) && !knownSenders.includes(draft.sender_email)) {
        await getSupabase().from('invoice_scan_rules').update({
          auto_senders: [...autoSenders, draft.sender_email]
        }).eq('id', rules.id);
      }
    }

    const { data: updated } = await getSupabase().from('invoice_drafts').update({
      status: 'classified',
      drive_file_id: driveFileId,
      drive_file_url: driveFileUrl,
      drive_folder_id: categoryFolderId,
      pdf_filename: fileName,
      updated_at: new Date().toISOString()
    }).eq('id', id).select().single();

    res.json({ success: true, draft: updated });
  } catch (err) {
    console.error('Classify error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/invoices/drafts/:id
router.delete('/drafts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: draft } = await getSupabase().from('invoice_drafts').select('drive_file_id').eq('id', id).single();
    if (draft?.drive_file_id) {
      try {
        const tokens = await getTokens();
        const auth = getOAuthClient(tokens);
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.delete({ fileId: draft.drive_file_id });
      } catch (err) { console.log('Drive delete (non-fatal):', err.message); }
    }
    await getSupabase().from('invoice_drafts').delete().eq('id', id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/invoices/categories
router.get('/categories', async (req, res) => {
  try {
    const { data } = await getSupabase().from('invoice_categories').select('*').eq('is_active', true).order('sort_order');
    res.json({ success: true, categories: data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/invoices/categories
router.post('/categories', async (req, res) => {
  try {
    const { name, color, icon, keywords, description } = req.body;
    const { data, error } = await getSupabase().from('invoice_categories').insert({ name, color, icon, keywords, description }).select().single();
    if (error) throw error;
    res.json({ success: true, category: data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/invoices/scan-rules
router.get('/scan-rules', async (req, res) => {
  try {
    const { data } = await getSupabase().from('invoice_scan_rules').select('*').single();
    res.json({ success: true, rules: data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// PATCH /api/invoices/scan-rules
router.patch('/scan-rules', async (req, res) => {
  try {
    const { data: existing } = await getSupabase().from('invoice_scan_rules').select('id').single();
    const { data, error } = await getSupabase().from('invoice_scan_rules')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select().single();
    if (error) throw error;
    res.json({ success: true, rules: data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/invoices/export/csv
router.get('/export/csv', async (req, res) => {
  try {
    const { data } = await getSupabase().from('invoice_drafts').select('*').eq('status', 'classified').order('received_at', { ascending: false });
    const headers = ['Date', 'Vendeur', 'Email', 'Sujet', 'Montant', 'Devise', 'Date facture', 'N° facture', 'Catégorie', 'Fichier Drive', 'Gmail', 'Notes'];
    const rows = (data || []).map(d => [
      d.received_at ? new Date(d.received_at).toLocaleDateString('fr-CA') : '',
      d.suggested_vendor_name || d.sender_name || '',
      d.sender_email || '', d.subject || '',
      d.final_amount || '', d.final_currency || '',
      d.final_invoice_date || '', d.final_invoice_number || '',
      d.final_category || '', d.drive_file_url || '',
      d.gmail_url || '', d.notes || ''
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mitchbi-factures.csv"');
    res.send('\uFEFF' + csv);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
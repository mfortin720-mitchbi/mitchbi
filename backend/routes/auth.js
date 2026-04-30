const express = require('express');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const getOAuthClient = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email'
];

// GET /api/auth/google — Générer l'URL d'autorisation
router.get('/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.json({ url });
});

// GET /api/auth/google/callback — Recevoir le code et sauvegarder les tokens
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // Récupérer l'email de l'utilisateur
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    // Sauvegarder les tokens dans Supabase
    const { error } = await supabase
      .from('invoice_settings')
      .upsert({
        gmail_connected: true,
        gmail_email: userInfo.email,
        google_access_token: tokens.access_token,
        google_refresh_token: tokens.refresh_token,
        google_token_expiry: tokens.expiry_date,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

    // Rediriger vers MitchBI avec succès
    res.redirect(`${process.env.FRONTEND_URL || 'https://mitchbi.com'}/invoices?gmail=connected`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${process.env.FRONTEND_URL || 'https://mitchbi.com'}/invoices?gmail=error`);
  }
});

// GET /api/auth/google/status — Vérifier si Gmail est connecté
router.get('/google/status', async (req, res) => {
  try {
    const { data } = await supabase
      .from('invoice_settings')
      .select('gmail_connected, gmail_email, last_scan_at, next_scan_at, scan_interval_hours')
      .single();
    res.json({ connected: data?.gmail_connected || false, email: data?.gmail_email, settings: data });
  } catch (err) {
    res.json({ connected: false });
  }
});

module.exports = router;
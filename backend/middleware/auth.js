const { createClient } = require('@supabase/supabase-js');

let supabase = null;
const getSupabase = () => {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY env vars are not set');
  supabase = createClient(url, key);
  return supabase;
};

// Every /api/* route requires a logged-in Supabase session. The frontend
// attaches the session's access_token as a Bearer token (see services/api.js).
// Exception: the Telegram webhook can't carry a Supabase session (it's called
// by Telegram's servers) -- it authenticates itself instead via the
// X-Telegram-Bot-Api-Secret-Token header, checked in the route handler.
async function requireAuth(req, res, next) {
  if (req.path === '/epicerie/telegram-webhook') return next();

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Missing Authorization header' });

  try {
    const { data, error } = await getSupabase().auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ success: false, error: 'Invalid or expired session' });
    req.user = data.user;
    next();
  } catch (err) {
    console.error('[auth] verification error:', err.message);
    res.status(500).json({ success: false, error: 'Auth verification failed' });
  }
}

module.exports = { requireAuth };

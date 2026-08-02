import { supabase } from './supabase';

const API_URL = import.meta.env.VITE_API_URL;

// Attaches the current Supabase session's access token so the backend can
// verify the caller is logged in. All /api/* routes require this now.
export async function apiFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = { ...(options.headers || {}) };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  return fetch(`${API_URL}${path}`, { ...options, headers });
}

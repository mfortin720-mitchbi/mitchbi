-- NexusIQ (Assistant module) memory tables.
-- Run this once in the Supabase SQL editor (same project already used by the
-- Épicerie module's grocery_* tables -- SUPABASE_URL/SUPABASE_SERVICE_KEY on
-- Railway are already correct, no new env vars needed).

-- Curated memory: NexusIQ writes here itself (save_memory tool) only what's
-- worth remembering -- preferences, corrections, project facts. Reloaded and
-- injected into the system prompt at the start of every conversation.
create table if not exists assistant_memory (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_email text,
  memory_type text not null check (memory_type in ('user', 'feedback', 'project', 'reference')),
  summary text not null,
  content text not null
);

create index if not exists assistant_memory_created_at_idx on assistant_memory (created_at desc);
create index if not exists assistant_memory_user_email_idx on assistant_memory (user_email);

alter table assistant_memory enable row level security;
-- No policies added on purpose: deny-by-default for anon/authenticated roles,
-- same convention as grocery_agent_log. Only the service-role key (used by
-- the backend) can read/write.

-- Raw transcript: one row per message (user and assistant), for audit/replay
-- only -- never reloaded as context, to keep the memory prompt small.
create table if not exists assistant_conversation_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_email text,
  role text not null check (role in ('user', 'assistant')),
  content text not null
);

create index if not exists assistant_conversation_log_created_at_idx on assistant_conversation_log (created_at desc);
create index if not exists assistant_conversation_log_user_email_idx on assistant_conversation_log (user_email);

alter table assistant_conversation_log enable row level security;

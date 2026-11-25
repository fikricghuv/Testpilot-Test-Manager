-- Project-scoped Telegram notification integration (bot token encrypted at rest).
CREATE TABLE IF NOT EXISTS project_telegram_integrations (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  bot_token_encrypted TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  thread_id INTEGER,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  events JSONB NOT NULL DEFAULT '{"bugs":true,"testRuns":true,"comments":true,"zyra":true,"other":true}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

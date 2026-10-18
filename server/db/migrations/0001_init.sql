-- Fase 3: utilizadores, sessões, conversas, mensagens, ficheiros e auditoria.
-- Todas as tabelas de dados de utilizador têm user_id e as consultas filtram sempre por ele.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         citext NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  display_name  text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Guarda-se apenas o SHA-256 do token; o token em claro só existe no cookie.
CREATE TABLE sessions (
  token_hash   bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE conversations (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  model      text NOT NULL CHECK (length(model) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_updated_idx ON conversations (user_id, updated_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq             bigint GENERATED ALWAYS AS IDENTITY,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL DEFAULT '',
  status          text NOT NULL CHECK (status IN ('complete', 'streaming', 'error', 'cancelled')),
  model           text,
  error           jsonb,
  usage           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_seq_idx ON messages (conversation_id, seq);
-- No máximo uma geração em curso por conversa (impede pedidos concorrentes).
CREATE UNIQUE INDEX messages_one_streaming_idx ON messages (conversation_id) WHERE status = 'streaming';

-- Metadados de ficheiros; o conteúdo vive no armazenamento de objetos (storage_key).
CREATE TABLE files (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES messages(id) ON DELETE SET NULL,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  media_type  text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('text', 'image', 'pdf')),
  size_bytes  integer NOT NULL CHECK (size_bytes > 0),
  sha256      bytea NOT NULL CHECK (length(sha256) = 32),
  storage_key text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_user_idx ON files (user_id, created_at DESC);
CREATE INDEX files_message_idx ON files (message_id);

-- Registo de auditoria apenas de inserção (a aplicação nunca faz UPDATE/DELETE aqui).
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  target     text,
  ip         text,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_user_idx ON audit_log (user_id, created_at DESC);

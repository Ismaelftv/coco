-- Pesquisa no histórico sem distinguir maiúsculas nem acentos, com índices trigram.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() não é IMMUTABLE; este invólucro fixa o dicionário para poder ser indexado.
CREATE FUNCTION forja_fold(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, $1)) $$;

CREATE INDEX conversations_title_trgm_idx ON conversations USING gin (forja_fold(title) gin_trgm_ops);
CREATE INDEX messages_content_trgm_idx ON messages USING gin (forja_fold(content) gin_trgm_ops);

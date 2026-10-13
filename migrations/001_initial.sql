CREATE SCHEMA IF NOT EXISTS radar;
REVOKE ALL ON SCHEMA radar FROM PUBLIC;

CREATE TABLE IF NOT EXISTS radar.runs (
  id text PRIMARY KEY, namespace text NOT NULL, day text NOT NULL,
  status text NOT NULL DEFAULT 'pending', body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_cycle ON radar.runs(namespace, day);
CREATE TABLE IF NOT EXISTS radar.leases (
  namespace text PRIMARY KEY, owner text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS radar.contents (
  id text PRIMARY KEY, fingerprint text NOT NULL, body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contents_fingerprint ON radar.contents(fingerprint);
CREATE TABLE IF NOT EXISTS radar.discovery_hits (
  run_id text NOT NULL REFERENCES radar.runs(id), query_id text NOT NULL,
  content_id text NOT NULL REFERENCES radar.contents(id), query jsonb NOT NULL,
  PRIMARY KEY(run_id, query_id, content_id)
);
CREATE TABLE IF NOT EXISTS radar.analyses (
  cache_key text PRIMARY KEY, content_id text NOT NULL REFERENCES radar.contents(id),
  phase text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS radar.briefs (
  id text PRIMARY KEY REFERENCES radar.runs(id), namespace text NOT NULL, day text NOT NULL,
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS radar.brief_items (
  brief_id text NOT NULL REFERENCES radar.briefs(id), content_id text NOT NULL,
  fingerprint text NOT NULL, topic text NOT NULL, PRIMARY KEY(brief_id, content_id)
);
CREATE TABLE IF NOT EXISTS radar.deliveries (
  id text PRIMARY KEY, brief_id text NOT NULL REFERENCES radar.briefs(id), target text NOT NULL,
  part integer NOT NULL, body jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0, error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS radar.feedback (
  namespace text NOT NULL, content_id text NOT NULL REFERENCES radar.contents(id),
  rating text NOT NULL CHECK(rating IN ('interesting','neutral','skip')), reason text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace, content_id)
);
CREATE TABLE IF NOT EXISTS radar.budgets (
  namespace text NOT NULL, day text NOT NULL, source_calls integer NOT NULL DEFAULT 0,
  model_calls integer NOT NULL DEFAULT 0, tokens bigint NOT NULL DEFAULT 0,
  cost double precision NOT NULL DEFAULT 0, PRIMARY KEY(namespace, day)
);
CREATE TABLE IF NOT EXISTS radar.usage (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES radar.runs(id), phase text NOT NULL,
  provider text NOT NULL, model text NOT NULL, input_tokens integer, output_tokens integer,
  estimated_cost double precision, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS radar.migrations (
  id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);

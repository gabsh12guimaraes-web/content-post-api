-- Pessoas da marca (fundador, equipe, cliente) com foto de rosto, para aparecerem nas imagens geradas em posts humanizados.
-- autorizado_em guarda quando quem enviou confirmou ter a autorização de uso de imagem da pessoa.
create table if not exists pessoas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  arquivo_id uuid not null references arquivos(id) on delete cascade,
  nome text not null default '',
  autorizado_por uuid references usuarios(id) on delete set null,
  autorizado_em timestamptz not null default now(),
  criado_em timestamptz not null default now()
);
create index if not exists pessoas_org on pessoas (org_id, criado_em desc);

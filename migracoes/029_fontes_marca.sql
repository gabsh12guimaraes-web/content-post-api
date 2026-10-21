create table fontes_marca (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  arquivo_id uuid not null references arquivos(id) on delete cascade,
  nome text not null,
  familia text not null,
  peso integer not null default 400,
  hash text not null,
  criado_em timestamptz not null default now(),
  unique(org_id, hash)
);
create index fontes_marca_org on fontes_marca(org_id);

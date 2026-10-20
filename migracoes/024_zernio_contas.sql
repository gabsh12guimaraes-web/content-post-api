-- Contas de um Zernio compartilhado precisam de vínculo explícito com uma organização.
-- O mesmo accountId nunca pode pertencer a duas organizações.
create table zernio_contas (
  conta_id text primary key,
  org_id uuid not null references organizacoes(id) on delete cascade,
  credencial_hash text not null,
  criado_em timestamptz not null default now()
);
create index zernio_contas_org on zernio_contas(org_id);

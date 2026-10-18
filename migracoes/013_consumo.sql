-- Consumo de IA por organização: tokens do Claude e fotos/clipes do Magnific, para o relatório de controle.
-- chave_propria: a organização usou a própria chave (o custo é dela); senão foi a chave da plataforma.
create table if not exists consumo (
  id bigserial primary key,
  org_id uuid not null references organizacoes(id) on delete cascade,
  provedor text not null,
  tipo text not null default '',
  entrada int not null default 0,
  saida int not null default 0,
  cache_leitura int not null default 0,
  cache_escrita int not null default 0,
  quantidade numeric not null default 0,
  chave_propria boolean not null default false,
  criado_em timestamptz not null default now()
);
create index if not exists consumo_org_data on consumo (org_id, criado_em);

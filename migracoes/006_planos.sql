-- Planos pagos pela Kiwify: cada organização tem um plano, um ciclo e até quando está paga.
-- Organizações novas (e as que já existem) começam no teste grátis de 7 dias.
alter table organizacoes add column if not exists plano text not null default 'teste';
alter table organizacoes add column if not exists ciclo text;
alter table organizacoes add column if not exists plano_ate timestamptz not null default (now() + interval '7 days');
alter table organizacoes add column if not exists kiwify_assinatura text;

-- Uso que conta para o limite do plano (post criado pela IA, busca de ideias).
create table if not exists uso (
  id bigserial primary key,
  org_id uuid not null references organizacoes(id) on delete cascade,
  tipo text not null check (tipo in ('post', 'ideias')),
  criado_em timestamptz not null default now()
);
create index if not exists uso_org_tipo_data on uso (org_id, tipo, criado_em);

-- Avisos da Kiwify já processados (a Kiwify pode reenviar o mesmo aviso).
create table if not exists kiwify_eventos (
  chave text primary key,
  evento text not null,
  org_id uuid references organizacoes(id) on delete set null,
  resultado text,
  recebido_em timestamptz not null default now()
);

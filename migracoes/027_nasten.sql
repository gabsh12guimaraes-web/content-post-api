-- Mantém o histórico e as assinaturas Kiwify enquanto novas compras usam a Nasten.
alter table organizacoes add column if not exists pagamento_provedor text;
alter table organizacoes add column if not exists pagamento_id text;
alter table organizacoes add column if not exists pagamento_em timestamptz;
update organizacoes set pagamento_provedor = 'kiwify' where plano <> 'teste' and pagamento_provedor is null;

-- Recebimento durável: a Nasten não reenvia automaticamente webhooks que falharam.
create table if not exists nasten_eventos (
  id text primary key,
  evento text not null,
  transacao text not null,
  dados jsonb not null,
  org_id uuid references organizacoes(id) on delete set null,
  status text not null default 'pendente' check (status in ('pendente', 'processando', 'feito')),
  tentativas int not null default 0,
  resultado text,
  executar_em timestamptz not null default now(),
  recebido_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists nasten_eventos_fila on nasten_eventos (status, executar_em);
create table if not exists nasten_pagamentos (
  transacao text primary key,
  org_id uuid not null references organizacoes(id) on delete cascade,
  plano text not null,
  ciclo text not null,
  status text not null,
  pago_em timestamptz not null,
  ate timestamptz not null,
  pago_centavos int not null,
  liquido_centavos int,
  verificado_em timestamptz not null default now()
);
create index if not exists nasten_pagamentos_org on nasten_pagamentos (org_id, pago_em desc);

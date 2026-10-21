create table mega_brain_estrategias (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  pedido uuid not null,
  briefing jsonb not null,
  resultado jsonb,
  status text not null default 'gerando' check (status in ('gerando','pronta','erro')),
  erro text,
  criado_por uuid references usuarios(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (org_id, pedido)
);
create index mega_brain_por_org on mega_brain_estrategias(org_id, criado_em desc);
alter table ideias add column estrategia_id uuid references mega_brain_estrategias(id) on delete set null;
alter table ideias add column etapa_funil text check (etapa_funil in ('topo','meio','fundo'));
create index ideias_da_estrategia on ideias(org_id, estrategia_id, etapa_funil);
create unique index tarefas_pedido_ideias on tarefas(org_id, (payload->>'pedido')) where tipo = 'ideias' and payload ? 'pedido';
alter table tarefas drop constraint if exists tarefas_tipo_check;
alter table tarefas add constraint tarefas_tipo_check check (tipo in ('ideias','criar','ajustar','importar','descreverImagem','criarModelo','analisarMarca','exemplosIdeia','estrategia'));

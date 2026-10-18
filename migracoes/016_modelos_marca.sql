-- Modelos de post feitos a partir dos posts que a marca já publica (enviados ou buscados no Instagram).
-- spec: cores, fonte, layout base, posições e moldura que a IA tirou dos exemplos; o painel desenha com ela.
create table if not exists modelos_marca (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  nome text not null default '',
  spec jsonb,
  exemplos uuid[] not null default '{}',
  status text not null default 'gerando' check (status in ('gerando', 'pronto', 'erro')),
  erro text,
  criado_em timestamptz not null default now()
);
create index if not exists modelos_marca_org on modelos_marca (org_id, criado_em desc);
alter table marcas add column if not exists modelo_padrao uuid references modelos_marca(id) on delete set null;

alter table tarefas drop constraint if exists tarefas_tipo_check;
alter table tarefas add constraint tarefas_tipo_check check (tipo in ('ideias', 'criar', 'ajustar', 'importar', 'descreverImagem', 'criarModelo'));

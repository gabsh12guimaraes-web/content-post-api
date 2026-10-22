create table sinsalabim_edicoes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  criado_por uuid references usuarios(id),
  pedido uuid not null,
  arquivo_id uuid not null references arquivos(id),
  nome text not null,
  estilo text not null default 'dinamico',
  status text not null default 'enviado',
  duracao numeric,
  transcricao jsonb,
  plano jsonb,
  versao integer not null default 0,
  mensagens jsonb not null default '[]',
  erro text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique(org_id, pedido)
);
create index sinsalabim_org on sinsalabim_edicoes(org_id, atualizado_em desc);
create table sinsalabim_exportacoes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  edicao_id uuid not null references sinsalabim_edicoes(id) on delete cascade,
  pedido uuid not null,
  versao integer not null,
  plano jsonb not null,
  ambiente text not null default 'v1',
  status text not null default 'pendente',
  render_id text,
  arquivo_id uuid references arquivos(id),
  post_id uuid references posts(id) on delete set null,
  banco_id uuid references banco_imagens(id) on delete set null,
  consulta_ate timestamptz,
  erro text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique(org_id, pedido)
);
create index sinsalabim_cota on sinsalabim_exportacoes(org_id, criado_em);
create unique index sinsalabim_uma_exportacao on sinsalabim_exportacoes(edicao_id) where status in ('pendente','enviando','renderizando','salvando');
alter table tarefas drop constraint tarefas_tipo_check;
alter table tarefas add constraint tarefas_tipo_check check (tipo in ('ideias','criar','ajustar','importar','descreverImagem','criarModelo','analisarMarca','exemplosIdeia','estrategia','sinsalabimAnalise','sinsalabimExportar'));

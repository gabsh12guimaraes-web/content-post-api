-- Banco de imagens da marca: fotos próprias (produtos, loja, equipe) usadas nos posts no lugar das geradas por IA.
create table if not exists banco_imagens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  arquivo_id uuid not null references arquivos(id) on delete cascade,
  nome text not null default '',
  descricao text not null default '',
  tags text[] not null default '{}',
  criado_em timestamptz not null default now()
);
create index if not exists banco_imagens_org on banco_imagens (org_id, criado_em desc);

-- Nova tarefa: a IA descreve as fotos enviadas ao banco.
alter table tarefas drop constraint if exists tarefas_tipo_check;
alter table tarefas add constraint tarefas_tipo_check check (tipo in ('ideias', 'criar', 'ajustar', 'importar', 'descreverImagem'));

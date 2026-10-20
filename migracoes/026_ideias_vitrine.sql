alter table ideias add column exemplos jsonb not null default '[]';
alter table ideias add column exemplos_em timestamptz;
alter table banco_imagens add column publico_login boolean not null default false;
alter table tarefas drop constraint if exists tarefas_tipo_check;
alter table tarefas add constraint tarefas_tipo_check check (tipo in ('ideias', 'criar', 'ajustar', 'importar', 'descreverImagem', 'criarModelo', 'analisarMarca', 'exemplosIdeia'));

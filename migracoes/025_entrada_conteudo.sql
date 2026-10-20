alter table marcas add column site text not null default '';
alter table posts add column origem text not null default 'ia' check (origem in ('ia', 'envio'));
alter table posts add column pedido_envio uuid;
create unique index posts_pedido_envio on posts (org_id, pedido_envio) where pedido_envio is not null;
alter table tarefas drop constraint if exists tarefas_tipo_check;
alter table tarefas add constraint tarefas_tipo_check check (tipo in ('ideias', 'criar', 'ajustar', 'importar', 'descreverImagem', 'criarModelo', 'analisarMarca'));

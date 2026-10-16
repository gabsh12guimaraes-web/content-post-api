-- Nova tarefa: trazer marca, fontes, ideias e calendário de uma base do Airtable.
alter table tarefas drop constraint if exists tarefas_tipo_check;
alter table tarefas add constraint tarefas_tipo_check check (tipo in ('ideias', 'criar', 'ajustar', 'importar'));

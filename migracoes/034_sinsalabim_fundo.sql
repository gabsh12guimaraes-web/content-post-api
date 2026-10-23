-- Sinsalabim: fundo trocado atrás da pessoa (desfoque, imagem do banco ou gerada) e o nome do projeto editável.
alter table sinsalabim_edicoes add column if not exists fundo jsonb;
alter table tarefas drop constraint if exists tarefas_tipo_check;
alter table tarefas add constraint tarefas_tipo_check check (tipo in ('ideias','criar','ajustar','importar','descreverImagem','criarModelo','analisarMarca','exemplosIdeia','estrategia','sinsalabimAnalise','sinsalabimExportar','sinsalabimFundo'));

-- Sinsalabim: vários vídeos viram uma sequência (partes, na ordem) e a etapa da análise aparece na barra de progresso.
alter table sinsalabim_edicoes add column if not exists partes jsonb;
alter table sinsalabim_edicoes add column if not exists etapa text;

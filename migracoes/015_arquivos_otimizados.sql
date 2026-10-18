-- Imagens mais leves: a original é comprimida ao salvar e ganha uma versão de prévia (720 px, WebP) para as listas e prévias.
-- tratado: já passou pela otimização (as antigas são tratadas aos poucos, em segundo plano).
alter table arquivos add column if not exists previa boolean not null default false;
alter table arquivos add column if not exists tratado boolean not null default false;
create index if not exists arquivos_nao_tratados on arquivos (criado_em) where not tratado;

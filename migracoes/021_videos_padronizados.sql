-- Vídeos já convertidos para o padrão do Instagram (H.264, 30 fps, AAC, faststart) não são convertidos de novo.
alter table arquivos add column if not exists padronizado boolean not null default false;

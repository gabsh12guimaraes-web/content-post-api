-- Banco de imagens e vídeos: tudo que a IA gera (fotos e clipes) também fica guardado para reutilizar,
-- por exemplo quando acabam os créditos do Magnific.
alter table banco_imagens add column if not exists origem text not null default 'envio';
alter table banco_imagens drop constraint if exists banco_imagens_origem_check;
alter table banco_imagens add constraint banco_imagens_origem_check check (origem in ('envio', 'ia'));
alter table banco_imagens add column if not exists post_id uuid references posts(id) on delete set null;
create index if not exists banco_imagens_org_origem on banco_imagens (org_id, origem, criado_em desc);

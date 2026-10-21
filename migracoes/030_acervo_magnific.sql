-- A preferência acompanha a chave, inclusive quando várias organizações usam a conta da plataforma.
-- Desligada por padrão: Business e Enterprise podem cobrar pelos downloads do acervo.
create table magnific_acervo (
  chave_hash text primary key,
  plano text check (plano in ('premium', 'premium_plus', 'pro')),
  atualizado_por uuid references usuarios(id) on delete set null,
  atualizado_em timestamptz not null default now()
);
alter table banco_imagens drop constraint banco_imagens_origem_check;
alter table banco_imagens add constraint banco_imagens_origem_check check (origem in ('envio', 'ia', 'acervo'));
alter table banco_imagens add column fonte jsonb;
create unique index banco_acervo_por_org on banco_imagens(org_id, (fonte->>'id')) where origem='acervo';

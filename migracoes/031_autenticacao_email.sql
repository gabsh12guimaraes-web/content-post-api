alter table usuarios add column email_confirmado_em timestamptz;
alter table usuarios add column exigir_confirmacao_email boolean not null default false;

create table conta_links (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuarios(id) on delete cascade,
  tipo text not null check (tipo in ('confirmacao', 'recuperacao')),
  token_hash text not null unique,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  usado_em timestamptz
);
create index conta_links_usuario on conta_links(usuario_id, tipo, criado_em);

create table conta_emails (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuarios(id) on delete cascade,
  link_id uuid references conta_links(id) on delete cascade,
  tipo text not null check (tipo in ('confirmacao', 'recuperacao', 'senha_alterada')),
  payload_cifrado text,
  criado_em timestamptz not null default now(),
  proximo_envio_em timestamptz not null default now(),
  enviado_em timestamptz,
  tentativas integer not null default 0,
  erro text
);
create index conta_emails_pendentes on conta_emails(proximo_envio_em) where payload_cifrado is not null;

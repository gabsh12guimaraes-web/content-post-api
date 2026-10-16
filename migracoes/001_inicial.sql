-- Estrutura inicial: contas, organizações, chaves das integrações e a pauta de cada organização.
-- Toda tabela de conteúdo tem org_id: nenhuma consulta da API lê dados sem filtrar pela organização.

create table usuarios (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,             -- sempre em minúsculas
  nome text not null default '',
  senha_hash text not null,
  salt text not null,
  tentativas int not null default 0,
  bloqueado_ate timestamptz,
  ultimo_acesso timestamptz,
  criado_em timestamptz not null default now()
);

create table organizacoes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  criado_por uuid references usuarios(id) on delete set null,
  criado_em timestamptz not null default now()
);

-- papel: dono (um ou mais), admin (gerencia membros e chaves), editor (cuida da pauta)
create table membros (
  org_id uuid not null references organizacoes(id) on delete cascade,
  usuario_id uuid not null references usuarios(id) on delete cascade,
  papel text not null check (papel in ('dono', 'admin', 'editor')),
  criado_em timestamptz not null default now(),
  primary key (org_id, usuario_id)
);
create index membros_usuario on membros (usuario_id);

create table sessoes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references usuarios(id) on delete cascade,
  token_hash text not null unique,
  org_atual uuid references organizacoes(id) on delete set null,
  expira_em timestamptz not null,
  criado_em timestamptz not null default now()
);

create table convites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  email text not null,
  papel text not null check (papel in ('admin', 'editor')),
  token_hash text not null unique,
  criado_por uuid references usuarios(id) on delete set null,
  expira_em timestamptz not null,
  aceito_em timestamptz,
  criado_em timestamptz not null default now()
);
create index convites_org on convites (org_id);

-- Chaves das APIs de cada organização, cifradas com AES-256-GCM (chave mestra só na variável CHAVE_MESTRA).
create table integracoes (
  org_id uuid not null references organizacoes(id) on delete cascade,
  provedor text not null check (provedor in ('anthropic', 'magnific', 'apify', 'ayrshare')),
  valor_cifrado text not null,
  dica text not null default '',          -- últimos 4 caracteres, para a pessoa reconhecer a chave
  atualizado_por uuid references usuarios(id) on delete set null,
  atualizado_em timestamptz not null default now(),
  primary key (org_id, provedor)
);

create table arquivos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  tipo text not null,
  nome text not null default 'arquivo',
  tamanho int not null default 0,
  chave text not null,                    -- segredo da URL pública /f/:id/:chave
  criado_em timestamptz not null default now()
);
create index arquivos_org on arquivos (org_id);

create table marcas (
  org_id uuid primary key references organizacoes(id) on delete cascade,
  nome text not null default '',
  posicionamento text not null default '',
  publico text not null default '',
  tom_de_voz text not null default '',
  pilares text[] not null default '{}',
  evitar text not null default '',
  redes text[] not null default '{}',
  frequencia_semanal int,
  exemplos text not null default '',
  cores text not null default '',
  idioma text not null default 'Português (Brasil)',
  logos jsonb not null default '{}',      -- { Logo, LogoDark, SimboloLight, SimboloDark }: id do arquivo
  mood_board uuid[] not null default '{}',
  atualizado_em timestamptz not null default now()
);

create table fontes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  nome text not null,
  tipo text,
  categoria text,
  rede text,
  url text,
  peso int not null default 3,
  ativa boolean not null default true,
  ultima_coleta timestamptz,
  criado_em timestamptz not null default now()
);
create index fontes_org on fontes (org_id);

create table coletas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  fonte_id uuid references fontes(id) on delete set null,
  id_externo text not null,
  url text,
  texto text,
  formato text,
  curtidas int,
  comentarios int,
  engajamento_relativo numeric,
  data_post date,
  coletado_em timestamptz not null default now(),
  unique (org_id, id_externo)
);

create table ideias (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  titulo text not null,
  resumo text not null default '',
  formato text,
  rede text,
  pilar text,
  score numeric not null default 0,
  por_que text not null default '',
  status text not null default 'Sugerida' check (status in ('Sugerida', 'Aprovada', 'Descartada', 'Guardada')),
  motivo_descarte text not null default '',
  referencias uuid[] not null default '{}',
  criada_em timestamptz not null default now()
);
create index ideias_org on ideias (org_id, criada_em desc);

create table posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  ideia_id uuid references ideias(id) on delete set null,
  titulo text not null,
  data_publicacao timestamptz not null,
  rede text,
  formato text,
  pilar text,
  status text not null default 'Planejado',
  versao int not null default 1,
  legenda text not null default '',
  hashtags text not null default '',
  slides jsonb not null default '[]',
  conteudo jsonb not null default '{}',
  fotos jsonb not null default '{}',      -- { n do slide: id do arquivo }
  clipes jsonb not null default '{}',     -- { n da cena ou slide: id do arquivo }
  regerar int[] not null default '{}',
  artes uuid[] not null default '{}',     -- artes finais (imagens ou vídeos) na ordem dos slides
  artes_prontas boolean not null default false,
  diagramacao jsonb not null default '{"alinhar":"esquerda","posicao":"auto"}',
  historico_ajustes text not null default '',
  link_publicado text,
  id_agendamento text,
  erro text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index posts_org_data on posts (org_id, data_publicacao);
create index posts_publicar on posts (status, data_publicacao);

create table revisoes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  post_id uuid not null references posts(id) on delete cascade,
  versao int not null,
  decisao text not null,
  comentario text not null default '',
  usuario_id uuid references usuarios(id) on delete set null,
  criado_em timestamptz not null default now()
);

-- Fila de trabalhos longos (coleta de ideias, criação, ajuste). A publicação roda pelo relógio.
create table tarefas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizacoes(id) on delete cascade,
  tipo text not null check (tipo in ('ideias', 'criar', 'ajustar')),
  payload jsonb not null default '{}',
  status text not null default 'pendente' check (status in ('pendente', 'rodando', 'feito', 'erro')),
  tentativas int not null default 0,
  executar_em timestamptz not null default now(),
  iniciado_em timestamptz,
  terminado_em timestamptz,
  erro text,
  criado_por uuid references usuarios(id) on delete set null,
  criado_em timestamptz not null default now()
);
create index tarefas_fila on tarefas (status, executar_em);
create index tarefas_org on tarefas (org_id, criado_em desc);

-- Opções de publicação de cada post: Reels de teste no Instagram e o selo de conteúdo feito com IA.
alter table posts add column if not exists publicacao jsonb not null default '{}'::jsonb;

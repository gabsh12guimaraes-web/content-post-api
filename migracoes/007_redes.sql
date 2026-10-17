-- Um post pode ir para várias redes (Instagram, Facebook, TikTok, X, Threads...). Vazio = só a rede principal.
alter table posts add column if not exists redes text[] not null default '{}';
-- Link do post publicado em cada rede: {"Instagram": "https://...", "X": "https://..."}
alter table posts add column if not exists links jsonb not null default '{}';

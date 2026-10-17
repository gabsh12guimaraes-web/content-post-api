-- Respostas dadas no painel antes de criar o post (capa, fundos, slides, duração, objetivo, observações).
alter table posts add column if not exists briefing jsonb;

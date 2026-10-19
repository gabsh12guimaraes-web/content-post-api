-- Fotos de referência do briefing: além de pessoas (rosto), produtos e objetos que a IA coloca nas imagens.
alter table pessoas add column if not exists tipo text not null default 'pessoa';

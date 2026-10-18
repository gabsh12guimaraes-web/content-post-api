-- Consumo de antes do registro (ligado em 18/10/2026 às 14:36 UTC), para o relatório não começar zerado.
-- Fotos e clipes: contados de verdade pelo que a IA guardou no banco de imagens (clipe sem duração guardada conta 5 s).
-- Tokens do Claude: não foram guardados; entram como estimativa por tarefa (estimado = true), com base no PRECOS.md.
alter table consumo add column if not exists estimado boolean not null default false;

insert into consumo (org_id, provedor, tipo, quantidade, estimado, criado_em)
select b.org_id, 'magnific', case when a.tipo like 'video/%' then 'clipe' else 'foto' end,
       case when a.tipo like 'video/%' then 5 else 1 end, true, b.criado_em
from banco_imagens b join arquivos a on a.id = b.arquivo_id
where b.origem = 'ia' and b.criado_em < '2026-10-18 14:36:00+00';

-- Por tarefa: criação de post 25 mil tokens de entrada e 6 mil de saída; busca de ideias 20 mil e 5 mil; ajuste 15 mil e 3 mil.
insert into consumo (org_id, provedor, tipo, entrada, saida, quantidade, estimado, criado_em)
select org_id, 'anthropic', tipo, case tipo when 'post' then 25000 else 20000 end, case tipo when 'post' then 6000 else 5000 end, 1, true, criado_em
from uso where criado_em < '2026-10-18 14:36:00+00';

insert into consumo (org_id, provedor, tipo, entrada, saida, quantidade, estimado, criado_em)
select org_id, 'anthropic', 'ajuste', 15000, 3000, 1, true, criado_em
from revisoes where decisao = 'PediuAjuste' and criado_em < '2026-10-18 14:36:00+00';

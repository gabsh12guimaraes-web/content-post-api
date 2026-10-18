-- Leva para o banco as fotos e clipes que a IA gerou em posts criados antes do banco guardar sozinho.
-- Pula o que já está no banco (inclusive fotos enviadas pela pessoa) e arquivos que não existem mais.
insert into banco_imagens (org_id, arquivo_id, nome, descricao, tags, origem, post_id, criado_em)
select distinct on (a.id)
  p.org_id, a.id,
  left(coalesce(nullif(p.titulo, ''), 'Post') || ' · ' || m.n, 80),
  left(coalesce((select x->>'prompt' from jsonb_array_elements(case when jsonb_typeof(p.conteudo->'prompts_imagem') = 'array' then p.conteudo->'prompts_imagem' else '[]'::jsonb end) x where x->>'slide' = m.n limit 1),
                (select x->>'prompt_video' from jsonb_array_elements(case when jsonb_typeof(p.conteudo->'cenas') = 'array' then p.conteudo->'cenas' else '[]'::jsonb end) x where x->>'n' = m.n limit 1), ''), 400),
  array['gerada por IA', case when a.tipo like 'video/%' then 'vídeo' else 'foto' end],
  'ia', p.id, a.criado_em
from posts p
cross join lateral (
  select key as n, value as arq from jsonb_each_text(case when jsonb_typeof(p.fotos) = 'object' then p.fotos else '{}'::jsonb end)
  union all
  select key, value from jsonb_each_text(case when jsonb_typeof(p.clipes) = 'object' then p.clipes else '{}'::jsonb end)
) m
join arquivos a on a.org_id = p.org_id and a.id::text = m.arq and (a.tipo like 'image/%' or a.tipo like 'video/%')
where not exists (select 1 from banco_imagens b where b.arquivo_id = a.id)
order by a.id, p.criado_em;

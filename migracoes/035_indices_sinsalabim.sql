-- Histórico de exportações de cada edição do Sinsalabim (aberto toda vez que a edição é carregada).
create index if not exists sinsalabim_exportacoes_edicao on sinsalabim_exportacoes (edicao_id, criado_em desc);

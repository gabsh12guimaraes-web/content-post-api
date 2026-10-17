-- Profile do Zernio de cada organização, na conta Zernio da plataforma. As redes que o cliente conecta pelo painel
-- ficam nesse profile, e a publicação com a chave da plataforma só usa as contas dele.
alter table organizacoes add column if not exists zernio_profile text;
create unique index if not exists organizacoes_zernio_profile on organizacoes (zernio_profile) where zernio_profile is not null

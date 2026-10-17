-- A publicação passa a ser pelo Zernio (no lugar do Ayrshare).
alter table integracoes drop constraint if exists integracoes_provedor_check;
delete from integracoes where provedor = 'ayrshare';
alter table integracoes add constraint integracoes_provedor_check check (provedor in ('anthropic', 'magnific', 'apify', 'zernio'));

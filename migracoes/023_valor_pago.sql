-- Valor real da última cobrança da Kiwify (com cupom), em centavos: o que o cliente pagou e o líquido que fica.
alter table organizacoes add column if not exists pago_centavos int;
alter table organizacoes add column if not exists liquido_centavos int;

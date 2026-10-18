-- Primeiro acesso: organizações novas passam pelo onboarding (dados da marca, visual, estilo do Instagram e primeiras ideias).
-- As que já existiam ficam como concluídas, para ninguém ver o passo a passo de novo.
alter table organizacoes add column if not exists onboarding_em timestamptz;
update organizacoes set onboarding_em = '2000-01-01' where onboarding_em is null;

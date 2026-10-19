-- Modelos montados à mão no editor (mesmas opções da Diagramação da revisão): guardam a diagramação pronta.
-- Os modelos do perfil (feitos pela IA a partir dos posts) continuam com spec; os montados à mão têm diag.
alter table modelos_marca add column if not exists diag jsonb;

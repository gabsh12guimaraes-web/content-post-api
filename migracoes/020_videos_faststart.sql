-- Vídeos já guardados passam de novo pelo tratamento: o índice (moov) vai para o começo do arquivo, para tocar sem baixar tudo.
update arquivos set tratado = false where tipo = 'video/mp4';

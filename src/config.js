// Configuração vinda das variáveis de ambiente (no Railway: aba Variables do serviço).
const env = process.env;

function obrigatoria(nome) {
  const v = env[nome];
  if (!v) throw new Error(`Falta a variável de ambiente ${nome}. Veja o arquivo .env.exemplo.`);
  return v;
}

export const config = {
  porta: Number(env.PORT) || 3000,
  // Postgres do Railway (DATABASE_URL). Para testes locais: "pglite:memoria" ou "pglite:./dados-locais".
  bancoUrl: env.DATABASE_URL || "pglite:./dados-locais",
  // 32 bytes em base64. Cifra as chaves das integrações. Se perder, as chaves salvas precisam ser cadastradas de novo.
  chaveMestra: () => obrigatoria("CHAVE_MESTRA"),
  // Endereço público desta API (para montar os links dos arquivos usados na publicação).
  urlPublica: (env.URL_PUBLICA || env.RAILWAY_PUBLIC_DOMAIN && `https://${env.RAILWAY_PUBLIC_DOMAIN}` || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ""),
  // Sites que podem chamar a API pelo navegador, separados por vírgula.
  origens: [...new Set([...(env.ORIGENS || "https://gabsh12guimaraes-web.github.io,http://localhost:4789").split(",").map(s => s.trim()).filter(Boolean), "capacitor://localhost"])],
  // Pasta dos arquivos enviados e gerados (no Railway: um Volume montado aqui).
  pastaArquivos: env.PASTA_ARQUIVOS || "./arquivos-locais",
  // Liga a fila de tarefas e a publicação agendada neste processo.
  trabalhador: env.TRABALHADOR !== "nao",
  modeloClaude: env.MODELO_CLAUDE || "claude-opus-5-5",
  // Cadastro aberto: qualquer pessoa cria conta e organização. "nao" deixa só por convite.
  cadastroAberto: env.CADASTRO_ABERTO !== "nao",
};

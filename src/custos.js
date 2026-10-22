// Preços usados para estimar o que cada uso custa para a plataforma (US$). Mesmos valores do PRECOS.md;
// confira nas contas de cada serviço e ajuste aqui se mudarem. DOLAR converte para R$ no painel admin.
export const DOLAR = Number(process.env.DOLAR) || 5.6;
export const CUSTO = {
  anthropic: { entrada: 4, saida: 20, cacheLeitura: 0.4, cacheEscrita: 5 }, // por milhão de tokens
  magnific: { foto: 0.07, foto_pessoa: 0.07, clipe: 0.1 },                 // por foto; clipe por segundo
  apify: { coleta: 0.0023 },                                                // por item coletado
  zernio: { publicacao: 16 / 120 },                                         // plano Build: US$ 16 por 120 posts
  groq: { minuto: 0.04 / 60 },                                             // Whisper Turbo: áudio transcrito
  shotstack: { minuto: 0.20 },                                             // preço avulso por minuto de vídeo exportado
  railwayOrgMesBrl: 5,                                                      // servidor, por organização ativa no mês (R$)
};
export const KIWIFY = { taxa: 0.0899, fixa: 2.49 };

// Custo em US$ de uma soma de consumo (entrada, saida, cache_leitura, cache_escrita, quantidade) de um provedor e tipo.
export function custoDe(provedor, tipo, s) {
  const n = k => Number(s[k]) || 0;
  if (provedor === "anthropic") { const c = CUSTO.anthropic; return (n("entrada") * c.entrada + n("saida") * c.saida + n("cache_leitura") * c.cacheLeitura + n("cache_escrita") * c.cacheEscrita) / 1e6; }
  const tabela = CUSTO[provedor];
  return tabela && typeof tabela === "object" ? n("quantidade") * (tabela[tipo] || 0) : 0;
}

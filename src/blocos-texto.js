import { falha, texto } from "./erros.js";
export function limparBlocos(v, estrito = false) {
  if (!Array.isArray(v)) { if (estrito) falha("Blocos de texto inválidos."); return undefined; }
  if (estrito && v.length > 8) falha("Use até 8 blocos de texto em cada imagem.");
  const numero = (v,p,min,max) => Number.isFinite(Number(v)) ? Math.max(min,Math.min(max,Number(v))) : p;
  return v.slice(0,8).filter(b => b && typeof b === "object" && !Array.isArray(b)).map((b,i) => {
    const espaco = 76 / Math.max(1,Math.min(v.length,8));
    const x = numero(b.x,7,5,80), y = numero(b.y,12+i*espaco,8,86);
    return { texto:texto(b.texto,600), tipo:["destaque","apoio","selo"].includes(b.tipo) ? b.tipo : "destaque", x,y,
      largura:numero(b.largura,86,15,95-x), altura:numero(b.altura,Math.max(6,espaco-3),6,94-y), tamanho:numero(b.tamanho,1,.6,1.6),
      alinhar:["esquerda","centro","direita"].includes(b.alinhar) ? b.alinhar : "esquerda",
      cor:b.cor === "destaque" ? "destaque" : "texto", caixa:b.caixa === true };
  });
}
export function prepararComposicoes(c) {
  for (const k of ["slides","cenas"]) if (Array.isArray(c[k])) for (const sl of c[k]) {
    if (sl && sl.blocos !== undefined) { const blocos = limparBlocos(sl.blocos); if (blocos) sl.blocos = blocos; else delete sl.blocos; }
  }
  return c;
}

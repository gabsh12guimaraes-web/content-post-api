// Ofertas públicas conferidas nos nove checkouts enviados para a migração à Nasten.
export const OFERTAS_NASTEN = {
  "essencial:mensal": { slug: "xk10c2k", id: 93, produto: "cmvha2fxo000001mcc35u73y1" },
  "essencial:semestral": { slug: "et20cqs", id: 94, produto: "cmvha2fxo000001mcc35u73y1" },
  "essencial:anual": { slug: "6t20djh", id: 95, produto: "cmvha2fxo000001mcc35u73y1" },
  "profissional:mensal": { slug: "5d6038k", id: 96, produto: "cmvhayhiv000101m38xju2ddi" },
  "profissional:semestral": { slug: "78703pn", id: 97, produto: "cmvhayhiv000101m38xju2ddi" },
  "profissional:anual": { slug: "d110wxt", id: 98, produto: "cmvhayhiv000101m38xju2ddi" },
  "agencia:mensal": { slug: "g6b03qk", id: 99, produto: "cmvhbb5pj000901m3cc227a8h" },
  "agencia:semestral": { slug: "wic0399", id: 100, produto: "cmvhbb5pj000901m3cc227a8h" },
  "agencia:anual": { slug: "6jd030e", id: 101, produto: "cmvhbb5pj000901m3cc227a8h" },
};
export const CHECKOUT_NASTEN = Object.fromEntries(Object.entries(OFERTAS_NASTEN).map(([chave, oferta]) => [chave, `https://app.nasten.com.br/checkout/${oferta.slug}`]));

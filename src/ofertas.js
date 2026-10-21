// Ofertas atuais: preços finais sem cupom, conferidos nos nove checkouts públicos.
export const OFERTAS_NASTEN = {
  "essencial:mensal": { slug: "1b00ye7", id: 102, produto: "cmvha2fxo000001mcc35u73y1" },
  "essencial:semestral": { slug: "n2004ue", id: 103, produto: "cmvha2fxo000001mcc35u73y1" },
  "essencial:anual": { slug: "lb1040d", id: 104, produto: "cmvha2fxo000001mcc35u73y1" },
  "profissional:mensal": { slug: "1i204x5", id: 105, produto: "cmvhayhiv000101m38xju2ddi" },
  "profissional:semestral": { slug: "w7304kn", id: 106, produto: "cmvhayhiv000101m38xju2ddi" },
  "profissional:anual": { slug: "qj40411", id: 107, produto: "cmvhayhiv000101m38xju2ddi" },
  "agencia:mensal": { slug: "wn504iq", id: 108, produto: "cmvhbb5pj000901m3cc227a8h" },
  "agencia:semestral": { slug: "sn604vs", id: 109, produto: "cmvhbb5pj000901m3cc227a8h" },
  "agencia:anual": { slug: "y910yjc", id: 110, produto: "cmvhbb5pj000901m3cc227a8h" },
};
// Reconhece renovações e eventos atrasados das ofertas anteriores. Não aparecem no catálogo.
export const OFERTAS_NASTEN_ANTIGAS = {
  "essencial:mensal": { id: 93, produto: "cmvha2fxo000001mcc35u73y1", total: 369 },
  "essencial:semestral": { id: 94, produto: "cmvha2fxo000001mcc35u73y1", total: 2034 },
  "essencial:anual": { id: 95, produto: "cmvha2fxo000001mcc35u73y1", total: 3684 },
  "profissional:mensal": { id: 96, produto: "cmvhayhiv000101m38xju2ddi", total: 877 },
  "profissional:semestral": { id: 97, produto: "cmvhayhiv000101m38xju2ddi", total: 4842 },
  "profissional:anual": { id: 98, produto: "cmvhayhiv000101m38xju2ddi", total: 8748 },
  "agencia:mensal": { id: 99, produto: "cmvhbb5pj000901m3cc227a8h", total: 2307 },
  "agencia:semestral": { id: 100, produto: "cmvhbb5pj000901m3cc227a8h", total: 12702 },
  "agencia:anual": { id: 101, produto: "cmvhbb5pj000901m3cc227a8h", total: 23028 },
};
export const CHECKOUT_NASTEN = Object.fromEntries(Object.entries(OFERTAS_NASTEN).map(([chave, oferta]) => [chave, `https://app.nasten.com.br/checkout/${oferta.slug}`]));

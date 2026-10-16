// Erro com mensagem para a pessoa e status HTTP. O painel mostra o campo "erro" da resposta.
export class ErroApi extends Error {
  constructor(mensagem, status = 400, extra = {}) { super(mensagem); this.status = status; this.extra = extra; }
}
export const falha = (msg, status, extra) => { throw new ErroApi(msg, status, extra); };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const exigirId = (v, msg = "Registro inválido.") => { if (!UUID.test(String(v || ""))) falha(msg); return String(v); };
export const texto = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

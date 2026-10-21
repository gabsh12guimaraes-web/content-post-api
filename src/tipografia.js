import crypto from "node:crypto";
import { create } from "fontkit";
import { db } from "./db.js";
import { falha, texto } from "./erros.js";
import { anexos, salvarArquivo, apagarArquivos } from "./arquivos.js";

export const FONTE_MARCA = /^marca-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export async function conferirFontes(org, diag) {
  const fontes = [diag.fonte, ...Object.values(diag.slides || {}).map(d => d.fonte)].filter(f => FONTE_MARCA.test(f || ""));
  for (const fonte of new Set(fontes)) {
    if (!(await db().query("select 1 from fontes_marca where id=$1 and org_id=$2", [fonte.slice(6),org])).rows.length) falha("Esta fonte não pertence à organização.", 404);
  }
}
export async function fontesDaMarca(org) {
  const rows = (await db().query("select * from fontes_marca where org_id=$1 order by criado_em", [org])).rows;
  const arquivos = await anexos(org, rows.map(r => r.arquivo_id));
  return rows.map(r => ({ id:r.id, nome:r.nome, familia:r.familia, peso:r.peso, arquivo:arquivos.get(r.arquivo_id) })).filter(r => r.arquivo);
}
export const acoesTipografia = {
  async enviarFonteMarca(ctx, b) {
    if (b.organizacao && b.organizacao !== ctx.org) falha("A organização mudou durante o envio. Escolha o arquivo novamente.", 409);
    if (typeof b.base64 !== "string" || b.base64.length > 7 * 1024 * 1024) falha("Envie uma fonte de até 5 MB.");
    const dados = Buffer.from(b.base64, "base64");
    if (dados.length < 32 || dados.length > 5 * 1024 * 1024) falha("Envie uma fonte válida de até 5 MB.");
    const assinatura = dados.toString("latin1",0,4);
    const tipo = { "\x00\x01\x00\x00":"font/ttf", OTTO:"font/otf", wOFF:"font/woff", wOF2:"font/woff2" }[assinatura];
    if (!tipo) falha("Formato inválido. Envie um arquivo TTF, OTF, WOFF ou WOFF2.");
    if ((assinatura === "wOFF" || assinatura === "wOF2") && (dados.readUInt32BE(8) !== dados.length || dados.readUInt32BE(16) > 20 * 1024 * 1024)) falha("A fonte está corrompida ou é grande demais.");
    let fonte;
    try { fonte = create(dados); if (!fonte.familyName || !fonte.numGlyphs || fonte.numGlyphs > 65535 || !fonte.unitsPerEm || !fonte.characterSet.length) throw new Error(); fonte.glyphForCodePoint(65).path; }
    catch { falha("Não foi possível abrir esta fonte. Confira o arquivo e tente novamente."); }
    const hash = crypto.createHash("sha256").update(dados).digest("hex");
    const nome = texto(b.nome,80) || texto(fonte.fullName || fonte.familyName,80) || "Fonte da marca";
    const anterior = (await db().query("select id from fontes_marca where org_id=$1 and hash=$2", [ctx.org,hash])).rows[0];
    if (anterior) return { id:anterior.id,tipografias:await fontesDaMarca(ctx.org) };
    let arquivo;
    try {
      arquivo = await salvarArquivo(ctx.org, { tipo,nome: nome + "." + tipo.split("/")[1],dados });
      const r = await db().transacao(async tx => {
        await tx.query("select id from organizacoes where id=$1 for update", [ctx.org]);
        const anterior = (await tx.query("select id from fontes_marca where org_id=$1 and hash=$2", [ctx.org,hash])).rows[0];
        if (anterior) return { id:anterior.id,usou:false };
        const peso = Math.max(100,Math.min(900,Math.round(Number(fonte["OS/2"]?.usWeightClass) || 400)));
        return { id:(await tx.query("insert into fontes_marca (org_id,arquivo_id,nome,familia,peso,hash) values ($1,$2,$3,$4,$5,$6) returning id", [ctx.org,arquivo,nome,texto(fonte.familyName,100),peso,hash])).rows[0].id,usou:true };
      });
      if (!r.usou) await apagarArquivos(ctx.org,[arquivo]);
      arquivo = null;
      return { id:r.id, tipografias:await fontesDaMarca(ctx.org) };
    } catch(e) { if (arquivo) await apagarArquivos(ctx.org,[arquivo]); throw e; }
  },
};

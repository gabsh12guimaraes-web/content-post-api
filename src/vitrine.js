// Vitrine pública separada da biblioteca privada: somente itens de IA selecionados pela administração.
import { db } from "./db.js";
import { config } from "./config.js";

export async function midiasLogin() {
  const r = await db().query(`select a.id, a.tipo, a.previa from banco_imagens b join arquivos a on a.id = b.arquivo_id and a.org_id = b.org_id
    where b.publico_login and b.origem = 'ia' and a.tipo in ('image/jpeg','image/png','image/webp','video/mp4') order by b.criado_em desc limit 8`);
  return r.rows.map(a => ({ id: a.id, tipo: a.tipo, url: `${config.urlPublica}/vitrine/${a.id}`, previa: a.previa ? `${config.urlPublica}/vitrine/${a.id}?v=p` : null }));
}
export async function arquivoLogin(id) {
  return (await db().query(`select a.id, a.chave from banco_imagens b join arquivos a on a.id = b.arquivo_id and a.org_id = b.org_id
    where a.id = $1 and b.publico_login and b.origem = 'ia' and a.tipo in ('image/jpeg','image/png','image/webp','video/mp4') limit 1`, [id])).rows[0] || null;
}

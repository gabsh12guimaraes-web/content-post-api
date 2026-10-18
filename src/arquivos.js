// Arquivos (logos, mood board, fotos, clipes, artes) ficam na pasta do Volume, um por id.
// O link público /f/:id/:chave não exige login (o Zernio e o navegador precisam abrir), mas a chave é secreta.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { segredoCurto } from "./cripto.js";
import sharp from "sharp";

// Otimização das imagens: a original fica no máximo com 2048 px (PNG sem transparência vira JPEG) e ganha uma
// versão de prévia com 720 px em WebP, usada nas listas e nas prévias do painel. A arte final usa a original.
const LADO_MAX = 2048, LADO_PREVIA = 720;
const OTIMIZAVEIS = ["image/png", "image/jpeg", "image/webp"];
sharp.concurrency(1); // o servidor é pequeno: uma imagem por vez
async function otimizarImagem(tipo, dados) {
  const img = sharp(dados, { failOn: "none" }).rotate();
  const m = await img.metadata();
  const grande = Math.max(m.width || 0, m.height || 0) > LADO_MAX;
  const transparente = tipo === "image/png" && m.hasAlpha && !(await sharp(dados).stats()).isOpaque;
  let saida = null, novoTipo = tipo;
  if (tipo === "image/png" && !transparente && dados.length > 400 * 1024) { saida = await img.clone().resize({ width: LADO_MAX, height: LADO_MAX, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer(); novoTipo = "image/jpeg"; }
  else if (grande || (tipo !== "image/png" && dados.length > 1.5 * 1024 * 1024)) {
    const r = img.clone().resize({ width: LADO_MAX, height: LADO_MAX, fit: "inside", withoutEnlargement: true });
    saida = await (tipo === "image/png" ? r.png({ compressionLevel: 9, palette: false }) : tipo === "image/webp" ? r.webp({ quality: 86 }) : r.jpeg({ quality: 86, mozjpeg: true })).toBuffer();
  }
  if (saida && saida.length >= dados.length) { saida = null; novoTipo = tipo; } // não piora o que já era leve
  const previa = await sharp(saida || dados, { failOn: "none" }).resize({ width: LADO_PREVIA, height: LADO_PREVIA, fit: "inside", withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
  return { dados: saida || dados, tipo: novoTipo, previa };
}
// Otimiza um arquivo já salvo (no disco e no banco). Falhas deixam a original como está.
export async function tratarArquivo(a) {
  try {
    if (!OTIMIZAVEIS.includes(a.tipo)) { await db().query("update arquivos set tratado = true where id = $1", [a.id]); return false; }
    const dados = await fs.readFile(caminho(a.org_id, a.id));
    const o = await otimizarImagem(a.tipo, dados);
    if (o.dados !== dados) await fs.writeFile(caminho(a.org_id, a.id), o.dados);
    await fs.writeFile(caminho(a.org_id, a.id) + ".p", o.previa);
    await db().query("update arquivos set tipo = $2, tamanho = $3, previa = true, tratado = true where id = $1", [a.id, o.tipo, o.dados.length]);
    return true;
  } catch (e) {
    console.error("[imagem]", a.id, e.message);
    await db().query("update arquivos set tratado = true where id = $1", [a.id]).catch(() => {});
    return false;
  }
}
// As imagens de antes da otimização são tratadas aos poucos, sem atrapalhar o resto.
let tratando = false;
export async function tratarAntigos(lote = 20) {
  if (tratando) return 0;
  tratando = true;
  try { return await tratarLote(lote); } finally { tratando = false; }
}
async function tratarLote(lote) {
  const { rows } = await db().query("select id, org_id, tipo from arquivos where not tratado order by criado_em desc limit $1", [lote]);
  for (const a of rows) await tratarArquivo(a);
  return rows.length;
}

const caminho = (org, id) => path.join(config.pastaArquivos, String(org), String(id));
export const TIPOS_ACEITOS = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "video/mp4"];
export const LIMITE_BYTES = 25 * 1024 * 1024;

export async function salvarArquivo(org, { tipo, nome, dados }) {
  if (!TIPOS_ACEITOS.includes(tipo)) throw Object.assign(new Error("Tipo de arquivo não aceito."), { status: 400 });
  if (dados.length > LIMITE_BYTES) throw Object.assign(new Error("Arquivo grande demais (máximo 25 MB)."), { status: 400 });
  const chave = segredoCurto();
  const { rows } = await db().query(
    "insert into arquivos (org_id, tipo, nome, tamanho, chave) values ($1, $2, $3, $4, $5) returning id",
    [org, tipo, String(nome || "arquivo").replace(/[^\w.\- ]+/g, "").slice(0, 80) || "arquivo", dados.length, chave]);
  const id = rows[0].id;
  await fs.mkdir(path.dirname(caminho(org, id)), { recursive: true });
  await fs.writeFile(caminho(org, id), dados);
  await tratarArquivo({ id, org_id: org, tipo });
  return id;
}

// Baixa um arquivo de uma URL (resultado do Magnific, que expira em minutos) e guarda.
export async function guardarDeUrl(org, url, nome) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`não consegui baixar o arquivo gerado (${r.status})`);
  const tipo = (r.headers.get("content-type") || "").split(";")[0].trim() || (/\.mp4/i.test(url) ? "video/mp4" : "image/jpeg");
  const dados = Buffer.from(await r.arrayBuffer());
  return salvarArquivo(org, { tipo: TIPOS_ACEITOS.includes(tipo) ? tipo : (/\.mp4/i.test(url) ? "video/mp4" : "image/jpeg"), nome, dados });
}

export async function lerArquivo(id, chave, { previa = false } = {}) {
  const { rows } = await db().query("select * from arquivos where id = $1", [id]);
  const a = rows[0];
  if (!a || a.chave !== chave) return null;
  if (previa && a.previa) { try { return { ...a, tipo: "image/webp", dados: await fs.readFile(caminho(a.org_id, a.id) + ".p") }; } catch (e) {} }
  try { return { ...a, dados: await fs.readFile(caminho(a.org_id, a.id)) }; } catch (e) { return null; }
}

export async function apagarArquivos(org, ids) {
  if (!ids.length) return;
  const { rows } = await db().query("delete from arquivos where org_id = $1 and id = any($2::uuid[]) and id not in (select arquivo_id from banco_imagens where org_id = $1) returning id", [org, ids]);
  await Promise.all(rows.flatMap(r => [fs.rm(caminho(org, r.id), { force: true }), fs.rm(caminho(org, r.id) + ".p", { force: true })]));
}

export const urlArquivo = a => `${config.urlPublica}/f/${a.id}/${a.chave}`;

// Busca vários arquivos de uma vez e devolve no formato que o painel já entende (o mesmo do Airtable).
export async function anexos(org, ids) {
  const lista = (ids || []).filter(Boolean);
  if (!lista.length) return new Map();
  const { rows } = await db().query("select id, tipo, nome, tamanho, chave, previa from arquivos where org_id = $1 and id = any($2::uuid[])", [org, lista]);
  // thumbnails.large = prévia leve (listas e prévias do painel); thumbnails.full = original (arte final, download).
  return new Map(rows.map(a => [a.id, { id: a.id, url: urlArquivo(a), filename: a.nome, type: a.tipo, size: a.tamanho,
    ...(a.previa ? { thumbnails: { large: { url: urlArquivo(a) + "?v=p" }, full: { url: urlArquivo(a) } } } : {}) }]));
}

// Arquivos (logos, mood board, fotos, clipes, artes) ficam na pasta do Volume, um por id.
// O link público /f/:id/:chave não exige login (o Zernio e o navegador precisam abrir), mas a chave é secreta.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
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
// MP4 com o índice (moov) no fim obriga o navegador a baixar o vídeo inteiro antes de tocar. Aqui o moov vai para o começo
// (como o "faststart" do ffmpeg): os deslocamentos das amostras (stco/co64) são corrigidos e nada é recodificado.
// Vídeo fragmentado, já com moov no começo ou que não dá para entender volta como veio.
export function mp4Faststart(dados) {
  const caixas = [];
  for (let i = 0; i + 8 <= dados.length;) {
    let tam = dados.readUInt32BE(i), cab = 8;
    const tipo = dados.toString("latin1", i + 4, i + 8);
    if (tam === 1) { if (i + 16 > dados.length) return dados; tam = Number(dados.readBigUInt64BE(i + 8)); cab = 16; }
    else if (tam === 0) tam = dados.length - i;
    if (tam < cab || i + tam > dados.length) return dados;
    caixas.push({ tipo, ini: i, tam }); i += tam;
  }
  const moov = caixas.find(c => c.tipo === "moov"), mdat = caixas.findIndex(c => c.tipo === "mdat");
  if (!moov || mdat < 0 || caixas.some(c => c.tipo === "moof") || caixas.indexOf(moov) < mdat) return dados;
  const novoMoov = Buffer.from(dados.subarray(moov.ini, moov.ini + moov.tam));
  const delta = moov.tam;
  const CONTEINERES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "udta"]);
  let ok = true;
  const andar = (ini, fim) => {
    for (let i = ini; i + 8 <= fim && ok;) {
      const tam = novoMoov.readUInt32BE(i), tipo = novoMoov.toString("latin1", i + 4, i + 8);
      if (tam < 8 || i + tam > fim) { ok = false; return; }
      if (CONTEINERES.has(tipo)) andar(i + 8, i + tam);
      else if (tipo === "stco") { const n = novoMoov.readUInt32BE(i + 12); for (let k = 0; k < n; k++) { const p = i + 16 + k * 4, v = novoMoov.readUInt32BE(p) + delta; if (v > 0xFFFFFFFF) { ok = false; return; } novoMoov.writeUInt32BE(v, p); } }
      else if (tipo === "co64") { const n = novoMoov.readUInt32BE(i + 12); for (let k = 0; k < n; k++) { const p = i + 16 + k * 8; novoMoov.writeBigUInt64BE(novoMoov.readBigUInt64BE(p) + BigInt(delta), p); } }
      i += tam;
    }
  };
  andar(8, novoMoov.length);
  if (!ok) return dados;
  // ftyp (e o que vier antes do 1º mdat) + moov + o resto, na ordem original
  const antes = caixas.slice(0, mdat).filter(c => c !== moov), depois = caixas.slice(mdat).filter(c => c !== moov);
  const pedaco = c => dados.subarray(c.ini, c.ini + c.tam);
  // moov entra logo antes do 1º mdat: só o que estava depois dele muda de lugar (delta = tamanho do moov)
  return Buffer.concat([...antes.map(pedaco), novoMoov, ...depois.map(pedaco)]);
}
// Vídeos: índice no começo e, se veio uma capa (quadro do vídeo), ela vira a prévia leve (lista e pôster).
async function tratarVideo(a, capa) {
  const dados = await fs.readFile(caminho(a.org_id, a.id));
  const novo = mp4Faststart(dados);
  if (novo !== dados) await fs.writeFile(caminho(a.org_id, a.id), novo);
  let previa = false;
  if (capa) { try { await fs.writeFile(caminho(a.org_id, a.id) + ".p", await sharp(capa, { failOn: "none" }).resize({ width: LADO_PREVIA, height: LADO_PREVIA, fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toBuffer()); previa = true; } catch (e) {} }
  await db().query(`update arquivos set tamanho = $2, tratado = true${previa ? ", previa = true" : ""} where id = $1`, [a.id, novo.length]);
  return true;
}
// Otimiza um arquivo já salvo (no disco e no banco). Falhas deixam a original como está.
export async function tratarArquivo(a, { capa } = {}) {
  try {
    if (a.tipo === "video/mp4") return await tratarVideo(a, capa);
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

export async function salvarArquivo(org, { tipo, nome, dados, capa }) {
  if (!TIPOS_ACEITOS.includes(tipo)) throw Object.assign(new Error("Tipo de arquivo não aceito."), { status: 400 });
  if (dados.length > LIMITE_BYTES) throw Object.assign(new Error("Arquivo grande demais (máximo 25 MB)."), { status: 400 });
  const chave = segredoCurto();
  const { rows } = await db().query(
    "insert into arquivos (org_id, tipo, nome, tamanho, chave) values ($1, $2, $3, $4, $5) returning id",
    [org, tipo, String(nome || "arquivo").replace(/[^\w.\- ]+/g, "").slice(0, 80) || "arquivo", dados.length, chave]);
  const id = rows[0].id;
  await fs.mkdir(path.dirname(caminho(org, id)), { recursive: true });
  await fs.writeFile(caminho(org, id), dados);
  await tratarArquivo({ id, org_id: org, tipo }, { capa });
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

// Para mandar aos pedaços (Range): onde está no disco e o tamanho, sem ler o arquivo inteiro.
export async function infoArquivo(id, chave, { previa = false } = {}) {
  const { rows } = await db().query("select * from arquivos where id = $1", [id]);
  const a = rows[0];
  if (!a || a.chave !== chave) return null;
  const alvo = previa && a.previa ? { arq: caminho(a.org_id, a.id) + ".p", tipo: "image/webp" } : { arq: caminho(a.org_id, a.id), tipo: a.tipo };
  try { const st = await fs.stat(alvo.arq); return { ...a, ...alvo, tamanho: st.size }; } catch (e) { return null; }
}
export const lerPedaco = (arq, ini, fim) => createReadStream(arq, { start: ini, end: fim });

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

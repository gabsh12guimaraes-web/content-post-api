// Arquivos (logos, mood board, fotos, clipes, artes) ficam na pasta do Volume, um por id.
// O link público /f/:id/:chave não exige login (o Zernio e o navegador precisam abrir), mas a chave é secreta.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { segredoCurto } from "./cripto.js";

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

export async function lerArquivo(id, chave) {
  const { rows } = await db().query("select * from arquivos where id = $1", [id]);
  const a = rows[0];
  if (!a || a.chave !== chave) return null;
  try { return { ...a, dados: await fs.readFile(caminho(a.org_id, a.id)) }; } catch (e) { return null; }
}

export async function apagarArquivos(org, ids) {
  if (!ids.length) return;
  const { rows } = await db().query("delete from arquivos where org_id = $1 and id = any($2::uuid[]) returning id", [org, ids]);
  await Promise.all(rows.map(r => fs.rm(caminho(org, r.id), { force: true })));
}

export const urlArquivo = a => `${config.urlPublica}/f/${a.id}/${a.chave}`;

// Busca vários arquivos de uma vez e devolve no formato que o painel já entende (o mesmo do Airtable).
export async function anexos(org, ids) {
  const lista = (ids || []).filter(Boolean);
  if (!lista.length) return new Map();
  const { rows } = await db().query("select id, tipo, nome, tamanho, chave from arquivos where org_id = $1 and id = any($2::uuid[])", [org, lista]);
  return new Map(rows.map(a => [a.id, { id: a.id, url: urlArquivo(a), filename: a.nome, type: a.tipo, size: a.tamanho }]));
}

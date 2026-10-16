// Importa da base do Airtable usada antes (tabelas Marca, Fontes, Ideias e Calendario).
// O token do Airtable chega cifrado na tarefa e é apagado dela quando a importação termina.
import { db } from "../db.js";
import { decifrar } from "../cripto.js";
import { guardarDeUrl } from "../arquivos.js";
import { registrar } from "./fila.js";

async function todos(token, base, tabela) {
  const lista = [];
  let offset = "";
  do {
    const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(tabela)}?pageSize=100${offset ? "&offset=" + offset : ""}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 404) return lista; // tabela não existe nesta base
    if (!r.ok) throw new Error(`o Airtable recusou a leitura de ${tabela} (${r.status}). Confira o token e se ele tem acesso à base.`);
    const j = await r.json();
    lista.push(...(j.records || []));
    offset = j.offset || "";
  } while (offset);
  return lista;
}
const sel = v => (v && typeof v === "object" ? v.name : v ?? null);
const json = (t, padrao) => { try { return JSON.parse(t || ""); } catch (e) { return padrao; } };
async function baixar(org, anexo, nome) { try { return await guardarDeUrl(org, anexo.url, anexo.filename || nome); } catch (e) { return null; } }
// Liga as chaves de um JSON {n: url} à lista de anexos na mesma ordem.
async function porSlide(org, mapaJson, lista, prefixo) {
  const out = {};
  const ordem = Object.keys(json(mapaJson, {})).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
  for (let i = 0; i < ordem.length; i++) if (lista && lista[i]) { const id = await baixar(org, lista[i], `${prefixo}-${ordem[i]}`); if (id) out[ordem[i]] = id; }
  return out;
}

registrar("importar", Object.assign(async (org, payload, tarefa) => {
  const token = decifrar(payload.token), base = payload.base;
  const cont = { marca: 0, fontes: 0, ideias: 0, posts: 0 };

  const [marca] = await todos(token, base, "Marca");
  if (marca) {
    const f = marca.fields;
    const logos = {};
    for (const k of ["Logo", "LogoDark", "SimboloLight", "SimboloDark"]) if ((f[k] || [])[0]) { const id = await baixar(org, f[k][0], k); if (id) logos[k] = id; }
    const mood = [];
    for (const a of (f.MoodBoard || []).slice(0, 20)) { const id = await baixar(org, a, "mood"); if (id) mood.push(id); }
    await db().query(`insert into marcas (org_id) values ($1) on conflict (org_id) do nothing`, [org]);
    await db().query(`update marcas set nome = $2, posicionamento = $3, publico = $4, tom_de_voz = $5, pilares = $6, evitar = $7, redes = $8,
      frequencia_semanal = $9, exemplos = $10, cores = $11, idioma = $12, logos = logos || $13::jsonb, mood_board = mood_board || $14::uuid[], atualizado_em = now() where org_id = $1`,
      [org, f.Nome || "", f.Posicionamento || "", f.Publico || "", f.TomDeVoz || "", (f.Pilares || []).map(sel), f.Evitar || "", (f.Redes || []).map(sel),
        f.FrequenciaSemanal ?? null, f.ExemplosBons || "", f.Cores || "", sel(f.Idioma) || "Português (Brasil)", JSON.stringify(logos), mood]);
    cont.marca = 1;
  }

  const existentes = new Set((await db().query("select lower(nome) as n from fontes where org_id = $1", [org])).rows.map(r => r.n));
  for (const r of await todos(token, base, "Fontes")) {
    const f = r.fields;
    if (!f.Nome || existentes.has(String(f.Nome).toLowerCase())) continue;
    await db().query("insert into fontes (org_id, nome, tipo, categoria, rede, url, peso, ativa) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [org, f.Nome, sel(f.Tipo), sel(f.Categoria), sel(f.Rede), f.URL || null, Number(f.Peso) || 3, f.Ativa === true]);
    cont.fontes++;
  }

  const mapaIdeias = {};
  const titulos = new Set((await db().query("select lower(titulo) as t from ideias where org_id = $1", [org])).rows.map(r => r.t));
  for (const r of await todos(token, base, "Ideias")) {
    const f = r.fields;
    if (!f.Titulo || titulos.has(String(f.Titulo).toLowerCase())) continue;
    const status = ["Sugerida", "Aprovada", "Descartada", "Guardada"].includes(sel(f.Status)) ? sel(f.Status) : "Sugerida";
    const { rows } = await db().query(
      "insert into ideias (org_id, titulo, resumo, formato, rede, pilar, score, por_que, status, motivo_descarte, criada_em) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, now())) returning id",
      [org, f.Titulo, f.Resumo || "", sel(f.Formato), sel(f.Rede), sel(f.Pilar), Number(f.Score) || 0, f.PorQueFunciona || "", status, f.MotivoDescarte || "", f.CriadaEm || null]);
    mapaIdeias[r.id] = rows[0].id;
    cont.ideias++;
  }

  const STATUS = { AguardandoVideo: "Planejado", VideoAnexado: "EmRevisao", Aprovado: "Agendado" };
  for (const r of await todos(token, base, "Calendario")) {
    const f = r.fields;
    if (!f.Titulo || !f.DataPublicacao) continue;
    const st = sel(f.Status) || "Planejado";
    const fotos = await porSlide(org, f.ImagensSlides, f.Fotos && f.Fotos.length ? f.Fotos : f.Arquivos, "foto");
    const clipes = await porSlide(org, f.ClipesSlides, f.Clipes, "clipe");
    const artes = [];
    if (f.ArtesProntas) for (const a of f.Arquivos || []) { const id = await baixar(org, a, "arte"); if (id) artes.push(id); }
    await db().query(
      `insert into posts (org_id, ideia_id, titulo, data_publicacao, rede, formato, pilar, status, versao, legenda, hashtags, slides, conteudo, fotos, clipes, artes, artes_prontas, diagramacao, historico_ajustes, link_publicado)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [org, mapaIdeias[(f.Ideia || [])[0]] || null, f.Titulo, f.DataPublicacao, sel(f.Rede), sel(f.Formato), sel(f.Pilar), STATUS[st] || st, Number(f.Versao) || 1,
        f.Legenda || "", f.Hashtags || "", JSON.stringify(json(f.Slides, [])), JSON.stringify(json(f.Conteudo, {})), JSON.stringify(fotos), JSON.stringify(clipes), artes,
        artes.length > 0, JSON.stringify(json(f.Diagramacao, { alinhar: "esquerda", posicao: "auto" })), f.HistoricoAjustes || "", f.LinkPublicado || null]);
    cont.posts++;
  }
  await db().query("update tarefas set payload = payload - 'token' where id = $1", [tarefa.id]);
  return cont;
}, {
  aoFalhar: async (_org, _payload, _e) => {},
}));

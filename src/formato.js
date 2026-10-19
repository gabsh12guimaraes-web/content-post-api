// Converte as linhas do banco no formato que o painel já usava com o Airtable (nomes de campo em PascalCase).
import { anexos } from "./arquivos.js";

const ordenar = mapa => Object.keys(mapa || {}).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
const LOGOS = ["Logo", "LogoDark", "SimboloLight", "SimboloDark"];

export async function marcaParaPainel(m) {
  if (!m) return null;
  const ids = [...LOGOS.map(k => (m.logos || {})[k]), ...(m.mood_board || [])];
  const a = await anexos(m.org_id, ids);
  const lista = id => (id && a.get(id) ? [a.get(id)] : []);
  return {
    id: m.org_id, Nome: m.nome, Posicionamento: m.posicionamento, Publico: m.publico, TomDeVoz: m.tom_de_voz,
    Pilares: m.pilares || [], Evitar: m.evitar, Redes: m.redes || [], FrequenciaSemanal: m.frequencia_semanal,
    ExemplosBons: m.exemplos, Cores: m.cores, Idioma: m.idioma, Perfil: m.perfil,
    ...Object.fromEntries(LOGOS.map(k => [k, lista((m.logos || {})[k])])),
    MoodBoard: (m.mood_board || []).map(id => a.get(id)).filter(Boolean),
  };
}

export const fonteParaPainel = f => ({ id: f.id, Nome: f.nome, Tipo: f.tipo, Categoria: f.categoria, Rede: f.rede, URL: f.url, Peso: f.peso, Ativa: f.ativa, UltimaColeta: f.ultima_coleta });

export const ideiaParaPainel = (i, postsDaIdeia = []) => ({
  id: i.id, Titulo: i.titulo, Resumo: i.resumo, Formato: i.formato, Rede: i.rede, Pilar: i.pilar, Score: Number(i.score),
  PorQueFunciona: i.por_que, Status: i.status, MotivoDescarte: i.motivo_descarte, Referencias: i.referencias || [],
  Calendario: postsDaIdeia, CriadaEm: i.criada_em,
});

export async function postsParaPainel(org, posts) {
  const ids = posts.flatMap(p => [...Object.values(p.fotos || {}), ...Object.values(p.clipes || {}), ...(p.artes || [])]);
  const a = await anexos(org, ids);
  return posts.map(p => {
    const nf = ordenar(p.fotos), nc = ordenar(p.clipes);
    const fotos = nf.map(n => a.get(p.fotos[n])).filter(Boolean);
    const clipes = nc.map(n => a.get(p.clipes[n])).filter(Boolean);
    return {
      id: p.id, Titulo: p.titulo, DataPublicacao: p.data_publicacao, Rede: p.rede, Formato: p.formato, Pilar: p.pilar,
      Status: p.status, Versao: p.versao, Legenda: p.legenda, Hashtags: p.hashtags, Slides: JSON.stringify(p.slides || []),
      LinkPublicado: p.link_publicado, Erro: p.erro, Redes: (p.redes && p.redes.length ? p.redes : [p.rede]).filter(Boolean), Links: p.links || {}, Publicacao: p.publicacao || {},
      Fotos: fotos, ImagensSlides: JSON.stringify(Object.fromEntries(nf.map(n => [n, (a.get(p.fotos[n]) || {}).url || ""]))),
      Clipes: clipes, ClipesSlides: JSON.stringify(Object.fromEntries(nc.map(n => [n, (a.get(p.clipes[n]) || {}).url || ""]))),
      Arquivos: (p.artes || []).map(id => a.get(id)).filter(Boolean), ArtesProntas: p.artes_prontas,
      Ideia: p.ideia_id ? [p.ideia_id] : [], Briefing: p.briefing ? JSON.stringify(p.briefing) : "", Diagramacao: JSON.stringify(p.diagramacao || {}),
    };
  });
}

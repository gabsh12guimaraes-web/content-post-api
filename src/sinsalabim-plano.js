// A IA propõe dados; só operações conhecidas chegam ao renderizador.
import fs from 'node:fs';
const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const num = (v, min, max, pad = min) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : pad;
export const ESTILOS_SINSA = ['clean', 'dinamico', 'comercial'];
// Edição no estilo do Captions: cortes secos sem pausas, zoom fixo alternado para esconder o salto,
// legenda curta palavra por palavra e a palavra-chave gigante. Nada de zoom lento (treme no render).
export const TRANSICOES_SINSA = ['corte', 'suave'];
export const LAYOUTS_APOIO = ['topo', 'janela', 'tela'];
export const LEGENDAS_SINSA = ['captions', 'pilula', 'unica'];
// Estilo que a pessoa escolhe no painel, sem IA. Só as fontes usadas vão embutidas no render (SIL OFL, em src/fontes).
export const FONTES_SINSA = {
  forte: { familia: 'SinsaForte', arquivo: 'montserrat-latin.woff2', peso: 900, faixa: '100 900' },
  condensada: { familia: 'SinsaCondensada', arquivo: 'anton-latin.woff2', peso: 400 },
  redonda: { familia: 'SinsaRedonda', arquivo: 'poppins-800-latin.woff2', peso: 800 },
  cursiva: { familia: 'SinsaScript', arquivo: 'pacifico-latin.woff2', peso: 400, manuscrita: true },
  elegante: { familia: 'SinsaElegante', arquivo: 'playfair-italico-latin.woff2', peso: 800, italico: true, manuscrita: true },
};
export const FONTES_LEGENDA = ['forte', 'condensada', 'redonda'];
export const FONTES_DESTAQUE = ['cursiva', 'elegante', 'forte', 'condensada', 'redonda'];
export const POSICOES_LEGENDA = { baixo: 1270, meio: 960, alto: 560 };
export const TAMANHOS_LEGENDA = { p: 0.84, m: 1, g: 1.2 };
const escolha = (v, lista, pad) => lista.includes(v) ? v : pad;
// O que vier válido em r vale; senão fica a escolha anterior (um ajuste pela IA não desfaz o estilo escolhido à mão).
export function estiloSinsa(r = {}, anterior = {}) {
  const posicoes = Object.keys(POSICOES_LEGENDA), tamanhos = Object.keys(TAMANHOS_LEGENDA);
  return {
    fonteLegenda: escolha(r.fonteLegenda, FONTES_LEGENDA, escolha(anterior.fonteLegenda, FONTES_LEGENDA, 'forte')),
    fonteDestaque: escolha(r.fonteDestaque, FONTES_DESTAQUE, escolha(anterior.fonteDestaque, FONTES_DESTAQUE, 'cursiva')),
    posicaoLegenda: escolha(r.posicaoLegenda, posicoes, escolha(anterior.posicaoLegenda, posicoes, 'baixo')),
    tamanhoLegenda: escolha(r.tamanhoLegenda, tamanhos, escolha(anterior.tamanhoLegenda, tamanhos, 'm')),
  };
}
// Luz e cor do vídeo: de -50 a 50 (temperatura: negativo esfria, positivo esquenta) e vinheta. Sem pedido, fica a anterior.
export function luzSinsa(v, anterior) {
  const b = v && typeof v === 'object' && !Array.isArray(v) ? v : (anterior || {});
  const n = x => Number.isFinite(Number(x)) ? Math.round(Math.max(-50, Math.min(50, Number(x)))) : 0;
  return { brilho: n(b.brilho), contraste: n(b.contraste), saturacao: n(b.saturacao), temperatura: n(b.temperatura), vinheta: b.vinheta === true };
}
// Editor (estilo CapCut): animações, textos livres, cards, música e efeitos sonoros.
export const ANIM_LEGENDA = ['pop', 'desfoque', 'subir', 'digitar', 'nenhuma'];
export const ANIM_TEXTO = ['surge', 'desfoque', 'subir', 'digitar', 'caixa'];
export const ANIM_IMAGEM = ['fade', 'pop', 'deslizar', 'flutuar'];
export const ANIM_CARD = ['pop', 'deslizar', 'desfoque'];
export const TIPOS_CARD = ['numero', 'selo', 'mensagem'];
const HEX = v => /^#[0-9a-f]{6}$/i.test(v || '');
// Linha do tempo: cada corte sabe onde começa na saída. Converte segundos do original <-> da edição.
export function mapaCortes(cortes) { let off = 0; return cortes.map(c => { const m = { ...c, saida: off }; off += c.fim - c.inicio; return m; }); }
export function fonteParaSaida(mapa, t) { const c = mapa.find(c => t >= c.inicio - 0.02 && t <= c.fim + 0.02); return c ? +(c.saida + Math.max(0, Math.min(c.fim - c.inicio, t - c.inicio))).toFixed(3) : null; }
export function saidaParaFonte(mapa, t) { const c = mapa.find(c => t >= c.saida - 0.001 && t < c.saida + (c.fim - c.inicio)) || mapa.at(-1); return c ? +(c.inicio + Math.max(0, Math.min(c.fim - c.inicio, t - c.saida))).toFixed(3) : 0; }
// Palavras ditas que ficaram na edição, no tempo da saída (e de qual palavra do original cada uma veio).
function palavrasNosCortes(cortes, palavras, correcoes = []) {
  const corrigidas = new Map(correcoes.map(c => [c.indice, c.texto])), lista = [], naSaida = new Map();
  let offset = 0;
  for (const c of cortes) {
    for (const [indice, w] of palavras.entries()) {
      // Não sobrepor duas falas nem incluir palavras cortadas ao meio.
      if (w.inicio < c.inicio - 0.02 || w.fim > c.fim + 0.02) continue;
      const pw = { texto: corrigidas.get(indice) || str(w.texto, 70), inicio: +Math.max(0, offset + w.inicio - c.inicio).toFixed(3), fim: +(offset + w.fim - c.inicio).toFixed(3) };
      lista.push(pw); if (!naSaida.has(indice)) naSaida.set(indice, pw);
    }
    offset += c.fim - c.inicio;
  }
  return { lista, naSaida };
}
const tempoValido = (o, total, durMin, durMax, durPad) => {
  const inicio = num(o.inicio, 0, Math.max(0, total - 0.3)); if (inicio + 0.3 > total + 0.001) return null;
  return { inicio: +inicio.toFixed(3), duracao: +Math.min(num(o.duracao, durMin, durMax, durPad), total - inicio).toFixed(3) };
};
// Texto em destaque (da IA ou criado à mão): animação, cor, fonte, tamanho e altura próprios.
export function destaqueValido(d, total) {
  if (!d || typeof d !== 'object') return null;
  const texto = str(d.texto, 40), t = texto && tempoValido(d, total, 0.4, 8, 1.5); if (!t) return null;
  return { texto, apoio: str(d.apoio, 60), ...t, animacao: escolha(d.animacao, ANIM_TEXTO, 'surge'), tamanho: +num(d.tamanho, 0.5, 1.6, 1).toFixed(2), y: Math.round(num(d.y, 150, 1650, 1000)),
    ...(HEX(d.cor) ? { cor: d.cor } : {}), ...(FONTES_DESTAQUE.includes(d.fonte) ? { fonte: d.fonte } : {}), ...(Number.isFinite(Number(d.falaEm)) ? { falaEm: +Number(d.falaEm).toFixed(3) } : {}) };
}
export function cardValido(c, total) {
  if (!c || !TIPOS_CARD.includes(c.tipo)) return null;
  const texto = str(c.texto, 40), t = texto && tempoValido(c, total, 0.5, 10, 2.2); if (!t) return null;
  return { tipo: c.tipo, texto, sub: str(c.sub, 90), ...t, animacao: escolha(c.animacao, ANIM_CARD, 'pop'), y: Math.round(num(c.y, 150, 1650, { numero: 360, selo: 300, mensagem: 380 }[c.tipo])) };
}
// O que a pessoa (ou a IA) escolheu para o vídeo todo e que um ajuste não deve desfazer sem pedido.
export function extrasSinsa(r = {}, anterior = {}, musicas = []) {
  const v = (k, lista, pad) => escolha(r[k], lista, escolha(anterior[k], lista, pad));
  const mus = r.musica === null ? null : r.musica !== undefined ? r.musica : anterior.musica;
  const musica = mus && musicas.some(m => m.id === mus.banco) ? { banco: mus.banco, volume: Math.round(num(mus.volume, 0, 100, 20)), inicio: +num(mus.inicio, 0, 600, 0).toFixed(1) } : null;
  return { animLegenda: v('animLegenda', ANIM_LEGENDA, 'pop'), musica, voz: Math.round(num(r.voz ?? anterior.voz, 0, 100, 100)), sfx: typeof r.sfx === 'boolean' ? r.sfx : anterior.sfx === true };
}
function apoiosValidos(lista, total, banco, max) {
  const imagens = new Set(banco.map(b => b.id)), saida = [];
  const pedidos = (Array.isArray(lista) ? lista : []).filter(a => a && imagens.has(a.banco)).map(a => {
    const layout = LAYOUTS_APOIO.includes(a.layout) ? a.layout : 'topo';
    return { banco: a.banco, inicio: +num(a.inicio, 0, Math.max(0, total - 0.3)).toFixed(3), duracao: +num(a.duracao, 0.8, layout === 'tela' ? 1.5 : 6, 1.8).toFixed(3), layout, animacao: escolha(a.animacao, ANIM_IMAGEM, 'fade'), inclinar: a.inclinar === true };
  }).filter(a => a.inicio + a.duracao <= total + 0.01).sort((a, b) => a.inicio - b.inicio);
  // Uma imagem por vez: a que começa antes de a anterior sair fica de fora.
  for (const a of pedidos) { if (saida.length >= max) break; const ant = saida.at(-1); if (!ant || a.inicio >= ant.inicio + ant.duracao - 0.01) saida.push(a); }
  return saida;
}
const PAUSA = 0.6, RESPIRO_INICIO = 0.12, RESPIRO_FIM = 0.18, MIN_TRECHO = 0.35;
export const ZOOM_SINSA = 1.12;
export const duracaoPlano = p => Math.round(p.cortes.reduce((t,c) => t+c.fim-c.inicio,0)*1000)/1000;
// Dentro de cada trecho escolhido, tira os silêncios maiores que PAUSA (com um respiro para não comer sílabas).
function semPausas(cortes, palavras) {
  const saida = [];
  for (const c of cortes) {
    const ws = palavras.filter(w => w.inicio >= c.inicio - 0.02 && w.fim <= c.fim + 0.02);
    if (!ws.length) { saida.push(c); continue; }
    let ini = ws[0].inicio - c.inicio > PAUSA ? ws[0].inicio - RESPIRO_INICIO : c.inicio;
    const partes = [];
    for (let k = 1; k < ws.length; k++) {
      if (ws[k].inicio - ws[k-1].fim <= PAUSA) continue;
      partes.push([ini, ws[k-1].fim + RESPIRO_FIM]); ini = ws[k].inicio - RESPIRO_INICIO;
    }
    const ultimo = ws.at(-1).fim;
    partes.push([ini, c.fim - ultimo > PAUSA ? ultimo + RESPIRO_FIM : c.fim]);
    for (const [k, [a, b]] of partes.entries()) {
      const inicio = Math.max(c.inicio, a), fim = Math.min(c.fim, b);
      if (fim - inicio >= MIN_TRECHO) saida.push(k ? { inicio, fim, zoom: false, transicao: 'corte', salto: true } : { ...c, inicio, fim });
    }
  }
  return saida;
}
export function limparPlanoSinsa(r, duracao, banco = [], palavras = []) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.cortes)) throw new Error('A edição veio incompleta. Peça um novo ajuste.');
  const pedidos=[];
  for(const c of r.cortes.slice(0,40)) {
    const inicio=num(c.inicio,0,duracao),fim=num(c.fim,inicio,duracao);
    if(fim-inicio<0.3 || inicio < (pedidos.at(-1)?.fim || 0)-0.02) continue;
    // "zoom" e "deslizar" de planos antigos viram zoom fixo e entrada suave.
    pedidos.push({inicio,fim,zoom:c.zoom===true||c.transicao==='zoom',transicao:c.transicao==='suave'||c.transicao==='deslizar'?'suave':'corte'});
  }
  const cortes=[];let total=0;
  for(const c of r.tirarPausas===false?pedidos:semPausas(pedidos,palavras)) {
    const tamanho=Math.min(c.fim-c.inicio,60-total);if(tamanho<0.3)break;
    const anterior=cortes.at(-1);
    // Salto dentro da mesma fala: alterna o enquadramento (normal / mais perto), como no Captions.
    const zoom=c.salto&&anterior?!anterior.zoom:c.zoom===true;
    cortes.push({inicio:+c.inicio.toFixed(3),fim:+(c.inicio+tamanho).toFixed(3),zoom,transicao:cortes.length&&c.transicao==='suave'?'suave':'corte'});total+=tamanho;
    if(total>=59.99||cortes.length>=120)break;
  }
  if(!cortes.length)throw new Error('Não encontramos trechos válidos para a edição. Tente explicar seu objetivo de outra forma.');
  const cor=/^#[0-9a-f]{6}$/i.test(r.cor || '')?r.cor:'#ff5478';
  const apoios=apoiosValidos(r.apoios,total,banco,3);
  const legendaEstilo=LEGENDAS_SINSA.includes(r.legendaEstilo)?r.legendaEstilo:'captions';
  const p={titulo:str(r.titulo,100)||'Meu vídeo',resumo:str(r.resumo,600),estilo:ESTILOS_SINSA.includes(r.estilo)?r.estilo:'dinamico',cor,cortes,legendas:r.legendas!==false,tituloTela:str(r.tituloTela,60),chamada:str(r.chamada,60),legenda:str(r.legenda,1600),hashtags:str(r.hashtags,500),apoios,visual:r.visual==='vibrante'?'vibrante':'natural',legendaEstilo,...estiloSinsa(r),luz:luzSinsa(r.luz),avisos:(Array.isArray(r.avisos)?r.avisos:[]).map(a=>str(a,180)).filter(Boolean).slice(0,4)};
  p.correcoes=(Array.isArray(r.correcoes)?r.correcoes:[]).slice(0,50).filter(c=>Number.isInteger(c.indice)&&c.indice>=0&&c.indice<palavras.length&&str(c.texto,70)).map(c=>({indice:c.indice,texto:str(c.texto,70)}));
  const {lista,naSaida}=palavrasNosCortes(cortes,palavras,p.correcoes);p.palavras=lista;
  p.duracao=duracaoPlano(p);
  // Destaques: a palavra-chave da frase em tamanho grande, no momento em que ela é dita (só palavras que ficaram na edição).
  p.destaques=[];
  const escolhidos=(Array.isArray(r.destaques)?r.destaques:[]).slice(0,20).filter(d=>Number.isInteger(d.indice)&&naSaida.has(d.indice)).map(d=>{const w=naSaida.get(d.indice);const bruto=str(d.texto,28)||w.texto.replace(/[.,!?;:…"“”]+/g,'');
    // A letra cursiva do destaque fica ilegível em maiúsculas: "PRODUTO" vira "Produto".
    const texto=bruto.length>3&&bruto===bruto.toLocaleUpperCase('pt-BR')?bruto[0]+bruto.slice(1).toLocaleLowerCase('pt-BR'):bruto;
    return {w,d,texto,falaEm:palavras[d.indice].inicio};}).sort((a,b)=>a.w.inicio-b.w.inicio);
  for(const e of escolhidos){
    const inicio=Math.max(0,e.w.inicio-0.05),duracao=Math.min(Math.max(1,e.w.fim-e.w.inicio+0.8),1.8,p.duracao-inicio);
    if(duracao<0.5||!e.texto||(p.destaques.length&&inicio<p.destaques.at(-1).inicio+p.destaques.at(-1).duracao))continue;
    const d=destaqueValido({...e.d,texto:e.texto,inicio,duracao,falaEm:e.falaEm},p.duracao);if(d)p.destaques.push(d);
    if(p.destaques.length>=12)break;
  }
  p.cards=(Array.isArray(r.cards)?r.cards:[]).slice(0,10).map(c=>cardValido(c,p.duracao)).filter(Boolean).sort((a,b)=>a.inicio-b.inicio);
  return p;
}
// Mudanças feitas à mão no painel: só campos conhecidos, validados como os da IA. Cortes e palavras não mudam aqui.
// Mudanças feitas à mão no editor: só campos conhecidos, validados como os da IA.
// opcoes: palavras e correções da transcrição (para refazer a legenda quando os cortes mudam) e as músicas do banco.
export function personalizarPlanoSinsa(plano, m = {}, banco = [], { palavras = null, duracaoFonte = Infinity, musicas = [] } = {}) {
  const p = { ...plano, ...estiloSinsa(m, plano), ...extrasSinsa(m, plano, musicas) };
  if (HEX(m.cor)) p.cor = m.cor;
  if (LEGENDAS_SINSA.includes(m.legendaEstilo)) p.legendaEstilo = m.legendaEstilo;
  if (typeof m.legendas === 'boolean') p.legendas = m.legendas;
  if (m.visual === 'natural' || m.visual === 'vibrante') p.visual = m.visual;
  if (typeof m.tituloTela === 'string') p.tituloTela = str(m.tituloTela, 60);
  if (typeof m.chamada === 'string') p.chamada = str(m.chamada, 60);
  // Cortes: aparar, dividir e excluir trechos (na ordem do original). A legenda e os textos ligados à fala acompanham.
  const antes = mapaCortes(plano.cortes || []);
  if (Array.isArray(m.cortes) && palavras) {
    const cortes = []; let total = 0;
    for (const c of [...m.cortes].filter(c => c && typeof c === 'object').map(c => ({ inicio: num(c.inicio, 0, duracaoFonte), fim: num(c.fim, 0, duracaoFonte), zoom: c.zoom === true, transicao: c.transicao === 'suave' ? 'suave' : 'corte' })).sort((a, b) => a.inicio - b.inicio)) {
      if (c.fim - c.inicio < 0.3 || (cortes.length && c.inicio < cortes.at(-1).fim - 0.02)) continue;
      const fim = Math.min(c.fim, c.inicio + 90 - total); if (fim - c.inicio < 0.3) break;
      cortes.push({ inicio: +c.inicio.toFixed(3), fim: +fim.toFixed(3), zoom: c.zoom, transicao: cortes.length ? c.transicao : 'corte' }); total += fim - c.inicio;
      if (cortes.length >= 150) break;
    }
    if (!cortes.length) throw Object.assign(new Error('O vídeo precisa de pelo menos um trecho.'), { status: 400 });
    p.cortes = cortes; p.palavras = palavrasNosCortes(cortes, palavras, plano.correcoes || []).lista; p.duracao = duracaoPlano(p);
  }
  const depois = mapaCortes(p.cortes), mudouCortes = p.cortes !== plano.cortes;
  // Textos: lista completa vinda do editor. Os ligados à fala (falaEm) seguem a palavra se os cortes mudarem.
  const base = Array.isArray(m.destaques) ? m.destaques : plano.destaques || [];
  const vistos = new Set();
  p.destaques = base.slice(0, 30).map(d => {
    if (!d || typeof d !== 'object') return null;
    // Formato antigo do painel: {indice, texto, apoio} edita um destaque que já existe.
    if (d.indice !== undefined) { const o = (plano.destaques || [])[d.indice]; if (!o || vistos.has(d.indice)) return null; vistos.add(d.indice); d = { ...o, ...d, apoio: typeof d.apoio === 'string' ? d.apoio : o.apoio }; delete d.indice; }
    let falaEm = Number.isFinite(Number(d.falaEm)) ? Number(d.falaEm) : antes.length ? saidaParaFonte(antes, num(d.inicio, 0, plano.duracao || 0)) : null;
    let inicio = num(d.inicio, 0, Infinity);
    if (mudouCortes && falaEm != null) { const novo = fonteParaSaida(depois, falaEm); if (novo == null) return null; inicio = novo; }
    else if (Array.isArray(m.destaques) && !mudouCortes) falaEm = saidaParaFonte(depois, inicio);
    return destaqueValido({ ...d, inicio, falaEm }, p.duracao);
  }).filter(Boolean).sort((a, b) => a.inicio - b.inicio);
  if (Array.isArray(m.apoios) || mudouCortes) p.apoios = apoiosValidos(Array.isArray(m.apoios) ? m.apoios : plano.apoios, p.duracao, banco, 12);
  if (Array.isArray(m.cards) || mudouCortes) p.cards = (Array.isArray(m.cards) ? m.cards : plano.cards || []).slice(0, 20).map(c => cardValido(c, p.duracao)).filter(Boolean).sort((a, b) => a.inicio - b.inicio);
  if (m.luz && typeof m.luz === 'object') p.luz = luzSinsa(m.luz);
  return p;
}
// Legenda curta: até 3 palavras (ou 1 no estilo "unica"), quebrando em pausa ou fim de frase.
export function gruposLegendas(p) {
  const max=p.legendaEstilo==='unica'?1:3,grupos=[];let grupo=[];
  for(const w of p.palavras || []) {
    const letras=grupo.reduce((n,x)=>n+x.texto.length+1,0)+w.texto.length;
    if(grupo.length && (grupo.length>=max || letras>18 || w.inicio-grupo.at(-1).fim>0.45 || /[.!?…]$/.test(grupo.at(-1).texto))) {grupos.push(grupo);grupo=[];}
    grupo.push(w);
  }
  if(grupo.length)grupos.push(grupo);return grupos;
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// O HTML5 do Shotstack bloqueia fontes remotas: as duas vão embutidas (Montserrat e Pacifico, SIL OFL).
const ARQUIVOS_FONTE = new Map();
const lerFonte = n => { if (!ARQUIVOS_FONTE.has(n)) ARQUIVOS_FONTE.set(n, fs.readFileSync(new URL('./fontes/' + n, import.meta.url)).toString('base64')); return ARQUIVOS_FONTE.get(n); };
// O HTML5 do Shotstack bloqueia fontes remotas: cada fonte usada vai embutida no CSS.
const fontes = chaves => [...new Set(chaves)].map(k => { const f = FONTES_SINSA[k]; return `@font-face{font-family:${f.familia};font-weight:${f.faixa || f.peso};font-style:${f.italico ? 'italic' : 'normal'};src:url(data:font/woff2;base64,${lerFonte(f.arquivo)}) format('woff2')}`; }).join('');
const s3=n=>Math.max(0,n).toFixed(3);
// Aparece só entre inicio e inicio+duracao: fora da animação vale a opacidade 0 da classe .j.
const janela=(inicio,duracao,extra='')=>`animation:ver ${s3(duracao)}s linear ${s3(inicio)}s 1${extra}`;
// Camada única com legendas, destaques e chamadas: os tempos são absolutos, a partir do início do vídeo.
const corTexto = hex => { const n = parseInt(hex.slice(1), 16), l = (0.2126 * (n >> 16) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255; return l > 0.6 ? '#111' : '#fff'; };
const ENTRADA_LEG = { pop: 'pop .16s ease-out', desfoque: 'desfoca .24s ease-out', subir: 'sobe .22s cubic-bezier(.2,.9,.3,1)' };
const ENTRADA_TXT = { surge: 'surge .32s cubic-bezier(.2,1.4,.4,1)', desfoque: 'desfoca .34s ease-out', subir: 'sobe .3s cubic-bezier(.2,.9,.3,1)', caixa: 'caixa .3s cubic-bezier(.2,1.2,.4,1)' };
const ENTRADA_CARD = { pop: 'surge .36s cubic-bezier(.2,1.4,.4,1)', deslizar: 'desliza .34s cubic-bezier(.2,.9,.3,1)', desfoque: 'desfoca .3s ease-out' };
// Camada única com legendas, textos, cards e chamadas: os tempos são absolutos, a partir do início do vídeo.
export function camadaTextoSinsa(plano, total=plano.duracao) {
  const cor=plano.cor,partes=[],anim=plano.animLegenda||'pop';
  const fl=plano.fonteLegenda||'forte',fd=plano.fonteDestaque||'cursiva',F=FONTES_SINSA[fl]||FONTES_SINSA.forte;
  const fam=f=>`${f.italico?'italic ':''}${f.peso}`;
  const usadas=new Set([fl,fd]);
  const livre=g=>!(plano.destaques||[]).some(d=>g[0].inicio<d.inicio+d.duracao&&g.at(-1).fim>d.inicio);
  if(plano.legendas)for(const g of gruposLegendas(plano).filter(livre)){
    const inicio=g[0].inicio,fim=Math.min(total,g.at(-1).fim+0.12);
    // "digitar": cada palavra aparece quando é dita.
    const palavras=g.map(w=>`<span class="w" style="animation:${anim==='digitar'?`mostra .08s linear ${s3(w.inicio)}s 1 both,`:''}acende ${s3(Math.max(0.08,w.fim-w.inicio))}s linear ${s3(w.inicio)}s 1">${esc(w.texto)}</span>`).join(' ');
    const entrada=ENTRADA_LEG[anim]?`animation:${ENTRADA_LEG[anim]} ${s3(inicio)}s 1 both`:'';
    partes.push(`<div class="j leg" style="${janela(inicio,fim-inicio)}"><div class="pop" style="${entrada}">${palavras}</div></div>`);
  }
  for(const d of plano.destaques||[]){
    const fonte=FONTES_SINSA[d.fonte||fd]||FONTES_SINSA.cursiva,c=d.cor||cor,k=d.tamanho||1,caixa=d.animacao==='caixa';
    usadas.add(d.fonte||fd);
    const manus=fonte.manuscrita&&!caixa,tam=Math.round((manus?(d.fonte||fd)==='elegante'?150:176:(d.fonte||fd)==='condensada'?170:140)*k);
    const estiloB=caixa?`font:${fam(F)} ${Math.round(120*k)}px/1.05 ${F.familia},sans-serif;text-transform:uppercase;background:${c};color:${corTexto(c)};padding:6px 26px;border-radius:12px;box-shadow:0 10px 0 #0003`
      :manus?`font:${fam(fonte)} ${tam}px/1.15 ${fonte.familia},serif;color:${c};-webkit-text-stroke:5px #fff;paint-order:stroke fill;text-shadow:0 0 26px #fff9,0 10px 0 #0004`
      :`font:${fam(fonte)} ${tam}px/1.05 ${fonte.familia},sans-serif;text-transform:uppercase;color:${c};-webkit-text-stroke:10px #000;paint-order:stroke fill;text-shadow:0 10px 0 #0004`;
    const n=Math.max(1,[...d.texto].length),entrada=d.animacao==='digitar'?`digita ${s3(Math.min(0.9,0.06*n))}s steps(${n}) ${s3(d.inicio)}s 1 both`:`${ENTRADA_TXT[d.animacao]||ENTRADA_TXT.surge} ${s3(d.inicio)}s 1 both`;
    // "digitar" revela as letras no próprio texto; as outras entradas animam o bloco inteiro.
    const digitar=d.animacao==='digitar';
    partes.push(`<div class="j dest" style="top:${d.y||1000}px;${janela(d.inicio,d.duracao)}"><div class="pop" style="${digitar?'':`animation:${entrada}`}">${d.apoio?`<small>${esc(d.apoio)}</small>`:''}<b style="${estiloB}${digitar?`;animation:${entrada}`:''}">${esc(d.texto)}</b></div></div>`);
  }
  for(const c of plano.cards||[]){
    const entrada=`animation:${ENTRADA_CARD[c.animacao]||ENTRADA_CARD.pop} ${s3(c.inicio)}s 1 both`;
    const corpo=c.tipo==='numero'?`<div class="card-n"><b>${esc(c.texto)}</b>${c.sub?`<small>${esc(c.sub)}</small>`:''}<span class="barras">${[34,56,78,100].map((h,k)=>`<i style="height:${h}%;animation:barra .4s ease-out ${s3(c.inicio+0.15+k*0.08)}s 1 both"></i>`).join('')}</span></div>`
      :c.tipo==='selo'?`<div class="card-s">${esc(c.texto)}${c.sub?` <em>${esc(c.sub)}</em>`:''}</div>`
      :`<div class="card-m"><div class="cab"><i></i>${esc(c.texto)}</div>${c.sub?`<p>${esc(c.sub)}</p>`:''}</div>`;
    partes.push(`<div class="j cardx" style="top:${c.y}px;${janela(c.inicio,c.duracao)}"><div class="pop" style="${entrada}">${corpo}</div></div>`);
  }
  const t=Math.min(2.6,total/2);
  if(plano.tituloTela)partes.push(`<div class="j card" style="${janela(0,t)}"><div class="pop" style="animation:pop .25s ease-out 0s 1 both">${esc(plano.tituloTela)}</div></div>`);
  if(plano.chamada)partes.push(`<div class="j card" style="${janela(total-t,t)}"><div class="pop" style="animation:pop .25s ease-out ${s3(total-t)}s 1 both">${esc(plano.chamada)}</div></div>`);
  const tam=(TAMANHOS_LEGENDA[plano.tamanhoLegenda]||1)*(fl==='condensada'?1.12:1);
  const tamLeg=Math.round((plano.legendaEstilo==='unica'?104:78)*tam),topo=POSICOES_LEGENDA[plano.posicaoLegenda]||POSICOES_LEGENDA.baixo;
  const ativa=plano.legendaEstilo==='pilula'?`color:#fff;background:${cor};box-shadow:0 6px 0 #0004`:`color:${cor};transform:scale(1.12)`;
  const css=`${fontes([...usadas])}html,body{margin:0;width:1080px;height:1920px;background:transparent;overflow:hidden}
.j{position:absolute;left:60px;right:60px;opacity:0;text-align:center}
@keyframes ver{from,to{opacity:1}}@keyframes pop{from{opacity:0;transform:scale(.82) translateY(14px)}to{opacity:1;transform:none}}@keyframes surge{from{opacity:0;transform:scale(.5) rotate(-4deg)}to{opacity:1;transform:none}}
@keyframes desfoca{from{opacity:0;filter:blur(18px);transform:scale(1.08)}to{opacity:1;filter:none;transform:none}}@keyframes sobe{from{opacity:0;transform:translateY(60px)}to{opacity:1;transform:none}}
@keyframes caixa{from{opacity:0;transform:scaleX(.2)}to{opacity:1;transform:none}}@keyframes desliza{from{opacity:0;transform:translateX(-140px)}to{opacity:1;transform:none}}
@keyframes digita{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}@keyframes mostra{from{opacity:0}to{opacity:1}}@keyframes barra{from{transform:scaleY(0)}to{transform:none}}
@keyframes acende{from,to{${ativa}}}
.leg{top:${topo}px;font:${fam(F)} ${tamLeg}px/1.12 ${F.familia},Arial,sans-serif;text-transform:uppercase;color:#fff;-webkit-text-stroke:12px #000;paint-order:stroke fill;text-shadow:0 7px 0 #0005;letter-spacing:-1px}
.leg .w{display:inline-block;padding:2px 12px;margin:0 -6px;border-radius:14px}
.dest small{display:block;font:${fam(F)} 46px/1.1 ${F.familia},Arial,sans-serif;text-transform:uppercase;color:#fff;-webkit-text-stroke:8px #000;paint-order:stroke fill;margin-bottom:-6px}
.dest b{display:inline-block;white-space:nowrap;transform-origin:left center}
.card{top:250px}.card .pop{display:inline-block;max-width:900px;padding:22px 34px;border-radius:26px;background:#fff;color:#0b0b0f;font:${fam(F)} 60px/1.12 ${F.familia},Arial,sans-serif;box-shadow:0 14px 40px #0006;border-bottom:10px solid ${cor}}
.card-n{display:inline-flex;align-items:center;gap:26px;padding:28px 38px;border-radius:32px;background:#fff;box-shadow:0 20px 60px #0007;text-align:left}
.card-n b{font:${fam(F)} 124px/1 ${F.familia},sans-serif;color:${cor}}.card-n small{max-width:330px;font:700 36px/1.2 Arial,sans-serif;color:#222}
.barras{display:flex;align-items:flex-end;gap:9px;height:96px}.barras i{width:20px;border-radius:5px;background:${cor};transform-origin:bottom}
.card-s{display:inline-block;padding:16px 30px;border-radius:20px;background:#111;color:#fff;font:${fam(F)} 50px/1.15 ${F.familia},sans-serif;box-shadow:0 14px 40px #0006}.card-s em{font-style:normal;padding:2px 14px;border-radius:10px;background:#FFE14A;color:#111}
.card-m{display:inline-block;width:780px;padding:32px 36px;border-radius:32px;background:#1c1d23;color:#fff;text-align:left;box-shadow:0 24px 70px #000a;border:2px solid #ffffff1a}
.card-m .cab{display:flex;align-items:center;gap:16px;font:${fam(F)} 40px/1.2 ${F.familia},sans-serif}.card-m .cab i{width:46px;height:46px;border-radius:50%;background:${cor}}
.card-m p{margin:18px 0 0;font:500 38px/1.4 Arial,sans-serif;color:#d9dae0}`;
  return {asset:{type:'html5',html:partes.join(''),css},start:0,length:+total.toFixed(3)};
}
// Efeitos sonoros: "whoosh" quando um texto ou card entra e "pop" quando uma imagem aparece (arquivos gerados na API, em /sfx).
export const SFX_SINSA = { whoosh: 0.55, pop: 0.25 };
const TRANS_IMG = { fade: d => d >= 2.4 ? { in: 'fade', out: 'fade' } : { in: 'fadeFast', out: 'fadeFast' }, pop: () => ({ in: 'zoom', out: 'fadeFast' }), deslizar: () => ({ in: 'slideUp', out: 'fadeFast' }), flutuar: () => ({ in: 'fade', out: 'fade' }) };
export function timelineSinsa(plano, video, imagens=[], { musicas = [], sfxBase = null } = {}) {
  let t=0;const voz=(plano.voz??100)/100;
  const videos=plano.cortes.map(c=>{const clip={asset:{type:'video',src:video,trim:c.inicio,volume:+voz.toFixed(2)},start:+t.toFixed(3),length:+(c.fim-c.inicio).toFixed(3),fit:'crop',...(c.zoom?{scale:ZOOM_SINSA}:{}),...(plano.visual==='vibrante'?{filter:'boost'}:{}),...(c.transicao==='suave'?{transition:{in:'fadeFast'}}:{})};t+=c.fim-c.inicio;return clip;});
  // Imagem de apoio: cartão no alto (a pessoa segue falando embaixo), janela no canto ou tela cheia por um instante.
  const LAYOUT={topo:{fit:'contain',scale:0.58,position:'top',offset:{y:-0.07}},janela:{fit:'contain',scale:0.36,position:'topRight',offset:{x:-0.05,y:-0.09}},tela:{fit:'crop'}};
  const apoios=plano.apoios.map(a=>({asset:{type:'image',src:imagens.find(i=>i.id===a.banco)?.url},start:a.inicio,length:a.duracao,...(LAYOUT[a.layout]||LAYOUT.topo),
    transition:(TRANS_IMG[a.animacao]||TRANS_IMG.fade)(a.duracao),...(a.animacao==='flutuar'?{effect:'zoomInSlow'}:{}),...(a.inclinar&&a.layout!=='tela'?{transform:{rotate:{angle:-4}}}:{})})).filter(a=>a.asset.src);
  const textos=camadaTextoSinsa(plano,t);
  const audios=[];
  const musica=plano.musica&&musicas.find(m=>m.id===plano.musica.banco);
  if(musica)audios.push({asset:{type:'audio',src:musica.url,trim:plano.musica.inicio||0,volume:+((plano.musica.volume??20)/100).toFixed(2),effect:'fadeInFadeOut'},start:0,length:+t.toFixed(3)});
  const sfx=[];
  if(plano.sfx&&sfxBase){
    for(const d of [...(plano.destaques||[]),...(plano.cards||[])])sfx.push({asset:{type:'audio',src:sfxBase+'/whoosh.mp3',volume:0.5},start:+Math.max(0,d.inicio-0.08).toFixed(3),length:SFX_SINSA.whoosh});
    for(const a of plano.apoios)sfx.push({asset:{type:'audio',src:sfxBase+'/pop.mp3',volume:0.55},start:a.inicio,length:SFX_SINSA.pop});
  }
  const trilhas=[{clips:textos.asset.html?[textos]:[]},{clips:apoios},{clips:videos},{clips:audios},{clips:sfx.filter(x=>x.start+x.length<=t+0.01)}].filter(x=>x.clips.length);
  return {timeline:{background:'#000000',tracks:trilhas},output:{format:'mp4',resolution:'1080',aspectRatio:'9:16',fps:30}};
}

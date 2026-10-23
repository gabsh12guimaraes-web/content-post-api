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
  const imagens=new Set(banco.map(b=>b.id));
  const apoios=(Array.isArray(r.apoios)?r.apoios:[]).slice(0,3).filter(a=>imagens.has(a.banco)).map(a=>{const layout=LAYOUTS_APOIO.includes(a.layout)?a.layout:'topo';return {banco:a.banco,inicio:num(a.inicio,0,Math.max(0,total-0.3)),duracao:num(a.duracao,0.8,layout==='tela'?1.5:3,1.8),layout};}).filter(a=>a.inicio+a.duracao<=total+0.01);
  const legendaEstilo=LEGENDAS_SINSA.includes(r.legendaEstilo)?r.legendaEstilo:'captions';
  const p={titulo:str(r.titulo,100)||'Meu vídeo',resumo:str(r.resumo,600),estilo:ESTILOS_SINSA.includes(r.estilo)?r.estilo:'dinamico',cor,cortes,legendas:r.legendas!==false,tituloTela:str(r.tituloTela,60),chamada:str(r.chamada,60),legenda:str(r.legenda,1600),hashtags:str(r.hashtags,500),apoios,visual:r.visual==='vibrante'?'vibrante':'natural',legendaEstilo,avisos:(Array.isArray(r.avisos)?r.avisos:[]).map(a=>str(a,180)).filter(Boolean).slice(0,4)};
  p.correcoes=(Array.isArray(r.correcoes)?r.correcoes:[]).slice(0,50).filter(c=>Number.isInteger(c.indice)&&c.indice>=0&&c.indice<palavras.length&&str(c.texto,70)).map(c=>({indice:c.indice,texto:str(c.texto,70)}));
  const corrigidas=new Map(p.correcoes.map(c=>[c.indice,c.texto]));
  p.palavras=[];let offset=0;const naSaida=new Map();
  for(const c of cortes) {
    for(const [indice,w] of palavras.entries()) {
      // Não sobrepor duas falas nem incluir palavras cortadas ao meio.
      if(w.inicio<c.inicio-0.02 || w.fim>c.fim+0.02)continue;
      const pw={texto:corrigidas.get(indice)||str(w.texto,70),inicio:+Math.max(0,offset+w.inicio-c.inicio).toFixed(3),fim:+(offset+w.fim-c.inicio).toFixed(3)};
      p.palavras.push(pw);if(!naSaida.has(indice))naSaida.set(indice,pw);
    }
    offset+=c.fim-c.inicio;
  }
  p.duracao=duracaoPlano(p);
  // Destaques: a palavra-chave da frase em tamanho grande, no momento em que ela é dita (só palavras que ficaram na edição).
  p.destaques=[];
  const escolhidos=(Array.isArray(r.destaques)?r.destaques:[]).slice(0,20).filter(d=>Number.isInteger(d.indice)&&naSaida.has(d.indice)).map(d=>{const w=naSaida.get(d.indice);const bruto=str(d.texto,28)||w.texto.replace(/[.,!?;:…"“”]+/g,'');
    // A letra cursiva do destaque fica ilegível em maiúsculas: "PRODUTO" vira "Produto".
    const texto=bruto.length>3&&bruto===bruto.toLocaleUpperCase('pt-BR')?bruto[0]+bruto.slice(1).toLocaleLowerCase('pt-BR'):bruto;
    return {w,texto,apoio:str(d.apoio,60)};}).sort((a,b)=>a.w.inicio-b.w.inicio);
  for(const d of escolhidos){
    const inicio=Math.max(0,d.w.inicio-0.05),duracao=Math.min(Math.max(1,d.w.fim-d.w.inicio+0.8),1.8,p.duracao-inicio);
    if(duracao<0.5||!d.texto||(p.destaques.length&&inicio<p.destaques.at(-1).inicio+p.destaques.at(-1).duracao))continue;
    p.destaques.push({texto:d.texto,apoio:d.apoio,inicio:+inicio.toFixed(3),duracao:+duracao.toFixed(3)});
    if(p.destaques.length>=12)break;
  }
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
let FONTES;
const fontes=()=>FONTES??=(()=>{const ler=n=>fs.readFileSync(new URL('./fontes/'+n,import.meta.url)).toString('base64');
  return `@font-face{font-family:SinsaForte;font-weight:100 900;src:url(data:font/woff2;base64,${ler('montserrat-latin.woff2')}) format('woff2')}@font-face{font-family:SinsaScript;src:url(data:font/woff2;base64,${ler('pacifico-latin.woff2')}) format('woff2')}`;})();
const s3=n=>Math.max(0,n).toFixed(3);
// Aparece só entre inicio e inicio+duracao: fora da animação vale a opacidade 0 da classe .j.
const janela=(inicio,duracao,extra='')=>`animation:ver ${s3(duracao)}s linear ${s3(inicio)}s 1${extra}`;
// Camada única com legendas, destaques e chamadas: os tempos são absolutos, a partir do início do vídeo.
export function camadaTextoSinsa(plano, total=plano.duracao) {
  const cor=plano.cor,partes=[];
  const livre=g=>!(plano.destaques||[]).some(d=>g[0].inicio<d.inicio+d.duracao&&g.at(-1).fim>d.inicio);
  if(plano.legendas)for(const g of gruposLegendas(plano).filter(livre)){
    const inicio=g[0].inicio,fim=Math.min(total,g.at(-1).fim+0.12);
    const palavras=g.map(w=>`<span class="w" style="animation:acende ${s3(Math.max(0.08,w.fim-w.inicio))}s linear ${s3(w.inicio)}s 1">${esc(w.texto)}</span>`).join(' ');
    partes.push(`<div class="j leg" style="${janela(inicio,fim-inicio)}"><div class="pop" style="animation:pop .16s ease-out ${s3(inicio)}s 1 both">${palavras}</div></div>`);
  }
  for(const d of plano.destaques||[])
    partes.push(`<div class="j dest" style="${janela(d.inicio,d.duracao)}"><div class="pop" style="animation:surge .32s cubic-bezier(.2,1.4,.4,1) ${s3(d.inicio)}s 1 both">${d.apoio?`<small>${esc(d.apoio)}</small>`:''}<b>${esc(d.texto)}</b></div></div>`);
  const t=Math.min(2.6,total/2);
  if(plano.tituloTela)partes.push(`<div class="j card" style="${janela(0,t)}"><div class="pop" style="animation:pop .25s ease-out 0s 1 both">${esc(plano.tituloTela)}</div></div>`);
  if(plano.chamada)partes.push(`<div class="j card" style="${janela(total-t,t)}"><div class="pop" style="animation:pop .25s ease-out ${s3(total-t)}s 1 both">${esc(plano.chamada)}</div></div>`);
  const ativa=plano.legendaEstilo==='pilula'?`color:#fff;background:${cor};box-shadow:0 6px 0 #0004`:`color:${cor};transform:scale(1.12)`;
  const css=`${fontes()}html,body{margin:0;width:1080px;height:1920px;background:transparent;overflow:hidden}
.j{position:absolute;left:60px;right:60px;opacity:0;text-align:center}
@keyframes ver{from,to{opacity:1}}@keyframes pop{from{opacity:0;transform:scale(.82) translateY(14px)}to{opacity:1;transform:none}}@keyframes surge{from{opacity:0;transform:scale(.5) rotate(-4deg)}to{opacity:1;transform:none}}
@keyframes acende{from,to{${ativa}}}
.leg{top:1270px;font:900 ${plano.legendaEstilo==='unica'?104:78}px/1.12 SinsaForte,Arial,sans-serif;text-transform:uppercase;color:#fff;-webkit-text-stroke:12px #000;paint-order:stroke fill;text-shadow:0 7px 0 #0005;letter-spacing:-1px}
.leg .w{display:inline-block;padding:2px 12px;margin:0 -6px;border-radius:14px}
.dest{top:1000px}.dest small{display:block;font:800 46px/1.1 SinsaForte,Arial,sans-serif;text-transform:uppercase;color:#fff;-webkit-text-stroke:8px #000;paint-order:stroke fill;margin-bottom:-6px}
.dest b{display:block;font:400 176px/1.15 SinsaScript,cursive;color:${cor};-webkit-text-stroke:5px #fff;paint-order:stroke fill;text-shadow:0 0 26px #fff9,0 10px 0 #0004;white-space:nowrap}
.card{top:250px}.card .pop{display:inline-block;max-width:900px;padding:22px 34px;border-radius:26px;background:#fff;color:#0b0b0f;font:900 60px/1.12 SinsaForte,Arial,sans-serif;box-shadow:0 14px 40px #0006;border-bottom:10px solid ${cor}}`;
  return {asset:{type:'html5',html:partes.join(''),css},start:0,length:+total.toFixed(3)};
}
export function timelineSinsa(plano, video, imagens=[]) {
  let t=0;
  const videos=plano.cortes.map(c=>{const clip={asset:{type:'video',src:video,trim:c.inicio,volume:1},start:+t.toFixed(3),length:+(c.fim-c.inicio).toFixed(3),fit:'crop',...(c.zoom?{scale:ZOOM_SINSA}:{}),...(plano.visual==='vibrante'?{filter:'boost'}:{}),...(c.transicao==='suave'?{transition:{in:'fadeFast'}}:{})};t+=c.fim-c.inicio;return clip;});
  // Imagem de apoio: cartão no alto (a pessoa segue falando embaixo), janela no canto ou tela cheia por um instante.
  const LAYOUT={topo:{fit:'contain',scale:0.58,position:'top',offset:{y:-0.07}},janela:{fit:'contain',scale:0.36,position:'topRight',offset:{x:-0.05,y:-0.09}},tela:{fit:'crop'}};
  const apoios=plano.apoios.map(a=>({asset:{type:'image',src:imagens.find(i=>i.id===a.banco)?.url},start:a.inicio,length:a.duracao,...(LAYOUT[a.layout]||LAYOUT.topo),transition:{in:a.layout==='tela'?'fadeFast':'slideDown',out:'fadeFast'}})).filter(a=>a.asset.src);
  const textos=camadaTextoSinsa(plano,t);
  const trilhas=[{clips:textos.asset.html?[textos]:[]},{clips:apoios},{clips:videos}].filter(x=>x.clips.length);
  return {timeline:{background:'#000000',tracks:trilhas},output:{format:'mp4',resolution:'1080',aspectRatio:'9:16',fps:30}};
}

import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
process.env.DATABASE_URL='pglite:memoria';
process.env.CHAVE_MESTRA=crypto.randomBytes(32).toString('base64');
process.env.GROQ_API_KEY='groq-somente-teste';process.env.SHOTSTACK_API_KEY='shotstack-somente-teste';
process.env.URL_PUBLICA='https://api.example.com';process.env.SINSA_ESPERA_MS='5';
const pasta=await fs.mkdtemp(path.join(os.tmpdir(),'sinsa-test-'));process.env.PASTA_ARQUIVOS=pasta;
const video=path.join(pasta,'original.mp4');
execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=180x320:r=15:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',video]);
const dados=await fs.readFile(video);
const {conectar,db,desconectar}=await import('../src/db.js');
const {criarApp}=await import('../src/app.js');
const {cifrar}=await import('../src/cripto.js');
const {processarSinsalabim,cotaSinsa}=await import('../src/sinsalabim.js');
const {limparPlanoSinsa,timelineSinsa,gruposLegendas,personalizarPlanoSinsa,camadaTextoSinsa}=await import('../src/sinsalabim-plano.js');
await conectar();const app=await criarApp();const originalFetch=globalThis.fetch;
let claudeFalhas=0,transcricoes=0,renders=0,analises=0,recusar=false,falhaRender=false,incerto=false;
const planoBase={titulo:'Um conteúdo que conecta',resumo:'Cortei a pausa e destaquei as palavras.',estilo:'dinamico',cor:'#ff5478',cortes:[{inicio:0,fim:1.9,zoom:true}],legendas:true,tituloTela:'Uma boa ideia',chamada:'Conheça a marca',legenda:'Conteúdo feito com cuidado.',hashtags:'#marca',apoios:[],avisos:[]};
globalThis.fetch=async(url,op={})=>{
 const u=String(url);
 if(u==='https://api.groq.com/openai/v1/audio/transcriptions'){
  transcricoes++;assert.equal(op.headers.Authorization,'Bearer groq-somente-teste');assert.equal(op.body.get('model'),'whisper-large-v3-turbo');
  return Response.json({text:'Olá mundo, vamos criar.',duration:2,words:[{word:'Olá',start:.1,end:.4},{word:'mundo',start:.5,end:.8},{word:'vamos',start:1,end:1.3},{word:'criar',start:1.4,end:1.8}]});
 }
 if(u==='https://api.anthropic.com/v1/messages'){
  if(claudeFalhas>0){claudeFalhas--;return Response.json({type:'error',error:{type:'overloaded_error',message:'Overloaded'}},{status:529});}
  analises++;const req=JSON.parse(op.body);assert(req.system.includes('Sinsalabim'));assert.equal(req.model,'claude-opus-5-5','usa o modelo padrão da plataforma');assert.equal(op.headers['x-api-key'] && op.headers['anthropic-version'],'2023-06-01');assert(req.max_tokens>=16000);const conteudo=req.messages[0].content;assert(conteudo.some(c=>c.type==='image'),'manda quadros do vídeo');assert(conteudo.some(c=>c.type==='text'&&c.text.includes('transcricao')),'manda a transcrição');return Response.json({content:[{type:'text',text:JSON.stringify(planoBase)}],usage:{input_tokens:300,output_tokens:200},stop_reason:'end_turn'});
 }
 if(/^https:\/\/api.shotstack.io\/edit\/(v1|stage)\/render$/.test(u)){
  renders++;globalThis.ultimoRender=JSON.parse(op.body);assert.equal(op.headers['x-api-key'],u.includes('/stage/')?'shotstack-sandbox-teste':'shotstack-somente-teste');const t=JSON.parse(op.body);assert.equal(t.output.aspectRatio,'9:16');assert(t.timeline.tracks.some(t=>t.clips.some(c=>c.asset.type==='html5')));
  if(incerto)throw new Error('timeout');if(recusar)return Response.json({message:'chave-secreta-nao-repetir'},{status:400});
  return Response.json({response:{id:'render-'+renders}});
 }
 if(/^https:\/\/api.shotstack.io\/edit\/(v1|stage)\/render\//.test(u)){assert.equal(op.headers['x-api-key'],u.includes('/stage/')?'shotstack-sandbox-teste':'shotstack-somente-teste');return Response.json({response:{status:falhaRender?'failed':'done',url:'https://render.shotstack.io/teste.mp4'}});}
 if(u==='https://render.shotstack.io/teste.mp4')return new Response(dados,{headers:{'content-type':'video/mp4'}});
 throw new Error('URL externa não autorizada no teste: '+u);
};
const api=async(body,token)=>{const r=await app.inject({method:'POST',url:'/api',payload:body,headers:token?{'x-pauta-token':token}:{}});return {status:r.statusCode,...r.json()};};
const esperar=async fn=>{for(let i=0;i<300;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw new Error('Tarefa de teste não terminou');};
const a=await api({acao:'cadastrar',nome:'Clara',email:'sinsa@example.com',senha:'senha-teste-123',organizacao:'Marca A'}),token=a.token,org=a.organizacao.id;
const b=await api({acao:'cadastrar',nome:'Outra pessoa',email:'outra@example.com',senha:'senha-teste-123',organizacao:'Marca B'});
await db().query("insert into integracoes(org_id,provedor,valor_cifrado) values($1,'anthropic',$2)",[org,cifrar('chave-mock-claude')]);
await db().query("insert into integracoes(org_id,provedor,valor_cifrado) values($1,'anthropic',$2)",[b.organizacao.id,cifrar('outra-chave-mock')]);
let banco,edicao;
after(async()=>{await esperar(async()=>!(await db().query("select 1 from tarefas where status in ('pendente','rodando')")).rows.length);globalThis.fetch=originalFetch;await app.close();await desconectar();await fs.rm(pasta,{recursive:true,force:true});});

test('plano recusa operações livres, limita duração, valida banco e escapa texto nas animações',()=>{
 const p=limparPlanoSinsa({...planoBase,cortes:[{inicio:-20,fim:90},{inicio:1,fim:3}],apoios:[{banco:'de-outra-org',inicio:0,duracao:1}],tituloTela:'<script>alert(1)</script>'},120,[],[]);
 assert.equal(p.duracao,60);assert.equal(p.apoios.length,0);const timeline=timelineSinsa(p,'https://api.example.com/f/a/b');assert(!JSON.stringify(timeline).includes('<script>'));assert(JSON.stringify(timeline).includes('&lt;script&gt;'));
 assert.throws(()=>limparPlanoSinsa({cortes:[]},2),/trechos válidos/);
});
test('upload real e análise com transcrição e imagens, isolados por organização',async()=>{
 banco=await api({acao:'enviarImagemBanco',tipo:'video/mp4',nome:'original.mp4',base64:dados.toString('base64'),descrever:false},token);assert.equal(banco.status,200);
 const pedido=crypto.randomUUID(),r=await api({acao:'criarSinsalabim',pedido,banco:banco.id,mensagem:'Corte as pausas e coloque legendas.'},token);assert.equal(r.status,200);edicao=r.id;
 assert.equal((await api({acao:'criarSinsalabim',pedido,banco:banco.id,mensagem:'Corte as pausas e coloque legendas.'},token)).id,edicao);
 await esperar(async()=>{const e=await api({acao:'obterSinsalabim',id:edicao},token);return e.edicao?.status==='pronto'&&e;});
 assert.equal(transcricoes,1);assert.equal(analises,1);
 const e=(await api({acao:'obterSinsalabim',id:edicao},token)).edicao;assert.equal(e.plano.palavras.length,4);assert.equal(e.versao,1);
 assert.equal((await api({acao:'obterSinsalabim',id:edicao},b.token)).status,404);
 assert.equal((await api({acao:'criarSinsalabim',pedido:crypto.randomUUID(),banco:banco.id,mensagem:'Quero editar este vídeo.'},b.token)).status,404);
 assert.equal((await api({acao:'listarSinsalabim'},b.token)).edicoes.length,0);assert.equal((await cotaSinsa(org)).usadas,0);
});
test('chat reaproveita transcrição e exige confirmação e versão da prévia para exportar',async()=>{
 assert.equal((await api({acao:'ajustarSinsalabim',id:edicao,mensagem:'Deixe o vídeo mais dinâmico.'},token)).status,200);
 await esperar(async()=>(await api({acao:'obterSinsalabim',id:edicao},token)).edicao?.versao===2);
 assert.equal(transcricoes,1);assert.equal(analises,2);
 assert.equal((await api({acao:'exportarSinsalabim',id:edicao,pedido:crypto.randomUUID(),versao:2},token)).status,400);
 assert.equal((await api({acao:'exportarSinsalabim',id:edicao,pedido:crypto.randomUUID(),versao:1,confirmado:true},token)).status,409);assert.equal(renders,0);
});
test('exportação é idempotente, persiste o MP4 no banco e envia para revisão sem publicar',async()=>{
 const pedido=crypto.randomUUID(),body={acao:'exportarSinsalabim',id:edicao,pedido,versao:2,confirmado:true};
 const [x,y]=await Promise.all([api(body,token),api(body,token)]);assert.equal(x.status,200);assert.equal(x.id,y.id);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[x.id])).rows[0].status==='renderizando');assert.equal(renders,1);
 await processarSinsalabim();const r=(await db().query('select * from sinsalabim_exportacoes where id=$1',[x.id])).rows[0];assert.equal(r.status,'feito');assert(r.arquivo_id);assert(r.banco_id);
 const repetida=await api({...body,pedido:crypto.randomUUID()},token);assert.equal(repetida.id,x.id);assert.equal(renders,1);assert.equal((await cotaSinsa(org)).usadas,1);
 const data=new Date(Date.now()+86400000).toISOString();const p=await api({acao:'revisarSinsalabim',exportacao:x.id,data},token);assert.equal(p.status,200);
 assert.equal((await api({acao:'revisarSinsalabim',exportacao:x.id,data},token)).id,p.id);
 const post=(await db().query('select * from posts where id=$1',[p.id])).rows[0];assert.equal(post.status,'EmRevisao');assert.equal(post.legenda,planoBase.legenda);assert.equal(post.artes_prontas,true);assert.equal(post.clipes['1'],r.arquivo_id);
 assert.equal((await db().query("select count(*)::int n from uso where org_id=$1 and tipo='post'",[org])).rows[0].n,1);
 assert.equal((await api({acao:'revisarSinsalabim',exportacao:x.id,data},b.token)).status,409);
 assert.equal((await api({acao:'removerImagemBanco',id:r.banco_id},token)).status,200);assert((await db().query('select id from arquivos where id=$1',[r.arquivo_id])).rows.length);
});
test('o limite mensal reserva no máximo cinco exportações sob concorrência',async()=>{
 const ids=[];for(let i=0;i<6;i++)ids.push((await db().query("insert into sinsalabim_edicoes(org_id,criado_por,pedido,arquivo_id,nome,status,plano,versao) select org_id,criado_por,$2,arquivo_id,'Outra edição','pronto',plano,1 from sinsalabim_edicoes where id=$1 returning id",[edicao,crypto.randomUUID()])).rows[0].id);
 const r=await Promise.all(ids.map(id=>api({acao:'exportarSinsalabim',id,pedido:crypto.randomUUID(),versao:1,confirmado:true},token)));
 assert.equal(r.filter(x=>x.status===200).length,4);assert.equal(r.filter(x=>x.status===402).length,2);assert.equal((await cotaSinsa(org)).usadas,5);
 await esperar(async()=>!(await db().query("select 1 from sinsalabim_exportacoes where status in ('pendente','enviando')")).rows.length);
 falhaRender=true;await processarSinsalabim();falhaRender=false;assert.equal((await cotaSinsa(org)).usadas,1);
});
test('rejeição definitiva libera a cota; envio incerto não é repetido automaticamente',async()=>{
 const id=(await db().query("select id from sinsalabim_edicoes where id<>$1 limit 1",[edicao])).rows[0].id;
 recusar=true;const x=await api({acao:'exportarSinsalabim',id,pedido:crypto.randomUUID(),versao:1,confirmado:true},token);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[x.id])).rows[0].status==='erro');recusar=false;assert.equal((await cotaSinsa(org)).usadas,1);
 incerto=true;const y=await api({acao:'exportarSinsalabim',id,pedido:crypto.randomUUID(),versao:1,confirmado:true},token);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[y.id])).rows[0].status==='incerto');incerto=false;
 assert.equal((await cotaSinsa(org)).usadas,2);assert(!(await db().query('select erro from sinsalabim_exportacoes where id=$1',[x.id])).rows[0].erro.includes('chave-secreta'));
});
test('sem chaves a opção informa indisponibilidade sem expor credenciais',async()=>{
 delete process.env.GROQ_API_KEY;
 const r=await api({acao:'listarSinsalabim'},token);assert.equal(r.configurado,false);assert(!JSON.stringify(r).includes('shotstack-somente-teste'));
 assert.equal((await api({acao:'criarSinsalabim',pedido:crypto.randomUUID(),banco:banco.id,mensagem:'Mais uma edição.'},token)).status,503);
 process.env.GROQ_API_KEY='groq-somente-teste';
});
test('retoma um envio interrompido sem fazer outra cobrança no provedor',async()=>{
 const {enfileirar}=await import('../src/tarefas/fila.js');
 const e=(await db().query('select * from sinsalabim_edicoes where id=$1',[edicao])).rows[0];
 const r=(await db().query("insert into sinsalabim_exportacoes(org_id,edicao_id,pedido,versao,plano,status) values($1,$2,$3,2,$4,'enviando') returning id",[org,e.id,crypto.randomUUID(),JSON.stringify(e.plano)])).rows[0];
 const antes=renders;await enfileirar(org,'sinsalabimExportar',{exportacao:r.id},a.usuario.id);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[r.id])).rows[0].status==='incerto');assert.equal(renders,antes);
});
test('uma exportação Sandbox mantém seu ambiente e não entra na revisão de produção',async()=>{
 await db().query("update sinsalabim_exportacoes set status='erro' where status='incerto'");
 process.env.SHOTSTACK_SANDBOX='sim';process.env.SHOTSTACK_SANDBOX_API_KEY='shotstack-sandbox-teste';
 const r=await api({acao:'exportarSinsalabim',id:edicao,pedido:crypto.randomUUID(),versao:2,confirmado:true},token);assert.equal(r.status,200);
 await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[r.id])).rows[0].status==='renderizando');
 process.env.SHOTSTACK_SANDBOX='nao';await processarSinsalabim();
 const e=(await db().query('select * from sinsalabim_exportacoes where id=$1',[r.id])).rows[0];assert.equal(e.status,'feito');assert.equal(e.ambiente,'stage');
 assert.equal((await api({acao:'revisarSinsalabim',exportacao:r.id,data:new Date(Date.now()+86400000).toISOString()},token)).status,400);
});

test('edição estilo Captions: tira pausas, zoom fixo alternado, legenda curta e destaque cursivo', () => {
  // Fala com uma pausa longa (1.4 a 4.1 s) no meio do primeiro trecho.
  const palavras = [{texto:'O',inicio:0.1,fim:0.2},{texto:'carvão',inicio:0.3,fim:0.8},{texto:'mancha',inicio:1.0,fim:1.4},{texto:'o',inicio:4.1,fim:4.2},{texto:'esmalte.',inicio:4.3,fim:4.8},{texto:'Viu',inicio:5.6,fim:5.9},{texto:'só?',inicio:6.0,fim:6.3},{texto:'Faz',inicio:7.5,fim:7.8},{texto:'diferença',inicio:7.9,fim:8.5}];
  const banco = [{id:'img-1',url:'https://api.example.com/f/1/k'}];
  const p = limparPlanoSinsa({...planoBase, visual:'vibrante', legendaEstilo:'palavra',
    cortes:[{inicio:0,fim:5,transicao:'zoom'},{inicio:5.5,fim:9,transicao:'deslizar'}],
    destaques:[{indice:1,texto:'Carvão',apoio:'não clareia'},{indice:2},{indice:4},{indice:99}],
    apoios:[{banco:'img-1',inicio:0.2,duracao:2,layout:'girar'},{banco:'img-1',inicio:2.5,duracao:3,layout:'tela'},{banco:'de-fora',inicio:0,duracao:1}]}, 9, banco, palavras);
  // A pausa vira um salto: 0 a 1.58 e 3.98 a 5 (zoom alternado); "deslizar" antigo vira entrada suave.
  assert.deepEqual(p.cortes.map(c=>[c.inicio,c.fim,c.zoom,c.transicao]), [[0,1.58,true,'corte'],[3.98,5,false,'corte'],[5.5,6.48,false,'suave'],[7.38,9,true,'corte']]);
  assert.equal(p.legendaEstilo,'captions','estilo desconhecido ou antigo vira o padrão');
  assert.deepEqual(p.apoios.map(a=>[a.layout,a.duracao]), [['topo',2],['tela',1.5]], 'tela cheia no máximo 1,5 s');
  assert.deepEqual(p.destaques.map(d=>d.texto), ['Carvão','esmalte'], '"mancha" encosta no destaque anterior e cai');
  const grupos = gruposLegendas(p).map(g=>g.map(w=>w.texto).join(' '));
  assert(grupos.every(g=>g.split(' ').length<=3)); assert(grupos.includes('Viu só?'));
  const t = timelineSinsa(p,'https://api.example.com/f/v/k',banco), trilhas = t.timeline.tracks.flatMap(x=>x.clips), json = JSON.stringify(t);
  const videos = trilhas.filter(c=>c.asset.type==='video');
  assert(videos.every(c=>c.filter==='boost' && !c.effect), 'cor viva e nada de zoom lento');
  assert.deepEqual(videos.map(c=>c.scale||1), [1.12,1,1,1.12]);
  assert.equal(videos[2].transition.in, 'fadeFast'); assert.equal(videos[0].transition, undefined);
  const texto = trilhas.filter(c=>c.asset.type==='html5');
  assert.equal(texto.length, 1, 'legendas, destaques e chamadas numa camada só');
  assert.equal(texto[0].start, 0); assert.equal(texto[0].length, p.duracao);
  assert(texto[0].asset.css.includes('data:font/woff2;base64,'), 'fontes embutidas');
  assert(json.includes('Carv') && json.includes('class=\\"j dest\\"') && json.includes('não clareia'));
  const topo = trilhas.find(c=>c.asset.type==='image'); assert.equal(topo.position,'top'); assert.equal(topo.fit,'contain');
  // Enquanto o destaque aparece, nenhum bloco de legenda é mostrado.
  const blocos = [...texto[0].asset.html.matchAll(/class="j leg" style="animation:ver ([\d.]+)s linear ([\d.]+)s/g)].map(m=>[+m[2],+m[2]+ +m[1]]);
  assert(blocos.length && blocos.every(([a,b]) => !p.destaques.some(d => a < d.inicio + d.duracao && b > d.inicio)));
});

test('vários vídeos viram uma sequência na ordem, com as partes marcadas para a edição', async () => {
  const v1 = await api({acao:'enviarImagemBanco',tipo:'video/mp4',nome:'parte-1.mp4',titulo:'Abertura',base64:dados.toString('base64'),descrever:false},token);
  const v2 = await api({acao:'enviarImagemBanco',tipo:'video/mp4',nome:'parte-2.mp4',titulo:'Produto',base64:dados.toString('base64'),descrever:false},token);
  assert.equal((await api({acao:'criarSinsalabim',pedido:crypto.randomUUID(),bancos:[v1.id,v1.id],mensagem:'Junte os vídeos numa sequência.'},token)).status,400,'vídeo repetido');
  const r = await api({acao:'criarSinsalabim',pedido:crypto.randomUUID(),bancos:[v1.id,v2.id],mensagem:'Junte os vídeos numa sequência.'},token);
  assert.equal(r.status,200,r.erro);
  let ultimo;const e = (await esperar(async()=>{const x=await api({acao:'obterSinsalabim',id:r.id},token);ultimo=x;return ['pronto','erro'].includes(x.edicao?.status)&&x;}).catch(err=>{console.log('ULTIMO',r.status,r.erro,JSON.stringify(ultimo).slice(0,300));throw err;})).edicao;
  assert.equal(e.status,'pronto',e.erro||'');
  assert.equal(e.partes.length,2); assert.deepEqual(e.partes.map(p=>p.nome),['Abertura','Produto']);
  assert.equal(e.partes[0].inicio,0); assert(Math.abs(e.partes[1].inicio-e.partes[0].fim)<0.01,'a segunda parte começa onde a primeira termina');
  const original=(await db().query("select arquivo_id from banco_imagens where id=$1",[v1.id])).rows[0].arquivo_id;
  const linha=(await db().query("select e.arquivo_id, e.duracao, a.tipo from sinsalabim_edicoes e join arquivos a on a.id=e.arquivo_id where e.id=$1",[r.id])).rows[0];
  assert.notEqual(linha.arquivo_id,original,'a edição usa o vídeo já unido'); assert.equal(linha.tipo,'video/mp4');
  assert(Math.abs(Number(linha.duracao)-e.partes[1].fim)<0.2,'duração da sequência inteira');
  assert.equal(e.etapa,'planejando');
  const outra = await api({acao:'criarSinsalabim',pedido:crypto.randomUUID(),bancos:[v1.id,v2.id],mensagem:'Quero editar estes vídeos.'},b.token);
  assert.equal(outra.status,404,'outra organização não usa os vídeos');
});

test('análise tenta de novo quando o Claude está sobrecarregado e mostra a etapa quando falha de vez',async()=>{
 const criar=async()=>{const r=await api({acao:'criarSinsalabim',pedido:crypto.randomUUID(),banco:banco.id,mensagem:'Corte as pausas.'},token);assert.equal(r.status,200);return (await esperar(async()=>{const x=await api({acao:'obterSinsalabim',id:r.id},token);return ['pronto','erro'].includes(x.edicao?.status)&&x;})).edicao;};
 claudeFalhas=1;const ok=await criar();assert.equal(ok.status,'pronto',ok.erro||'');assert.equal(claudeFalhas,0);
 claudeFalhas=2;const ruim=await criar();assert.equal(ruim.status,'erro');
 assert.match(ruim.erro,/A IA não conseguiu montar a edição agora\. Motivo: falha na API do Claude: Overloaded\./);
});

test('personalização à mão: fontes, posição, destaques e imagens com fade, só com o que é válido', () => {
  const palavras = [{texto:'Olha',inicio:0.1,fim:0.4},{texto:'esse',inicio:0.5,fim:0.8},{texto:'produto',inicio:0.9,fim:1.4},{texto:'que',inicio:1.5,fim:1.7},{texto:'muda',inicio:1.8,fim:2.1},{texto:'tudo',inicio:2.2,fim:2.6}];
  const banco = [{id:'img-1',url:'https://api.example.com/f/1/k'},{id:'img-2',url:'https://api.example.com/f/2/k'}];
  const base = limparPlanoSinsa({...planoBase,tirarPausas:false,cortes:[{inicio:0,fim:8}],destaques:[{indice:2},{indice:5}]}, 8, banco, palavras);
  assert.equal(base.fonteLegenda,'forte'); assert.equal(base.fonteDestaque,'cursiva'); assert.equal(base.destaques.length,2);
  const p = personalizarPlanoSinsa(base, {fonteLegenda:'condensada',fonteDestaque:'elegante',posicaoLegenda:'alto',tamanhoLegenda:'g',cor:'#22c55e',legendaEstilo:'pilula',tituloTela:'  Novo título  ',
    destaques:[{indice:1,texto:'Tudo!',apoio:'muda'},{indice:1,texto:'repetido'},{indice:7,texto:'não existe'}],
    apoios:[{banco:'img-2',inicio:3,duracao:2.5,layout:'janela'},{banco:'img-1',inicio:0.5,duracao:1.5,layout:'tela'},{banco:'img-1',inicio:3.5,duracao:1},{banco:'de-fora',inicio:6,duracao:1}]}, banco);
  assert.deepEqual([p.fonteLegenda,p.fonteDestaque,p.posicaoLegenda,p.tamanhoLegenda,p.cor,p.legendaEstilo,p.tituloTela],['condensada','elegante','alto','g','#22c55e','pilula','Novo título']);
  assert.deepEqual(p.destaques.map(d=>[d.texto,d.apoio,d.inicio]), [['Tudo!','muda',base.destaques[1].inicio]], 'tira o primeiro, edita o segundo e mantém o momento da fala');
  assert.deepEqual(p.apoios.map(a=>[a.banco,a.inicio,a.layout]), [['img-1',0.5,'tela'],['img-2',3,'janela']], 'imagem sobreposta e de fora da organização saem');
  assert.deepEqual(p.cortes, base.cortes); assert.deepEqual(p.palavras, base.palavras);
  const ignorado = personalizarPlanoSinsa(p, {fonteLegenda:'comic-sans',cor:'vermelho',legendaEstilo:'neon'}, banco);
  assert.deepEqual([ignorado.fonteLegenda,ignorado.cor,ignorado.legendaEstilo],['condensada','#22c55e','pilula']);
  const t = timelineSinsa(p,'https://api.example.com/f/v/k',banco), clips = t.timeline.tracks.flatMap(x=>x.clips), css = clips.find(c=>c.asset.type==='html5').asset.css;
  assert(css.includes('font-family:SinsaCondensada') && css.includes('font-family:SinsaElegante') && !css.includes('font-family:SinsaScript'), 'embute só as fontes usadas');
  assert(css.includes('.leg{top:560px'));
  const imgs = clips.filter(c=>c.asset.type==='image');
  assert.deepEqual(imgs.map(c=>c.transition), [{in:'fadeFast',out:'fadeFast'},{in:'fade',out:'fade'}], 'imagens entram e saem com fade');
});
test('personalizar pela API gera nova versão, confere a versão e respeita a organização', async () => {
  const e = (await api({acao:'obterSinsalabim',id:edicao},token)).edicao;assert.equal(e.status,'pronto');
  const ok = await api({acao:'personalizarSinsalabim',id:e.id,versao:e.versao,mudancas:{fonteLegenda:'redonda',cor:'#123abc'}},token);
  assert.equal(ok.status,200,ok.erro); assert.equal(ok.edicao.versao,e.versao+1); assert.equal(ok.edicao.plano.fonteLegenda,'redonda'); assert.equal(ok.edicao.plano.cor,'#123abc');
  assert.equal((await api({acao:'personalizarSinsalabim',id:e.id,versao:e.versao,mudancas:{cor:'#000000'}},token)).status,409,'versão antiga não sobrescreve');
  assert.equal((await api({acao:'personalizarSinsalabim',id:e.id,versao:ok.edicao.versao,mudancas:{}},b.token)).status,404);
});

test('fundo e luz: troca o fundo no servidor, bloqueia exportar enquanto processa e usa o vídeo tratado no render', async () => {
  let e = (await api({acao:'obterSinsalabim',id:edicao},token)).edicao;
  const original = e.arquivo.url;
  assert.equal((await api({acao:'personalizarSinsalabim',id:e.id,versao:e.versao,mudancas:{fundo:{tipo:'imagem',banco:'nao-existe'}}},token)).status,400);
  const r = await api({acao:'personalizarSinsalabim',id:e.id,versao:e.versao,mudancas:{fundo:{tipo:'desfoque'},luz:{brilho:20,temperatura:30,vinheta:true,contraste:999}}},token);
  assert.equal(r.status,200,r.erro); assert.equal(r.edicao.fundo.status,'processando'); assert.equal(r.edicao.fundo.pedido,undefined,'o pedido interno não vai ao navegador');
  assert.deepEqual(r.edicao.plano.luz,{brilho:20,contraste:50,saturacao:0,temperatura:30,vinheta:true});
  assert.equal((await api({acao:'exportarSinsalabim',id:e.id,versao:r.edicao.versao,pedido:crypto.randomUUID(),confirmado:true},token)).status,409,'espera o fundo');
  e = (await esperar(async()=>{const x=await api({acao:'obterSinsalabim',id:edicao},token);return ['pronto','erro'].includes(x.edicao?.fundo?.status)&&x;})).edicao;
  assert.equal(e.fundo.status,'pronto',e.fundo.erro||''); assert.match(e.fundo.arquivo.url,/\/f\//); assert.notEqual(e.fundo.arquivo.url,original);
  await db().query('delete from sinsalabim_exportacoes where org_id=$1',[org]);
  const x = await api({acao:'exportarSinsalabim',id:e.id,versao:e.versao,pedido:crypto.randomUUID(),confirmado:true},token);
  assert.equal(x.status,200,x.erro);
  await esperar(async()=>(await db().query('select status from sinsalabim_exportacoes where id=$1',[x.id])).rows[0].status!=='pendente'&&(await db().query('select status from sinsalabim_exportacoes where id=$1',[x.id])).rows[0].status!=='enviando');
  const fonte = globalThis.ultimoRender.timeline.tracks.at(-1).clips[0].asset.src;
  assert.notEqual(fonte,original,'o render usa o vídeo com fundo e luz'); assert.notEqual(fonte,e.fundo.arquivo.url,'com luz ajustada, sai uma cópia corrigida');
  // Voltar ao original não cria tarefa e libera o cenário gravado.
  await db().query("update sinsalabim_exportacoes set status='erro' where org_id=$1 and status in ('renderizando','salvando')",[org]);
  const v = (await api({acao:'obterSinsalabim',id:edicao},token)).edicao;
  const o = await api({acao:'personalizarSinsalabim',id:v.id,versao:v.versao,mudancas:{fundo:{tipo:'original'}}},token);
  assert.equal(o.edicao.fundo.tipo,'original'); assert.equal(o.edicao.fundo.arquivo,null);
});
test('renomear o projeto de vídeo', async () => {
  const r = await api({acao:'renomearSinsalabim',id:edicao,nome:'  Campanha de outubro  '},token);
  assert.equal(r.status,200); assert.equal(r.nome,'Campanha de outubro');
  assert.equal((await api({acao:'listarSinsalabim'},token)).edicoes.find(x=>x.id===edicao).nome,'Campanha de outubro');
  assert.equal((await api({acao:'renomearSinsalabim',id:edicao,nome:''},token)).status,400);
  assert.equal((await api({acao:'renomearSinsalabim',id:edicao,nome:'Outro'},b.token)).status,404);
});

test('editor: cortes aparados e divididos refazem a legenda e levam os textos ligados à fala', () => {
  const palavras = [{texto:'Um',inicio:0.2,fim:0.5},{texto:'dois',inicio:0.6,fim:0.9},{texto:'três',inicio:2.2,fim:2.6},{texto:'quatro',inicio:4.1,fim:4.6}];
  const base = limparPlanoSinsa({...planoBase,tirarPausas:false,cortes:[{inicio:0,fim:5}],destaques:[{indice:3,texto:'Quatro',animacao:'caixa',cor:'#ffe14a'}]}, 5, [], palavras);
  assert.equal(base.destaques[0].falaEm, 4.1); assert.equal(base.destaques[0].animacao, 'caixa');
  // Tira o trecho do meio (1 a 4 s): "três" some da legenda e o destaque de "quatro" anda para trás.
  const p = personalizarPlanoSinsa(base, {cortes:[{inicio:0,fim:1},{inicio:4,fim:5,transicao:'suave'},{inicio:0.5,fim:0.6}]}, [], {palavras, duracaoFonte:5});
  assert.deepEqual(p.cortes.map(c=>[c.inicio,c.fim,c.transicao]), [[0,1,'corte'],[4,5,'suave']], 'sobreposto sai');
  assert.equal(p.duracao, 2); assert.deepEqual(p.palavras.map(w=>w.texto), ['Um','dois','quatro']);
  assert.equal(p.destaques.length, 1); assert(Math.abs(p.destaques[0].inicio - 1.05) < 0.06, String(p.destaques[0].inicio));
  // Cortar a fala do destaque tira o destaque; sem nenhum trecho, é erro.
  assert.equal(personalizarPlanoSinsa(base, {cortes:[{inicio:0,fim:2}]}, [], {palavras, duracaoFonte:5}).destaques.length, 0);
  assert.throws(() => personalizarPlanoSinsa(base, {cortes:[]}, [], {palavras, duracaoFonte:5}), /pelo menos um trecho/);
});
test('editor: textos livres, cards, animações, imagens que pulam, música e efeitos sonoros', () => {
  const palavras = [{texto:'Olha',inicio:0.1,fim:0.4},{texto:'isso',inicio:0.5,fim:0.9}];
  const banco = [{id:'img-1',url:'https://api.example.com/f/1/k'}], musicas = [{id:'mus-1',nome:'Trilha',url:'https://api.example.com/f/m/k'}];
  const base = limparPlanoSinsa({...planoBase,tirarPausas:false,cortes:[{inicio:0,fim:10}]}, 10, banco, palavras);
  const p = personalizarPlanoSinsa(base, {
    animLegenda:'digitar', sfx:true, voz:80, musica:{banco:'mus-1',volume:30,inicio:12},
    destaques:[{texto:'EDIT',inicio:2,duracao:1.2,animacao:'caixa',cor:'#FFE14A',y:420,tamanho:1.3},{texto:'Livre',inicio:5,animacao:'digitar',fonte:'forte'},{texto:'',inicio:1}],
    cards:[{tipo:'numero',texto:'92%',sub:'voltam a comprar',inicio:3,duracao:2},{tipo:'selo',texto:'com',sub:'motion',inicio:7,animacao:'deslizar'},{tipo:'emoji',texto:'x',inicio:1}],
    apoios:[{banco:'img-1',inicio:6,duracao:2,layout:'topo',animacao:'pop',inclinar:true}],
  }, banco, {palavras, duracaoFonte:10, musicas});
  assert.equal(p.animLegenda,'digitar'); assert.equal(p.destaques.length,2); assert.equal(p.destaques[0].y,420); assert.equal(p.cards.length,2);
  assert.equal(personalizarPlanoSinsa(p,{musica:{banco:'de-fora'}},banco,{musicas}).musica,null,'música de fora do banco não entra');
  const t = timelineSinsa(p,'https://api.example.com/f/v/k',banco,{musicas,sfxBase:'https://api.example.com/sfx'}), clips = t.timeline.tracks.flatMap(x=>x.clips);
  const html = clips.find(c=>c.asset.type==='html5').asset;
  assert(html.html.includes('card-n') && html.html.includes('92%') && html.html.includes('card-s') && html.html.includes('<em>motion</em>'));
  assert(html.html.includes('animation:caixa') && html.html.includes('animation:digita') && html.html.includes('mostra .08s'));
  assert(html.css.includes('font-family:SinsaForte'));
  const img = clips.find(c=>c.asset.type==='image'); assert.deepEqual(img.transition,{in:'zoom',out:'fadeFast'}); assert.equal(img.transform.rotate.angle,-4);
  assert.equal(clips.find(c=>c.asset.type==='video').asset.volume,0.8);
  const audios = clips.filter(c=>c.asset.type==='audio');
  const trilha = audios.find(a=>a.asset.src.includes('/f/m/')); assert.equal(trilha.asset.volume,0.3); assert.equal(trilha.asset.trim,12); assert.equal(trilha.length,p.duracao);
  assert.equal(audios.filter(a=>a.asset.src.endsWith('/whoosh.mp3')).length,4,'whoosh nos 2 textos e 2 cards'); assert.equal(audios.filter(a=>a.asset.src.endsWith('/pop.mp3')).length,1);
});
test('efeitos sonoros servidos pela API e música aceita no banco', async () => {
  const r = await app.inject({method:'GET',url:'/sfx/whoosh.mp3'}); assert.equal(r.statusCode,200); assert.equal(r.headers['content-type'],'audio/mpeg'); assert(r.rawPayload.length>1000);
  assert.equal((await app.inject({method:'GET',url:'/sfx/../app.js'})).statusCode,404);
  const mp3 = (await app.inject({method:'GET',url:'/sfx/pop.mp3'})).rawPayload.toString('base64');
  const m = await api({acao:'enviarImagemBanco',tipo:'audio/mpeg',base64:mp3,nome:'trilha.mp3',titulo:'Trilha calma'},token);
  assert.equal(m.status,200,m.erro);
  const e = (await api({acao:'obterSinsalabim',id:edicao},token)).edicao;
  assert(e.musicas.some(x=>x.id===m.id&&x.nome==='Trilha calma')); assert(!e.apoios.some(x=>x.id===m.id),'música não aparece como imagem');
});

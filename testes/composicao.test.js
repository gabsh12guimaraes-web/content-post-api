import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.DATABASE_URL="pglite:memoria";
process.env.CHAVE_MESTRA=crypto.randomBytes(32).toString("base64");
process.env.PASTA_ARQUIVOS=fs.mkdtempSync(path.join(os.tmpdir(),"pauta-tipografia-"));
process.env.URL_PUBLICA="http://teste.local";
const {conectar,db,desconectar}=await import("../src/db.js");
const {criarApp}=await import("../src/app.js");
const {prepararComposicoes}=await import("../src/blocos-texto.js");
await import("../src/tarefas/trabalhos.js");
let app,a,b,post,fonte;
const chamar=async(payload,token=a?.token)=>{const r=await app.inject({method:"POST",url:"/api",payload,headers:token?{"x-pauta-token":token}:{}});return {status:r.statusCode,...r.json()};};
const arquivo=ext=>fs.readFileSync(new URL('./fixtures/fonte-teste.'+ext,import.meta.url)).toString('base64');
before(async()=>{await conectar();app=await criarApp();a=await chamar({acao:'cadastrar',nome:'Ana',email:'a@fontes.test',senha:'segredo123',organizacao:'Marca A'});b=await chamar({acao:'cadastrar',nome:'Bia',email:'b@fontes.test',senha:'segredo123',organizacao:'Marca B'});post=(await db().query("insert into posts (org_id,titulo,data_publicacao,formato,status,slides,artes_prontas) values ($1,'Post',now()+interval '1 day','Carrossel','EmRevisao',$2,true) returning id",[a.organizacao.id,JSON.stringify([{n:1,titulo:'Antes',texto:'Texto',prompt_imagem:'Keep this',usa_imagem:true},{n:2,titulo:'Segundo',texto:'Apoio'}])])).rows[0].id;});
after(async()=>{await app.close();await desconectar();fs.rmSync(process.env.PASTA_ARQUIVOS,{recursive:true,force:true});});
test('fontes reais TTF, OTF, WOFF e WOFF2 são validadas, guardadas e entregues com MIME correto',async()=>{
 for(const ext of ['ttf','otf','woff','woff2']){
  const r=await chamar({acao:'enviarFonteMarca',nome:'Minha fonte '+ext,base64:arquivo(ext)});assert.equal(r.status,200);if(ext==='ttf')fonte=r.id;
  const f=r.tipografias.find(f=>f.id===r.id);assert.equal(f.familia,'CP Test');assert.equal(f.peso,400);assert.match(f.arquivo.url,/\/f\//);
  const binary=await app.inject({method:'GET',url:new URL(f.arquivo.url).pathname});assert.equal(binary.statusCode,200);assert.equal(binary.headers['content-type'],'font/'+ext);assert.deepEqual(binary.rawPayload,Buffer.from(arquivo(ext),'base64'));assert.equal(binary.headers['access-control-allow-origin'],'*');
 }
 assert.equal((await chamar({acao:'listar'},b.token)).tipografias.length,0);
});
test('reenvio simultâneo não duplica fonte; arquivos inválidos e grandes são recusados',async()=>{
 assert.equal((await chamar({acao:'enviarFonteMarca',organizacao:b.organizacao.id,base64:arquivo('ttf')})).status,409);
 const antes=(await db().query('select count(*)::int n from arquivos where org_id=$1',[a.organizacao.id])).rows[0].n;
 const [x,y]=await Promise.all([chamar({acao:'enviarFonteMarca',base64:arquivo('ttf')}),chamar({acao:'enviarFonteMarca',base64:arquivo('ttf')})]);assert.equal(x.id,fonte);assert.equal(y.id,fonte);
 assert.equal((await db().query('select count(*)::int n from arquivos where org_id=$1',[a.organizacao.id])).rows[0].n,antes);
 for(const dados of [Buffer.from('<svg>bad</svg>'),Buffer.from('wOF2'+'x'.repeat(100)),Buffer.alloc(5*1024*1024+1)])assert.equal((await chamar({acao:'enviarFonteMarca',base64:dados.toString('base64')})).status,400);
});
test('a fonte funciona na diagramação geral, por slide e nos modelos; outra organização não pode usá-la',async()=>{
 const d={modelo:'foto',fonte:'marca-'+fonte,slides:{2:{fonte:'marca-'+fonte}}};
 assert.equal((await chamar({acao:'salvarDiagramacao',id:post,diagramacao:d})).status,200);
 const p=(await db().query('select * from posts where id=$1',[post])).rows[0];assert.equal(p.diagramacao.fonte,d.fonte);assert.equal(p.diagramacao.slides[2].fonte,d.fonte);assert.equal(p.artes_prontas,false);
 assert.equal((await chamar({acao:'salvarModeloMarca',nome:'Modelo próprio',diagramacao:d})).status,200);
 assert.equal((await chamar({acao:'salvarModeloMarca',nome:'Fonte de outra marca',diagramacao:d},b.token)).status,404);
 const outro=(await db().query("insert into posts (org_id,titulo,data_publicacao,formato,status) values ($1,'Outro',now()+interval '1 day','Estatico','EmRevisao') returning id",[b.organizacao.id])).rows[0].id;
 assert.equal((await chamar({acao:'salvarDiagramacao',id:outro,diagramacao:d},b.token)).status,404);
});
test('vários destaques persistem nos slides e conteúdo, preservando prompts, invalidando artes e isolando organizações',async()=>{
 const blocos=[{texto:'Primeira frase',tipo:'destaque',x:7,y:20,largura:86,altura:20},{texto:'Segunda frase',tipo:'destaque',x:7,y:48,largura:86,altura:20,cor:'destaque'},{texto:'Detalhe',tipo:'selo',y:75,caixa:true}];
 const r=await chamar({acao:'salvarTextos',id:post,slides:[{n:1,titulo:'Resumo',texto:'Apoio',blocos},{n:2,titulo:'Segundo',texto:'Apoio'}],legenda:'Legenda',hashtags:'#marca'});assert.equal(r.status,200);
 const p=(await db().query('select * from posts where id=$1',[post])).rows[0];assert.equal(p.slides[0].blocos.length,3);assert.equal(p.slides[0].blocos[1].tipo,'destaque');assert.equal(p.slides[0].prompt_imagem,'Keep this');assert.deepEqual(p.conteudo.slides,p.slides);assert.equal(p.artes_prontas,false);
 assert.equal((await chamar({acao:'salvarTextos',id:post,slides:[{n:1,blocos}]},b.token)).status,404);
 assert.equal((await chamar({acao:'salvarTextos',id:post,slides:[{n:1,blocos:Array(9).fill(blocos[0])}]})).status,400);
 const legado=await chamar({acao:'salvarTextos',id:post,slides:[{n:1,titulo:'Resumo editado',texto:'Apoio'}]});assert.equal(legado.status,200);assert.equal((await db().query('select slides from posts where id=$1',[post])).rows[0].slides[0].blocos.length,3);
});
test('composições sugeridas pela IA têm coordenadas limitadas e estilos conhecidos',()=>{
 const c=prepararComposicoes({slides:[{blocos:[{texto:'Oi',x:500,y:-50,largura:900,altura:300,tamanho:10,tipo:'script',cor:'red',caixa:'true'}]}],cenas:[{blocos:[{texto:'Vídeo',tipo:'destaque'}]}]});
 const b=c.slides[0].blocos[0];assert.equal(b.x,80);assert.equal(b.y,8);assert.equal(b.largura,15);assert.equal(b.altura,86);assert.equal(b.tamanho,1.6);assert.equal(b.tipo,'destaque');assert.equal(b.cor,'texto');assert.equal(b.caixa,false);assert.equal(c.cenas[0].blocos[0].texto,'Vídeo');
});
test('criação e ajuste por IA mantêm múltiplos destaques no fluxo real de posts',async()=>{
 const original=globalThis.fetch;let system='';
 const blocos=[{texto:'Uma frase forte',tipo:'destaque',x:7,y:20,largura:86,altura:20},{texto:'Outra frase forte',tipo:'destaque',x:7,y:50,largura:86,altura:20}];
 const conteudo={legenda:'Legenda da marca',hashtags:['#marca'],slides:[{n:1,titulo:'Resumo',texto:'Apoio',usa_imagem:false,blocos},{n:2,titulo:'Segundo',texto:'Apoio',usa_imagem:false,blocos:[{...blocos[0],texto:'Preservar este bloco'}]}],cenas:[],prompts_imagem:[],alterou_imagens:[],alterou_slides:[1]};
 globalThis.fetch=async(url,op)=>{assert.match(String(url),/api.anthropic.com/);system=JSON.parse(op.body).system;return Response.json({content:[{type:'text',text:JSON.stringify(conteudo)}],stop_reason:'end_turn'});};
 const esperar=async id=>{for(let n=0;n<250;n++){const p=(await db().query('select * from posts where id=$1',[id])).rows[0];if(!['EmCriacao','Ajustes'].includes(p.status)&&(await db().query("select 1 from tarefas where org_id=$1 and status in ('pendente','rodando')",[a.organizacao.id])).rows.length===0)return p;await new Promise(r=>setTimeout(r,20));}throw new Error('A IA não terminou');};
 try{
  await chamar({acao:'salvarIntegracao',provedor:'anthropic',valor:'sk-font-test'});
  const id=(await db().query("insert into posts (org_id,titulo,data_publicacao,formato,status) values ($1,'Criação',now()+interval '1 day','Carrossel','Planejado') returning id",[a.organizacao.id])).rows[0].id;
  assert.equal((await chamar({acao:'criarPost',id})).status,200);let p=await esperar(id);assert.equal(p.status,'EmRevisao');assert.equal(p.slides[0].blocos.length,2);assert.match(system,/Composição livre/);
  const segundo=p.slides[1];conteudo.slides[0].blocos[1].texto='Outra frase revisada';conteudo.slides[1].blocos[0].texto='Esta mudança não deve passar';
  assert.equal((await chamar({acao:'ajustarPost',id,slide:1,comentario:'Mude só a segunda frase do primeiro slide'})).status,200);p=await esperar(id);assert.equal(p.slides[0].blocos[1].texto,'Outra frase revisada');assert.deepEqual(p.slides[1],segundo);assert.match(system,/Preserve os "blocos"/);
 }finally{globalThis.fetch=original;}
});

import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.DATABASE_URL = "pglite:memoria";
process.env.CHAVE_MESTRA = crypto.randomBytes(32).toString("base64");
process.env.NASTEN_WEBHOOK_SECRET = crypto.randomBytes(64).toString("hex");
process.env.NASTEN_PUBLIC_KEY = "teste-publica";
process.env.NASTEN_SECRET_KEY = "teste-secreta";
process.env.PAGAMENTOS_PROVEDOR = "nasten";
const { conectar, db, desconectar } = await import("../src/db.js");
const { criarApp } = await import("../src/app.js");
const { assinaturaNastenOk, processarEventosNasten, reconciliarNasten, fimDoCiclo, consultarNasten } = await import("../src/nasten.js");
const { OFERTAS_NASTEN } = await import("../src/ofertas.js");
const { catalogo } = await import("../src/planos.js");
const original = globalThis.fetch, vendas = new Map();
let app, n=0, auths=0, negarToken=false, indisponivel=false, lista=[];
const api = async (payload, token) => (await app.inject({method:"POST",url:"/api",payload,headers:token?{"x-pauta-token":token}:{}})).json();
const cadastrar = async () => { const email=`pessoa-${++n}@nasten.test`; return {...await api({acao:"cadastrar",nome:"Pessoa",email,senha:"segredo123",organizacao:"Marca "+n}),email}; };
const org = async u => (await db().query("select * from organizacoes where id=$1",[u.organizacao.id])).rows[0];
function venda(u, chave="essencial:mensal", extra={}) {
  const [plano,ciclo]=chave.split(":"), id="cvenda"+crypto.randomBytes(12).toString("hex");
  const v={id,companyId:"cmvh9snyi000m01jdkus2qxv5",saleType:"producer",amount:17712,netAmount:17000,status:"paid",aprovedAt:new Date().toISOString(),createdAt:new Date().toISOString(),customer:{emails:[{email:u.email}]},trackingParameters:{sck:u.organizacao.id},...extra};
  vendas.set(id,v);
  return {id:crypto.randomUUID(),scope:"user",type:"transaction",event:"transaction_paid",transaction:{id,sandbox:false},product:{id:OFERTAS_NASTEN[chave].produto},sale:{mainOfferId:OFERTAS_NASTEN[chave].id},customer:{email:u.email},plano,ciclo};
}
async function aviso(c, op={}) {
  const bruto=JSON.stringify(c),t=String(Date.now()),h=crypto.createHmac("sha256",process.env.NASTEN_WEBHOOK_SECRET).update(t+"."+bruto).digest("hex");
  return app.inject({method:"POST",url:"/nasten",payload:bruto,headers:{"content-type":"application/json","signature-hmac":`t=${t},v1=${h}`,...op.headers}});
}
async function esperar(c, feito=true) {
  for(let i=0;i<300;i++){
    await processarEventosNasten();
    const t=(await db().query("select * from nasten_eventos where id=$1",[c.id])).rows[0];
    if(t && (feito?t.status==="feito":t.status==="pendente"&&t.tentativas>0))return t;
    await new Promise(r=>setTimeout(r,5));
  }
  throw new Error("Evento não processado: "+c.id);
}
async function tentar(c){await db().query("update nasten_eventos set executar_em=now() where id=$1",[c.id]);return esperar(c);}
before(async()=>{
  await conectar();app=await criarApp();
  globalThis.fetch=async(url,op={})=>{
    assert.equal(new URL(url).origin,"https://api.nasten.net");
    if(String(url).endsWith("/auth")){
      auths++;assert.equal(op.method,"POST");assert.equal(op.body,undefined);assert.equal(op.headers["Content-Type"],undefined);
      assert.equal(op.headers.Authorization,"Basic "+Buffer.from(`${process.env.NASTEN_PUBLIC_KEY}:${process.env.NASTEN_SECRET_KEY}`).toString("base64"));
      return Response.json({success:true,token:"token-teste",expiresIn:600000});
    }
    assert.equal(op.headers.Authorization,"Bearer token-teste");
    if(negarToken){negarToken=false;return new Response("",{status:401});}
    if(indisponivel)throw new Error("Indisponibilidade simulada");
    const u=new URL(url);
    if(u.pathname==="/v1/transactions")return Response.json({success:true,data:u.searchParams.get("offset")==="0"?lista:[]});
    const v=vendas.get(u.pathname.split("/").at(-1));
    return v?Response.json({success:true,data:v}):new Response("",{status:404});
  };
});
after(async()=>{await processarEventosNasten();globalThis.fetch=original;await app.close();await desconectar();});

test("catálogo tem os nove checkouts Nasten e preserva preços, cupons e contexto da organização",async()=>{
  process.env.KIWIFY_CHECKOUT=JSON.stringify({"essencial:mensal":"https://pay.kiwify.com.br/antigo"});
  const c=catalogo();delete process.env.KIWIFY_CHECKOUT;
  assert.equal(c.provedor,"nasten");assert.equal(c.planos.flatMap(p=>p.ciclos).length,9);
  for(const p of c.planos)for(const ciclo of p.ciclos){const u=new URL(ciclo.checkout);assert.equal(u.host,"app.nasten.com.br");assert.equal(u.pathname,"/checkout/"+OFERTAS_NASTEN[p.id+":"+ciclo.ciclo].slug);assert.equal(u.searchParams.get("coupon"),(p.id+ciclo.ciclo).toUpperCase());}
  const u=await cadastrar(),privado=await api({acao:"plano"},u.token);
  for(const p of privado.planos)for(const ciclo of p.ciclos){const link=new URL(ciclo.checkout);assert.equal(link.searchParams.get("sck"),u.organizacao.id);assert.equal(link.searchParams.get("email"),u.email);}
  assert.equal(c.planos[0].ciclos[0].porMes,177.12);assert.equal(c.planos[1].ciclos[2].total,4811.4);
  delete process.env.PAGAMENTOS_PROVEDOR;process.env.KIWIFY_CHECKOUT=JSON.stringify({"essencial:mensal":"https://pay.kiwify.com.br/antigo"});
  assert.equal(catalogo().provedor,"kiwify");assert.match(catalogo().planos[0].ciclos[0].checkout,/pay.kiwify.com.br/);
  process.env.PAGAMENTOS_PROVEDOR="nasten";delete process.env.KIWIFY_CHECKOUT;
});

test("assinatura usa corpo bruto, segredo não vazio e timestamp recente; ping não libera plano",async()=>{
  const c=venda(await cadastrar()),t=String(Date.now()),raw=JSON.stringify(c,null,2);
  const h=crypto.createHmac("sha256",process.env.NASTEN_WEBHOOK_SECRET).update(t+"."+raw).digest("hex");
  assert(assinaturaNastenOk(raw,`t=${t},v1=${h}`));assert(!assinaturaNastenOk(JSON.stringify(c),`t=${t},v1=${h}`));
  assert(!assinaturaNastenOk(raw,`t=${Date.now()-3600000},v1=${h}`));
  const empty=crypto.createHmac("sha256","").update(t+"."+raw).digest("hex");assert(!assinaturaNastenOk(raw,`t=${t},v1=${empty}`));
  assert.equal((await app.inject({method:"POST",url:"/nasten",payload:{test:true}})).statusCode,200);
  assert.equal((await app.inject({method:"POST",url:"/nasten",payload:{...c,test:true}})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url:"/nasten",payload:c})).statusCode,401);
  assert.equal((await aviso({...c,scope:"postback"})).statusCode,400);
  assert.equal((await aviso({...c,transaction:{...c.transaction,sandbox:true}})).json().ignorado,"teste");
  assert.equal((await db().query("select count(*)::int as n from nasten_eventos")).rows[0].n,0);
});

test("pagamento confirmado ativa plano; entregas repetidas não prolongam acesso nem armazenam documento",async()=>{
  const u=await cadastrar(),c=venda(u,"profissional:anual");c.customer.document="nao-guardar";
  assert.equal((await aviso(c)).statusCode,202);await esperar(c);
  const pago=await org(u);assert.equal(pago.plano,"profissional");assert.equal(pago.ciclo,"anual");assert.equal(pago.pagamento_provedor,"nasten");assert.equal(pago.liquido_centavos,17000);
  await aviso(c);const outro={...c,id:crypto.randomUUID()};await aviso(outro);await esperar(outro);
  assert.equal(+(await org(u)).plano_ate,+pago.plano_ate);assert.equal((await db().query("select count(*)::int as n from nasten_pagamentos where transacao=$1",[c.transaction.id])).rows[0].n,1);
  const dados=(await db().query("select dados from nasten_eventos where id=$1",[c.id])).rows[0].dados;assert(!JSON.stringify(dados).includes("nao-guardar"));assert(!JSON.stringify(dados).includes(u.email));
});

test("API prevalece sobre aviso; credenciais ausentes e falha externa ficam na fila para nova tentativa",async()=>{
  const u=await cadastrar(),c=venda(u),secret=process.env.NASTEN_SECRET_KEY;delete process.env.NASTEN_SECRET_KEY;
  await aviso(c);assert.match((await esperar(c,false)).resultado,/Configure/);assert.equal((await org(u)).plano,"teste");
  process.env.NASTEN_SECRET_KEY=secret;indisponivel=true;await db().query("update nasten_eventos set executar_em=now() where id=$1",[c.id]);await esperar(c,false);indisponivel=false;
  vendas.get(c.transaction.id).status="pending";await db().query("update nasten_eventos set executar_em=now() where id=$1",[c.id]);await esperar(c,false);assert.equal((await org(u)).plano,"teste");
  vendas.get(c.transaction.id).status="paid";await tentar(c);assert.equal((await org(u)).plano,"essencial");
});

test("compras pertencem ao comprador, à empresa e à oferta; nunca escolhe outra organização pelo e-mail",async()=>{
  const u=await cadastrar(),outro=await cadastrar(),c=venda(u);vendas.get(c.transaction.id).trackingParameters.sck=outro.organizacao.id;
  await aviso(c);assert.match((await esperar(c,false)).resultado,/não pertence/);assert.equal((await org(outro)).plano,"teste");
  const empresaErrada=venda(u);vendas.get(empresaErrada.transaction.id).companyId="outra-empresa";await aviso(empresaErrada);assert.match((await esperar(empresaErrada,false)).resultado,/empresa/);
  const ofertaErrada=venda(u);ofertaErrada.product.id="produto-estranho";await aviso(ofertaErrada);assert.match((await esperar(ofertaErrada,false)).resultado,/Oferta/);
  await api({acao:"criarOrganizacao",nome:"Outra marca do mesmo dono"},u.token);
  const semSck=venda(u);vendas.get(semSck.transaction.id).trackingParameters={};await aviso(semSck);assert.match((await esperar(semSck,false)).resultado,/única/);
  assert.equal((await org(u)).plano,"teste");
});

test("compra pela landing aguarda cadastro e depois libera a única organização com o mesmo e-mail",async()=>{
  const email=`pessoa-${n+1}@nasten.test`,fake={email,organizacao:{id:crypto.randomUUID()}},c=venda(fake);
  vendas.get(c.transaction.id).trackingParameters={};await aviso(c);await esperar(c,false);
  const u=await cadastrar();assert.equal(u.email,email);await tentar(c);assert.equal((await org(u)).plano,"essencial");
});

test("pagamento mais novo prevalece; estorno antigo e aviso Kiwify não encerram a nova compra",async()=>{
  const u=await cadastrar(),antigo=venda(u,"essencial:mensal",{aprovedAt:new Date(Date.now()-86400000).toISOString()});await aviso(antigo);await esperar(antigo);
  const novo=venda(u,"agencia:semestral");await aviso(novo);await esperar(novo);const atual=await org(u);
  vendas.get(antigo.transaction.id).status="refund";const refund={...antigo,id:crypto.randomUUID(),event:"transaction_refunded"};await aviso(refund);await esperar(refund);assert.equal(+(await org(u)).plano_ate,+atual.plano_ate);
  const atrasado=venda(u,"profissional:mensal",{aprovedAt:new Date(Date.now()-2*86400000).toISOString()});await aviso(atrasado);await esperar(atrasado);assert.equal((await org(u)).plano,"agencia");
  process.env.KIWIFY_TOKEN="legado-teste";const raw=JSON.stringify({order_id:"antigo",webhook_event_type:"order_refunded",TrackingParameters:{sck:u.organizacao.id}}),sig=crypto.createHmac("sha1",process.env.KIWIFY_TOKEN).update(raw).digest("hex");
  const legado=await app.inject({method:"POST",url:"/kiwify?signature="+sig,payload:raw,headers:{"content-type":"application/json"}});assert.match(legado.json().resultado,/migrada/);delete process.env.KIWIFY_TOKEN;
  const cancel={...novo,id:crypto.randomUUID(),event:"product_canceled"};await aviso(cancel);await esperar(cancel);assert.equal(+(await org(u)).plano_ate,+atual.plano_ate);
  vendas.get(novo.transaction.id).status="chargeback";const estorno={...novo,id:crypto.randomUUID(),event:"transaction_refunded"};await aviso(estorno);await esperar(estorno);assert(+(await org(u)).plano_ate<=Date.now());
  await aviso({...novo,id:crypto.randomUUID()});await processarEventosNasten();assert(+(await org(u)).plano_ate<=Date.now());
});

test("conciliador recupera venda sem webhook e estorno perdido; não ativa itens desconhecidos",async()=>{
  const u=await cadastrar(),c=venda(u),v=vendas.get(c.transaction.id);v.TransactionItems=[{name:"Content Post - Essencial",quantity:1,amount:17712}];lista=[v];
  await reconciliarNasten();assert.equal((await org(u)).plano,"essencial");
  v.status="refund";lista=[];await reconciliarNasten();assert(+(await org(u)).plano_ate<=Date.now());
  const outro=await cadastrar(),e=venda(outro),errada=vendas.get(e.transaction.id);errada.TransactionItems=[{name:"Outro produto Essencial",quantity:1,amount:17712}];lista=[errada];await reconciliarNasten();assert.equal((await org(outro)).plano,"teste");lista=[];
});

test("token é reaproveitado e renovado após 401; fim do ciclo respeita meses do calendário",async()=>{
  const antes=auths;await consultarNasten("/v1/transactions?offset=0");assert.equal(auths,antes);
  negarToken=true;await consultarNasten("/v1/transactions?offset=0");assert.equal(auths,antes+1);
  assert.equal(fimDoCiclo("2026-01-31T15:00:00Z",1).toISOString(),"2026-03-03T15:00:00.000Z");
  assert.equal(fimDoCiclo("2026-08-31T15:00:00Z",6).toISOString(),"2027-03-03T15:00:00.000Z");
});

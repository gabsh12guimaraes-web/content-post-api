// Acesso ao Postgres. Em produção usa o pg (Railway); em testes, o PGlite (Postgres embutido).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const raiz = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let banco = null;

async function abrir(url) {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const local = url.slice("pglite:".length);
    const pg = local === "memoria" ? new PGlite() : new PGlite(local);
    await pg.waitReady;
    return {
      query: async (sql, params = []) => { const r = await pg.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; },
      exec: sql => pg.exec(sql),
      transacao: async fn => pg.transaction(tx => fn({ query: async (sql, params = []) => { const r = await tx.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } })),
      fechar: () => pg.close(),
    };
  }
  const { default: pgmod } = await import("pg");
  const pool = new pgmod.Pool({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined, max: 10 });
  return {
    query: (sql, params = []) => pool.query(sql, params),
    exec: sql => pool.query(sql),
    transacao: async fn => {
      const c = await pool.connect();
      try { await c.query("begin"); const r = await fn({ query: (s, p = []) => c.query(s, p) }); await c.query("commit"); return r; }
      catch (e) { await c.query("rollback").catch(() => {}); throw e; }
      finally { c.release(); }
    },
    fechar: () => pool.end(),
  };
}

export async function conectar(url = config.bancoUrl) {
  if (banco) return banco;
  banco = await abrir(url);
  await migrar(banco);
  return banco;
}
export function db() {
  if (!banco) throw new Error("banco não conectado");
  return banco;
}
export async function desconectar() { if (banco) { await banco.fechar(); banco = null; } }

// Roda os arquivos de migracoes/ em ordem, uma vez cada.
async function migrar(b) {
  await b.exec(`create table if not exists _migracoes (nome text primary key, aplicada_em timestamptz not null default now())`);
  const feitas = new Set((await b.query("select nome from _migracoes")).rows.map(r => r.nome));
  const pasta = path.join(raiz, "migracoes");
  for (const nome of fs.readdirSync(pasta).filter(f => f.endsWith(".sql")).sort()) {
    if (feitas.has(nome)) continue;
    const sql = fs.readFileSync(path.join(pasta, nome), "utf8");
    await b.transacao(async tx => {
      for (const parte of sql.split(/;\s*$/m).map(s => s.trim()).filter(Boolean)) await tx.query(parte);
      await tx.query("insert into _migracoes (nome) values ($1)", [nome]);
    });
  }
}

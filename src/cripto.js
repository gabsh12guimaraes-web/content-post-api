// Senhas (scrypt), tokens de sessão e convite (só o hash vai para o banco) e o cofre das chaves (AES-256-GCM).
import crypto from "node:crypto";
import { config } from "./config.js";

const scrypt = (senha, salt) => new Promise((ok, falha) =>
  crypto.scrypt(String(senha), String(salt), 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? falha(e) : ok(k.toString("hex")))));

export async function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, senha_hash: await scrypt(senha, salt) };
}
export async function conferirSenha(senha, salt, esperado) {
  const calc = Buffer.from(await scrypt(senha, salt || "sem-salt"), "hex");
  const ref = Buffer.from(String(esperado || ""), "hex");
  return ref.length === calc.length && ref.length > 0 && crypto.timingSafeEqual(calc, ref);
}
export const novoToken = () => crypto.randomBytes(32).toString("hex");
export const hashToken = t => crypto.createHash("sha256").update(String(t)).digest("hex");
export const segredoCurto = () => crypto.randomBytes(18).toString("base64url");

function chave() {
  const k = Buffer.from(config.chaveMestra(), "base64");
  if (k.length !== 32) throw new Error("CHAVE_MESTRA precisa ter 32 bytes em base64 (gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\")");
  return k;
}
export function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", chave(), iv);
  const dados = Buffer.concat([c.update(String(texto), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), dados.toString("base64")].join(".");
}
export function decifrar(guardado) {
  const [v, iv, tag, dados] = String(guardado).split(".");
  if (v !== "v1") throw new Error("formato de chave desconhecido");
  const d = crypto.createDecipheriv("aes-256-gcm", chave(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(dados, "base64")), d.final()]).toString("utf8");
}

// Padroniza vídeos para o Instagram (e as outras redes) antes de publicar: H.264 High em yuv420p, 30 quadros por
// segundo constantes, áudio AAC 48 kHz estéreo (silencioso se o vídeo não tiver som) e índice no começo do arquivo.
// Vídeos gravados no navegador (sobretudo no iPhone) podem vir com áudio Opus, MP4 fragmentado ou quadros irregulares,
// e o Instagram recusa ("had a problem processing this video").
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import ffmpeg from "ffmpeg-static";

const rodar = (args, ms = 10 * 60000) => new Promise((ok, falha) => {
  const p = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", d => { err = (err + d).slice(-4000); });
  const t = setTimeout(() => { p.kill("SIGKILL"); falha(new Error("a conversão do vídeo demorou demais")); }, ms);
  p.on("error", e => { clearTimeout(t); falha(e); });
  // o erro leva a saída inteira (saida): "ffmpeg -i" sem arquivo de saída termina com erro, mas lista duração e trilhas
  p.on("close", c => { clearTimeout(t); c === 0 ? ok(err) : falha(Object.assign(new Error("ffmpeg: " + err.split("\n").filter(Boolean).slice(-3).join(" | ")), { saida: err })); });
});
// Só um vídeo por vez: o servidor é pequeno.
let fila = Promise.resolve();
const umPorVez = fn => { const r = fila.then(fn, fn); fila = r.catch(() => {}); return r; };

// Até quatro quadros pequenos do arquivo local para entender um post pronto, sem alterar o vídeo.
export function quadrosDoVideo(arq, { intervalo = 15 } = {}) {
  return umPorVez(() => new Promise((ok, falha) => {
    const segundos = Math.max(1, Math.min(300, Number(intervalo) || 15));
    const p = spawn(ffmpeg, ["-hide_banner", "-i", arq, "-vf", `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${segundos})',scale=640:-2`, "-fps_mode", "vfr", "-frames:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    const partes = []; let tamanho = 0;
    const t = setTimeout(() => { p.kill("SIGKILL"); falha(new Error("Não consegui ler o vídeo a tempo.")); }, 30000);
    p.stdout.on("data", d => { tamanho += d.length; if (tamanho > 4 * 1024 * 1024) { p.kill("SIGKILL"); return; } partes.push(d); });
    p.on("error", e => { clearTimeout(t); falha(e); });
    p.on("close", code => {
      clearTimeout(t); if (code !== 0) return falha(new Error("Não consegui abrir o vídeo enviado. Exporte em MP4 (H.264) e envie novamente."));
      const b = Buffer.concat(partes), imagens = []; let inicio = 0;
      for (let i = 1; i < b.length; i++) if (b[i - 1] === 0xff && b[i] === 0xd9) { imagens.push(b.subarray(inicio, i + 1)); inicio = i + 1; }
      imagens.length ? ok(imagens) : falha(new Error("O vídeo não contém quadros legíveis."));
    });
  }));
}

async function temAudio(arq) {
  // "ffmpeg -i" sem saída termina com erro, mas lista as trilhas no stderr
  const info = await rodar(["-hide_banner", "-i", arq], 30000).catch(e => e.saida || e.message);
  return /Stream #.*Audio:/.test(info);
}

// Converte o arquivo no lugar. Devolve o novo tamanho em bytes.
export function padronizarVideo(arq) {
  return umPorVez(async () => {
    const saida = arq + ".ig.mp4";
    const audio = await temAudio(arq);
    const args = ["-hide_banner", "-y", "-i", arq,
      ...(audio ? [] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
      "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0",
      "-vf", "scale='min(1080,iw)':-2:flags=bicubic,fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-level", "4.1", "-crf", "21", "-maxrate", "8M", "-bufsize", "16M",
      "-g", "60", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-shortest", "-movflags", "+faststart", "-max_muxing_queue_size", "2048", saida];
    try { await rodar(args); }
    catch (e) { await fs.rm(saida, { force: true }); throw e; }
    await fs.rename(saida, arq);
    return (await fs.stat(arq)).size;
  });
}

// Vídeos que não chegam em MP4 (sobretudo o .mov do iPhone, muitas vezes em HEVC e 4K) são convertidos aqui, porque
// a conversão no navegador falha no iPhone e no app. Sai H.264 + AAC, 30 fps, índice no começo, com a qualidade
// ajustada para caber no limite do volume. A entrada é um arquivo no disco (ou um Buffer, gravado antes num temporário).
export const LIMITE_MP4 = 24 * 1024 * 1024;
const erro400 = msg => Object.assign(new Error(msg), { status: 400 });
async function examinar(arq) {
  const info = await rodar(["-hide_banner", "-i", arq], 30000).catch(e => e.saida || e.message);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  const t = /Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(info);
  return { duracao: m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0, video: /Stream #.*Video:/.test(info), audio: /Stream #.*Audio:/.test(info), largura: t ? +t[1] : 0, altura: t ? +t[2] : 0 };
}
// bitrate para caber em ~23 MB (com folga para o áudio e o contêiner); vídeos longos saem em 720p
const qualidade = dur => { const kbps = Math.max(450, Math.min(6000, Math.floor((23 * 8 * 1024) / dur) - 140)); return { kbps, lado: kbps < 1600 ? 720 : 1080 }; };
// Poucas threads: com "0" o x264 abre uma por núcleo da máquina do Railway e a memória estoura em sequências longas.
const THREADS = String(Math.max(1, Math.min(4, os.availableParallelism ? os.availableParallelism() : os.cpus().length)));
const codificacao = kbps => ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-b:v", kbps + "k", "-maxrate", Math.round(kbps * 1.4) + "k", "-bufsize", kbps * 2 + "k", "-g", "60", "-threads", THREADS];
async function finalizar(saida, pasta, dur) {
  const mp4 = await fs.readFile(saida);
  if (mp4.length > LIMITE_MP4) throw erro400("Mesmo convertido, o vídeo ficou grande demais. Envie um trecho mais curto.");
  const path = await import("node:path"), capa = path.join(pasta, "capa.jpg");
  let quadro;
  try { await rodar(["-hide_banner", "-y", "-ss", String(Math.min(1, dur / 2)), "-i", saida, "-frames:v", "1", "-vf", "scale=720:-2", capa], 30000); quadro = await fs.readFile(capa); } catch (e) {}
  return { dados: mp4, capa: quadro, duracao: dur };
}
export function converterParaMp4(entrada, { maxSegundos = 300 } = {}) {
  return umPorVez(async () => {
    const os = await import("node:os"), path = await import("node:path");
    const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "conv-"));
    try {
      let arq = entrada;
      if (Buffer.isBuffer(entrada)) { arq = path.join(pasta, "entrada"); await fs.writeFile(arq, entrada); }
      const saida = path.join(pasta, "saida.mp4"), info = await examinar(arq), dur = info.duracao;
      if (!info.video || !dur) throw erro400("Não consegui abrir este vídeo. Exporte em MOV ou MP4 e tente de novo.");
      if (dur > maxSegundos) throw erro400(`O vídeo tem ${Math.round(dur / 60)} min; o limite é de ${Math.round(maxSegundos / 60)} minutos. Corte o trecho que vai usar.`);
      const { kbps, lado } = qualidade(dur);
      const escala = `scale='if(gt(iw,ih),-2,min(${lado},iw))':'if(gt(iw,ih),min(${lado},ih),-2)':flags=bicubic,fps=30,format=yuv420p`;
      await rodar(["-hide_banner", "-y", "-i", arq, "-map", "0:v:0", ...(info.audio ? ["-map", "0:a:0"] : []), "-vf", escala, ...codificacao(kbps),
        ...(info.audio ? ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"] : []), "-movflags", "+faststart", "-max_muxing_queue_size", "4096", saida], 20 * 60000);
      return await finalizar(saida, pasta, dur);
    } finally { await fs.rm(pasta, { recursive: true, force: true }); }
  });
}
// Junta vários vídeos, na ordem, numa sequência vertical 9:16 (cada um encaixado sem cortar, com o som de cada um;
// quem não tem som ganha silêncio). Devolve também onde cada parte começa e termina na sequência.
export function juntarVideos(arquivos, { maxSegundos = 300 } = {}) {
  return umPorVez(async () => {
    const os = await import("node:os"), path = await import("node:path");
    const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "junta-"));
    try {
      const infos = [];
      for (const a of arquivos) { const i = await examinar(a); if (!i.video || !i.duracao) throw erro400("Um dos vídeos não abriu. Envie de novo em MP4 ou MOV."); infos.push(i); }
      const total = infos.reduce((t, i) => t + i.duracao, 0);
      if (total > maxSegundos) throw erro400(`Os vídeos somam ${Math.round(total / 60)} min; o limite da sequência é de ${Math.round(maxSegundos / 60)} minutos.`);
      const { kbps, lado } = qualidade(total), L = lado === 720 ? 720 : 1080, A = Math.round(L * 16 / 9);
      const entradas = [], filtros = [], pares = [];
      arquivos.forEach((a, k) => entradas.push("-i", a));
      infos.forEach((i, k) => { if (!i.audio) entradas.push("-f", "lavfi", "-t", i.duracao.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"); });
      let silencio = arquivos.length;
      infos.forEach((i, k) => {
        filtros.push(`[${k}:v:0]scale=${L}:${A}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${L}:${A}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${k}]`);
        filtros.push(`[${i.audio ? k + ":a:0" : (silencio++) + ":a:0"}]aresample=48000,aformat=channel_layouts=stereo[a${k}]`);
        pares.push(`[v${k}][a${k}]`);
      });
      filtros.push(`${pares.join("")}concat=n=${arquivos.length}:v=1:a=1[v][a]`);
      const saida = path.join(pasta, "sequencia.mp4");
      await rodar(["-hide_banner", "-y", ...entradas, "-filter_complex", filtros.join(";"), "-map", "[v]", "-map", "[a]", ...codificacao(kbps),
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-max_muxing_queue_size", "4096", saida], 20 * 60000);
      let ini = 0; const partes = infos.map(i => { const p = { inicio: +ini.toFixed(3), fim: +(ini + i.duracao).toFixed(3) }; ini += i.duracao; return p; });
      return { ...(await finalizar(saida, pasta, total)), partes };
    } finally { await fs.rm(pasta, { recursive: true, force: true }); }
  });
}

// Luz e cor (Sinsalabim): brilho, contraste e saturação de -50 a 50, temperatura de -50 (fria) a 50 (quente) e vinheta.
const LUZ_NEUTRA = { brilho: 0, contraste: 0, saturacao: 0, temperatura: 0, vinheta: false };
export const luzNeutra = l => !l || Object.keys(LUZ_NEUTRA).every(k => !l[k]);
export function filtrosLuz(l) {
  if (luzNeutra(l)) return "";
  const n = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
  const f = [`eq=brightness=${(n(l.brilho, -50, 50) / 100 * 0.3).toFixed(3)}:contrast=${(1 + n(l.contraste, -50, 50) / 100 * 0.6).toFixed(3)}:saturation=${(1 + n(l.saturacao, -50, 50) / 100).toFixed(3)}`];
  if (n(l.temperatura, -50, 50)) f.push(`colortemperature=temperature=${Math.round(6500 - n(l.temperatura, -50, 50) * 50)}:mix=0.8`);
  if (l.vinheta) f.push("vignette=angle=PI/4.5");
  return f.join(",");
}
export function aplicarLuzVideo(arq, luz) {
  return umPorVez(async () => {
    const path = await import("node:path"), pasta = await fs.mkdtemp(path.join(os.tmpdir(), "luz-"));
    try {
      const info = await examinar(arq), saida = path.join(pasta, "luz.mp4"), { kbps } = qualidade(info.duracao);
      await rodar(["-hide_banner", "-y", "-i", arq, "-map", "0:v:0", ...(info.audio ? ["-map", "0:a:0", "-c:a", "copy"] : []), "-vf", filtrosLuz(luz) + ",format=yuv420p", ...codificacao(kbps), "-movflags", "+faststart", saida], 20 * 60000);
      return await finalizar(saida, pasta, info.duracao);
    } finally { await fs.rm(pasta, { recursive: true, force: true }); }
  });
}
// Troca o fundo atrás da pessoa: "desfoque" desfoca o próprio cenário; "imagem" põe a foto (caminho) no lugar.
// faixas: [[inicio, fim], ...] em segundos do original; fora delas o quadro fica como estava.
export function trocarFundoVideo(arq, { tipo, imagem = null, faixas = null, aoAvancar = () => {} }) {
  return umPorVez(async () => {
    const path = await import("node:path"), { mascaraDoVideo } = await import("./segmentacao.js");
    const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "fundo-"));
    try {
      const info = await examinar(arq);
      if (!info.video || !info.duracao || !info.largura) throw erro400("Não consegui abrir este vídeo para trocar o fundo.");
      const w = info.largura - (info.largura % 2), h = info.altura - (info.altura % 2), mascara = path.join(pasta, "mascara.mp4"), saida = path.join(pasta, "fundo.mp4");
      await mascaraDoVideo(arq, mascara, { largura: w, altura: h, duracao: info.duracao, faixas, aoAvancar: f => aoAvancar(f * 0.8) });
      const { kbps } = qualidade(info.duracao);
      // Borda da máscara um pouco desfocada e endurecida: corta o halo sem serrilhar o cabelo.
      const m = `scale=${w}:${h}:flags=bicubic,fps=30,format=gray,gblur=sigma=2.2,lutyuv=y='clip((val-38)*1.45,0,255)'`;
      const entradas = tipo === "imagem" ? ["-i", arq, "-loop", "1", "-i", imagem, "-i", mascara] : ["-i", arq, "-i", mascara];
      const filtro = tipo === "imagem"
        ? `[0:v]scale=${w}:${h},fps=30,format=yuva420p[fg];[2:v]${m}[m];[fg][m]alphamerge[p];[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=1.2,format=yuv420p[bg];[bg][p]overlay=0:0:shortest=1,format=yuv420p[v]`
        : `[0:v]scale=${w}:${h},fps=30,split[a][b];[a]format=yuva420p[fg];[1:v]${m}[m];[fg][m]alphamerge[p];[b]scale=${Math.round(w / 4)}:-2,gblur=sigma=5,scale=${w}:${h},format=yuv420p[bg];[bg][p]overlay=0:0:shortest=1,format=yuv420p[v]`;
      await rodar(["-hide_banner", "-y", ...entradas, "-filter_complex", filtro, "-map", "[v]", ...(info.audio ? ["-map", "0:a:0", "-c:a", "copy"] : []),
        "-t", info.duracao.toFixed(3), ...codificacao(kbps), "-movflags", "+faststart", "-max_muxing_queue_size", "4096", saida], 30 * 60000);
      aoAvancar(0.97);
      return await finalizar(saida, pasta, info.duracao);
    } finally { await fs.rm(pasta, { recursive: true, force: true }); }
  });
}

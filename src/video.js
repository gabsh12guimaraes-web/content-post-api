// Padroniza vídeos para o Instagram (e as outras redes) antes de publicar: H.264 High em yuv420p, 30 quadros por
// segundo constantes, áudio AAC 48 kHz estéreo (silencioso se o vídeo não tiver som) e índice no começo do arquivo.
// Vídeos gravados no navegador (sobretudo no iPhone) podem vir com áudio Opus, MP4 fragmentado ou quadros irregulares,
// e o Instagram recusa ("had a problem processing this video").
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
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

// Vídeos que não chegam em MP4 (sobretudo o .mov do iPhone, muitas vezes em HEVC) são convertidos aqui, porque
// a conversão no navegador falha no iPhone e no app. Sai H.264 + AAC, 30 fps, índice no começo, com a qualidade
// ajustada para caber no limite do volume. Devolve o MP4 e um quadro (JPEG) para a capa.
export const LIMITE_MP4 = 24 * 1024 * 1024;
export function converterParaMp4(dados, { maxSegundos = 300 } = {}) {
  return umPorVez(async () => {
    const os = await import("node:os"), path = await import("node:path");
    const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "conv-"));
    try {
      const entrada = path.join(pasta, "entrada"), saida = path.join(pasta, "saida.mp4"), capa = path.join(pasta, "capa.jpg");
      await fs.writeFile(entrada, dados);
      const info = await rodar(["-hide_banner", "-i", entrada], 30000).catch(e => e.saida || e.message);
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
      const dur = m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
      if (!/Stream #.*Video:/.test(info) || !dur) throw Object.assign(new Error("Não consegui abrir este vídeo. Exporte em MOV ou MP4 e tente de novo."), { status: 400 });
      if (dur > maxSegundos) throw Object.assign(new Error(`O vídeo tem ${Math.round(dur / 60)} min; o limite é de ${Math.round(maxSegundos / 60)} minutos. Corte o trecho que vai usar.`), { status: 400 });
      const audio = /Stream #.*Audio:/.test(info);
      // bitrate para caber em ~23 MB (com folga para o áudio e o contêiner); vídeos longos saem em 720p
      const kbps = Math.max(450, Math.min(6000, Math.floor((23 * 8 * 1024) / dur) - 140)), lado = kbps < 1600 ? 720 : 1080;
      const escala = `scale='if(gt(iw,ih),-2,min(${lado},iw))':'if(gt(iw,ih),min(${lado},ih),-2)':flags=bicubic,fps=30,format=yuv420p`;
      await rodar(["-hide_banner", "-y", "-i", entrada, "-map", "0:v:0", ...(audio ? ["-map", "0:a:0"] : []), "-vf", escala,
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-b:v", kbps + "k", "-maxrate", Math.round(kbps * 1.4) + "k", "-bufsize", kbps * 2 + "k", "-g", "60",
        ...(audio ? ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"] : []), "-movflags", "+faststart", "-max_muxing_queue_size", "2048", saida]);
      const mp4 = await fs.readFile(saida);
      if (mp4.length > LIMITE_MP4) throw Object.assign(new Error("Mesmo convertido, o vídeo ficou grande demais. Envie um trecho mais curto."), { status: 400 });
      let quadro;
      try { await rodar(["-hide_banner", "-y", "-ss", String(Math.min(1, dur / 2)), "-i", saida, "-frames:v", "1", "-vf", "scale=720:-2", capa], 30000); quadro = await fs.readFile(capa); } catch (e) {}
      return { dados: mp4, capa: quadro, duracao: dur };
    } finally { await fs.rm(pasta, { recursive: true, force: true }); }
  });
}

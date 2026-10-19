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
  p.on("close", c => { clearTimeout(t); c === 0 ? ok(err) : falha(new Error("ffmpeg: " + err.split("\n").filter(Boolean).slice(-3).join(" | "))); });
});
// Só um vídeo por vez: o servidor é pequeno.
let fila = Promise.resolve();
const umPorVez = fn => { const r = fila.then(fn, fn); fila = r.catch(() => {}); return r; };

async function temAudio(arq) {
  // "ffmpeg -i" sem saída termina com erro, mas lista as trilhas no stderr
  const info = await rodar(["-hide_banner", "-i", arq], 30000).catch(e => e.message);
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

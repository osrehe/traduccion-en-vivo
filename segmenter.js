// Port de segmenter.py: corta el chorro de deltas en líneas cerradas, un idioma
// por instancia. Misma lógica y mismo orden de reglas; la explicación de cada
// una está en el original. Aquí solo se comenta lo que cambia en JavaScript.
//
// Reloj inyectado en **segundos** (como `time.monotonic()`), para que la
// aritmética de los plazos sea idéntica a la de Python y la paridad, exacta.
//
// Diferencia conocida: `length` cuenta unidades UTF-16 y `len()` de Python
// cuenta caracteres. Solo discrepan con caracteres fuera del plano básico
// (emojis), que la transcripción no produce.

import * as config from "./config.js";

export const FRASE = "frase";
export const BLANDO = "blando";
export const SILENCIO = "silencio";
export const DURO = "duro";
export const FINAL = "final";

const FIN_FRASE = /[.?!…]+(?=\s)/gu;
const ULTIMA_PALABRA = /\S+$/u;
// `[^\W\d_]` de Python: letras y numerales que no son dígitos.
const INICIALES = /^(?:[\p{L}\p{Nl}\p{No}]\.)+$/u;
const BLANDOS = ",;";
const HUERFANA = ".,;:!?…"; // puntuación que no puede abrir línea (¿ y ¡ sí)

export const ABREVIATURAS = new Set(
  `
  mr. mrs. ms. dr. drs. prof. st. mt. jr. sr. vs. etc. inc. ltd. co. corp.
  fig. no. approx. dept. est. min. max. sec. eg. ie. al.
  sra. srta. dra. ud. uds. ee. uu. núm. nº pág. págs. avda. ej. ap. cía.
  `.split(/\s+/).filter(Boolean),
);

export const ahoraS = () => performance.now() / 1000;

// `str.rfind(c, inicio, fin)` de Python para un solo carácter.
function rfind(s, c, inicio, fin) {
  const desde = Math.min(fin, s.length) - 1;
  if (desde < 0) return -1;
  const i = s.lastIndexOf(c, desde);
  return i >= inicio ? i : -1;
}

function esFalsoPositivo(buf, fin) {
  const m = ULTIMA_PALABRA.exec(buf.slice(0, fin));
  if (m === null) return false;
  const palabra = m[0];
  if (ABREVIATURAS.has(palabra.toLowerCase())) return true;
  return INICIALES.test(palabra);
}

// Quita la puntuación que encabeza una línea, solo para mostrarla (no del buffer).
function sinHuerfana(texto) {
  const t = texto.trim();
  let i = 0;
  while (i < t.length && HUERFANA.includes(t[i])) i++;
  return t.slice(i).trim();
}

export class Segmentador {
  constructor(
    idioma,
    {
      softChars = config.SOFT_BREAK_CHARS,
      hardChars = config.HARD_BREAK_CHARS,
      silencioMs = config.SILENCE_CLOSE_MS,
      stickyChars = config.STICKY_MIN_CHARS,
      now = ahoraS,
    } = {},
  ) {
    this.idioma = idioma;
    this.softChars = softChars;
    this.hardChars = hardChars;
    this.silencioMs = silencioMs;
    this.stickyChars = stickyChars;
    this._now = now;

    // [texto, elapsed_ms] de cada delta que sigue en el buffer.
    this._piezas = [];
    this._buf = "";
    this._ultimoDeltaS = null;
    this._n = 0;
  }

  // -- entrada ---------------------------------------------------------------

  feed(delta, elapsedMs) {
    if (!delta) return [];
    this._ultimoDeltaS = this._now();
    this._piezas.push([delta, Math.trunc(elapsedMs)]);
    this._buf += delta;
    return this._cerrarLoQueToque();
  }

  tick() {
    if (!this._buf.trim() || this._ultimoDeltaS === null) return [];
    if ((this._now() - this._ultimoDeltaS) * 1000 < this.silencioMs) return [];
    if (!this.parcial) {
      this._piezas = [];
      this._buf = "";
      return [];
    }
    return [this._cortar(this._buf.length, SILENCIO)];
  }

  flush() {
    if (!this.parcial) {
      this._piezas = [];
      this._buf = "";
      return [];
    }
    return [this._cortar(this._buf.length, FINAL)];
  }

  get parcial() {
    return sinHuerfana(this._buf);
  }

  // -- interno ---------------------------------------------------------------

  _cerrarLoQueToque() {
    const salida = [];
    for (;;) {
      const corte = this._buscarCorte();
      if (corte === null) return salida;
      salida.push(this._cortar(...corte));
    }
  }

  _buscarCorte() {
    const buf = this._buf;
    if (!buf.trim()) return null;

    // 1. Fin de frase, con la regla sticky.
    for (const m of buf.matchAll(FIN_FRASE)) {
      const fin = m.index + m[0].length;
      if (esFalsoPositivo(buf, fin)) continue;
      if (buf.slice(0, fin).trim().length < this.stickyChars) continue;
      return [fin, FRASE];
    }

    // 2. Corte blando por la última coma pasado el umbral.
    if (buf.length > this.softChars) {
      const idx = Math.max(...[...BLANDOS].map((c) => rfind(buf, c, 0, this.hardChars)));
      if (idx >= Math.floor(this.softChars / 2)) return [idx + 1, BLANDO];
    }

    // 3. Corte duro, en un hueco entre palabras.
    if (buf.length >= this.hardChars) {
      const hueco = rfind(buf, " ", Math.floor(this.hardChars / 2), this.hardChars);
      return [hueco > 0 ? hueco : this.hardChars, DURO];
    }

    return null;
  }

  _cortar(k, motivo) {
    const texto = this._buf.slice(0, k);
    const inicio = this._piezas[0][1];
    let finMs = inicio;

    let restantes = [];
    let pos = 0;
    for (const [pieza, ms] of this._piezas) {
      const iniP = pos;
      const finP = pos + pieza.length;
      if (iniP < k) finMs = ms;
      if (finP > k) restantes.push([pieza.slice(Math.max(0, k - iniP)), ms]);
      pos = finP;
    }

    // El resto arranca con el espacio que separaba las dos frases.
    while (restantes.length && !restantes[0][0].trim()) restantes.shift();
    if (restantes.length) restantes[0][0] = restantes[0][0].trimStart();

    this._piezas = restantes;
    this._buf = restantes.map(([p]) => p).join("");

    this._n += 1;
    return Object.freeze({
      lineId: `${this.idioma}${this._n}`,
      lang: this.idioma,
      text: sinHuerfana(texto),
      startMs: inicio,
      endMs: finMs,
      reason: motivo,
    });
  }
}

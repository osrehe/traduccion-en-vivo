// Port de pairing.py: empareja las líneas inglesas con las españolas por
// solapamiento de `elapsed_ms` corregido por un retardo estimado, y conmuta a
// modo columnas si el emparejado se degrada. La explicación de cada regla está
// en el original; aquí solo se comenta lo que cambia en JavaScript.
//
// Las filas salen como `{tipo: "fila", id, en, es, cerrada}`, el equivalente de
// `events.RowUpdated`.

import * as config from "./config.js";
import { ahoraS } from "./segmenter.js";

export const PAREADO = "pareado";
export const COLUMNAS = "columnas";

const TOLERANCIA_MS = 50;

// `int(statistics.median(xs))`: con un número par de muestras, la media de las
// dos centrales truncada hacia cero.
function medianaEntera(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const m = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return Math.trunc(m);
}

// `round()` de Python (al par en los empates), para que el motivo de la
// degradación diga el mismo porcentaje.
function redondeoPython(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function solape(a, b) {
  const ancho = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  if (ancho <= 0) return 0.0;
  const corto = Math.max(1, Math.min(a[1] - a[0], b[1] - b[0]));
  return Math.min(1.0, ancho / corto);
}

function quitar(lista, x) {
  lista.splice(lista.indexOf(x), 1);
}

class Fila {
  constructor(rowId, creadaS, en = [], es = []) {
    this.rowId = rowId;
    this.creadaS = creadaS;
    this.en = en;
    this.es = es;
    this.cerrada = false;
  }

  evento() {
    return {
      tipo: "fila",
      id: this.rowId,
      en: this.en.map((x) => x.text).join(" "),
      es: this.es.map((x) => x.text).join(" "),
      cerrada: this.cerrada,
    };
  }

  get ventanaEn() {
    return [this.en[0].startMs, this.en[this.en.length - 1].endMs];
  }
}

export class Emparejador {
  constructor({
    lagInitMs = config.PAIR_LAG_INIT_MS,
    ventana = config.PAIR_LAG_WINDOW,
    solapeMin = config.PAIR_MIN_OVERLAP,
    huerfanaMs = config.PAIR_ORPHAN_MS,
    commitMs = config.COMMIT_WINDOW_MS,
    dispersionMaxMs = config.PAIR_LAG_SPREAD_MAX_MS,
    tasaHuerfanasMax = config.PAIR_ORPHAN_RATE_MAX,
    minMuestras = config.PAIR_MIN_MUESTRAS,
    huerfanaEsMaxMs = config.PAIR_ORPHAN_ES_MAX_MS,
    inglesAbierto = () => false,
    now = ahoraS,
  } = {}) {
    this.solapeMin = solapeMin;
    this.huerfanaMs = huerfanaMs;
    this.huerfanaEsMaxMs = huerfanaEsMaxMs;
    this._inglesAbierto = inglesAbierto;
    this.commitMs = commitMs;
    this.ventana = ventana;
    this.dispersionMaxMs = dispersionMaxMs;
    this.tasaHuerfanasMax = tasaHuerfanasMax;
    this.minMuestras = minMuestras;
    this._now = now;

    this.modo = PAREADO;
    this.motivoDegradacion = "";
    this.lagMs = lagInitMs;

    this._muestras = [];
    // Pendientes `{linea, llegadaS}`; se buscan y se quitan por identidad.
    this._pend = { en: [], es: [] };
    this._abiertas = [];
    this._ultimoMs = {};
    this._nLineas = 0;
    this._nHuerfanas = 0;
    this._nFilas = 0;
  }

  // -- entrada ---------------------------------------------------------------

  add(linea) {
    this._nLineas += 1;
    const salida = [];

    const previo = this._ultimoMs[linea.lang];
    this._ultimoMs[linea.lang] = linea.startMs;
    if (previo !== undefined && linea.startMs < previo - TOLERANCIA_MS) {
      salida.push(...this._degradar("elapsed_ms no monótono"));
    }

    if (this.modo === COLUMNAS) return [...salida, this._filaSuelta(linea)];

    this._pend[linea.lang].push({ linea, llegadaS: this._now() });
    salida.push(...this._intentar());
    return [...salida, ...this.tick()];
  }

  tick() {
    const ahora = this._now();
    const salida = [];

    const plazos = { en: this.huerfanaMs, es: this.huerfanaMs };
    if (this._pend.es.length && this._inglesAbierto()) {
      plazos.es = Math.max(this.huerfanaMs, this.huerfanaEsMaxMs);
    }
    for (const idioma of ["en", "es"]) {
      for (const p of [...this._pend[idioma]]) {
        if ((ahora - p.llegadaS) * 1000 < plazos[idioma]) continue;
        quitar(this._pend[idioma], p);
        this._nHuerfanas += 1;
        salida.push(this._nuevaFila({ [idioma]: [p.linea] }));
      }
    }

    for (const fila of [...this._abiertas]) {
      if ((ahora - fila.creadaS) * 1000 >= this.commitMs) {
        fila.cerrada = true;
        quitar(this._abiertas, fila);
        salida.push(fila.evento());
      }
    }

    return [...salida, ...this._vigilar()];
  }

  // Fin de sesión: un solo evento por fila, ya cerrado.
  flush() {
    this._intentar();
    for (const idioma of ["en", "es"]) {
      for (const p of this._pend[idioma]) this._nuevaFila({ [idioma]: [p.linea] });
      this._pend[idioma] = [];
    }
    return this._cerrarAbiertas();
  }

  // Texto [en, es] de las líneas cerradas que aún esperan pareja.
  get pendientes() {
    return ["en", "es"].map((idioma) =>
      this._pend[idioma].map((p) => p.linea.text).join(" "),
    );
  }

  // -- emparejado ------------------------------------------------------------

  _intentar() {
    const salida = [];
    for (const pEs of [...this._pend.es]) {
      const es = pEs.linea;
      const ventana = [es.startMs - this.lagMs, es.endMs - this.lagMs];

      const fila = this._filaAbiertaQueSolape(ventana);
      if (fila !== null) {
        quitar(this._pend.es, pEs);
        fila.es.push(es);
        salida.push(fila.evento());
        continue;
      }

      const encajan = this._pend.en.filter(
        (p) => solape([p.linea.startMs, p.linea.endMs], ventana) >= this.solapeMin,
      );
      if (!encajan.length) continue;

      const corte = this._pend.en.indexOf(encajan[0]);
      for (const p of this._pend.en.slice(0, corte)) {
        this._nHuerfanas += 1;
        salida.push(this._nuevaFila({ en: [p.linea] }));
      }
      this._pend.en = this._pend.en.slice(corte).filter((p) => !encajan.includes(p));
      quitar(this._pend.es, pEs);

      this._anotarLag(encajan[0].linea, es);
      salida.push(this._nuevaFila({ en: encajan.map((p) => p.linea), es: [es] }));
    }
    return salida;
  }

  _filaAbiertaQueSolape(ventana) {
    for (let i = this._abiertas.length - 1; i >= 0; i--) {
      const fila = this._abiertas[i];
      if (fila.en.length && solape(fila.ventanaEn, ventana) >= this.solapeMin) return fila;
    }
    return null;
  }

  _anotarLag(en, es) {
    this._muestras.push(es.startMs - en.startMs);
    this._muestras = this._muestras.slice(-this.ventana);
    this.lagMs = medianaEntera(this._muestras);
  }

  // -- filas -----------------------------------------------------------------

  _nuevaFila({ en = [], es = [] } = {}) {
    this._nFilas += 1;
    const fila = new Fila(`f${this._nFilas}`, this._now(), en, es);
    this._abiertas.push(fila);
    return fila.evento();
  }

  _filaSuelta(linea) {
    this._nFilas += 1;
    const fila = new Fila(`f${this._nFilas}`, this._now());
    fila[linea.lang].push(linea);
    fila.cerrada = true;
    return fila.evento();
  }

  // -- vigilancia de la propia calidad ---------------------------------------

  _vigilar() {
    if (this.modo === COLUMNAS) return [];
    if (this._muestras.length >= 4) {
      const dispersion = Math.max(...this._muestras) - Math.min(...this._muestras);
      if (dispersion > this.dispersionMaxMs) {
        return this._degradar(`retardo inestable (${dispersion} ms)`);
      }
    }
    if (this._nLineas >= this.minMuestras) {
      const tasa = this._nHuerfanas / this._nLineas;
      if (tasa > this.tasaHuerfanasMax) {
        return this._degradar(`${redondeoPython(tasa * 100)} % de líneas sin pareja`);
      }
    }
    return [];
  }

  _degradar(motivo) {
    if (this.modo === COLUMNAS) return [];
    this.modo = COLUMNAS;
    this.motivoDegradacion = motivo;

    const salida = this._cerrarAbiertas();
    for (const idioma of ["en", "es"]) {
      for (const p of this._pend[idioma]) salida.push(this._filaSuelta(p.linea));
      this._pend[idioma] = [];
    }
    return salida;
  }

  _cerrarAbiertas() {
    const salida = [];
    for (const fila of this._abiertas) {
      fila.cerrada = true;
      salida.push(fila.evento());
    }
    this._abiertas = [];
    return salida;
  }
}

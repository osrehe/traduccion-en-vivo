// La parte de realtime_client.py que no toca la red: reparte los deltas a los
// segmentadores, pasa las líneas al emparejador y publica filas, línea en curso
// y cambios de modo. backend.js le da los eventos del socket y le llama a
// `tick()` cada 50 ms; tools/paridad.mjs hace lo mismo con una grabación.
//
// Publica objetos `{tipo: "fila" | "en_curso" | "modo", ...}`, el equivalente
// de `RowUpdated`, `LiveUpdated` y el `StatusChanged` del modo columnas.

import * as config from "./config.js";
import { Segmentador, ahoraS } from "./segmenter.js";
import { Emparejador, PAREADO } from "./pairing.js";

export const TICK_SUPERVISOR_MS = 50;

// `int(x)` de Python sobre lo que venga en `elapsed_ms`; null si no es entero.
function enteroPython(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

export class Motor {
  constructor({ publicar, now = ahoraS }) {
    this._publicar = publicar;
    this._now = now;
    this._t0 = now();
    this._modoAvisado = PAREADO;
    this._enCurso = ["", ""];

    this._segs = {
      en: new Segmentador("en", { silencioMs: config.SILENCE_CLOSE_EN_MS, now }),
      es: new Segmentador("es", { now }),
    };
    this._par = new Emparejador({
      inglesAbierto: () => Boolean(this._segs.en.parcial),
      now,
    });
  }

  get modo() {
    return this._par.modo;
  }

  get lagMs() {
    return this._par.lagMs;
  }

  // Consume los deltas de transcripción; devuelve false si el evento es otro.
  despachar(ev) {
    if (ev.type === "session.input_transcript.delta") this._delta("en", ev);
    else if (ev.type === "session.output_transcript.delta") this._delta("es", ev);
    else return false;
    return true;
  }

  // El supervisor: cierres por silencio, vencimientos y avisos.
  tick() {
    for (const seg of Object.values(this._segs)) {
      for (const linea of seg.tick()) this._filas(this._par.add(linea));
    }
    this._filas(this._par.tick());
    this._publicarEnCurso();
    this._vigilarModo();
  }

  // Al cortarse la sesión, lo que quedaba a medias se pinta igual.
  cerrar() {
    for (const seg of Object.values(this._segs)) {
      for (const linea of seg.flush()) this._filas(this._par.add(linea));
    }
    this._filas(this._par.flush());
    this._publicarEnCurso();
  }

  _delta(idioma, ev) {
    const texto = ev.delta || "";
    if (!texto) return;
    let elapsed = enteroPython(ev.elapsed_ms);
    if (elapsed === null) elapsed = Math.trunc((this._now() - this._t0) * 1000);
    for (const linea of this._segs[idioma].feed(texto, elapsed)) {
      this._filas(this._par.add(linea));
    }
    this._publicarEnCurso();
  }

  _filas(filas) {
    for (const fila of filas) this._publicar(fila);
  }

  // Lo pendiente de emparejar más el buffer abierto; solo si cambió.
  _publicarEnCurso() {
    const [pendEn, pendEs] = this._par.pendientes;
    const actual = [
      [pendEn, this._segs.en.parcial].filter(Boolean).join(" "),
      [pendEs, this._segs.es.parcial].filter(Boolean).join(" "),
    ];
    if (actual[0] !== this._enCurso[0] || actual[1] !== this._enCurso[1]) {
      this._enCurso = actual;
      this._publicar({ tipo: "en_curso", en: actual[0], es: actual[1] });
    }
  }

  _vigilarModo() {
    if (this._par.modo !== this._modoAvisado) {
      this._modoAvisado = this._par.modo;
      this._publicar({
        tipo: "modo",
        detalle: `modo columnas: ${this._par.motivoDegradacion}`,
      });
    }
  }
}

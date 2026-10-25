// La red: el equivalente de realtime_client.py en el navegador. Abre el
// WebSocket con la clave como subprotocolo (el navegador no puede mandar la
// cabecera Authorization; verificado contra la API el 2026-10-25), manda el
// audio agrupado en ~100 ms, reconecta con backoff y se despide rápido. La
// segmentación y el emparejado van en motor.js.
//
// Publica por `publicar` los eventos del motor más estos:
//   {tipo: "estado", estado, detalle}   {tipo: "error", mensaje, fatal}
//   {tipo: "nivel", rms, pico}          {tipo: "separador", id, texto}

import * as config from "./config.js";
import { Motor, TICK_SUPERVISOR_MS } from "./motor.js";

export const DETENIDO = "detenido";
export const CONECTANDO = "conectando";
export const EN_MARCHA = "en marcha";
export const RECONECTANDO = "reconectando";
export const ERROR = "error";

export const SEPARADOR_RECONEXION = "— reconectado —";
const PREFIJO_CLAVE = "openai-insecure-api-key.";

const BLOQUE_MS = 20; // lo que entrega mic-worklet.js
const BLOQUES_POR_ENVIO = Math.max(1, Math.floor(config.SEND_CHUNK_MS / BLOQUE_MS));
const ENVIO_FORZADO_MS = 200; // con poco audio, mandarlo igual pasado este tiempo
const NIVEL_CADA_MS = 250;
const SILENCIO_DBFS = -99.0;
// Audio retenido mientras no hay conexión (~800 ms): al llenarse se tira lo
// más antiguo, como la cola acotada del escritorio.
const COLA_MAX_BLOQUES = 40;

// Cada conexión cuenta `elapsed_ms` desde cero. Sin desplazarlo, la primera
// línea tras reconectar parece retroceder en el tiempo y el emparejador se
// rinde a modo columnas para el resto de la sesión. Se suma lo ya visto más
// este hueco, para que nada de una conexión solape con la anterior.
const HUECO_RECONEXION_MS = 10_000;

const PLAZO_CONEXION_MS = 10_000;
const PLAZO_COLA_MS = 500; // al parar: lo que se recoge de la traducción en vuelo
const PLAZO_CIERRE_RAPIDO_MS = 700;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function dbfs(amplitud) {
  return amplitud > 0 ? 20 * Math.log10(amplitud / 32768) : SILENCIO_DBFS;
}

// [rms, pico] en dBFS de un bloque PCM16.
export function nivel(muestras) {
  if (!muestras.length) return [SILENCIO_DBFS, SILENCIO_DBFS];
  let pico = 0;
  let suma = 0;
  for (const v of muestras) {
    pico = Math.max(pico, Math.abs(v));
    suma += v * v;
  }
  return [dbfs(Math.sqrt(suma / muestras.length)), dbfs(pico)];
}

// Ganancia por software con recorte duro. Con 1.0 devuelve lo mismo.
export function amplificar(muestras, ganancia) {
  if (ganancia === 1.0) return muestras;
  const salida = new Int16Array(muestras.length);
  for (let i = 0; i < muestras.length; i++) {
    salida[i] = Math.max(-32768, Math.min(32767, Math.trunc(muestras[i] * ganancia)));
  }
  return salida;
}

function base64(muestras) {
  const bytes = new Uint8Array(muestras.buffer, muestras.byteOffset, muestras.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function sessionUpdate() {
  return {
    type: "session.update",
    session: {
      audio: {
        input: {
          transcription: { model: config.INPUT_TRANSCRIPTION_MODEL },
          noise_reduction: { type: config.NOISE_REDUCTION },
        },
        output: { language: config.OUTPUT_LANGUAGE },
      },
    },
  };
}

export class Backend {
  constructor({ clave, publicar, url = config.TRANSLATE_URL, ganancia = config.MIC_GAIN }) {
    this.url = url;
    this.clave = clave;
    this.ganancia = Number(ganancia) || 1.0;
    this._publicarFuera = publicar;
    this._motor = new Motor({ publicar: (ev) => this._publicar(ev) });

    this._ws = null;
    this._listo = false; // socket abierto y session.update enviado
    this._parado = false;
    // Tras `stop()` el backend calla: con Reiniciar ya hay otro hablando.
    this._mudo = false;
    this._intento = 0;
    this._conexiones = 0;
    this._nSep = 0;
    this._desfaseMs = 0;
    this._maxElapsedMs = 0;
    this._latido = null;
    this._reintento = null;

    this._bloques = [];
    this._ultimoEnvio = 0;
    this._nivelDesde = 0;
    this._rmsAcum = [];
    this._picoAcum = SILENCIO_DBFS;
  }

  start() {
    if (!this.clave) {
      this._publicar({ tipo: "error", mensaje: "falta la clave de OpenAI: ponla en Ajustes", fatal: true });
      this._parado = true;
      return;
    }
    this._latido = setInterval(() => this._tick(), TICK_SUPERVISOR_MS);
    this._conectar();
  }

  // Un bloque de 20 ms del micrófono.
  audio(bloque) {
    if (this._parado) return;
    this._bloques.push(bloque);
    if (this._bloques.length > COLA_MAX_BLOQUES) this._bloques.shift();
    if (this._listo && this._bloques.length >= BLOQUES_POR_ENVIO) this._enviarAudio();
  }

  // Cierre educado y rápido: `session.close`, medio segundo para recoger la
  // última frase traducida y cerrar el socket con el receptor aún leyendo.
  // La API real no contesta a `session.close` (ver realtime_client.py).
  async stop() {
    if (this._parado) {
      this._mudo = true;
      return;
    }
    this._parado = true;
    clearTimeout(this._reintento);
    clearInterval(this._latido);

    const ws = this._ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      this._enviar({ type: "session.close" });
      await esperar(PLAZO_COLA_MS);
      await this._cerrarSocket(ws, PLAZO_CIERRE_RAPIDO_MS);
    } else if (ws) {
      ws.close();
    }
    this._ws = null;
    this._listo = false;
    this._motor.cerrar();
    this._publicar({ tipo: "estado", estado: DETENIDO, detalle: "" });
    this._mudo = true;
  }

  // -- conexión ---------------------------------------------------------------

  _conectar() {
    if (this._parado) return;
    this._publicar({ tipo: "estado", estado: CONECTANDO, detalle: "" });

    let ws;
    try {
      ws = new WebSocket(this.url, ["realtime", PREFIJO_CLAVE + this.clave]);
    } catch {
      // El navegador rechaza un subprotocolo con espacios u otros caracteres raros.
      this._fatal("la clave tiene caracteres no válidos: revísala en Ajustes");
      return;
    }
    this._ws = ws;
    let abierto = false;
    const plazo = setTimeout(() => {
      if (!abierto) ws.close();
    }, PLAZO_CONEXION_MS);

    ws.onopen = () => {
      abierto = true;
      clearTimeout(plazo);
      this._conexiones += 1;
      if (this._conexiones > 1) this._desfaseMs = this._maxElapsedMs + HUECO_RECONEXION_MS;
      this._enviar(sessionUpdate());
      this._listo = true;
      this._ultimoEnvio = performance.now();
      this._publicar({ tipo: "estado", estado: EN_MARCHA, detalle: "conectado" });
      if (this._conexiones > 1) {
        // Marcar el corte: puede faltar contexto y hay que verlo.
        this._nSep += 1;
        this._publicar({ tipo: "separador", id: `sep${this._nSep}`, texto: SEPARADOR_RECONEXION });
      }
    };
    ws.onmessage = (e) => this._recibir(e.data);
    ws.onerror = () => {}; // detrás siempre llega un onclose
    ws.onclose = (e) => {
      clearTimeout(plazo);
      this._alCerrar(ws, abierto, e);
    };
  }

  _alCerrar(ws, abierto, e) {
    if (ws !== this._ws) return; // un socket ya sustituido o despedido
    this._ws = null;
    this._listo = false;
    if (this._parado) return; // stop() se encarga del resto

    // Al cortarse la sesión, lo que quedaba a medias se pinta igual.
    this._motor.cerrar();
    if (!abierto) {
      this._publicar({ tipo: "error", mensaje: "no se pudo conectar con la API (¿sin red?)", fatal: false });
    } else if (e.code !== 1000) {
      this._publicar({ tipo: "error", mensaje: `conexión perdida (código ${e.code})`, fatal: false });
    } else {
      this._intento = 0;
    }

    const backoff = config.RECONNECT_BACKOFF_S;
    const espera = backoff[Math.min(this._intento, backoff.length - 1)];
    this._intento += 1;
    this._publicar({ tipo: "estado", estado: RECONECTANDO, detalle: `reintento en ${espera}s` });
    this._reintento = setTimeout(() => this._conectar(), espera * 1000);
  }

  _cerrarSocket(ws, plazoMs) {
    return new Promise((resolver) => {
      const t = setTimeout(resolver, plazoMs);
      ws.addEventListener("close", () => {
        clearTimeout(t);
        resolver();
      });
      ws.close(1000);
    });
  }

  // El error va lo último: la pantalla reacciona llamando a stop(), y para
  // entonces el backend ya tiene que estar parado o se despediría entero y su
  // «detenido» taparía el error.
  _fatal(mensaje) {
    this._parado = true;
    clearTimeout(this._reintento);
    clearInterval(this._latido);
    const ws = this._ws;
    this._ws = null;
    this._listo = false;
    if (ws) ws.close();
    this._motor.cerrar();
    this._publicar({ tipo: "error", mensaje, fatal: true });
  }

  // -- recepción --------------------------------------------------------------

  _recibir(crudo) {
    let ev;
    try {
      ev = JSON.parse(crudo);
    } catch {
      return;
    }
    if (!ev || typeof ev !== "object") return;
    if (typeof ev.elapsed_ms === "number" && ev.type && ev.type.endsWith("_transcript.delta")) {
      ev.elapsed_ms += this._desfaseMs;
      this._maxElapsedMs = Math.max(this._maxElapsedMs, ev.elapsed_ms);
    }
    if (this._motor.despachar(ev)) return;

    switch (ev.type) {
      case "session.output_audio.delta":
        return; // llega quiera uno o no; se tira
      case "error": {
        const err = ev.error || {};
        if (err.code === "invalid_api_key") {
          this._fatal("la API rechazó la clave: revísala en Ajustes");
          return;
        }
        this._publicar({
          tipo: "error",
          mensaje: `${err.code || "error"}: ${err.message || "sin detalle"}`,
          fatal: false,
        });
        return;
      }
      case "session.updated":
        this._publicar({ tipo: "estado", estado: EN_MARCHA, detalle: "sesión lista" });
        return;
      case "session.closed":
        this._publicar({ tipo: "estado", estado: RECONECTANDO, detalle: "el servidor cerró la sesión" });
        return;
    }
  }

  // -- envío ------------------------------------------------------------------

  _tick() {
    this._motor.tick();
    const ahora = performance.now();
    if (this._listo && this._bloques.length && ahora - this._ultimoEnvio >= ENVIO_FORZADO_MS) {
      this._enviarAudio();
    }
    if (this._rmsAcum.length && ahora - this._nivelDesde >= NIVEL_CADA_MS) {
      this._publicar({ tipo: "nivel", rms: Math.max(...this._rmsAcum), pico: this._picoAcum });
      this._nivelDesde = ahora;
      this._rmsAcum = [];
      this._picoAcum = SILENCIO_DBFS;
    }
  }

  _enviarAudio() {
    let total = 0;
    for (const b of this._bloques) total += b.length;
    const junto = new Int16Array(total);
    let off = 0;
    for (const b of this._bloques) {
      junto.set(b, off);
      off += b.length;
    }
    this._bloques = [];
    this._ultimoEnvio = performance.now();

    const datos = amplificar(junto, this.ganancia);
    const [rms, pico] = nivel(datos);
    this._rmsAcum.push(rms);
    this._picoAcum = Math.max(this._picoAcum, pico);
    this._enviar({ type: "session.input_audio_buffer.append", audio: base64(datos) });
  }

  _enviar(payload) {
    const ws = this._ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  _publicar(ev) {
    if (this._mudo) return;
    try {
      this._publicarFuera(ev);
    } catch (exc) {
      console.error("publicar", exc); // publicar jamás puede tumbar el backend
    }
  }
}

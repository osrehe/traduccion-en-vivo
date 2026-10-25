// Procesador del AudioWorklet: pasa lo que da el micrófono (float32 a la
// frecuencia del AudioContext, 44,1 o 48 kHz en el iPhone) a PCM16 mono a
// 24 kHz y lo manda al hilo principal en bloques de 20 ms, como el callback de
// PortAudio del escritorio.
//
// Se remuestrea aquí en vez de pedir `new AudioContext({sampleRate: 24000})`
// porque conectar un micrófono a un contexto de otra frecuencia no funciona
// igual en todos los navegadores.

const SALIDA_HZ = 24000;
const BLOQUE = 480; // 20 ms a 24 kHz

class Microfono extends AudioWorkletProcessor {
  constructor() {
    super();
    this.paso = sampleRate / SALIDA_HZ; // muestras de entrada por cada una de salida
    // Posición de la siguiente muestra de salida, relativa al bloque de
    // entrada actual; -1 es la última muestra del bloque anterior.
    this.pos = 0;
    this.previa = 0;
    this.crudaPrevia = 0;
    this.filtrado = new Float32Array(128);
    this.bloque = new Int16Array(BLOQUE);
    this.n = 0;
  }

  process(inputs) {
    const canal = inputs[0] && inputs[0][0];
    if (!canal || !canal.length) return true;
    const largo = canal.length;
    if (this.filtrado.length < largo) this.filtrado = new Float32Array(largo);

    // Media de cada dos muestras: un paso bajo mínimo para que lo que hay por
    // encima de 12 kHz no se pliegue sobre la voz al diezmar.
    const x = this.filtrado;
    if (this.paso > 1) {
      let ant = this.crudaPrevia;
      for (let i = 0; i < largo; i++) {
        x[i] = (canal[i] + ant) / 2;
        ant = canal[i];
      }
      this.crudaPrevia = ant;
    } else {
      x.set(canal);
    }

    // Interpolación lineal entre la muestra `i` y la `i + 1`.
    let pos = this.pos;
    while (pos < largo - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.previa : x[i];
      const v = a + (x[i + 1] - a) * frac;
      const s = Math.max(-1, Math.min(1, v));
      this.bloque[this.n++] = Math.round(s < 0 ? s * 32768 : s * 32767);
      if (this.n === BLOQUE) {
        this.port.postMessage(this.bloque.buffer, [this.bloque.buffer]);
        this.bloque = new Int16Array(BLOQUE);
        this.n = 0;
      }
      pos += this.paso;
    }
    this.pos = pos - largo;
    this.previa = x[largo - 1];
    return true;
  }
}

registerProcessor("microfono", Microfono);

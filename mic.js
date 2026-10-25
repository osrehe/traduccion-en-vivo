// Captura del micrófono: getUserMedia + AudioWorklet (mic-worklet.js), que
// entrega bloques de 20 ms de PCM16 mono a 24 kHz por `onBloque`.
//
// `abrir()` crea y reanuda el AudioContext **antes** del primer `await`: Safari
// en iOS solo deja arrancar el audio dentro del gesto del usuario, así que hay
// que llamarlo directamente desde el manejador del toque, sin nada asíncrono
// delante.

export class Microfono {
  constructor({ onBloque, onCorte = () => {} }) {
    this.onBloque = onBloque;
    this.onCorte = onCorte;
    this.ctx = null;
    this.stream = null;
    this._nodo = null;
  }

  async abrir() {
    this.ctx = new AudioContext();
    const reanudado = this.ctx.resume();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (exc) {
      this.cerrar();
      throw new Error(
        exc && exc.name === "NotAllowedError"
          ? "sin permiso para usar el micrófono"
          : `no se pudo abrir el micrófono (${(exc && exc.message) || exc})`,
      );
    }
    await reanudado;
    await this.ctx.audioWorklet.addModule(new URL("./mic-worklet.js", import.meta.url));

    const fuente = this.ctx.createMediaStreamSource(this.stream);
    this._nodo = new AudioWorkletNode(this.ctx, "microfono");
    this._nodo.port.onmessage = (e) => this.onBloque(new Int16Array(e.data));
    // Conectado al destino aunque no suene nada (el procesador no escribe su
    // salida): algunos navegadores no procesan un nodo que no llega a ninguna
    // parte.
    fuente.connect(this._nodo).connect(this.ctx.destination);

    for (const pista of this.stream.getAudioTracks()) {
      pista.addEventListener("ended", () => this.onCorte());
    }
  }

  get etiqueta() {
    const pista = this.stream && this.stream.getAudioTracks()[0];
    return pista ? pista.label : "";
  }

  // ¿Sigue capturando? iOS corta el micrófono al pasar a segundo plano.
  get vivo() {
    const pista = this.stream && this.stream.getAudioTracks()[0];
    return Boolean(pista && pista.readyState === "live");
  }

  // Al volver a primer plano: el contexto puede haber quedado suspendido.
  async reanudar() {
    if (this.ctx && this.ctx.state !== "running") await this.ctx.resume();
  }

  cerrar() {
    if (this.stream) for (const pista of this.stream.getTracks()) pista.stop();
    if (this._nodo) this._nodo.port.onmessage = null;
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this._nodo = null;
  }
}

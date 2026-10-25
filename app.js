// La pantalla: el equivalente de ui.py y de la Sesion de main.py. Recibe los
// eventos del backend, los agrupa por fila y pinta una vez por fotograma.
//
// Cada Iniciar o Reiniciar es una **generación**: el backend nuevo vuelve a
// numerar sus filas desde «f1», así que la clave de una fila es «gen/id». Las
// filas del backend viejo que lleguen tarde se pintan en su sitio; su estado,
// nivel y línea en curso ya no cuentan.

import * as config from "./config.js";
import { Backend, CONECTANDO, DETENIDO, EN_MARCHA, ERROR, RECONECTANDO } from "./backend.js";
import { Microfono } from "./mic.js";

const WATCHDOG_MS = 10_000; // en marcha y sin eventos este tiempo -> aviso ámbar
const NIVEL_VENTANA_MS = 3000; // el aviso de «micro bajo» mira el pico de estos ms
const MARGEN_ABAJO_PX = 48;

const CLAVE_LS = "traduccion.clave";
const GANANCIA_LS = "traduccion.ganancia";
const INGLES_LS = "traduccion.ingles";

const PUNTO = {
  [DETENIDO]: "var(--gris)",
  [CONECTANDO]: "var(--ambar)",
  [EN_MARCHA]: "var(--verde)",
  [RECONECTANDO]: "var(--ambar)",
  [ERROR]: "var(--rojo)",
};

const $ = (id) => document.getElementById(id);
const ui = {
  principal: $("btn-principal"),
  reiniciar: $("btn-reiniciar"),
  ingles: $("chk-ingles"),
  exportar: $("btn-exportar"),
  ajustes: $("btn-ajustes"),
  transcript: $("transcript"),
  filas: $("filas"),
  vivo: $("vivo"),
  vacio: $("vacio"),
  final: $("btn-final"),
  punto: $("punto"),
  estado: $("estado"),
  nivel: $("nivel"),
  dlgAjustes: $("dlg-ajustes"),
  inClave: $("in-clave"),
  inGanancia: $("in-ganancia"),
  notaClave: $("nota-clave"),
  dlgIniciar: $("dlg-iniciar"),
};

// -- almacenamiento local (puede fallar en privado: nunca es crítico) ---------

function leer(clave, porDefecto = "") {
  try {
    return localStorage.getItem(clave) ?? porDefecto;
  } catch {
    return porDefecto;
  }
}

function guardar(clave, valor) {
  try {
    if (valor === null) localStorage.removeItem(clave);
    else localStorage.setItem(clave, valor);
  } catch {
    // sin almacenamiento: dura lo que dure la página
  }
}

// Solo para probar contra tools/fake_server.py: `?servidor=ws://127.0.0.1:8765`.
// Solo vale si la propia página se sirve desde esta máquina: en la versión
// publicada, un enlace con ese parámetro mandaría la clave a lo que escuche en
// ese puerto del teléfono.
const LOCAL = ["127.0.0.1", "localhost"];

function urlApi() {
  const servidor = LOCAL.includes(location.hostname)
    ? new URLSearchParams(location.search).get("servidor")
    : null;
  if (servidor) {
    try {
      const u = new URL(servidor);
      if (u.protocol === "ws:" && LOCAL.includes(u.hostname)) {
        return `ws://${u.host}/v1/realtime/translations?model=${config.TRANSLATE_MODEL}`;
      }
    } catch {
      // URL inválida: se usa la de verdad
    }
  }
  return config.TRANSLATE_URL;
}

// -- estado de la sesión ----------------------------------------------------

let gen = 0;
let corriendo = false;
let mic = null;
let backend = null;
let wakeLock = null;
let nReanudaciones = 0;
let nReinicios = 0;

let estado = DETENIDO;
let detalle = "";
let ultimoEvento = performance.now();
let ultimoNivel = null;
let picos = []; // [t, pico_dbfs] recientes

// Filas por clave «gen/id»: {el, en, es, cerrada, sep}. `orden` es el de
// pantalla, que es el de la primera vez que se vio cada una.
const filas = new Map();
const orden = [];
const sucias = new Set();
const vivo = { en: "", es: "" };
let vivoSucio = false;
let fotograma = 0;

const limpiar = (texto) => (texto || "").replace(/\s+/g, " ").trim();
const hora = () => new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });

function alEvento(g, ev) {
  const actual = g === gen;
  if (actual) ultimoEvento = performance.now();

  switch (ev.tipo) {
    case "fila": {
      const clave = `${g}/${ev.id}`;
      const fila = obtenerFila(clave);
      fila.en = limpiar(ev.en);
      fila.es = limpiar(ev.es);
      fila.cerrada = ev.cerrada;
      sucias.add(clave);
      break;
    }
    case "separador":
      separador(`${g}/${ev.id}`, ev.texto);
      break;
    case "en_curso":
      if (!actual) return;
      vivo.en = limpiar(ev.en);
      vivo.es = limpiar(ev.es);
      vivoSucio = true;
      break;
    case "nivel":
      if (!actual) return;
      ultimoNivel = ev;
      picos.push([performance.now(), ev.pico]);
      break;
    case "modo":
      if (!actual) return;
      estado = EN_MARCHA;
      detalle = ev.detalle;
      break;
    case "estado":
      if (!actual) return;
      estado = ev.estado;
      detalle = ev.detalle;
      break;
    case "error":
      if (!actual) return;
      if (ev.fatal && corriendo) detener();
      estado = ERROR;
      detalle = ev.mensaje;
      break;
  }
  programarPintado();
}

function obtenerFila(clave) {
  let fila = filas.get(clave);
  if (!fila) {
    fila = { el: null, en: "", es: "", cerrada: false, sep: null };
    filas.set(clave, fila);
    orden.push(clave);
  }
  return fila;
}

function separador(clave, texto) {
  const fila = obtenerFila(clave);
  fila.sep = texto;
  fila.cerrada = true;
  sucias.add(clave);
  programarPintado();
}

// -- pintado ----------------------------------------------------------------

function programarPintado() {
  if (!fotograma) fotograma = requestAnimationFrame(pintar);
}

function estaAbajo() {
  const t = ui.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight <= MARGEN_ABAJO_PX;
}

function pintar() {
  fotograma = 0;
  const abajo = estaAbajo();

  for (const clave of sucias) {
    const fila = filas.get(clave);
    if (!fila) continue;
    if (!fila.el) {
      fila.el = document.createElement("div");
      if (fila.sep === null) {
        fila.el.className = "fila";
        fila.el.append(document.createElement("p"), document.createElement("p"));
        fila.el.children[0].className = "en";
        fila.el.children[1].className = "es";
      }
      ui.filas.append(fila.el);
    }
    if (fila.sep !== null) {
      fila.el.className = "sep";
      fila.el.textContent = fila.sep;
    } else {
      fila.el.classList.toggle("abierta", !fila.cerrada);
      fila.el.children[0].textContent = fila.en;
      fila.el.children[1].textContent = fila.es;
    }
  }
  sucias.clear();

  if (vivoSucio) {
    vivoSucio = false;
    ui.vivo.children[0].textContent = vivo.en;
    ui.vivo.children[1].textContent = vivo.es;
    ui.vivo.hidden = !vivo.en && !vivo.es;
  }
  ui.vacio.hidden = orden.length > 0 || !ui.vivo.hidden;

  if (abajo) ui.transcript.scrollTop = ui.transcript.scrollHeight;
  actualizarBotonFinal();
  aplicarEstado();
}

function actualizarBotonFinal() {
  ui.final.hidden = estaAbajo();
}

function aplicarEstado() {
  const callado = estado === EN_MARCHA && performance.now() - ultimoEvento > WATCHDOG_MS;
  ui.punto.style.background = callado ? "var(--ambar)" : PUNTO[estado] || "var(--gris)";
  let texto = estado.charAt(0).toUpperCase() + estado.slice(1);
  if (callado) texto += ` · sin datos desde hace ${WATCHDOG_MS / 1000} s`;
  if (detalle) texto += ` · ${detalle}`;
  ui.estado.textContent = texto;
  ui.estado.title = texto;
  aplicarNivel();
}

// «mic −38 dBFS», en rojo con aviso si en unos segundos no hubo voz.
function aplicarNivel() {
  if (estado !== EN_MARCHA || ultimoNivel === null) {
    picos = [];
    ui.nivel.textContent = "";
    ui.nivel.classList.remove("bajo");
    return;
  }
  const ahora = performance.now();
  picos = picos.filter(([t]) => ahora - t <= NIVEL_VENTANA_MS);
  const pico = picos.length ? Math.max(...picos.map(([, p]) => p)) : ultimoNivel.pico;
  const bajo = pico < config.MIC_LOW_PEAK_DBFS;
  ui.nivel.textContent = `mic ${Math.round(ultimoNivel.rms)} dBFS` + (bajo ? " · ¡no capta voz!" : "");
  ui.nivel.classList.toggle("bajo", bajo);
}

// -- controles --------------------------------------------------------------

function hayTexto() {
  return orden.length > 0 || Boolean(vivo.en || vivo.es);
}

function vaciar() {
  filas.clear();
  orden.length = 0;
  sucias.clear();
  ui.filas.replaceChildren();
  vivo.en = vivo.es = "";
  vivoSucio = true;
  programarPintado();
}

function alPulsarPrincipal() {
  if (corriendo) {
    detener();
    return;
  }
  if (!leer(CLAVE_LS)) {
    abrirAjustes("Pega tu clave de OpenAI para empezar.");
    return;
  }
  if (hayTexto()) {
    ui.dlgIniciar.showModal();
    return;
  }
  arrancar();
}

// Se llama siempre desde el manejador de un toque, sin nada asíncrono delante:
// iOS solo deja arrancar el audio dentro del gesto del usuario.
function arrancar() {
  gen += 1;
  const g = gen;
  corriendo = true;
  estado = CONECTANDO;
  detalle = "";
  ultimoEvento = performance.now();
  ultimoNivel = null;
  ponerBotones();

  mic = new Microfono({
    onBloque: (b) => backend && backend.audio(b),
    onCorte: () => {
      if (corriendo) alEvento(gen, { tipo: "error", mensaje: "el micrófono se cortó: pulsa Detener e Iniciar", fatal: false });
    },
  });
  const abriendo = mic.abrir();

  backend = nuevoBackend((ev) => alEvento(g, ev));
  backend.start();

  abriendo.catch((exc) => {
    if (g !== gen) return;
    detener();
    estado = ERROR;
    detalle = exc.message;
    programarPintado();
  });
  pedirWakeLock();
  programarPintado();
}

function nuevoBackend(publicar) {
  return new Backend({
    clave: leer(CLAVE_LS),
    ganancia: Number(leer(GANANCIA_LS, "1")) || 1,
    url: urlApi(),
    publicar,
  });
}

function detener() {
  if (!corriendo) return;
  corriendo = false;
  ponerBotones();
  estado = DETENIDO;
  detalle = "";
  if (mic) mic.cerrar();
  mic = null;
  const b = backend;
  backend = null;
  if (b) b.stop();
  soltarWakeLock();
  programarPintado();
}

// Sesión nueva con la API sin tocar la pantalla ni el micrófono, para cuando
// la traducción se tuerce. El backend nuevo arranca ya (así no se pierde
// audio), pero lo que publique espera a que el viejo termine de despedirse:
// sus últimas filas van delante del separador.
async function reiniciar() {
  if (!corriendo || !backend) return;
  ui.reiniciar.disabled = true;
  const viejo = backend;
  gen += 1;
  const g = gen;
  const enEspera = [];
  let libre = false;
  backend = nuevoBackend((ev) => (libre ? alEvento(g, ev) : enEspera.push(ev)));
  backend.start();
  estado = CONECTANDO;
  detalle = "reiniciando";
  programarPintado();

  await viejo.stop();
  nReinicios += 1;
  separador(`ui/reinicio${nReinicios}`, `— reiniciado · ${hora()} —`);
  vivo.en = vivo.es = ""; // lo que tenía en curso el viejo ya está en sus filas
  vivoSucio = true;
  libre = true;
  for (const ev of enEspera) alEvento(g, ev);
  ponerBotones();
}

function ponerBotones() {
  ui.principal.textContent = corriendo ? "Detener" : "Iniciar";
  ui.principal.classList.toggle("detener", corriendo);
  ui.reiniciar.disabled = !corriendo;
}

// -- diálogo de inicio con texto en pantalla ---------------------------------

$("btn-continuar").addEventListener("click", () => {
  ui.dlgIniciar.close();
  nReanudaciones += 1;
  separador(`ui/reanudado${nReanudaciones}`, `— continúa · ${hora()} —`);
  arrancar();
});
$("btn-nuevo").addEventListener("click", () => {
  ui.dlgIniciar.close();
  vaciar();
  arrancar();
});
$("btn-cancelar-inicio").addEventListener("click", () => ui.dlgIniciar.close());

// -- ajustes ----------------------------------------------------------------

function abrirAjustes(nota = "") {
  ui.inClave.value = leer(CLAVE_LS);
  ui.inGanancia.value = leer(GANANCIA_LS, String(config.MIC_GAIN));
  ui.notaClave.textContent = nota || "Se guarda solo en este dispositivo y solo se envía a OpenAI.";
  ui.notaClave.classList.toggle("aviso", Boolean(nota));
  ui.dlgAjustes.showModal();
}

ui.dlgAjustes.addEventListener("close", () => {
  if (ui.dlgAjustes.returnValue !== "guardar") return;
  const clave = ui.inClave.value.trim();
  guardar(CLAVE_LS, clave || null);
  const ganancia = Math.min(8, Math.max(1, Number(ui.inGanancia.value) || 1));
  guardar(GANANCIA_LS, String(ganancia));
  // Un backend en marcha sigue con lo que tenía; vale desde el próximo Iniciar.
});
$("btn-borrar-clave").addEventListener("click", () => {
  ui.inClave.value = "";
  guardar(CLAVE_LS, null);
});

// -- exportar a Markdown -----------------------------------------------------

function markdown() {
  const fecha = new Date().toLocaleString("es", { dateStyle: "long", timeStyle: "short" });
  const partes = [`# Traducción en vivo · ${fecha}`, ""];
  const filasMd = orden.map((clave) => filas.get(clave));
  if (vivo.en || vivo.es) filasMd.push({ en: vivo.en, es: vivo.es, sep: null });
  for (const f of filasMd) {
    if (f.sep !== null) partes.push(`*${f.sep}*`, "");
    else if (f.en && f.es) partes.push(`*${f.en}*  `, f.es, "");
    else if (f.en) partes.push(`*${f.en}*`, "");
    else if (f.es) partes.push(f.es, "");
  }
  return partes.join("\n");
}

async function exportar() {
  if (!hayTexto()) return;
  const d = new Date();
  const dos = (n) => String(n).padStart(2, "0");
  const nombre = `traduccion-${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}-${dos(d.getHours())}${dos(d.getMinutes())}.md`;
  const texto = markdown();
  // `text/plain` y no `text/markdown`: la hoja de compartir del iPhone no
  // aceptaba el archivo con ese tipo, y la descarga de reserva no hace nada en
  // iOS. El nombre conserva la extensión .md.
  const archivo = new File([texto], nombre, { type: "text/plain" });

  // En el iPhone, la hoja de compartir: como archivo (Guardar en Archivos) si
  // el sistema lo admite y, si no, como texto (Notas, Mail...). Un solo intento:
  // `share()` gasta el gesto del usuario y un segundo intento lo rechazaría.
  // En el ordenador, una descarga normal.
  const tactil = matchMedia("(pointer: coarse)").matches;
  if (tactil && navigator.share) {
    const datos =
      navigator.canShare && navigator.canShare({ files: [archivo] })
        ? { files: [archivo], title: nombre }
        : { title: nombre, text: texto };
    try {
      await navigator.share(datos);
      return;
    } catch (exc) {
      if (exc && exc.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(archivo);
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// -- pantalla encendida y vuelta a primer plano ------------------------------

async function pedirWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    }
  } catch {
    // sin Wake Lock: la pantalla se apagará con el bloqueo automático
  }
}

function soltarWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !corriendo) return;
  pedirWakeLock();
  if (mic) mic.reanudar().catch(() => {});
});

// -- arranque ---------------------------------------------------------------

// Ocultar o mostrar el inglés cambia la altura de todo: si se estaba leyendo
// el final, se sigue en el final.
function aplicarIngles() {
  const abajo = estaAbajo();
  ui.transcript.classList.toggle("sin-ingles", !ui.ingles.checked);
  if (abajo) ui.transcript.scrollTop = ui.transcript.scrollHeight;
  actualizarBotonFinal();
}

ui.ingles.checked = leer(INGLES_LS, "1") === "1";
aplicarIngles();
ui.ingles.addEventListener("change", () => {
  guardar(INGLES_LS, ui.ingles.checked ? "1" : "0");
  aplicarIngles();
});
ui.principal.addEventListener("click", alPulsarPrincipal);
ui.reiniciar.addEventListener("click", reiniciar);
ui.exportar.addEventListener("click", exportar);
ui.ajustes.addEventListener("click", () => abrirAjustes());
ui.final.addEventListener("click", () => {
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  actualizarBotonFinal();
});
ui.transcript.addEventListener("scroll", actualizarBotonFinal, { passive: true });
// El aviso de «sin datos» y el del nivel dependen del tiempo, no solo de eventos.
setInterval(aplicarEstado, 1000);
aplicarEstado();

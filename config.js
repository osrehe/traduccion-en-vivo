// Constantes de config.py, 1:1. El porqué de cada valor está comentado allí;
// si cambia una, cambia en los dos sitios (tools/paridad.mjs lo delata).

// --- Audio -------------------------------------------------------------------
// El endpoint exige PCM16 mono a 24 kHz.
export const SAMPLE_RATE = 24_000;
export const CHANNELS = 1;
export const SAMPLE_WIDTH = 2; // bytes por muestra

// El sender agrupa este tiempo de audio antes de mandarlo por el socket.
export const SEND_CHUNK_MS = 100;

// Ganancia por software antes de enviar (1.0 = tal cual). En la web se ajusta
// desde la pantalla de ajustes; este es el valor por defecto.
export const MIC_GAIN = 1;
// Por debajo de este pico (dBFS) la barra avisa de que el micro no capta voz.
export const MIC_LOW_PEAK_DBFS = -30.0;

// --- API ---------------------------------------------------------------------
export const TRANSLATE_MODEL = "gpt-realtime-translate";
export const TRANSLATE_URL =
  "wss://api.openai.com/v1/realtime/translations" + `?model=${TRANSLATE_MODEL}`;
export const INPUT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
export const OUTPUT_LANGUAGE = "es";
export const NOISE_REDUCTION = "near_field";

// Reconexión con backoff exponencial.
export const RECONNECT_BACKOFF_S = [1, 2, 4, 8, 16, 30];
export const SESSION_ROTATE_MIN = 25;

// --- Segmentación ------------------------------------------------------------
export const SOFT_BREAK_CHARS = 120;
export const HARD_BREAK_CHARS = 200;
export const SILENCE_CLOSE_MS = 1200;
export const SILENCE_CLOSE_EN_MS = 2000;
export const COMMIT_WINDOW_MS = 2500;
export const STICKY_MIN_CHARS = 15;

// --- Emparejamiento inglés<->español -----------------------------------------
export const PAIR_LAG_INIT_MS = 900;
export const PAIR_LAG_WINDOW = 8;
export const PAIR_MIN_OVERLAP = 0.30;
export const PAIR_ORPHAN_MS = 5000;
export const PAIR_ORPHAN_ES_MAX_MS = 15_000;
export const PAIR_LAG_SPREAD_MAX_MS = 10_000;
export const PAIR_ORPHAN_RATE_MAX = 0.30;
export const PAIR_MIN_MUESTRAS = 6;

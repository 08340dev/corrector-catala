// © 2026 08340dev. Tots els drets reservats. Vegeu el fitxer LICENSE.
// Configuración por defecto, compartida por todas las partes de la extensión.
// eslint-disable-next-line no-unused-vars
const CORRECTOR_DEFAULTS = {
  // Interruptor general.
  enabled: true,
  // Variante: ca-ES (general), ca-ES-valencia, ca-ES-balear.
  language: 'ca-ES',
  // Servidor LanguageTool. Por defecto, el público de Softcatalà.
  // Para publicar la extensión, usa tu propio servidor (ver README).
  serverUrl: 'https://api.softcatala.org/corrector/v2',
  // Webs donde la extensión no actúa (por nombre de host).
  disabledHosts: [],
  // Palabras que el usuario ha añadido a su diccionario personal.
  dictionary: []
};

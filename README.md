# Corrector de català (extensión de Chrome)

Corrige ortografía y gramática en catalán mientras escribes en cualquier web.
El motor es **LanguageTool** (software libre), el mismo que usa el corrector de
Softcatalà. Esta extensión no es un producto oficial de Softcatalà.

> **© 2026 08340dev. Todos los derechos reservados.**
> Este repositorio es público solo para consulta. No se permite copiar,
> modificar, reutilizar ni redistribuir el código sin autorización por escrito.
> Ver [LICENSE](LICENSE).

## Probarla en tu Chrome

1. Descomprime el zip en una carpeta que no vayas a borrar.
2. Abre `chrome://extensions`.
3. Activa **Modo de desarrollador** (arriba a la derecha).
4. Pulsa **Cargar descomprimida** y elige la carpeta `corrector-catala`.
5. Abre cualquier web con un cuadro de texto y escribe, por ejemplo:
   `Tinc que anar al mercat a comprar cosas.`

Tras medio segundo sin teclear aparecen los subrayados. Pulsa sobre uno para
ver la sugerencia y aplicarla.

## Qué hace

- Subraya en rojo la ortografía, en naranja la gramática y en azul el estilo.
- Tarjeta con la explicación, las sugerencias, **Ignora** y **Afegeix al diccionari**.
- Funciona en `<textarea>` y en editores `contenteditable` (Gmail, etc.).
- Variantes: catalán general, valenciano y balear (en Opciones).
- Se puede desactivar por web desde el icono de la extensión.
- Si el texto está claramente en otro idioma, no marca nada.
- Aplicar una sugerencia respeta el Ctrl+Z.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `manifest.json` | Declaración de la extensión (Manifest V3) y permisos. |
| `defaults.js` | Configuración por defecto (servidor, variante…). |
| `background.js` | Service worker: hace la petición al servidor LanguageTool. |
| `content.js` | Detecta los campos, pide la corrección, pinta subrayados y tarjeta. |
| `content.css` | Estilo de los subrayados en editores `contenteditable`. |
| `popup.html/js` | Ventana del icono: activar/desactivar. |
| `options.html/js` | Opciones: variante, servidor, diccionario, webs excluidas. |

## Cómo funciona por dentro

1. `content.js` espera 500 ms desde la última tecla.
2. Divide el texto en párrafos y envía solo los que han cambiado (el resto sale de caché).
3. `background.js` hace `POST {servidor}/check` con `text` y `language=ca-ES`.
4. El servidor devuelve `matches` (posición, longitud, mensaje, sugerencias).
5. En `<textarea>` se pinta una capa transparente superpuesta con los subrayados;
   en `contenteditable` se usa la CSS Custom Highlight API, que no modifica la página.

## El servidor

Por defecto apunta a la API pública de Softcatalà:
`https://api.softcatala.org/corrector/v2`

Sirve para probar. Softcatalà es una asociación de voluntarios, así que **antes
de publicar la extensión** conviene una de estas dos cosas:

- Pedirles permiso (corrector@softcatala.org).
- Montar tu propio servidor LanguageTool y poner su dirección en Opciones:

```bash
docker run -d -p 8081:8010 erikvl87/languagetool
# Servidor en Opciones: http://localhost:8081/v2
```

Las reglas de catalán son las mismas, porque Softcatalà las publica dentro de LanguageTool.

## Limitaciones conocidas

- **Google Docs** no funciona: dibuja el texto en un canvas y necesita una integración aparte.
- Los campos `<input>` de una línea no se corrigen (solo `<textarea>` y editores).
- Editores de código (CodeMirror, Monaco, Ace) se excluyen a propósito.
- Editores dentro de Shadow DOM pueden no mostrar los subrayados.
- Requiere Chrome 105 o superior.

## Antes de publicar en la Chrome Web Store

- Redacta una política de privacidad: el texto que escribe el usuario se envía al servidor de corrección.
- Justifica el permiso `<all_urls>` (la extensión corrige en cualquier web).
- Usa un servidor propio o acordado.
- Sube el número de `version` en `manifest.json` con cada entrega.

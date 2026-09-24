# Seguridad

## Qué versiones se mantienen

Solo `main`. No hay releases: los arreglos van directo ahí.

## Cómo reportar una vulnerabilidad

No abras un issue público con los detalles. Usá el reporte privado de GitHub (pestaña **Security** → **Report a vulnerability**). Si no está disponible, abrí un issue que diga solo que querés reportar un problema de seguridad, sin detalles, y se coordina un canal privado.

Contá qué se puede hacer, cómo reproducirlo y qué versión probaste (`git rev-parse --short HEAD`). Es un proyecto personal: la respuesta puede tardar unos días.

## Qué tener en cuenta

- El dashboard es para correr en tu máquina. Escucha en `127.0.0.1` y rechaza pedidos con otro `Host` u `Origin`. **No lo expongas** a una red ni a internet (`CONTROL_PLANE_HOST` existe, pero no es para eso).
- Cada sesión corre `claude --dangerously-skip-permissions`: puede ejecutar comandos y editar archivos sin preguntar, con tus permisos. Usalo en repos y máquinas en los que eso sea aceptable.
- Instalar una skill copia su carpeta, incluidos los scripts que Claude puede ejecutar. Instalá solo de fuentes en las que confiás.
- El dashboard no guarda ni maneja credenciales: el login es el de Claude Code.

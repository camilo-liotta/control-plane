# Cómo contribuir

control-plane es un proyecto personal que se comparte por si le sirve a alguien más. Si lo usás y querés mejorarlo, bienvenido. Issues y PRs en castellano o en inglés (*English is fine too*).

## Reportar un bug

1. Buscá en los [issues](../../issues) si ya está reportado.
2. Abrí uno nuevo con la plantilla **Reportar un bug**. Lo que más ayuda:
   - Qué hiciste, qué esperabas y qué pasó.
   - Versiones: `git rev-parse --short HEAD` (control-plane), `claude --version`, `node --version`, sistema operativo y navegador.
   - Lo que muestra la terminal donde corre el server y, si es de la UI, la consola del navegador.
3. Antes de pegar logs o capturas, sacá tokens, rutas privadas y contenido de tus conversaciones.

Si es un problema de seguridad, no abras un issue: seguí [SECURITY.md](SECURITY.md).

## Pedir una mejora

Abrí un issue con la plantilla **Pedir una mejora**: qué problema te resuelve y cómo te lo imaginás. Para cambios grandes (una pantalla nueva, otra forma de orquestar, dependencias nuevas), conviene charlarlo en el issue antes de escribir el código.

## Preparar el entorno

Necesitás Node.js 24+, git y Claude Code instalado y logueado.

```bash
npm install
npm run dev        # server en 4700 + Vite con recarga en http://localhost:4701
npm run typecheck
npm test           # tests del server (node:test)
npm run build      # compila la web
```

### Probar sin romper tu configuración de Claude Code

El dashboard escribe en la configuración real de Claude Code (plugins, MCP, skills, settings). Para probar cambios que tocan eso, no uses tu cuenta de todos los días:

- Levantá el server con su propia base: `CONTROL_PLANE_HOME=$(mktemp -d) CONTROL_PLANE_PORT=4710 npm run serve`.
- Agregá una **cuenta de prueba** cuyo directorio sea una carpeta temporal (**Administrar cuentas…**) y creá los proyectos de prueba con esa cuenta y un repo descartable.
- Ojo: algunos comandos de `claude` no validan lo que reciben (por ejemplo, `claude plugin enable` con un plugin que no existe igual escribe en tu `settings.json`).

## Pull requests

- Un cambio por PR, desde una rama propia, contra `main`.
- Contá qué cambia, por qué y cómo lo probaste. Si toca la UI, sumá una captura.
- `npm run typecheck` y `npm test` tienen que pasar. Si arreglás un bug del server, sumá un test que lo muestre.
- Seguí el estilo del código que tocás: mismos nombres, mismos patrones, comentarios solo donde hacen falta. Nada de frameworks nuevos sin charlarlo antes.
- Los textos de la UI van en castellano rioplatense (voseo), con el mismo tono del resto.
- El dashboard es 100% local: nada de telemetría, servicios externos ni cuentas propias. Solo habla con Claude Code y con tu navegador.
- Si el cambio se ve desde afuera, actualizá el README.

Al contribuir aceptás que tu código se publique con la [licencia MIT](LICENSE) del proyecto y que seguís el [código de conducta](CODE_OF_CONDUCT.md).

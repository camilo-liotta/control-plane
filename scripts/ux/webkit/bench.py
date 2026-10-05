# Banco WebKitGTK (WebKit2 4.1: el motor de la app de escritorio en Linux). Carga una URL, pone el
# tema, mide lo que importa de la base (fuentes, oklch, color-mix, la hoja) y captura la ventana.
# Uso: lo llama run.sh. Necesita python3-gi y gir1.2-webkit2-4.1.
import sys
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1"); gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk, WebKit2

url, theme, out = sys.argv[1], sys.argv[2], sys.argv[3]
win = Gtk.Window(); win.set_default_size(1440, 900)
view = WebKit2.WebView(); win.add(view); win.show_all()
CHECK = """(() => { const cs = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null };
 const inset = cs('[data-slot=sidebar-inset]');
 return JSON.stringify({ fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
   oklch: CSS.supports('color', 'oklch(0.5 0.1 200)'), colorMix: CSS.supports('color', 'color-mix(in oklch, red 50%, blue)'),
   hoja: inset && { radio: inset.borderRadius, sombra: inset.boxShadow !== 'none' }, ua: navigator.userAgent }) })()"""
step = {"n": 0}

def js(code, cb=None):
    def done(v, res):
        try:
            val = v.evaluate_javascript_finish(res).to_string()
        except Exception as e:  # noqa: BLE001
            val = "ERROR " + str(e)
        if cb: cb(val)
    view.evaluate_javascript(code, -1, None, None, None, done)

def tick():
    step["n"] += 1
    if step["n"] == 1:
        js(f'localStorage.setItem("theme", "{theme}"); location.reload(); 1')
    elif step["n"] == 3:
        js(CHECK, lambda v: print(v, flush=True))
    elif step["n"] == 4:
        w = view.get_window()
        Gdk.pixbuf_get_from_window(w, 0, 0, w.get_width(), w.get_height()).savev(out, "png", [], [])
        Gtk.main_quit()
        return False
    return True

view.load_uri(url)
GLib.timeout_add(2500, tick)
Gtk.main()

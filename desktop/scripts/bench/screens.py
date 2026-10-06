#!/usr/bin/env python3
"""Captura las pantallas locales de la app (desktop/ui) en WebKitGTK, como las ve la ventana.

  screens.py <carpeta ui> <pantallas.tsv> <carpeta salida> <light|dark>

pantallas.tsv sale del test `dump_screens_for_the_bench` (CP_DESK_SCREENS=… cargo test dump_screens).
Corre dentro del GNOME del banco (eval "$(run.sh env)"), con GDK_BACKEND=x11.
"""
import os, sys
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1"); gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, WebKit2, GLib, Gdk

ui, tsv, out, theme = sys.argv[1:5]
os.makedirs(out, exist_ok=True)
Gtk.Settings.get_default().set_property("gtk-application-prefer-dark-theme", theme == "dark")
jobs = [l.rstrip("\n").split("\t", 1) for l in open(tsv) if "\t" in l]
win = Gtk.Window(); win.set_default_size(960, 680)
view = WebKit2.WebView(); win.add(view); win.show_all()
base = "file://" + os.path.abspath(ui) + "/index.html?"

def next_job():
    if not jobs:
        Gtk.main_quit(); return False
    name, query = jobs[0]
    view.load_uri(base + query)
    return False

def on_load(v, ev):
    if ev != WebKit2.LoadEvent.FINISHED:
        return
    def snap():
        name, _ = jobs.pop(0)
        gw = win.get_window()
        Gdk.pixbuf_get_from_window(gw, 0, 0, gw.get_width(), gw.get_height()).savev(f"{out}/{name}-{theme}.png", "png", [], [])
        print("captura", name, theme)
        next_job()
        return False
    GLib.timeout_add(700, snap)  # que carguen las fuentes y termine la animación de entrada

view.connect("load-changed", on_load)
GLib.idle_add(next_job)
GLib.timeout_add_seconds(120, Gtk.main_quit)
Gtk.main()

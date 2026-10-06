#!/usr/bin/env python3
"""Una ventana chica de la que se arrastran archivos (como desde el gestor de archivos).

  dragsrc.py <archivo> [archivo…]    la ventana se llama "arrastrar-desde", arriba a la izquierda
"""
import os, signal, sys, gi

# Uno solo a la vez: se reemplaza al anterior (por su pid, guardado en el banco).
PID = os.path.join(os.environ.get("BENCH", "."), "drag.pid")
try:
    os.kill(int(open(PID).read()), signal.SIGTERM)
except (OSError, ValueError):
    pass
open(PID, "w").write(str(os.getpid()))
gi.require_version("Gtk", "3.0"); gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk
files = [os.path.abspath(f) for f in sys.argv[1:]]
w = Gtk.Window(title="arrastrar-desde"); w.set_default_size(220, 120); w.move(0, 0)
box = Gtk.EventBox(); box.add(Gtk.Label(label="\n".join(os.path.basename(f) for f in files)))
box.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [], Gdk.DragAction.COPY)
box.drag_source_add_uri_targets()
box.connect("drag-data-get", lambda wd, ctx, data, info, t: data.set_uris(["file://" + f for f in files]))
w.add(box); w.connect("destroy", Gtk.main_quit); w.show_all()
print("lista", flush=True)
Gtk.main()

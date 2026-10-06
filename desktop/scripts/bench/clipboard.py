#!/usr/bin/env python3
"""Pone algo en el portapapeles del GNOME del banco y se queda como dueño (hay que dejarlo corriendo).

  clipboard.py image <archivo.png>   una imagen (como "Copiar imagen")
  clipboard.py text <texto>          texto
"""
import os, signal, sys, gi

# Uno solo a la vez: se reemplaza al anterior (por su pid, guardado en el banco).
PID = os.path.join(os.environ.get("BENCH", "."), "clip.pid")
try:
    os.kill(int(open(PID).read()), signal.SIGTERM)
except (OSError, ValueError):
    pass
open(PID, "w").write(str(os.getpid()))
gi.require_version("Gtk", "3.0"); gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk, GdkPixbuf
cb = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
if sys.argv[1] == "image":
    cb.set_image(GdkPixbuf.Pixbuf.new_from_file(sys.argv[2]))
else:
    cb.set_text(sys.argv[2], -1)
cb.store()
print("en el portapapeles", flush=True)
Gtk.main()

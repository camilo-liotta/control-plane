#!/usr/bin/env python3
"""Herramientas del banco (correr con el entorno de `run.sh env`):

  bench.py windows                    ventanas X visibles (título y tamaño)
  bench.py shot <título> <out.png>    captura la ventana cuyo título contiene <título>
  bench.py close <título>             le pide cerrar a esa ventana (como la X de la barra)
  bench.py a11y                       los controles de la app (AT-SPI)
  bench.py press <nombre>             aprieta el botón o la casilla con ese nombre (AT-SPI)
  bench.py menu                       el menú del ícono (dbusmenu)
  bench.py menu-click <texto>         toca ese ítem del menú del ícono
  bench.py click <x> <y>              clic real en la pantalla (Mutter RemoteDesktop)
"""
import ctypes, json, subprocess, sys, time
import gi

def x11():
    x = ctypes.cdll.LoadLibrary("libX11.so.6")
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x.XInternAtom.restype = ctypes.c_ulong
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
    x.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
    return x

class Attr(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int), ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", ctypes.c_void_p), ("root", ctypes.c_ulong), ("class", ctypes.c_int), ("bit_gravity", ctypes.c_int), ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int), ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong), ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong), ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int), ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long), ("do_not_propagate_mask", ctypes.c_long), ("override_redirect", ctypes.c_int), ("screen", ctypes.c_void_p)]

def windows():
    """Las ventanas de primer nivel de los clientes (las que tienen título), visibles."""
    x = x11()
    x.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(Attr)]
    dpy = x.XOpenDisplay(None)
    out = []
    def walk(w):
        r, p = ctypes.c_ulong(), ctypes.c_ulong()
        k, n = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
        if not x.XQueryTree(dpy, w, ctypes.byref(r), ctypes.byref(p), ctypes.byref(k), ctypes.byref(n)):
            return
        for i in range(n.value):
            nm = ctypes.c_char_p()
            x.XFetchName(dpy, k[i], ctypes.byref(nm))
            a = Attr()
            x.XGetWindowAttributes(dpy, k[i], ctypes.byref(a))
            name = (nm.value or b"").decode("utf-8", "replace")
            if name and a.map_state == 2 and a.width > 50 and name != "mutter guard window":
                out.append((k[i], name, a.width, a.height))
            walk(k[i])
    walk(x.XDefaultRootWindow(dpy))
    return x, dpy, out

def shot(title, path):
    gi.require_version("Gdk", "3.0"); gi.require_version("GdkX11", "3.0")
    from gi.repository import Gdk, GdkX11
    _, _, wins = windows()
    # Con el marco (la barra de título que dibuja mutter): el más grande de los que tienen ese título.
    hits = sorted([w for w in wins if title in w[1]], key=lambda w: -w[2] * w[3])
    if not hits:
        sys.exit(f"no hay ventana con «{title}»: {[w[1] for w in wins]}")
    xid, name, w, h = hits[0]
    gw = GdkX11.X11Window.foreign_new_for_display(Gdk.Display.get_default(), xid)
    Gdk.pixbuf_get_from_window(gw, 0, 0, w, h).savev(path, "png", [], [])
    print("captura", path, name, w, h)

def close(title):
    class CM(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]
    class Ev(ctypes.Union):
        _fields_ = [("xclient", CM), ("pad", ctypes.c_long * 24)]
    x, dpy, wins = windows()
    x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Ev)]
    for xid, name, *_ in sorted(wins, key=lambda w: w[2] * w[3]):
        if name == title:
            ev = Ev(); ev.xclient.type = 33; ev.xclient.window = xid; ev.xclient.format = 32
            ev.xclient.message_type = x.XInternAtom(dpy, b"WM_PROTOCOLS", 0)
            ev.xclient.l[0] = x.XInternAtom(dpy, b"WM_DELETE_WINDOW", 0)
            x.XSendEvent(dpy, xid, 0, 0, ctypes.byref(ev)); x.XSync(dpy, 0)
            print("cerrada", name); return
    sys.exit(f"no hay ventana «{title}»")

def atspi_nodes():
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    d = Atspi.get_desktop(0)
    def walk(o, depth):
        yield o, depth
        # La página del webview tiene miles de nodos: los diálogos nativos no están ahí.
        if o.get_role_name() in ("document web", "embedded", "html container"):
            return
        for i in range(o.get_child_count()):
            c = o.get_child_at_index(i)
            if c is not None:
                yield from walk(c, depth + 1)
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if a and (a.get_name() or "") not in ("gnome-shell", "mutter-x11-frames", "ibus-x11", ""):
            yield from walk(a, 0)

def a11y():
    for o, d in atspi_nodes():
        role, name = o.get_role_name(), o.get_name() or ""
        if role in ("frame", "dialog", "alert") or (name and role in ("button", "push button", "check box", "label", "toggle button")):
            print("  " * d + f"{role}: {name!r}")

def press(name):
    for o, _ in atspi_nodes():
        if (o.get_name() or "") == name and o.get_role_name() in ("button", "push button", "check box", "toggle button"):
            o.get_action_iface().do_action(0); print("apretado", name); return
    sys.exit(f"no hay control «{name}»")

MENU = "/org/ayatana/NotificationItem/tray_icon_tray_app_main/Menu"
def menu_conn():
    out = subprocess.run(["busctl", "--user", "list"], capture_output=True, text=True).stdout
    # La app de desarrollo es "control-plane-d(esktop)"; otra copia, con CP_DESK_COMM.
    import os
    comm = os.environ.get("CP_DESK_COMM", "control-plane-d")
    for line in out.splitlines()[1:]:
        if len(line.split()) > 2 and line.split()[0].startswith(":") and line.split()[2] == comm:
            c = line.split()[0]
            r = subprocess.run(["busctl", "--user", "--timeout=3", "--json=short", "call", c, MENU, "com.canonical.dbusmenu", "GetLayout", "iias", "0", "--", "-1", "0"], capture_output=True, text=True)
            if r.returncode == 0:
                return c, json.loads(r.stdout)["data"][1]
    sys.exit("no encontré el menú del ícono (¿--tray?)")

def menu_items():
    conn, root = menu_conn()
    def walk(node, depth=0):
        nid, props, kids = node
        yield nid, props, depth
        for k in kids:
            yield from walk(k["data"], depth + 1)
    return conn, list(walk(root))

def menu():
    _, items = menu_items()
    for nid, p, d in items:
        if d == 0 or p.get("visible", {}).get("data") is False:
            continue
        if p.get("type", {}).get("data") == "separator":
            print("  " * (d - 1) + "──────"); continue
        flags = []
        if p.get("enabled", {}).get("data") is False: flags.append("(deshabilitado)")
        if p.get("toggle-type", {}).get("data"): flags.append("[x]" if p.get("toggle-state", {}).get("data") == 1 else "[ ]")
        print("  " * (d - 1) + p.get("label", {}).get("data", "") + (" " + " ".join(flags) if flags else ""))

def menu_click(text):
    conn, items = menu_items()
    for nid, p, _ in items:
        if p.get("label", {}).get("data", "").replace("_", "") == text.replace("_", ""):
            subprocess.run(["busctl", "--user", "call", conn, MENU, "com.canonical.dbusmenu", "Event", "isvu", str(nid), "clicked", "s", "", "0"], check=True)
            print("tocado", text); return
    sys.exit(f"no hay ítem «{text}»")

def click(x, y):
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    call = lambda path, iface, m, args=None, rt=None: bus.call_sync("org.gnome.Mutter.RemoteDesktop", path, iface, m, args, rt, 0, -1, None)
    sp = call("/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop", "CreateSession", None, GLib.VariantType("(o)")).unpack()[0]
    S = "org.gnome.Mutter.RemoteDesktop.Session"
    call(sp, S, "Start"); time.sleep(0.3)
    call(sp, S, "NotifyPointerMotionRelative", GLib.Variant("(dd)", (-5000.0, -5000.0))); time.sleep(0.1)
    call(sp, S, "NotifyPointerMotionRelative", GLib.Variant("(dd)", (float(x), float(y)))); time.sleep(0.2)
    for down in (True, False):
        call(sp, S, "NotifyPointerButton", GLib.Variant("(ib)", (272, down))); time.sleep(0.05)
    time.sleep(0.3); call(sp, S, "Stop")

if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["help"]
    fn = {"windows": lambda: [print(hex(w[0]), repr(w[1]), w[2], w[3]) for w in windows()[2]], "shot": shot, "close": close, "a11y": a11y, "press": press, "menu": menu, "menu-click": menu_click, "click": click}.get(cmd)
    fn(*args) if fn else print(__doc__)

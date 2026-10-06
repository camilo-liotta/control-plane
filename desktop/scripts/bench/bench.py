#!/usr/bin/env python3
"""Herramientas del banco (correr con el entorno de `run.sh env`):

  bench.py windows                    ventanas X visibles (título y tamaño)
  bench.py shot <título> <out.png>    captura la ventana cuyo título contiene <título>
  bench.py close <título>             le pide cerrar a esa ventana (como la X de la barra)
  bench.py resize <título> <w> <h>    cambia el tamaño de esa ventana (el cliente, sin el marco)
  bench.py a11y                       los controles de la app (AT-SPI)
  bench.py press <nombre>             aprieta el botón o la casilla con ese nombre (AT-SPI)
  bench.py menu                       el menú del ícono (dbusmenu)
  bench.py menu-click <texto>         toca ese ítem del menú del ícono
  bench.py click <x> <y>              clic real en la pantalla (Mutter RemoteDesktop)
  bench.py click-el <expresión JS>    clic real en el centro del elemento de la página (OFFSET_Y: la barra)
  bench.py drag <x1> <y1> <x2> <y2>   arrastre real con el botón apretado
  bench.py keys <combo> [combo…]      teclas reales: ctrl+v, ctrl+shift+z, alt+Down, Escape, question…
  bench.py type <texto>               escribe el texto tecla por tecla
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

def resize(title, w, h):
    class CM(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]
    class Ev(ctypes.Union):
        _fields_ = [("xclient", CM), ("pad", ctypes.c_long * 24)]
    x, dpy, wins = windows()
    x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Ev)]
    x.XResizeWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_uint, ctypes.c_uint]
    atom = lambda n: x.XInternAtom(dpy, n, 0)
    for xid, name, *_ in sorted(wins, key=lambda w: w[2] * w[3]):
        if name == title:
            # Desmaximizar primero (_NET_WM_STATE remove): maximizada, el gestor ignora el tamaño.
            ev = Ev(); ev.xclient.type = 33; ev.xclient.window = xid; ev.xclient.format = 32
            ev.xclient.message_type = atom(b"_NET_WM_STATE")
            ev.xclient.l[0] = 0; ev.xclient.l[1] = atom(b"_NET_WM_STATE_MAXIMIZED_VERT"); ev.xclient.l[2] = atom(b"_NET_WM_STATE_MAXIMIZED_HORZ"); ev.xclient.l[3] = 1
            x.XSendEvent(dpy, x.XDefaultRootWindow(dpy), 0, (1 << 20) | (1 << 19), ctypes.byref(ev)); x.XSync(dpy, 0)
            time.sleep(0.5)
            x.XResizeWindow(dpy, xid, int(w), int(h)); x.XSync(dpy, 0); print("tamaño", w, h); return
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

class Remote:
    """Una sesión de Mutter RemoteDesktop: mouse y teclado de verdad para la pantalla aislada."""
    S = "org.gnome.Mutter.RemoteDesktop.Session"
    def __enter__(self):
        from gi.repository import Gio, GLib
        self.GLib = GLib
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        self.sp = self.call("/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop", "CreateSession", None, GLib.VariantType("(o)")).unpack()[0]
        self.call(self.sp, self.S, "Start"); time.sleep(0.3)
        # La primera tecla de una sesión nueva se pierde: un Shift suelto de calentamiento.
        self.s("NotifyKeyboardKeysym", "(ub)", 0xFFE1, True); self.s("NotifyKeyboardKeysym", "(ub)", 0xFFE1, False); time.sleep(0.1)
        return self
    def __exit__(self, *a):
        time.sleep(0.2); self.call(self.sp, self.S, "Stop")
    def call(self, path, iface, m, args=None, rt=None):
        return self.bus.call_sync("org.gnome.Mutter.RemoteDesktop", path, iface, m, args, rt, 0, -1, None)
    def s(self, m, fmt, *args):
        self.call(self.sp, self.S, m, self.GLib.Variant(fmt, args))
    def move_to(self, x, y):
        self.s("NotifyPointerMotionRelative", "(dd)", -5000.0, -5000.0); time.sleep(0.05)
        self.s("NotifyPointerMotionRelative", "(dd)", float(x), float(y)); time.sleep(0.1)
    def button(self, down):
        self.s("NotifyPointerButton", "(ib)", 272, down); time.sleep(0.05)
    def keysym(self, sym, down):
        self.s("NotifyKeyboardKeysym", "(ub)", sym, down); time.sleep(0.02)

def click(x, y):
    with Remote() as r:
        r.move_to(x, y); r.button(True); r.button(False)

def element_center(expr):
    import os
    js = f"(()=>{{const e=({expr}); if(!e) return null; e.scrollIntoView({{block:'nearest'}}); const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]}})()"
    out = subprocess.run(["node", os.path.join(os.path.dirname(__file__), "page.mjs"), f"JSON.stringify({js})"], capture_output=True, text=True, timeout=15).stdout.strip()
    pos = json.loads(json.loads(out)) if out.startswith('"') else None
    if not pos:
        sys.exit(f"no hay elemento: {expr}")
    # La ventana arranca arriba a la izquierda; su contenido empieza OFFSET_Y px más abajo (barra de título).
    return pos[0], pos[1] + float(os.environ.get("OFFSET_Y", "69"))

def click_el(expr):
    x, y = element_center(expr)
    click(x, y)
    print("clic en", round(x), round(y))

def drag(x1, y1, x2, y2):
    with Remote() as r:
        r.move_to(x1, y1); r.button(True)
        steps = 20
        for i in range(1, steps + 1):
            r.s("NotifyPointerMotionRelative", "(dd)", (float(x2) - float(x1)) / steps, (float(y2) - float(y1)) / steps); time.sleep(0.04)
        time.sleep(0.4); r.button(False)

def keysym_of(name):
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
    alias = {"ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "super": "Super_L", "esc": "Escape", "enter": "Return", "up": "Up", "down": "Down", "?": "question", "`": "grave"}
    n = alias.get(name.lower(), name)
    sym = Gdk.keyval_from_name(n)
    if sym in (0, 0xFFFFFF):
        sym = Gdk.unicode_to_keyval(ord(n)) if len(n) == 1 else 0
    if not sym:
        sys.exit(f"tecla desconocida «{name}»")
    return sym

def keys(*combos):
    with Remote() as r:
        for combo in combos:
            parts = [keysym_of(p) for p in (combo.split("+") if combo != "+" else ["plus"])]
            for k in parts: r.keysym(k, True)
            for k in reversed(parts): r.keysym(k, False)
            time.sleep(0.15)

def type_text(text):
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
    with Remote() as r:
        for ch in text:
            k = Gdk.unicode_to_keyval(ord(ch)) if ch != " " else Gdk.keyval_from_name("space")
            r.keysym(k, True); r.keysym(k, False)

if __name__ == "__main__":
    cmd, *args = sys.argv[1:] or ["help"]
    fn = {"windows": lambda: [print(hex(w[0]), repr(w[1]), w[2], w[3]) for w in windows()[2]], "shot": shot, "close": close, "resize": resize, "a11y": a11y, "press": press, "menu": menu, "menu-click": menu_click, "click": click, "click-el": click_el, "drag": drag, "keys": keys, "type": type_text}.get(cmd)
    fn(*args) if fn else print(__doc__)

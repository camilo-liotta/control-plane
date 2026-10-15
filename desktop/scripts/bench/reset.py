#!/usr/bin/env python3
"""Deja los ajustes de la app de desarrollo del banco como la primera vez (aviso de cerrar, Al salir)."""
import json, os, sys
p = os.path.join(os.environ["BENCH"], "home/.config/app.control-plane.desktop.dev/settings.json")
s = json.load(open(p)) if os.path.exists(p) else {}
s.update({"closeHintShown": False, "onExit": "ask", "updateNotified": None, "claudePath": None})
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(s, open(p, "w"), indent=2)

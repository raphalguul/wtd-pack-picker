"""PyInstaller runtime hook — injects a minimal PIL stub so UnityPy can import without the full Pillow library."""

import sys
import types

pil = types.ModuleType("PIL")
pil_image = types.ModuleType("PIL.Image")
pil_image.open = lambda *a, **kw: (_ for _ in ()).throw(ImportError("PIL not bundled — audio-only build"))
pil.Image = pil_image
sys.modules["PIL"] = pil
sys.modules["PIL.Image"] = pil_image

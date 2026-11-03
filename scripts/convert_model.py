"""Download ISNet (general use) and convert it to a browser-friendly fp16 ONNX file.

Run once (or when changing the model):
    uv venv -p 3.12 .venv-tools && VIRTUAL_ENV=.venv-tools uv pip install onnx onnxconverter-common
    .venv-tools/bin/python scripts/convert_model.py

Output: models-src/isnet-fp16.onnx and models-src/u2netp.onnx (4.6 MB, the
"quick" model shown first on slow connections). Then run `pnpm prepare-model`.

Model: IS-Net "general use" weights by Xuebin Qin et al. (DIS, Apache-2.0),
as exported to ONNX by the rembg project.
"""
import hashlib
import os
import urllib.request

import onnx
from onnx import utils
from onnxconverter_common import float16

URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx"
SHA256 = "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"
OUT = "models-src"
src = os.path.join(OUT, "isnet-general-use.onnx")
pruned = os.path.join(OUT, "isnet-fp32.onnx")
dst = os.path.join(OUT, "isnet-fp16.onnx")

os.makedirs(OUT, exist_ok=True)
if not os.path.exists(src):
    print("Downloading", URL)
    urllib.request.urlretrieve(URL, src)
digest = hashlib.sha256(open(src, "rb").read()).hexdigest()
assert digest == SHA256, f"checksum mismatch: {digest}"

# Keep only the final mask output; drops unused side outputs.
utils.extract_model(src, pruned, ["input_image"], ["output_image"])
model = onnx.load(pruned)
# fp16 weights halve the download with no measurable quality change.
# Inputs/outputs stay float32 so the browser code is the same for every backend.
model16 = float16.convert_float_to_float16(model, keep_io_types=True, op_block_list=["Resize"])
onnx.save(model16, dst)
print("Wrote", dst, os.path.getsize(dst), "bytes")

# Small "quick" model: U²-Net-P (Apache-2.0 weights, rembg export), used unchanged.
QUICK_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
QUICK_SHA256 = "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"
quick = os.path.join(OUT, "u2netp.onnx")
if not os.path.exists(quick):
    print("Downloading", QUICK_URL)
    urllib.request.urlretrieve(QUICK_URL, quick)
digest = hashlib.sha256(open(quick, "rb").read()).hexdigest()
assert digest == QUICK_SHA256, f"checksum mismatch: {digest}"
print("Verified", quick, os.path.getsize(quick), "bytes")

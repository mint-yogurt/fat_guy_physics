# glad (vendored)

Pre-generated OpenGL 3.3 core loader, checked in so that building this
project never requires Python or the `glad` generator — only GLFW/GLM are
fetched at configure time.

To regenerate (e.g. to bump the GL version or add extensions):

```sh
python3 -m venv /tmp/glad-venv
/tmp/glad-venv/bin/pip install glad2
/tmp/glad-venv/bin/glad --api gl:core=3.3 --extensions "" --out-path /tmp/glad-out c
```

Then copy `src/gl.c`, `include/glad/gl.h`, and `include/KHR/khrplatform.h`
from `/tmp/glad-out` over the files in this directory.

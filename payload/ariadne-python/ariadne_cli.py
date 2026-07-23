"""Console entry points for the installed package (uvx/pipx aegis-ariadne).

The edition's modules import each other flat (``import server``,
``from trust import …``) because their primary life is as loose files vendored
into a repo's ``.ariadne/`` directory, where the script dir is sys.path[0].
When installed as the ``aegis_ariadne`` package instead, these shims put the
package directory on sys.path first, so the exact same files work unchanged in
both modes. (The flat names exist only inside this process — nothing else
imports them.) All commands operate on the WORKSPACE they are run from:
config, extensions, and the index live in <cwd>/.ariadne (or $ARIADNE_HOME).
"""
import os
import runpy
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _flat_path():
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)


def server_main():
    _flat_path()
    import server
    server.main()


def indexer_main():
    _flat_path()
    import indexer
    indexer.main()


def docgen_main():
    # docgen is a top-to-bottom script by design (zero tokens, runs in hooks);
    # execute it exactly as `python3 docgen.py` would
    _flat_path()
    runpy.run_path(os.path.join(_HERE, "docgen.py"), run_name="__main__")

import re

# Convertit un composant genere (format preview : imports ES) vers le format
# attendu par l'app CV Smart, ou le fichier est EVALUE comme un corps de
# fonction recevant `React` et `engine`, et ou les images viennent de la base
# via un objet `assets`.

IMAGE_IMPORT_RE = re.compile(r"^import\s+(\w+)\s+from\s+['\"]@/images/([^'\"]+)['\"];?\s*$", re.MULTILINE)
ANY_IMPORT_RE = re.compile(r"^import\s+.*?from\s+['\"][^'\"]+['\"];?\s*$|^import\s+['\"][^'\"]+['\"];?\s*$", re.MULTILINE)

REACT_SYMBOLS = ["useLayoutEffect", "useEffect", "useRef", "useState", "useMemo", "useCallback", "Fragment"]
ENGINE_SYMBOLS = ["splitEntryIntoFragments", "PaginatedEntryPages", "usePaginatedGroups", "paginationEngine", "entryFragments"]


def _snake(name: str) -> str:
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    return re.sub(r"[-\s]+", "_", name).lower()


def to_db_format(source: str) -> dict:
    assets = [{"varName": m.group(1), "key": _snake(m.group(1)), "file": m.group(2)}
              for m in IMAGE_IMPORT_RE.finditer(source)]

    code = ANY_IMPORT_RE.sub("", source)
    code = re.sub(r"^\s*\n", "", code)

    # Les images arrivent desormais par la prop `assets`, transmise
    # explicitement a chaque sous-composant : plus rien a reecrire ici. Un
    # import d'image residuel (ancien format) est encore converti, mais vers
    # la prop et non vers une variable de module.
    for a in assets:
        code = re.sub(rf"\b{re.escape(a['varName'])}\b", f"assets.{a['key']}", code)

    # `export default function X(...)` -> `function X(...)`, et on renvoie le
    # composant en fin de fichier comme l'attend l'evaluateur.
    default_fn = re.search(r"export\s+default\s+function\s+(\w+)", code)
    default_ref = re.search(r"export\s+default\s+(\w+)\s*;?\s*$", code, re.MULTILINE)
    if default_fn:
        component_name = default_fn.group(1)
        code = re.sub(r"export\s+default\s+function", "function", code, count=1)
    elif default_ref:
        component_name = default_ref.group(1)
        code = re.sub(r"export\s+default\s+\w+\s*;?\s*$", "", code, count=1, flags=re.MULTILINE)
    else:
        raise ValueError("Composant introuvable : aucun `export default` dans le fichier.")

    # Le composant accepte `assets` et le publie en portee module, avant que
    # React ne rende ses enfants -- qui peuvent donc l'utiliser sans le recevoir.
    sig_re = re.compile(rf"function\s+{re.escape(component_name)}\s*\(\s*\{{([^}}]*)\}}\s*\)\s*\{{")

    def _fix_sig(m):
        props_list = m.group(1).strip().rstrip(",")
        has_assets = re.search(r"\bassets\b", props_list) is not None
        return f"function {component_name}({{ {props_list}{'' if has_assets else ', assets'} }}) {{\n"

    code = sig_re.sub(_fix_sig, code, count=1)

    def used(names):
        return [n for n in names if re.search(rf"\b{n}\b", code)]

    react_used = used(REACT_SYMBOLS)
    engine_used = used(ENGINE_SYMBOLS)

    header_lines = []
    if react_used:
        header_lines.append(f"const {{ {', '.join(react_used)} }} = React")
    if engine_used:
        header_lines.append(f"const {{ {', '.join(engine_used)} }} = engine")
    header = "\n".join(header_lines)

    return {
        "code": f"{header}\n\n{code.strip()}\n\nreturn {component_name}\n",
        "assets": assets,
        "component_name": component_name,
    }

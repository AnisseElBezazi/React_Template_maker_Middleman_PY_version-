import re

# Applique dans le JSX les ajustements d'images faits a la souris dans la
# preview (editeur type Figma : deplacer / redimensionner).
#
# Pourquoi reecrire le className plutot qu'ajouter un style inline : le
# composant est responsive (tout est en `em` relatif a une police racine
# calculee depuis la largeur du conteneur). Un style inline en pixels
# casserait cette mise a l'echelle, et un second prop `style` ecraserait
# silencieusement celui d'origine (perdant par exemple un `transform:
# rotate(...)`). On retire donc uniquement les utilitaires de position/taille
# en conflit, et on ajoute les nouvelles valeurs en `em`.

IMG_TAG_START_RE = re.compile(r"<img\s")
# Memes balises, dans le meme ordre, que l'etiquetage fait au rendu -- c'est
# ce qui garantit que l'index recu de l'editeur designe bien la meme balise
# dans le source.
TEXT_TAG_START_RE = re.compile(r"<(p|h[1-6]|li|div)([\s>])")

# Utilitaires Tailwind de position/taille qu'un deplacement ou un
# redimensionnement rend obsoletes -- on les retire pour eviter deux regles
# contradictoires sur la meme propriete. Le `-?` initial couvre les
# utilitaires negatifs (-right-[8%], -bottom-[0.3em]).
CONFLICTING_RE = re.compile(
    r"^-?(?:"
    r"(?:left|right|top|bottom|inset|inset-x|inset-y)-(?:\[[^\]]*\]|auto|full|\d+(?:\.\d+)?|px)"
    r"|(?:w|h)-(?:\[[^\]]*\]|full|auto|screen|px|\d+(?:\.\d+)?)"
    r")$"
)


def _find_tag_span(source: str, start_re: "re.Pattern", index: int) -> tuple[int, int] | None:
    """Trouve l'etendue exacte de la Nieme balise correspondant a start_re,
    en suivant l'imbrication des accolades JSX et les chaines, pour ne pas
    s'arreter sur un `>` qui appartiendrait a une expression interne."""
    n = 0
    for m in start_re.finditer(source):
        if n != index:
            n += 1
            continue
        start = m.start()
        depth = 0
        quote = None
        i = start
        length = len(source)
        while i < length:
            c = source[i]
            if quote:
                if c == quote and (i == 0 or source[i - 1] != "\\"):
                    quote = None
            elif c in ('"', "'", "`"):
                quote = c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            elif c == ">" and depth == 0:
                return (start, i + 1)
            i += 1
        return None
    return None


def _clean_class_name(class_name: str, move: bool) -> list[str]:
    kept = []
    for c in class_name.split():
        if not CONFLICTING_RE.match(c):
            kept.append(c)
            continue
        # En redimensionnement seul, on ne touche pas au positionnement.
        if not move and re.match(r"^-?(?:left|right|top|bottom|inset)", c):
            kept.append(c)
    return kept


def _find_style_object_end(tag: str, from_index: int) -> int:
    """Fin de l'objet litteral d'un style={{ ... }} : on compte les
    accolades pour retrouver la fermeture reelle."""
    depth = 0
    for i in range(from_index, len(tag)):
        c = tag[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _override_props(edit: dict, move: bool) -> list[str]:
    props = []
    if move:
        props += [
            "position: 'absolute'", f"left: '{edit['left']}em'", f"top: '{edit['top']}em'",
            "right: 'auto'", "bottom: 'auto'",
        ]
    else:
        # Image restee dans le flux (nudge par marge cote editeur) : jamais
        # de position absolue, sous peine de faire s'effondrer un parent
        # "auto" dont la largeur sert de repere en % a un autre element
        # (ex: bandeau de titre avec du texte ancre en % par-dessus).
        for prop in ("marginLeft", "marginTop"):
            if edit.get(prop) is not None:
                props.append(f"{prop}: '{edit[prop]}em'")
    if edit.get("width") is not None:
        props.append(f"width: '{edit['width']}em'")
    if edit.get("height") is not None:
        props.append(f"height: '{edit['height']}em'")
    if props:
        props.append("maxWidth: 'none'")
    return props


def _merge_style(tag: str, props: list[str]) -> str:
    """Fusionne des proprietes CSS dans le style inline d'une balise."""
    if not props:
        return tag
    style_match = re.search(r"style=\{\{", tag)
    if style_match:
        obj_open = tag.index("{", style_match.start() + len("style=")) + 1
        obj_end = _find_style_object_end(tag, obj_open)
        if obj_end != -1:
            inner = tag[obj_open + 1:obj_end].strip()
            merged = f"{inner.rstrip(', ')}, {', '.join(props)}" if inner else ", ".join(props)
            return tag[:obj_open + 1] + f" {merged} " + tag[obj_end:]
    return re.sub(r"^<(\w+)", lambda m: f"<{m.group(1)} style={{{{ {', '.join(props)} }}}}", tag, count=1)


def apply_text_edits(jsx_source: str, text_edits: dict) -> dict:
    """Marges (interieures/exterieures) ajustees a la souris sur les blocs de
    texte. Comme pour les images, on ecrit dans le style inline : il prime
    sur les classes utilitaires deja presentes."""
    source = jsx_source
    applied = []
    indexes = sorted((int(k) for k in text_edits.keys()), reverse=True)

    for index in indexes:
        props = [f"{k}: '{v}em'" for k, v in text_edits[str(index)].items() if v is not None]
        if not props:
            continue
        span = _find_tag_span(source, TEXT_TAG_START_RE, index)
        if not span:
            continue
        start, end = span
        tag = source[start:end]
        source = source[:start] + _merge_style(tag, props) + source[end:]
        applied.append(index)
    return {"source": source, "applied": applied}


def apply_image_edits(jsx_source: str, edits: dict) -> dict:
    source = jsx_source
    applied = []
    # De la fin vers le debut : patcher une balise decale tout ce qui suit.
    indexes = sorted((int(k) for k in edits.keys()), reverse=True)

    for index in indexes:
        edit = edits[str(index)]
        span = _find_tag_span(source, IMG_TAG_START_RE, index)
        if not span:
            continue
        start, end = span
        tag = source[start:end]
        class_match = re.search(r'className="([^"]*)"', tag)
        move = edit.get("left") is not None and edit.get("top") is not None

        new_tag = tag
        if class_match:
            cleaned = " ".join(_clean_class_name(class_match.group(1), move))
            new_tag = re.sub(r'className="[^"]*"', f'className="{cleaned}"', new_tag, count=1)

        props = _override_props(edit, move)
        style_match = re.search(r"style=\{\{", new_tag)
        if style_match:
            obj_open = new_tag.index("{", style_match.start() + len("style=")) + 1
            obj_end = _find_style_object_end(new_tag, obj_open)
            if obj_end != -1:
                inner = new_tag[obj_open + 1:obj_end].strip()
                merged = f"{inner.rstrip(', ')}, {', '.join(props)}" if inner else ", ".join(props)
                new_tag = new_tag[:obj_open + 1] + f" {merged} " + new_tag[obj_end:]
        else:
            new_tag = re.sub(r"^<img\s", f"<img style={{{{ {', '.join(props)} }}}} ", new_tag, count=1)

        source = source[:start] + new_tag + source[end:]
        applied.append(index)

    return {"source": source, "applied": applied}


# --- Ajustements portant sur une CLASSE ---------------------------------
# Les titres de section sont rendus par le moteur de pagination, du code
# partage qu'on ne modifie jamais. Leur style vient d'une chaine de classes
# que le composant genere passe au moteur : c'est donc cette chaine, dans le
# composant, qu'il faut corriger.

# Un raccourci comme px-[0.7em] couvre deux cotes : le retirer pour n'en
# changer qu'un remettrait l'autre a zero. On developpe donc d'abord tous les
# espacements en valeurs par cote, on applique les modifications, puis on
# reecrit des utilitaires explicites cote par cote.
EXPAND = {
    "p": ["pt", "pr", "pb", "pl"], "px": ["pl", "pr"], "py": ["pt", "pb"],
    "pt": ["pt"], "pr": ["pr"], "pb": ["pb"], "pl": ["pl"],
    "m": ["mt", "mr", "mb", "ml"], "mx": ["ml", "mr"], "my": ["mt", "mb"],
    "mt": ["mt"], "mr": ["mr"], "mb": ["mb"], "ml": ["ml"],
}
PROP_TO_UTIL = {
    "paddingTop": "pt", "paddingRight": "pr", "paddingBottom": "pb", "paddingLeft": "pl",
    "marginTop": "mt", "marginRight": "mr", "marginBottom": "mb", "marginLeft": "ml",
}

SPACING_CLASS_RE = re.compile(r"^(-?)([a-z]{1,2})-(.+)$")


def rewrite_spacing_classes(class_name: str, spacing: dict) -> str:
    """Reecrit une chaine de classes utilitaires en y imposant les
    espacements demandes, sans perdre ceux des cotes qu'on ne touche pas."""
    sides: dict[str, str] = {}
    kept = []

    for c in class_name.split():
        m = SPACING_CLASS_RE.match(c)
        targets = EXPAND.get(m.group(2)) if m else None
        if not targets:
            kept.append(c)
            continue
        for side in targets:
            sides[side] = m.group(1) + m.group(3)  # la derniere declaration l'emporte

    for prop, em in spacing.items():
        if em is None:
            continue
        sides[PROP_TO_UTIL[prop]] = f"[{em}em]"

    for side, value in sides.items():
        neg = value.startswith("-")
        kept.append(f"{'-' if neg else ''}{side}-{value[1:] if neg else value}")
    return " ".join(kept)


def apply_class_edits(jsx_source: str, class_edits: dict) -> dict:
    source = jsx_source
    applied = []
    for class_name, spacing in class_edits.items():
        if not class_name or not spacing:
            continue
        next_class_name = rewrite_spacing_classes(class_name, spacing)
        # La chaine apparait telle quelle dans le composant (constante ou
        # attribut) : on la remplace partout ou elle est ecrite litteralement.
        if class_name not in source:
            continue
        source = source.replace(class_name, next_class_name)
        applied.append(class_name)
    return {"source": source, "applied": applied}

import re

# Deux defauts distincts se combinent sur les templates generes, et il faut
# LES DEUX classes pour etre a l'abri (verifie empiriquement) :
#
# 1. La BOITE sort de son parent. Dans un conteneur `flex flex-col
#    items-center` (ou items-start/end), l'enfant est dimensionne sur son
#    CONTENU sur l'axe transverse et n'est pas borne par la largeur du
#    parent : un <p> de 389px se retrouve dans un parent de 329px.
#    -> corrige par `max-w-full`.
# 2. Le TEXTE sort de sa boite. Une chaine sans espace (email, URL, mot
#    tres long) n'a aucune opportunite de cesure : le CSS n'a pas le droit
#    de la couper, donc il la laisse depasser.
#    -> corrige par `break-words` (overflow-wrap: break-word).
#
# `max-w-full` n'est PAS applique aux <div> : une banniere pleine largeur
# jouant sur des marges negatives serait rognee. Les div ne recoivent que
# `break-words`, qui ne contraint aucune largeur.

BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li"}
WRAP_ONLY_TAGS = {"div", "span", "a", "td", "th"}

TAG_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])")
CLASS_ATTR_RE = re.compile(r'className="([^"]*)"')
CLASS_EXPR_RE = re.compile(r"className=\{")


def _find_tag_end(src: str, start: int) -> int:
    """Trouve le `>` qui ferme reellement la balise ouvrante commencant a
    `start`, en ignorant ceux qui vivent dans une chaine ou une expression
    {...} (ex: onClick={() => ...}, className={a > b ? x : y})."""
    depth = 0
    quote = None
    i = start
    n = len(src)
    while i < n:
        c = src[i]
        if quote:
            if c == quote and (i == 0 or src[i - 1] != "\\"):
                quote = None
        elif c in ('"', "'", "`"):
            quote = c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == ">" and depth == 0:
            return i
        i += 1
    return -1


def _has_class(cls: str, name: str) -> bool:
    return re.search(rf"(^|\s){re.escape(name)}(\s|$)", cls) is not None


def add_text_safety(jsx: str) -> dict:
    edits = []
    for m in TAG_RE.finditer(jsx):
        tag = m.group(1).lower()
        is_block = tag in BLOCK_TAGS
        if not is_block and tag not in WRAP_ONLY_TAGS:
            continue

        end = _find_tag_end(jsx, m.end())
        if end == -1:
            continue
        attrs = jsx[m.end():end]

        if CLASS_EXPR_RE.search(attrs):
            continue

        cls_match = CLASS_ATTR_RE.search(attrs)
        cls = cls_match.group(1) if cls_match else ""

        no_wrap_wanted = _has_class(cls, "truncate") or _has_class(cls, "whitespace-nowrap")

        add = []
        if is_block and not _has_class(cls, "max-w-full") and not re.search(r"(^|\s)max-w-", cls):
            add.append("max-w-full")
        if not no_wrap_wanted and not _has_class(cls, "break-words") and not _has_class(cls, "break-all"):
            add.append("break-words")
        if not add:
            continue

        if cls_match:
            at = m.end() + cls_match.start()
            new_text = f'className="{(cls + " " + " ".join(add)).strip()}"'
            edits.append((at, at + len(cls_match.group(0)), new_text))
        else:
            at = m.end()
            edits.append((at, at, f' className="{" ".join(add)}"'))

    out = jsx
    for start, end, text in sorted(edits, key=lambda e: e[0], reverse=True):
        out = out[:start] + text + out[end:]
    return {"jsx": out, "count": len(edits)}

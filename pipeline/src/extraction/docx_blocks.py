"""Parcours des paragraphes d'un .docx dans l'ORDRE REEL du document (corps,
tableaux imbriques, en-tetes/pieds de page, et zones de texte/formes) --
partage entre l'extraction (numerote les paragraphes pour Kimi) et le
remplacement (retrouve le paragraphe N pour y ecrire une balise Jinja)."""
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

MC_CHOICE = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Choice"
W_TXBX_CONTENT = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}txbxContent"


def _iter_block_items(parent):
    if hasattr(parent, "element") and hasattr(parent.element, "body"):
        parent_elm = parent.element.body  # Document : le conteneur reel est .body, pas .element.
    elif hasattr(parent, "_element"):
        parent_elm = parent._element  # _Cell (= ._tc), _Header, _Footer : conteneur direct.
    else:
        parent_elm = parent  # deja un element lxml brut (ex: w:txbxContent d'une forme).
    for child in parent_elm.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            yield Table(child, parent)


def _iter_textbox_contents(paragraph):
    """Zones de texte/formes (encadre, pastille) ancrees DANS ce paragraphe
    precis -- frequent pour un bandeau de CV design. On ne regarde que
    mc:Choice (la representation moderne, DrawingML) : mc:Fallback contient
    une COPIE du meme texte pour la compatibilite avec les vieux lecteurs --
    la lire aussi numeroterait et modifierait tout en double."""
    for choice in paragraph._p.iter(MC_CHOICE):
        yield from choice.iter(W_TXBX_CONTENT)


def _iter_paragraphs_ctx(container, table_stack, zones):
    """Coeur partage : yield (paragraphe, pile_de_contexte_tableau, zones).

    `table_stack` -- pile de (ligne, nb_lignes, colonne, nb_colonnes), un
    niveau par tableau imbrique (quasi toujours un seul pour un CV) --
    necessaire pour savoir si une boucle doit etre une balise `{%tr%}`
    (ligne de tableau) plutot que `{%p%}` (paragraphe), ce qu'un simple
    numero de paragraphe ne dit pas.

    `zones` -- liste de libelles ("en-tête", "forme/encadré"...) pour tout
    paragraphe qui n'est pas un paragraphe de corps ordinaire : sans elle,
    un bandeau d'en-tete ou une pastille de forme sont soit invisibles pour
    le modele (jamais numerotes), soit numerotes sans qu'il sache qu'ils se
    repetent sur chaque page ou vivent dans une forme plutot qu'en ligne."""
    for block in _iter_block_items(container):
        if isinstance(block, Paragraph):
            yield block, list(table_stack), list(zones)
            for txbx in _iter_textbox_contents(block):
                yield from _iter_paragraphs_ctx(txbx, [], zones + ["forme/encadré"])
        else:
            # Une cellule fusionnee horizontalement (gridSpan) est renvoyee
            # une fois PAR COLONNE DE GRILLE qu'elle couvre par row.cells de
            # python-docx -- sans dedoublonnage, ses paragraphes seraient
            # vus (et donc potentiellement supprimes) plusieurs fois. Meme
            # logique pour une fusion verticale (vMerge) : `seen` est
            # partage sur TOUTES les lignes de cette table.
            seen = set()
            rows = block.rows
            row_count = len(rows)
            for r_idx, row in enumerate(rows):
                cells = row.cells
                col_count = len(cells)
                for c_idx, cell in enumerate(cells):
                    tc_id = id(cell._tc)
                    if tc_id in seen:
                        continue
                    seen.add(tc_id)
                    yield from _iter_paragraphs_ctx(cell, table_stack + [(r_idx, row_count, c_idx, col_count)], zones)


def iter_paragraphs(container):
    for p, _ctx, _zones in _iter_paragraphs_ctx(container, [], []):
        yield p


def iter_paragraphs_with_context(container):
    """Comme `iter_paragraphs`, mais avec le contexte tableau + zones de
    chaque paragraphe -- MEME ORDRE, donc MEMES INDICES (construit sur le
    meme generateur interne)."""
    yield from _iter_paragraphs_ctx(container, [], [])


def iter_header_footer_parts(doc):
    """Toutes les parties d'en-tete/pied de page REELLEMENT utilisees par au
    moins une section, sans doublon -- plusieurs sections partagent souvent
    la MEME partie (is_linked_to_previous=True = "pas de copie a soi", donc
    on l'ignore la ou elle n'apporte rien de nouveau) et l'objet retourne
    peut alors etre litteralement le meme d'une section a l'autre.
    Sans ce parcours, un bandeau d'en-tete (nom, titre, bandeau repete sur
    chaque page) est INVISIBLE pour iter_paragraphs -- qui ne regarde que le
    corps du document -- et ne peut donc jamais recevoir de balise Jinja."""
    seen_ids = set()
    parts = []
    for section in doc.sections:
        # Paires paires/impaires (rId type="even") : la relation peut exister
        # dans le .docx sans etre actives (reglage document "pages paires/
        # impaires differentes" desactive) -- on les inclut quand meme, sans
        # risque : is_linked_to_previous/le dedoublonnage ci-dessous filtre
        # deja les cas ou elles ne sont pas une copie distincte.
        candidates = [
            ("en-tête", section.header), ("pied de page", section.footer),
            ("en-tête (pages paires)", section.even_page_header),
            ("pied de page (pages paires)", section.even_page_footer),
        ]
        if section.different_first_page_header_footer:
            candidates += [
                ("en-tête 1ère page", section.first_page_header),
                ("pied de page 1ère page", section.first_page_footer),
            ]
        for label, part in candidates:
            if part is None or part.is_linked_to_previous:
                continue
            part_id = id(part._element)
            if part_id in seen_ids:
                continue
            seen_ids.add(part_id)
            parts.append((label, part))
    return parts


def iter_document_paragraphs_with_context(doc):
    """Parcours COMPLET et canonique d'un document : corps d'abord, puis
    chaque en-tete/pied de page reellement utilise (et, dans les deux cas,
    toute forme/zone de texte ancree dans un paragraphe) -- c'est la
    fonction que docx_to_numbered_text.py ET replace_in_docx.py doivent
    utiliser TOUS LES DEUX (jamais iter_paragraphs(doc) directement) pour
    que l'index N designe le meme paragraphe des deux cotes. Yield
    (paragraphe, contexte_tableau, zones) -- zones est une liste vide pour
    un paragraphe de corps ordinaire."""
    for p, ctx, zones in _iter_paragraphs_ctx(doc, [], []):
        yield p, ctx, zones
    for label, part in iter_header_footer_parts(doc):
        for p, ctx, zones in _iter_paragraphs_ctx(part, [], [label]):
            yield p, ctx, zones


def paragraph_text(p):
    return "".join(run.text for run in p.runs)

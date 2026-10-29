import copy
import random
import re
import sys
import json

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table, _Row
from docx.text.paragraph import Paragraph
from docx_blocks import iter_document_paragraphs_with_context, _iter_textbox_contents

# Un paragraphe dont le texte final n'est QUE des balises de controle Jinja
# plates (if/elif/else/endif/for/endfor, sans le moindre texte ni {{ }} de
# sortie autour) -- typiquement un marqueur `{% endfor %}` ou `{% if %}`
# ecrit seul dans son propre paragraphe pour permettre a une boucle/condition
# de traverser plusieurs paragraphes sans les isoler comme {%p%} l'exigerait
# (voir jinja_pass1_replacements.md). Un tel paragraphe n'affiche jamais rien
# LUI-MEME (sa balise ne produit aucune sortie), donc s'il herite une puce de
# liste (numPr, direct ou via son style), Word affiche quand meme une puce
# vide a cote de rien -- que le if/for autour soit vrai ou faux.
# `[^{}]*?` (pas `.*?`) entre le mot-cle et `%}` : `_PURE_MARKER_RE` ci-dessous
# ancre sur TOUTE la chaine (`^(...)+$`, DOTALL) et repete ce groupe -- avec un
# `.` autorisant `{`/`}`, le moteur regex backtrack et laisse UNE SEULE
# "balise" sauter par-dessus du vrai contenu ({{ }}) et d'autres balises pour
# atteindre un `%}` plus loin, des que la premiere tentative (courte) empeche
# le `+` externe de couvrir toute la chaine -- ce qui faisait passer un
# paragraphe avec du VRAI contenu ({{ formation.name }}...) pour un marqueur
# pur, et lui retirait donc sa puce a tort (confirme sur un cas reel : la
# boucle formations perdait sa puce alors que son paragraphe affiche bien
# {{ formation.name }}). Exclure `{`/`}` du milieu de la balise empeche
# structurellement ce saut, meme apres backtracking.
_MARKER_TAG = r"\{%-?\s*(if|elif|else|endif|for|endfor)\b[^{}]*?-?%\}"
_PURE_MARKER_RE = re.compile(r"^(\s*" + _MARKER_TAG + r"\s*)+$", re.DOTALL)


def _is_pure_marker(text):
    return bool(_PURE_MARKER_RE.match(text))


def _strip_bullet(p):
    """Desactive la puce/numerotation de CE paragraphe precis, heritee de son
    style ou posee directement, sans toucher au reste de sa mise en forme.
    `w:numId=0` est la facon documentee OOXML de desactiver explicitement la
    numerotation d'un paragraphe qui en heriterait sinon de son style --
    on ne touche pas au style lui-meme (qui peut porter d'autres reglages
    utiles : indentation, espacement...), seulement a la puce."""
    pPr = p._p.get_or_add_pPr()
    numPr = pPr.find(qn("w:numPr"))
    if numPr is None:
        numPr = pPr.makeelement(qn("w:numPr"), {})
        pPr.insert(0, numPr)
    else:
        for child in list(numPr):
            numPr.remove(child)
    numPr.append(numPr.makeelement(qn("w:numId"), {qn("w:val"): "0"}))


def _set_paragraph_text(p, text):
    """Le setter `.text` de python-docx appelle `clear_content()` sur le run,
    qui retire TOUS ses enfants sauf `w:rPr` -- y compris un `<w:drawing>` si
    ce run porte une image (logo, icone...) plutot que juste du texte.
    Confirme sur un cas reel : le logo d'une entreprise vivait dans le
    PREMIER run (texte vide) du meme paragraphe que le trigramme du
    candidat (second run) -- toucher meme seulement `runs[0]` a suffi a
    supprimer le logo, invisible ensuite sur toutes les pages qui en
    dependaient. On ignore donc TOUT run qui porte un dessin, quelle que
    soit sa position -- le nouveau texte va dans le premier run SANS dessin
    trouve (ajoute a la fin s'il n'y en a aucun), jamais dans un run qui en
    porte un."""
    target = None
    for run in p.runs:
        if run._r.find(qn("w:drawing")) is not None:
            continue
        if target is None:
            target = run
        else:
            run.text = ""
    if target is not None:
        target.text = text
    else:
        p.add_run(text)


def _existing_para_ids(doc):
    """Toutes les valeurs w14:paraId deja presentes dans le corps, les
    en-tetes et les pieds de page -- pour ne generer que du frais qui ne
    percute rien de deja la."""
    ids = set()
    for p, _ctx, _zones in iter_document_paragraphs_with_context(doc):
        val = p._p.get(qn("w14:paraId"))
        if val:
            ids.add(val)
    return ids


def _fresh_para_id(used_ids):
    while True:
        candidate = f"{random.randint(0, 0xFFFFFFFF):08X}"
        if candidate not in used_ids:
            used_ids.add(candidate)
            return candidate


def _reassign_para_ids(element, used_ids):
    """Donne un w14:paraId/w14:textId FRAIS a `element` (s'il s'agit d'un
    `<w:p>`) et a chacun de ses descendants `<w:p>` -- indispensable apres un
    `copy.deepcopy()` d'un paragraphe ou d'une ligne de tableau : le clone
    garde SINON l'ID EXACT de l'original (deepcopy copie aussi les
    attributs), et Word considere alors le fichier corrompu des qu'un meme
    paraId apparait sur plusieurs paragraphes -- confirme sur un cas reel
    (\"Word a trouve du contenu illisible\") ou une seule correction
    d'isolation avait scinde un paragraphe en 5 clones partageant tous le
    meme paraId d'origine. `used_ids` est partage entre tous les clones
    generes dans le meme passage pour garantir l'unicite entre eux, pas
    seulement vis-a-vis de l'existant."""
    for p in element.iter(qn("w:p")):
        p.set(qn("w14:paraId"), _fresh_para_id(used_ids))
        p.set(qn("w14:textId"), _fresh_para_id(used_ids))


# ---------------------------------------------------------------------------
# Filet de securite : Kimi ecrit une balise `{%p%}`/`{%tr%}` PLUS du contenu
# (ou une AUTRE balise `{%p%}`/`{%tr%}`) dans le MEME paragraphe/la MEME ligne
# de tableau, malgre la regle d'isolation du prompt -- ca arrive, et docxtpl
# n'avertit jamais : ca supprime silencieusement tout le reste au rendu (voir
# jinja_pass1_replacements.md). Plutot que de compter sur une conformite
# parfaite de Kimi, on DETECTE cette violation apres coup et on la corrige
# nous-memes en scindant le paragraphe/la ligne en plusieurs, un par balise +
# un pour le contenu reel entre elles -- structure identique a ce que le
# prompt demande d'ecrire directement, mais garantie par du code deterministe
# plutot que par une consigne que le modele peut oublier de suivre.
_P_TAG_RE = re.compile(r"\{%p\s+(?:if|elif|else|endif|for|endfor)\b.*?%\}")
_TR_TAG_RE = re.compile(r"\{%tr\s+(?:if|elif|else|endif|for|endfor)\b.*?%\}")


def _split_into_segments(text, tag_re):
    """Coupe `text` aux frontieres de chaque balise trouvee par `tag_re` :
    renvoie une liste de (est_une_balise, texte) ou chaque balise est SEULE
    dans son entree et tout le texte entre deux balises (ou avant/apres) est
    regroupe dans les siennes -- les segments purement blancs (espaces/sauts
    de ligne sans aucune balise) sont abandonnes, pas materialises en
    paragraphe pour rien. `None` s'il ne reste au final qu'UN SEUL segment
    (une balise seule, sans rien d'autre autour -- deja isole, aucune
    violation) : une SEULE balise avec du texte/une {{ }} accolee EST deja
    une violation (pas besoin d'en avoir deux), tout comme deux balises."""
    matches = list(tag_re.finditer(text))
    if not matches:
        return None
    segments = []
    pos = 0
    for m in matches:
        if m.start() > pos:
            chunk = text[pos:m.start()]
            if chunk.strip():
                segments.append((False, chunk))
        segments.append((True, m.group(0)))
        pos = m.end()
    if pos < len(text):
        chunk = text[pos:]
        if chunk.strip():
            segments.append((False, chunk))
    if len(segments) <= 1:
        return None
    return segments


def _apply_paragraph_split(p, segments, used_ids):
    """Materialise `segments` (voir _split_into_segments) en autant de
    paragraphes reels que d'entrees, chacun une copie EXACTE du paragraphe
    d'origine (donc avec SA mise en forme) mais avec un seul segment comme
    texte -- inseres a la place de l'unique paragraphe d'origine. Chaque
    clone recoit un w14:paraId/textId frais (voir _reassign_para_ids) : sans
    ca, N clones du meme paragraphe partagent tous l'ID d'origine, ce que
    Word refuse d'ouvrir sans passer par sa boite de recuperation."""
    anchor = p._p
    for _is_tag, seg_text in segments:
        new_p = copy.deepcopy(anchor)
        _reassign_para_ids(new_p, used_ids)
        anchor.addprevious(new_p)
        _set_paragraph_text(Paragraph(new_p, p._parent), seg_text)
    parent = anchor.getparent()
    if parent is not None:
        parent.remove(anchor)


def _fix_paragraph_isolation(doc):
    """Corrige toute violation `{%p%}` -- deux balises (ou une balise + du
    texte/un {{ }}) dans le meme paragraphe -- ou que le paragraphe vive
    (corps, tableau, en-tete/pied de page, zone de texte). Un paragraphe
    n'hebergeant qu'UNE SEULE balise `{%p%}` est deja correct, on n'y touche
    pas."""
    targets = []
    for p, _ctx, _zones in iter_document_paragraphs_with_context(doc):
        text = "".join(run.text for run in p.runs)
        segments = _split_into_segments(text, _P_TAG_RE)
        if segments:
            targets.append((p, segments))
    used_ids = _existing_para_ids(doc)
    for p, segments in targets:
        _apply_paragraph_split(p, segments, used_ids)


def _split_row_into_groups(row, tag_re):
    """Meme principe que `_split_into_segments`, mais pour une LIGNE de
    tableau : chaque balise `{%tr%}` trouvee (dans N'IMPORTE QUELLE cellule)
    devient sa PROPRE ligne (juste elle, les autres cellules vides), et tout
    le texte entre deux balises -- meme s'il traverse plusieurs cellules --
    est regroupe dans UNE ligne de contenu commune, chaque morceau restant
    dans SA colonne d'origine (les morceaux purement blancs sont abandonnes).
    `None` s'il ne reste au final qu'UN SEUL groupe (une balise seule sur
    toute la ligne, rien d'autre -- deja isolee, aucune violation) : UNE
    SEULE balise avec du contenu ailleurs sur la ligne (meme dans une AUTRE
    cellule) EST deja une violation -- le regex `{%tr%}` de docxtpl detruit
    toute la ligne des qu'elle contient une balise, quel que soit le nombre."""
    cells = row.cells
    cell_segments = []
    for cell_idx, cell in enumerate(cells):
        text = cell.text
        matches = list(tag_re.finditer(text))
        pieces = []
        pos = 0
        for m in matches:
            if m.start() > pos:
                chunk = text[pos:m.start()]
                if chunk.strip():
                    pieces.append((False, chunk))
            pieces.append((True, m.group(0)))
            pos = m.end()
        if pos < len(text):
            chunk = text[pos:]
            if chunk.strip():
                pieces.append((False, chunk))
        cell_segments.append(pieces)

    if not any(is_tag for pieces in cell_segments for is_tag, _ in pieces):
        return None

    groups = []
    current = {}
    for cell_idx, pieces in enumerate(cell_segments):
        for is_tag, text in pieces:
            if is_tag:
                if current:
                    groups.append(current)
                    current = {}
                groups.append({cell_idx: text})
            else:
                current[cell_idx] = current.get(cell_idx, "") + text
    if current:
        groups.append(current)
    if len(groups) <= 1:
        return None
    return groups


def _apply_row_split(table, row_index, groups, used_ids):
    """Materialise `groups` (voir _split_row_into_groups) en autant de
    lignes reelles que d'entrees, chacune une copie EXACTE de la ligne
    d'origine (memes cellules, meme mise en forme, meme bordures) mais avec
    le texte de chaque cellule remplace par ce que ce groupe y met (vide si
    la cellule n'apparait pas dans ce groupe) -- inserees a la place de
    l'unique ligne d'origine. Chaque clone recoit des w14:paraId/textId
    frais pour ses paragraphes (voir _reassign_para_ids) -- une ligne
    dupliquee N fois duplique aussi les paragraphes de SES cellules, meme
    probleme d'ID que pour un paragraphe isole."""
    original_tr = table.rows[row_index]._tr
    for group in groups:
        new_tr = copy.deepcopy(original_tr)
        _reassign_para_ids(new_tr, used_ids)
        original_tr.addprevious(new_tr)
        # La nouvelle ligne vient d'etre inseree juste avant l'originale : on
        # la retrouve directement via son element (pas via un index, qui a
        # change), pour ne jamais viser la mauvaise ligne.
        new_row = _Row(new_tr, table)
        for cell_idx, cell in enumerate(new_row.cells):
            _set_paragraph_text(cell.paragraphs[0], group.get(cell_idx, ""))
            for extra_p in cell.paragraphs[1:]:
                _set_paragraph_text(extra_p, "")
    parent = original_tr.getparent()
    if parent is not None:
        parent.remove(original_tr)


_FLAVORED_KEYWORD_RE = re.compile(r"\{%(p|tr)?\s+(if|elif|else|endif|for|endfor)\b")


def _table_ancestor(p):
    """L'element `<w:tbl>` englobant le plus proche de ce paragraphe, ou
    `None` s'il vit dans le corps (ou un en-tete/pied de page hors tableau).
    `ctx` (voir docx_blocks.py) ne donne que ligne/colonne, jamais une
    identite de table -- deux tables distinctes a une seule ligne auraient
    le meme ctx -- d'ou ce parcours direct de l'arbre XML."""
    el = p._p.getparent()
    while el is not None:
        if el.tag == qn("w:tbl"):
            return el
        el = el.getparent()
    return None


def _fix_stranded_markers(doc):
    """Deplace automatiquement un `{%p if/for%}` ou son `{%p endif/endfor%}`
    (ou `{%tr%}` equivalent) egare comme paragraphe SUPPLEMENTAIRE a la fin
    d'une cellule de tableau, alors que son autre moitie vit dans le corps du
    document -- confirme sur DEUX cas reels independants : un `{%p if
    data.certifications%}` glisse a la fin de la derniere cellule du tableau
    Langues (au lieu d'un paragraphe du corps juste avant le titre
    Certifications), et un `{%p endfor%}` fermant la boucle
    `data.experiences` cache a la fin de la cellule "Environnement metier"
    (au lieu d'un paragraphe du corps juste apres ce petit tableau). Dans les
    DEUX cas la correction est la MEME : la moitie egaree appartient a un
    paragraphe du corps juste APRES le tableau qui la contient -- exactement
    ce que produit `table.addnext(marker)`. Champ d'application volontairement
    ETROIT : seulement quand une moitie est dans UN tableau et l'autre dans le
    corps -- si les DEUX sont chacune dans un tableau (forcement DIFFERENT
    puisqu'un meme tableau est traite comme un seul conteneur), on ne devine
    pas laquelle deplacer ni ou : `_fix_flavor_mismatches` echoue alors
    bruyamment plutot que de risquer un mauvais deplacement.

    Balayage en DEUX temps (jamais de mutation pendant le parcours) : on
    repere d'abord TOUTES les paires a corriger sans toucher a l'arbre (un
    generateur qui parcourt un arbre en cours de modification peut sauter ou
    dupliquer des noeuds), puis on applique les deplacements une fois le
    parcours termine."""
    stack = []  # pile de [flavor, "if" ou "for", table_englobante, paragraphe]
    relocations = []  # (paragraphe_a_deplacer, table_apres_laquelle_le_placer)
    for p, _ctx, _zones in iter_document_paragraphs_with_context(doc):
        text = "".join(run.text for run in p.runs)
        matches = list(_FLAVORED_KEYWORD_RE.finditer(text))
        if not matches:
            continue
        table_here = _table_ancestor(p)
        for m in matches:
            flavor, keyword = m.group(1) or "", m.group(2)
            if keyword in ("if", "for"):
                stack.append([flavor, keyword, table_here, p])
            elif keyword in ("endif", "endfor"):
                expects = "if" if keyword == "endif" else "for"
                if not (stack and stack[-1][1] == expects):
                    continue
                opener_flavor, _kw, opener_table, opener_p = stack.pop()
                if not opener_flavor or opener_table is table_here:
                    continue  # balise plate, ou deja dans le meme conteneur
                if opener_table is None and table_here is not None:
                    relocations.append((p, table_here))
                elif opener_table is not None and table_here is None:
                    relocations.append((opener_p, opener_table))
                # sinon : deux tableaux differents, laisse _fix_flavor_mismatches geren

    for marker_p, table_el in relocations:
        if table_el.getparent() is not None:
            table_el.addnext(marker_p._p)


def _fix_flavor_mismatches(doc):
    """Un `{%p for%}` (ou `{%tr for%}`) ouvert doit se fermer avec `{%p endfor%}`
    (ou `{%tr endfor%}`) -- JAMAIS un `{% endfor %}` plat, et inversement (pareil
    pour if/elif/else/endif). Le mecanisme `{%p%}`/`{%tr%}` traite CHAQUE
    paragraphe/ligne INDEPENDAMMENT (il ne cherche pas de fermeture assortie)
    alors qu'une balise plate, elle, ne supprime jamais son propre paragraphe/
    ligne -- melanger les deux familles pour UNE MEME construction produit du
    XML mal forme une fois les substitutions appliquees : aucune erreur ne
    remonte, mais le resultat casse de facon imprevisible (des elements de la
    liste peuvent disparaitre en silence, ou se retrouver colles ensemble --
    confirme par test direct). On reecrit ici la famille de la balise
    fermante/elif/else pour qu'elle corresponde TOUJOURS a celle de son
    ouvrante -- seule la famille (p/tr/plate) change, jamais le texte de la
    condition/variable. Si la pile ne correspond pas (ex: un endfor alors que
    la construction ouverte est un if) c'est un DESEQUILIBRE reel, pas juste
    un probleme de famille -- on n'y touche pas, le corriger a l'aveugle
    risquerait d'aggraver les choses plutot que de les reparer.

    Verifie AUSSI, pour les seules constructions `{%p%}`/`{%tr%}` (jamais les
    plates, libres de traverser les paragraphes), que l'ouvrante et la
    fermante vivent dans le MEME conteneur (le corps, ou la MEME table --
    peu importe la ligne, un `{%tr for%}` traverse legitimement plusieurs
    lignes d'UNE table). Un tag peut etre PARFAITEMENT isole (seul dans son
    paragraphe, aucune violation d'isolation) tout en etant plante dans la
    MAUVAISE cellule -- confirme sur un cas reel : un `{%p if
    data.certifications%}` glisse a la fin de la derniere cellule du tableau
    Langues (au lieu d'un paragraphe du corps juste avant le titre
    Certifications), et un `{%p endfor%}` fermant la boucle
    `data.experiences` cache a la fin de la cellule "Environnement metier"
    d'une experience (au lieu d'un paragraphe du corps juste apres). Le
    mecanisme `{%p%}` traite chaque paragraphe comme une unite a supprimer/
    repeter -- ouvrante et fermante dans deux conteneurs differents n'ont
    plus de sens comme unite unique, et docxtpl produit alors du XML qui
    traverse une frontiere de table de facon incoherente : pas d'erreur a la
    generation, mais Word refuse d'ouvrir le resultat ("contenu illisible")
    et des sections entieres peuvent se retrouver mal placees. Contrairement
    au probleme de famille ci-dessus, le cas le plus courant (une moitie dans
    UN tableau, l'autre dans le corps) est deja deplace automatiquement par
    `_fix_stranded_markers` AVANT cette fonction -- ce qui reste ici (les deux
    dans des tableaux DIFFERENTS) n'a pas de correction sure : deviner lequel
    deplacer et ou risquerait d'empirer les choses. On echoue donc bruyamment
    plutot que de livrer un docx silencieusement corrompu."""
    stack = []  # pile de [flavor, "if" ou "for", container_key, apercu_texte]
    for p, _ctx, _zones in iter_document_paragraphs_with_context(doc):
        text = "".join(run.text for run in p.runs)
        matches = list(_FLAVORED_KEYWORD_RE.finditer(text))
        if not matches:
            continue
        here = _table_ancestor(p)  # element <w:tbl>, ou None si dans le corps
        new_text = text
        offset = 0
        changed = False
        for m in matches:
            flavor, keyword = m.group(1) or "", m.group(2)
            wanted = None
            if keyword in ("if", "for"):
                stack.append([flavor, keyword, here, text.strip()[:80]])
                continue
            elif keyword in ("elif", "else"):
                if stack and stack[-1][1] == "if":
                    wanted = stack[-1][0]
            elif keyword in ("endif", "endfor"):
                expects = "if" if keyword == "endif" else "for"
                if stack and stack[-1][1] == expects:
                    opener = stack.pop()
                    wanted = opener[0]
                    if wanted and here != opener[2]:
                        where = lambda key: "dans un tableau" if key is not None else "dans le corps du document"
                        raise RuntimeError(
                            f"Balise `{{%{wanted} {keyword}%}}` mal placee : elle ferme "
                            f"`{{%{opener[0]} {expects}%}}` (paragraphe \"{opener[3]}...\") "
                            f"ouvert {where(opener[2])}, mais cette fermeture est "
                            f"{where(here)} -- ouvrante et fermante d'une meme construction "
                            f"`{{%{wanted}%}}` doivent vivre dans le MEME conteneur (le corps, "
                            f"ou la meme table). Probablement une balise egaree dans la "
                            f"derniere cellule d'un tableau au lieu d'un paragraphe du corps "
                            f'au bon endroit. Paragraphe fautif : "{text.strip()[:80]}..."'
                        )
            if wanted is not None and wanted != flavor:
                new_prefix = "{%" + wanted + " " + keyword if wanted else "{% " + keyword
                start, end = m.start() + offset, m.end() + offset
                new_text = new_text[:start] + new_prefix + new_text[end:]
                offset += len(new_prefix) - (m.end() - m.start())
                changed = True
        if changed:
            _set_paragraph_text(p, new_text)


def _fix_table_row_isolation(doc):
    """Corrige toute violation `{%tr%}` -- deux balises (ou une balise + du
    contenu reel) sur la meme ligne, meme reparties entre plusieurs cellules
    -- pour toutes les tables du corps ET des en-tetes/pieds de page (une
    ligne de contact peut y vivre, voir docx_blocks.py)."""
    tables = list(doc.tables)
    for section in doc.sections:
        for part in (section.header, section.footer, section.even_page_header, section.even_page_footer):
            if part is not None and not part.is_linked_to_previous:
                tables.extend(part.tables)

    used_ids = _existing_para_ids(doc)
    for table in tables:
        row_index = 0
        while row_index < len(table.rows):
            groups = _split_row_into_groups(table.rows[row_index], _TR_TAG_RE)
            if groups:
                _apply_row_split(table, row_index, groups, used_ids)
                row_index += len(groups)
            else:
                row_index += 1


def _remove_or_clear(p):
    """Un paragraphe qui ne doit plus rien afficher (ex: une puce d'exemple
    en trop dans une liste dont un seul element sert de gabarit `{%p for%}`)
    est SUPPRIME, pas juste vide de texte -- sinon sa mise en forme de LISTE
    A PUCES (numPr) reste active et Word affiche quand meme une puce vide a
    cote de rien. Sans risque de fusion de mise en forme ici (contrairement
    a l'ancien comportement qui fusionnait plusieurs CHAMPS dans un seul
    paragraphe) : ce paragraphe ne recoit jamais aucun contenu, il disparait
    juste entierement.
    Exception 1 : le DERNIER paragraphe d'une cellule de tableau ne peut pas
    etre supprime (Word exige au moins un paragraphe par cellule) -- la on
    se rabat sur vider son texte, comme avant.
    Exception 2, plus grave si elle est ratee : un paragraphe qui HEBERGE une
    zone de texte/forme flottante (mc:AlternateContent/wps:txbxContent, voir
    docx_blocks.py) n'a souvent AUCUN texte a lui -- le vrai contenu vit dans
    des paragraphes IMBRIQUES dedans, deja numerotes et tagues a part. Le
    SUPPRIMER supprimerait le noeud XML ENTIER (donc tout ce qui est imbrique
    dedans avec). Le VIDER (`_set_paragraph_text`) n'est pas plus sûr : le
    setter `.text` de python-docx appelle `clear_content()` sur le run, qui
    retire TOUS ses enfants sauf `w:rPr` -- y compris un `<w:drawing>` si le
    dessin qui porte la zone de texte est justement porté par CE run. Dans
    les deux cas, un bandeau de CV entier (trigramme, titre, années
    d'expérience...) peut disparaître alors que chacun de ces champs a
    pourtant reçu sa propre balise correcte par ailleurs, dans un paragraphe
    IMBRIQUÉ différent. La seule option sûre est de NE RIEN FAIRE à ce
    paragraphe conteneur : il n'affiche jamais rien par lui-même de toute
    façon (son texte est déjà vide), donc le laisser tel quel ne change rien
    au rendu -- alors que le modifier risque de tout détruire.
    Exception 3, silencieuse et tout aussi grave : un paragraphe peut HEBERGER
    une rupture de section (`w:sectPr` dans son `w:pPr`) -- c'est ce qui
    delimite par exemple la section "bandeau complet" (premiere page) de la
    section "en-tete simplifie" (pages suivantes), chacune avec son propre
    en-tete. SUPPRIMER ce paragraphe supprime la rupture avec lui : les deux
    sections fusionnent en une seule silencieusement (aucune erreur), qui
    utilise l'en-tete de la section SURVIVANTE pour tout le document --
    confirme sur un cas reel ou Kimi avait mis un paragraphe de formation
    (`replace: ""`) qui se trouvait etre exactement celui portant cette
    rupture : plus aucune trace du bandeau de premiere page nulle part. On se
    rabat ici aussi sur vider le texte (en retirant en plus sa puce
    eventuelle, sinon on recree le probleme que ce fallback existe pour
    eviter) plutot que de toucher a l'element paragraphe lui-meme."""
    parent = p._element.getparent()
    if parent is not None and parent.tag == qn("w:tc") and len(parent.findall(qn("w:p"))) <= 1:
        _set_paragraph_text(p, "")
        return
    if any(True for _ in _iter_textbox_contents(p)):
        return
    pPr = p._p.find(qn("w:pPr"))
    if pPr is not None and pPr.find(qn("w:sectPr")) is not None:
        _set_paragraph_text(p, "")
        _strip_bullet(p)
        return
    if parent is not None:
        parent.remove(p._element)


def _table_is_empty(table):
    return all(not cell.text.strip() for row in table.rows for cell in row.cells)


def _is_blank_paragraph(p):
    return not p.text.strip()


def _remove_leftover_divider_tables(doc):
    """Un CV Word conçu avec plusieurs \"emplacements d'expérience\"
    pré-formattés a l'avance (copier-collés dans le gabarit source, au-delà
    du nombre d'expériences réelles du candidat) laisse souvent, après la
    dernière expérience réelle représentée par la boucle `{%p for exp%}`,
    une SÉRIE de petits tableaux entièrement vides (aucun texte, aucune
    balise) qui ne servent plus qu'à afficher une bordure basse -- un trait
    décoratif entre deux expériences dans le gabarit d'origine. Invisibles
    pour Kimi (`docx_to_numbered_text.py` ne numérote que les PARAGRAPHES
    non vides, jamais les tableaux) donc jamais tagués ni nettoyés par lui.

    Un tableau vide ISOLé ailleurs dans le CV peut être un séparateur
    volontaire du design (à garder) -- mais PLUSIEURS D'AFFILÉE (rien que des
    paragraphes vides entre eux) n'ont aucune ambiguïté : ce sont des
    emplacements inutilisés. Seuls les groupes d'AU MOINS DEUX tableaux vides
    consécutifs sont supprimés ici (avec leurs paragraphes vides
    intermédiaires) ; un tableau vide seul n'est jamais touché."""
    body = doc.element.body
    children = list(body.iterchildren())
    run = []
    table_count = 0

    def flush():
        nonlocal run, table_count
        if table_count >= 2:
            for idx in run:
                body.remove(children[idx])
        run = []
        table_count = 0

    for i, child in enumerate(children):
        if child.tag == qn("w:tbl"):
            if _table_is_empty(Table(child, doc)):
                run.append(i)
                table_count += 1
                continue
            flush()
        elif child.tag == qn("w:p"):
            if run and _is_blank_paragraph(Paragraph(child, doc)):
                run.append(i)  # paragraphe vide tolere au milieu d'une serie deja commencee
                continue
            flush()
        else:
            flush()
    flush()


def _merge_leftover_empty_sections(doc):
    """Un CV Word dont le gabarit source place chaque expérience d'exemple
    dans SA PROPRE section (souvent pour un controle de mise en page fin,
    par ex. un habillage different par experience) laisse, apres la derniere
    experience REELLEMENT utilisee par la boucle `{%p for exp%}`, une SERIE
    de ruptures de section vestigiales -- un paragraphe vide par experience
    d'exemple jamais reprise, chacun hebergeant encore un `w:sectPr`. Une
    section demarre par defaut sur une NOUVELLE PAGE (`w:type` absent ou
    "nextPage") : plusieurs de ces paragraphes vides d'affilee, sans le
    moindre contenu reel entre eux, produisent donc plusieurs PAGES
    ENTIEREMENT VIERGES a la fin du document rendu -- confirme sur un cas
    reel (3 pages blanches d'affilee juste apres la fin des expériences).

    Une SEULE rupture de section vide n'est jamais touchee EN MILIEU DE
    DOCUMENT (elle peut porter une mise en forme de page volontaire pour la
    suite du document -- taille, colonnes, en-tete different). Seuls les
    GROUPES d'AU MOINS DEUX paragraphes hebergeant un `w:sectPr`, consecutifs
    et separes uniquement par d'autres paragraphes vides (jamais de vrai
    contenu ni de tableau entre eux), sont fusionnes : on ne garde que le
    DERNIER `w:sectPr` du groupe (qui definit la mise en page du reste du
    document), les paragraphes precedents du groupe sont supprimes
    entierement avec leur rupture.

    EXCEPTION -- tout paragraphe vide a sectPr qui se retrouve juste avant le
    `w:sectPr` de fin de document (aucun contenu reel apres lui, plus jamais
    aucune section suivante) : la aussi, il ne separe plus rien -- confirme
    sur un cas reel ou un DERNIER paragraphe vide a sectPr (proprietes
    identiques au sectPr de fin de document) suffisait a lui seul a produire
    une page finale entierement vierge supplementaire, meme apres reduction
    du groupe precedent a un seul survivant. On transfere alors ses
    proprietes de page vers le sectPr de fin de document (qui les aurait de
    toute facon portees pour ce contenu une fois la rupture retiree) puis on
    la retire du paragraphe, qui redevient un paragraphe vide ordinaire.

    PIEGE CONFIRME SUR UN CAS REEL -- une rupture de section supprimee ici
    peut porter la SEULE `w:headerReference` de tout le document (sur 5
    sections originales, une seule avait un en-tete rattache, et ce n'etait
    PAS la derniere du groupe vestigial) : la garder uniquement sur le
    DERNIER `w:sectPr` du groupe, sans reporter les references des autres,
    fait disparaitre le logo d'en-tete de TOUT le document rendu -- un bug
    silencieux, sans la moindre erreur a la generation. Chaque suppression
    de sectPr ci-dessous reporte donc d'abord ses `headerReference`/
    `footerReference` vers le sectPr survivant."""
    body = doc.element.body
    children = list(body.iterchildren())
    run = []  # indices de paragraphes vides consecutifs (avec ou sans sectPr)
    sectpr_positions = []  # sous-ensemble de `run` qui hebergent un sectPr

    def _sectPr_of(idx):
        p = children[idx]
        return p.find(qn("w:pPr")).find(qn("w:sectPr"))

    def _carry_over_header_footer_refs(discarded_sectPr, surviving_sectPr):
        ref_tags = (qn("w:headerReference"), qn("w:footerReference"))
        existing_types = {
            (c.tag, c.get(qn("w:type"))) for c in surviving_sectPr if c.tag in ref_tags
        }
        to_add = [
            c for c in discarded_sectPr
            if c.tag in ref_tags and (c.tag, c.get(qn("w:type"))) not in existing_types
        ]
        if not to_add:
            return
        insert_at = 0
        for c in surviving_sectPr:
            if c.tag not in ref_tags:
                break
            insert_at += 1
        for offset, ref in enumerate(to_add):
            surviving_sectPr.insert(insert_at + offset, copy.deepcopy(ref))

    def flush():
        nonlocal run, sectpr_positions
        if len(sectpr_positions) >= 2:
            survivor_sectPr = _sectPr_of(sectpr_positions[-1])
            for idx in sectpr_positions[:-1]:
                _carry_over_header_footer_refs(_sectPr_of(idx), survivor_sectPr)
                body.remove(children[idx])
        run = []
        sectpr_positions = []

    for i, child in enumerate(children):
        if child.tag == qn("w:p") and _is_blank_paragraph(Paragraph(child, doc)):
            run.append(i)
            pPr = child.find(qn("w:pPr"))
            if pPr is not None and pPr.find(qn("w:sectPr")) is not None:
                sectpr_positions.append(i)
            continue
        if child.tag == qn("w:sectPr"):
            if len(sectpr_positions) >= 2:
                survivor_sectPr = _sectPr_of(sectpr_positions[-1])
                for idx in sectpr_positions[:-1]:
                    _carry_over_header_footer_refs(_sectPr_of(idx), survivor_sectPr)
                    body.remove(children[idx])
                sectpr_positions = sectpr_positions[-1:]
            if len(sectpr_positions) == 1:
                p = children[sectpr_positions[0]]
                pPr = p.find(qn("w:pPr"))
                sectPr = pPr.find(qn("w:sectPr"))
                _carry_over_header_footer_refs(child, sectPr)
                for old_child in list(child):
                    child.remove(old_child)
                for new_child in list(sectPr):
                    child.append(new_child)
                pPr.remove(sectPr)
            run = []
            sectpr_positions = []
            continue
        flush()
    flush()


def replace_text_in_doc(doc, edits):
    """`edits` : liste de {"paragraphs": [index, ...], "replace": [texte, ...]}
    -- `replace` a TOUJOURS la meme longueur que `paragraphs` : chaque
    paragraphe recoit SON PROPRE texte et GARDE SA PROPRE mise en forme
    (police, taille, gras...). Le contenu de plusieurs champs n'est JAMAIS
    fusionne dans un seul paragraphe -- ca, c'est toujours interdit.

    Avant, un groupe de paragraphes etait fusionne dans le premier et les
    autres supprimes -- si ce premier paragraphe etait par exemple un titre
    en gras (nom d'entreprise dans un encadre colore), TOUT le bloc fusionne
    (description, dates...) heritait de cette police/gras. Ici, la balise
    Jinja pour chaque champ va dans le paragraphe qui contenait deja ce
    champ, donc elle garde naturellement la bonne mise en forme.

    Un paragraphe qui ne doit plus rien afficher DU TOUT (ex: une puce
    d'exemple en trop), lui, est supprime (voir _remove_or_clear) -- ca
    n'est pas une "fusion", personne n'herite de rien, le paragraphe
    disparait juste. Le laisser vide de texte mais toujours present
    afficherait une puce vide (numPr actif sans contenu).

    Kimi reference les paragraphes par leur INDEX (celui affiche entre
    crochets par docx_to_numbered_text.py) : plus besoin de retrouver du
    texte recopie caractere pour caractere, qui echouait silencieusement des
    qu'un detail differait (espace insecable, paragraphe duplique...).
    """
    # MEME fonction, MEME ordre que docx_to_numbered_text.py (corps puis
    # en-tetes/pieds de page) : sans ca, l'index N ne designerait pas le
    # meme paragraphe des deux cotes des que le CV a un bandeau d'en-tete.
    paragraphs = [p for p, _ctx, _zone in iter_document_paragraphs_with_context(doc)]
    n = len(paragraphs)

    for edit in edits:
        idxs = edit.get("paragraphs", [])
        replaces = edit.get("replace", [])
        if not isinstance(replaces, list):
            replaces = [replaces] * len(idxs)
        # `zip(idxs, replaces)` tronquerait silencieusement des que `replace`
        # est reellement plus court que `paragraphs` -- le cas normal promis
        # au modele (voir jinja_pass1_replacements.md) -- en laissant les
        # paragraphes en trop totalement intacts (texte d'exemple d'origine
        # y compris). On complete donc nous-memes au lieu de compter sur
        # l'appelant pour l'avoir deja fait.
        for i, idx in enumerate(idxs):
            text = replaces[i] if i < len(replaces) else ""
            if isinstance(idx, int) and 0 <= idx < n:
                if text:
                    _set_paragraph_text(paragraphs[idx], text)
                    if _is_pure_marker(text):
                        _strip_bullet(paragraphs[idx])
                else:
                    _remove_or_clear(paragraphs[idx])

    _fix_stranded_markers(doc)
    _fix_flavor_mismatches(doc)
    _fix_paragraph_isolation(doc)
    _fix_table_row_isolation(doc)
    _remove_leftover_divider_tables(doc)
    _merge_leftover_empty_sections(doc)


def main():
    if len(sys.argv) != 4:
        print("Usage: python3 replace_in_docx.py <input.docx> <edits.json> <output.docx>")
        sys.exit(1)

    input_path = sys.argv[1]
    edits_path = sys.argv[2]
    output_path = sys.argv[3]

    try:
        with open(edits_path, "r", encoding="utf-8") as f:
            edits = json.load(f)

        doc = Document(input_path)
        replace_text_in_doc(doc, edits)
        doc.save(output_path)

        print(f"SUCCESS: {output_path}")
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

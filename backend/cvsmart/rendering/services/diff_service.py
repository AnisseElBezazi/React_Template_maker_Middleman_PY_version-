from pathlib import Path

from PIL import Image
from pixelmatch.contrib.PIL import pixelmatch


def generate_diff_image(target_path: Path, rendered_path: Path, out_path: Path) -> dict:
    """Genere une image de difference pixel-a-pixel (pixelmatch) -- zones
    differentes surlignees en rouge vif, pour que le modele VOIE ses ecarts
    au lieu de deviner en comparant deux images cote a cote."""
    img1 = Image.open(target_path).convert("RGBA")
    img2 = Image.open(rendered_path).convert("RGBA")
    if img1.size != img2.size:
        raise ValueError(
            f"Dimensions differentes entre cible ({img1.width}x{img1.height}) et rendu "
            f"({img2.width}x{img2.height}) -- diff impossible sans les recadrer d'abord."
        )
    diff = Image.new("RGBA", img1.size)
    diff_pixel_count = pixelmatch(img1, img2, diff, threshold=0.1)
    diff.save(out_path)
    total = img1.width * img1.height
    return {"diff_pixel_count": diff_pixel_count, "total_pixels": total, "diff_ratio": diff_pixel_count / total}
